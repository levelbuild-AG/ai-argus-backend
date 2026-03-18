# Package 4 — Production deployment preparation

Concrete deployment plan, sizing, infra requirements, and decision framing. Grounded in ext/v2 code paths and MT-IT–proven flows.

---

## 1. k-native / production architecture plan

### 1.1 Runtime components

| Component | Role | Used by |
|-----------|------|--------|
| **api** (Node) | Main backend: auth, convos, files, agents, admin, ext/v2 | All traffic; tenant config cache, provider caches, Mongo/Redis/Meili/storage clients |
| **rag_api** (Python/FastAPI) | Embeddings + vector write/read; tenant-scoped by internal auth | API when `POST /ext/v2/files` with `tool_resource=file_search` |
| **System Mongo** | Users, Tenants, Sessions, system data | API only (default connection) |
| **Tenant Mongo(s)** | Conversations, messages, files metadata per tenant | API via TenantConnectionManager (per-tenant connections) |
| **Postgres/pgvector** | RAG embeddings per tenant | rag_api only |
| **Meilisearch** | Full-text search; tenant-isolated indexes | API (indexSync, search routes) |
| **Redis** | Rate limits, bans, convo access cache, concurrent limiting; tenant-prefixed keys | API only |
| **Object storage (S3/MinIO etc.)** | File uploads; per-tenant bucket/prefix | API (file strategies) |

Optional for minimal ext/v2: Meili (if no search), RAG (if no file_search). Redis is required for rate limiting/cache if those features are on; check `USE_REDIS` guards.

### 1.2 Stateless vs stateful

| Component | Stateless? | Scales horizontally? | Singleton initially? | Can be external managed? |
|-----------|------------|----------------------|---------------------|---------------------------|
| **api** | Yes (per process) | Yes | No (1–2 replicas from day one is fine) | No (your app) |
| **rag_api** | Yes (per process) | Yes | No (1–2 replicas) | No (your app) |
| **System Mongo** | Stateful | No (replica set for HA only) | Yes (1 cluster) | Yes (Atlas, etc.) |
| **Tenant Mongo** | Stateful | No for 5–10 tenants | Yes (1 cluster, multiple DBs) | Yes (Atlas, etc.) |
| **Postgres/pgvector** | Stateful | No (or read replicas later) | Yes (1 instance) | Yes (RDS, Cloud SQL, etc.) |
| **Meilisearch** | Stateful | No for small scale | Yes (1 node) | Yes (Meili Cloud) or self-hosted |
| **Redis** | Stateful | No for small scale | Yes (1 instance) | Yes (ElastiCache, etc.) |
| **Object storage** | Stateful | N/A | N/A (single cluster, many buckets/prefixes) | Yes (S3, GCS, etc.) |

### 1.3 Minimum production topology (5–10 tenants, thousands of users)

- **api:** 1–2 replicas behind a load balancer (e.g. k8s Deployment). Stateless; can add replicas. In-memory tenant/config caches are per-replica (no cross-replica invalidation); acceptable for 5–10 tenants and infrequent config changes.
- **rag_api:** 1–2 replicas. Stateless; Postgres is the shared bottleneck.
- **System Mongo:** 1 replica set (3 nodes for HA) or single node for dev/small prod. Holds Users, Tenants. **Singleton.** Can be MongoDB Atlas or self-hosted.
- **Tenant Mongo:** 1 cluster with multiple DBs (one DB per tenant) or one Mongo URI per tenant. **Singleton cluster** for 5–10 tenants. Can be same Atlas cluster as system or separate.
- **Postgres (pgvector):** 1 instance (multiple DBs per tenant or tenant column). **Singleton.** Use PgBouncer if multiple rag_api replicas. Can be RDS/Cloud SQL.
- **Meilisearch:** 1 node. **Singleton** for this scale. Tenant isolation via index naming/filter (see indexSync).
- **Redis:** 1 instance (or Sentinel for HA). **Singleton.** Used for rate limits and caches. Can be ElastiCache/Redis Cloud.
- **Object storage:** 1 cluster (S3/MinIO) with per-tenant bucket or prefix. **External/managed** (S3, GCS, MinIO).

**What scales horizontally from day one:** api, rag_api.  
**What remains singleton initially:** System Mongo (1 cluster), Tenant Mongo (1 cluster or N URIs), Postgres (1 instance), Meili (1 node), Redis (1 instance).  
**What can be external managed services:** Mongo, Postgres, Meili, Redis, object storage — all of them.

---

## 2. Resource sizing and bottleneck analysis

### 2.1 First-pass sizing (5–10 tenants, thousands of users, ext/v2 + RAG + search)

| Component | CPU | Memory | Storage | Replicas (initial) | Notes |
|-----------|-----|--------|---------|---------------------|--------|
| **api** | 0.5–2 cores | 1–2 Gi | — | 1–2 | I/O-bound; add replicas for throughput. |
| **rag_api** | 0.5–1 core | 512 Mi–1 Gi | — | 1–2 | Thread pool ~8; embedding + PG write. |
| **System Mongo** | 1–2 cores | 2–4 Gi | 10–50 Gi | 1 cluster (or 3-node RS) | Users, Tenants; modest growth. |
| **Tenant Mongo** | 2–4 cores shared | 2–4 Gi | 20–100 Gi | 1 cluster | Multiple DBs; size from convo/message volume. |
| **Postgres (pgvector)** | 1–2 cores | 2–4 Gi | 20–50 Gi | 1 instance | Embeddings; dimension and doc count drive size. |
| **Meilisearch** | 0.5–1 core | 1–2 Gi | 5–20 Gi | 1 node | Index from convo titles/content. |
| **Redis** | 0.25 core | 256 Mi–512 Mi | 0 or persist | 1 instance | Rate limit + cache. |
| **Object storage** | — | — | Per tenant | 1 cluster | S3/MinIO; size from upload volume. |

### 2.2 Hot paths (from ext/v2 and code)

- **ext/v2 request:** `requireExtUserAuth` (system User Mongo) → `extV2RequireTenantContext` → handler. Then: tenant Mongo (convos/messages), tenant storage (files), optional rag_api → Postgres (file_search), Meili (search).
- **Likely bottlenecks (in order):**  
  1. **External LLM** (agents/chat): provider latency and rate limits.  
  2. **Tenant Mongo:** connection count = tenants × API replicas; pool limits.  
  3. **rag_api + Postgres:** embedding CPU and vector write volume.  
  4. **Meilisearch:** indexSync and search QPS.  
  5. **Redis:** usually fine unless very high QPS.

### 2.3 Biggest unknowns that affect sizing

- Concurrent LLM request volume and provider limits.
- File upload volume and average size (RAG + storage growth).
- Conversation and message volume per tenant (Mongo + Meili index size).
- Whether tenant Mongo is one cluster (multiple DBs) or N separate clusters (connection count and ops complexity).

---

## 3. Required infra/config changes before deployment

### 3.1 k-native / Kubernetes

- **api / rag_api:** Run as Deployments with explicit resource requests/limits (CPU, memory from §2.1). No init containers required for migration (run migration as a one-off Job or from a host).
- **Secrets:** Store `MONGO_URI`, `SYSTEM_MONGO_URI`, `ADMIN_AUTH_SECRET`, `RAG_INTERNAL_AUTH_SECRET`, provider keys in k8s Secrets or a secret manager; inject as env (no .env in image).
- **Config:** `MULTI_TENANCY_ENABLED=true`, `USE_REDIS=true`, `RAG_API_URL` (internal service URL for rag_api). No config maps required for app logic beyond what is already env-driven.

### 3.2 Ingress / gateway / auth

- **ext/v2:** Ingress must route `/ext/v2/*` to api. No JWT required for data plane; trusted headers (`X-User-Email`, `X-Tenant-ID`, etc.) must be set by your gateway or upstream after auth. Do not allow clients to send arbitrary `X-Tenant-ID` / `X-User-Email` without validation.
- **Admin API:** `/api/admin/*` must **not** be reachable by the public. Ingress or gateway must restrict access (e.g. internal only, or VPN, or allowlist IPs). Admin routes require `X-Admin-Auth: <ADMIN_AUTH_SECRET>` and `X-LibreChat-Role: ADMIN`; the gateway must inject these after your admin auth — never trust these headers from the internet.

### 3.3 Admin API protection

- **Required:** Only a trusted edge (your API gateway, internal service, or admin UI backend) may call `/api/admin/tenants`. That edge must strip any client-sent `X-Admin-Auth` / `X-LibreChat-Role` and inject them only after verifying the caller. Document and enforce: no direct exposure of admin routes to the public.

### 3.4 Config cache / multi-replica

- **Current behavior:** Each api replica has its own in-memory tenant config cache. On tenant PATCH/PUT, only the replica that served the request (or none, if the request was to admin only) invalidates its cache; other replicas may serve stale config until next load. For 5–10 tenants and infrequent rotation, this is acceptable. For many tenants or frequent rotation, plan for shared cache or broadcast invalidation later; no code change in Package 4.

### 3.5 Logging / observability minimums

- **Minimum:** Ensure logs (stdout/stderr) are collected and searchable; include request IDs where present. No new structured fields are added in Package 4; optional later: `tenantId` / `userId` in access logs.
- **Health:** `GET /ext/v2/health` returns 200 and `{ status: 'ok' }`; use for liveness/readiness if needed.

### 3.6 Backup / restore expectations

- **System Mongo:** Backup before user identity migration; backup regularly (Users, Tenants). Restore procedure documented in `docs/MIGRATION_USER_IDENTITY_INDEXES.md` (no automatic rollback for index migration).
- **Tenant Mongo(s):** Per-tenant backup/restore if required by compliance.
- **Postgres (RAG):** Backup vector DBs if RAG is critical; test restore of one tenant.
- **Redis:** Ephemeral acceptable for rate limit/cache; if persistent, backup policy is deployment-specific.

---

## 4. Deployment readiness checklist (summary)

- **Release gate tests (must be green before rollout):**  
  - `mt.extv2.e2e.spec.js` (14/14) — run against target env or a staging that mirrors it.  
  - `requireExtUserAuth.identity.spec.js` (3/3).  
  - Tenant config contract suite if you use admin API in production.
- **Migrations:** User identity index migration run and verified (dry-run then real run; see `docs/MIGRATION_USER_IDENTITY_INDEXES.md`).
- **Env / secrets:** MONGO_URI or SYSTEM_MONGO_URI, ADMIN_AUTH_SECRET, RAG_API_URL and RAG_INTERNAL_AUTH_SECRET if using RAG, USE_REDIS, MULTI_TENANCY_ENABLED.
- **Tenant creation:** At least one tenant via POST /api/admin/tenants; smoke test ext/v2 (convo, file, RAG if used, identity, search).
- **Secret rotation:** PATCH tenant config and confirm next request uses new creds (no restart).
- **Rollback:** Revert api/rag_api image; backing data unchanged. User index migration has no automatic rollback.

Full operator checklist: `docs/PRE_PRODUCTION_VALIDATION_CHECKLIST.md`.

---

## 5. Final decision framing

### 5.1 What can be deployed now

- **ext/v2 production surface** with:
  - Tenant-scoped identity (same email across tenants supported; DB indexes migrated).
  - Tenant-scoped config (Google/Vertex raw JSON, storage, RAG, dbUri).
  - Live config/credential updates without restart.
  - Tenant onboarding via admin API and ext/v2 smoke tests proven.
- **Deployment model:** api + rag_api as stateless replicas; Mongo (system + tenant), Postgres, Meili, Redis, object storage as singletons or managed services. Minimum topology in §1.3 and sizing in §2.1 are sufficient for 5–10 tenants and thousands of users, subject to unknowns in §2.3.

### 5.2 What should remain disabled

- **Assistants API (OpenAI Assistants), Azure Assistants, Azure OpenAI chat** in MT mode — not proven tenant-isolated; keep disabled.
- **Internal `/api/*` JWT routes as primary integration** — treat as compatibility-only; not the release gate. If internal UI or JWT clients are in scope, re-prove or add smoke tests before relying on them.
- **`MT_E2E_INTERNAL_ROUTES`** — must be off in production (test-only).
- **`?secrets=1` on admin tenant GET/list** — do not use in production; use only in secure debugging.

### 5.3 What would make this unsafe if ignored

- **Admin API exposed to the internet** without a trusted gateway that injects admin headers after auth — risk of tenant config takeover or secret exposure.
- **Skipping user identity migration** — same-email-across-tenants will fail at runtime (unique index violations) or leave legacy global indexes in place.
- **Mongo/Postgres/Redis/storage not backed up** — no recovery path for tenant or system data.
- **ext/v2 traffic trusting client-supplied `X-Tenant-ID` / `X-User-Email`** without an upstream that validates and sets them — risk of tenant spoofing and data leakage.
- **Deploying with Assistants/Azure paths enabled** for MT — unproven isolation.

---

## 6. Operational bottlenecks to watch (recap)

- **TenantConnectionManager:** Many tenants × many API replicas → high Mongo connection count; tune `MONGO_MAX_POOL_SIZE` and monitor.
- **indexSync:** Per-tenant; can be heavy; monitor Meili and API CPU/memory.
- **RAG ingest:** Burst file_search uploads can queue at rag_api/Postgres; consider rate limiting if needed.
- **Provider rate limits:** External; 429s and backoff affect latency; not solvable by backend sizing alone.

---

## 7. What the Helm chart manages vs expects externally

- **Helm-manages (current scope):**
  - `api` (Deployment by default; optional Knative Service).
  - `rag_api` (Deployment by default; optional Knative Service).
  - ClusterIP Services for api and rag_api.
  - Public Ingress for api/ext-v2 surface.
  - Internal/admin Ingress for `/api/admin` (must also be restricted at gateway/network).
  - App-level ConfigMap/Secret for non-secret env and secrets:
    - `ADMIN_AUTH_SECRET`, `RAG_INTERNAL_AUTH_SECRET`, `MULTI_TENANCY_ENABLED`.
  - Tenant bootstrap Job and its ConfigMap/Secret:
    - Embedded `scripts/provision-tenants.js` and `tenants/bootstrap.tenants.yaml`.
    - Secret for `TENANT_LEVELBUILD_GOOGLE_KEY_JSON`.

- **Expected external / separately managed (for production):**
  - Mongo (system + tenant), Postgres/pgvector, Redis, Meilisearch, and S3/MinIO are assumed to be provisioned and managed by your platform team or cloud provider.
  - The chart only wires env/URIs to these services; it does not (yet) create StatefulSets/Services for them in prod.

This is intentional for first rollout: Helm is the **app + ingress + bootstrap** layer; backing stores are external and managed via your existing infra tooling.

*Update this doc after concrete load tests and when IaC for stateful dependencies are added.*
