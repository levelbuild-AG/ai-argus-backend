# Admin Tenant Config API

Runtime create/edit/delete of tenant configs. Admin-only; auth via **optional request header** + shared secret (no LibreChat user-record roles).

---

## 1. Auth: Header + shared secret

- **Role header**: `X-LibreChat-Role: ADMIN` (or env `ADMIN_ROLE_HEADER` / `ADMIN_ROLE_VALUE`)
- **Secret header**: `X-Admin-Auth: <ADMIN_AUTH_SECRET>`
- **Env**: `ADMIN_AUTH_SECRET` (min 16 chars). If unset or too short, admin routes return 503.

**Rule:** Admin role is **not** derived from LibreChat user DB. Only a **trusted edge** (e.g. WebApp or ext-v2 gateway) must inject these headers. The public LibreChat UI must NOT be able to self-assert admin.

**Who injects the header:** Your reverse proxy or API gateway (e.g. nginx, Kong, or the ext-v2 backend) that sits in front of the LibreChat API. That component must:
1. Authenticate the caller (e.g. internal service or admin UI).
2. Set `X-LibreChat-Role: ADMIN` and `X-Admin-Auth: <ADMIN_AUTH_SECRET>` only for allowed callers.
3. Never expose `ADMIN_AUTH_SECRET` to the client; keep it in server env only.

### 1.1 Trust model (required for production)

- **This route must only be reachable behind trusted proxy X** (e.g. your WebApp backend or ext-v2 gateway). The public LibreChat UI must not be able to call `/api/admin/*` with self-asserted admin headers.
- **Proxy must strip inbound** `X-LibreChat-Role` and `X-Admin-Auth` from all requests coming from the public/internet. Do not trust these headers from untrusted clients.
- **Proxy must inject** `X-LibreChat-Role: ADMIN` and `X-Admin-Auth: <ADMIN_AUTH_SECRET>` only for requests that have been authenticated as admin (e.g. by your internal auth service or admin session).
- **TODO checklist (if not yet implemented):**
  - [ ] Proxy configuration strips `X-LibreChat-Role` and `X-Admin-Auth` on public-facing routes.
  - [ ] Admin UI or internal service calls API only via the proxy that injects headers after auth.
  - [ ] `ADMIN_AUTH_SECRET` is set only in server env and never in client bundles.

### 1.1a Extra hardening (deployment layer)

- **Recommended:** Require a **third header** (e.g. `X-Internal-Request: 1`) or enforce an **allowlist of source IPs** at the proxy so that only your internal services can reach `/api/admin/*`. If your proxy cannot set a custom header, document the proxy requirement and restrict by IP in the proxy config.
- **Implementation:** Optional env `ADMIN_REQUIRE_INTERNAL_HEADER` (e.g. `X-Internal-Request`) — when set, the admin middleware rejects requests that do not include that header. This is **not** a substitute for keeping the route behind a trusted edge; it is an extra signal for deployments that can set it.
- **TODO (deployment):** If you do not have a proxy that can set `X-Internal-Request` or restrict by IP, document that `/api/admin/*` must only be exposed to trusted internal networks and leave IP allowlist as a deployment-layer TODO.

### 1.2 initializeTenantConfigs always runs (proof)

- **File:** `api/server/index.js` — startup order: `await seedDatabase()` → `await initializeTenantConfigs()` → `assertAlwaysOnMTWiring()` → … → `app.use('/api/admin', ...)`. So `initializeTenantConfigs()` is always awaited and cannot be skipped; it runs before any routes are mounted.
- **File:** `api/server/services/start/tenantConfigInit.js` — the MT-flag skip was removed; the function always loads base config and tenant configs. So TenantConfigService is always initialized before assertAlwaysOnMTWiring runs.

### 1.3 Admin route gate (grep proof)

- **Only gate for `/api/admin/**`:** `requireAdminHeader` is the sole middleware that protects admin routes. All requests to `/api/admin/*` must pass this middleware first; there are no other admin entry points.
- **Proof (grep):**
  - Mount: `api/server/index.js` — `app.use('/api/admin', requireAdminHeader, routes.admin);` (only place that mounts `/api/admin`).
  - No other routes use `requireAdminHeader` or mount under `/admin`:  
    `rg "requireAdminHeader|/api/admin" api/` → only `api/server/index.js` and `api/server/middleware/requireAdminHeader.js`; no other router mounts admin paths.
  - `checkAdmin` (roles) is used for other features (e.g. config proof endpoint); it is **not** used for `/api/admin/tenants`. Admin tenant config is **header-only**.

---

## 2. Endpoints (all under `/api/admin`, require admin headers)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/tenants` | List tenants (paginated). Query: `page`, `limit`, `status=all`, `secrets=1` |
| POST | `/api/admin/tenants/validate` | Validate create payload (no persist) |
| POST | `/api/admin/tenants` | Create tenant |
| GET | `/api/admin/tenants/:tenantId` | Get one (secrets redacted unless `?secrets=1`) |
| PUT | `/api/admin/tenants/:tenantId` | Full replace (validate then atomic write) |
| PATCH | `/api/admin/tenants/:tenantId` | Partial update (validate then atomic write) |
| DELETE | `/api/admin/tenants/:tenantId` | Soft-delete (`status: 'deleted'`) |
| POST | `/api/admin/tenants/:tenantId/validate` | Validate update payload (no persist) |

---

## 3. Persistence and bootstrap

- Tenant documents live in **system Mongo** `tenants` collection.
- **Bootstrap:** Startup and seed do **not** overwrite existing tenant configs (create-if-missing only).
- **No overwrite on restart (proof):**
  - **tenantConfigInit** (`api/server/services/start/tenantConfigInit.js`): Calls `getTenantConfigService().loadAllTenantConfigs()` only. **loadAllTenantConfigs** (`TenantConfigService.js`): `Tenant.find({ status: 'active' })` then `loadTenantConfig(tenantId)` per tenant — **read + cache only; no write.**
  - **tenantSeed.js** (`api/server/services/start/tenantSeed.js`): `Tenant.findOne({ tenantId: legacyTenantId })`; if existing → log and **return** (no exit, no overwrite). If not existing → `Tenant.create(...)`. No code path writes over an existing tenant doc from env/defaults.
- **Soft delete:** DELETE sets `status: 'deleted'`; document remains for safety.

---

## 4. Validation and versioning

- **Tier 1:** Schema validation (shape, required fields, allowed values). Includes: bedrock (accessKeyId, secretAccessKey, region); storage (provider-specific: s3→bucket, azure_blob→container, local→basePath); customEndpoints (baseURL http/https, apiKey string, headers string→string). See `validateTenantConfigSchema.js`.
- **Tier 2:** Connectivity checks (Mongo, Postgres when configured) with **strict timeouts**. If any check fails, request is rejected and **no** persist.
- **Validation levels and timeouts:** All Tier 2 connectivity checks use a single timeout constant (e.g. 5000 ms). Mongo: `serverSelectionTimeoutMS`; Postgres: `connectionTimeoutMillis`. Defined in `validateTenantConfigConnectivity.js` (`CONNECTIVITY_TIMEOUT_MS`). Fast failure avoids blocking the request thread.
- **Optimistic concurrency:** Send `If-Match: <configVersion>` or body `expectedVersion`. On mismatch → 409.
- **Versioning:** `configVersion` incremented on each update; `updatedAt` set.

---

## 5. Cache invalidation (on successful persist)

- **TenantConfigService:** cache cleared for that tenant.
- **TenantConnectionManager:** `closeConnection(tenantId)` when `dbUri` (or Mongo config) changes.
- **rag_api:** `POST /internal/cache/invalidate` (body `{ tenantId }` or query `?tenantId=...`), protected by `X-Internal-Auth`. API calls this after persist when tenant has RAG config; best-effort (failure does not fail the request).

Responses for PUT/PATCH/DELETE include **`appliedInvalidations`** (array of `{ target, status: 'ok'|'failed', detail?: string }`, e.g. `{ target: 'tenantConfigCache', status: 'ok' }`, `{ target: 'rag_api', status: 'ok' }` or `{ target: 'rag_api', status: 'failed', detail: 'timeout' }`). All invalidation is centralized: **grep proof** — `api/server/routes/admin/tenants.js` calls only `onTenantConfigChanged`, `onTenantDeleted`, and `buildConfigDiff` from `TenantRuntimeInvalidationService`; there are no direct `clearCache`/`closeConnection`/`invalidateRagCache` calls in the router (they live in `api/server/services/Config/TenantRuntimeInvalidationService.js`).

---

## 6. No-brick semantics

- **Validation fails** → 400, nothing persisted.
- **Validation succeeds, persist succeeds** → 200. Cache invalidation runs **best-effort** after persist. If invalidation fails (e.g. rag_api unreachable), the API still returns 200 and includes `appliedInvalidations` with e.g. `{ target: 'rag_api', status: 'failed', detail: '...' }`. Log the failure; do not return 500 so clients are not confused.
- **Optimistic concurrency:** `If-Match: <configVersion>` (integer) or body `expectedVersion`. Mismatch → 409; no write. `configVersion` is incremented atomically via Mongo `$inc`.

---

## 7. Redaction and safe logging

- **Secrets:** GET/list redact secrets unless `?secrets=1`. Validation and connectivity error messages must **not** include full URIs with passwords; use masked/redacted form in logs and API responses.

---

## 8. Env reference

| Variable | Description |
|----------|-------------|
| `ADMIN_AUTH_SECRET` | Shared secret for `X-Admin-Auth`; min 16 chars. Required for admin API. |
| `ADMIN_ROLE_HEADER` | Role header name (default `X-LibreChat-Role`) |
| `ADMIN_AUTH_HEADER` | Auth header name (default `X-Admin-Auth`) |
| `ADMIN_ROLE_VALUE` | Value that means admin (default `ADMIN`) |
| `RAG_API_URL` | Base URL of rag_api (for cache invalidation call) |
| `RAG_INTERNAL_AUTH_SECRET` | Shared secret for rag_api `X-Internal-Auth` (min 16 chars). Must match rag_api env. |

---

## 9. Tenant Mongo isolation (supported options)

Same as in `TENANT_MONGO_ROUTING_PROOF.md`:

1. **Separate Mongo instance** — different host per tenant (`dbUri` points to different servers). **Supported.**
2. **Shared instance, separate DB** — same host, different DB name in `dbUri`. **Supported.**
3. **Shared instance, same DB, tenant-prefixed collections** — **Not supported / not planned.** Use per-tenant URI (1 or 2).

---

## 10. Tenant config shape (reference)

See **Tenant** schema in `packages/data-schemas/src/schema/tenant.ts`. Key fields:

- **Top-level:** `tenantId`, `name`, `dbUri`, `status`, `configVersion`, `config`.
- **config.mongodb:** (optional) not yet used; tenant Mongo URI is currently **top-level `dbUri`** (per-tenant; supports multi-instance).
- **config.rag:** `postgresUri`, `vectorDbType` (e.g. `pgvector`, `atlas-mongo`).
- **config.storage:** `provider` (`s3` | `local` | `firebase` | `azure_blob`), `bucket`/`container`/`basePath`, `prefix`.
- **config.bedrock:** `accessKeyId`, `secretAccessKey`, `region`, etc.
- **config.customEndpoints:** map of endpointId → `{ apiKey, baseURL, modelDefaults?, headers? }`.
- **Secrets** (redacted in GET unless `?secrets=1`): API keys, `bedrock`, `customEndpoints`, `googleServiceKeyFile`, etc.

---

## 11. Production operator workflow (tenant onboarding)

Proof-backed flow for onboarding a tenant with Google/Vertex raw JSON creds, storage, RAG, and dbUri.

### 11.1 What can be set today via `/api/admin/tenants`

| Item | How | Endpoint |
|------|-----|----------|
| **Tenant id + name** | `tenantId`, `name` | POST (create), PUT/PATCH (update) |
| **Tenant Mongo (conversations)** | `dbUri` | POST, PUT, PATCH |
| **Google / Vertex** | `config.googleServiceKeyFile` (raw JSON string, base64, or file path), `config.googleApiKey` (optional) | POST, PATCH (merge into config) |
| **Storage** | `config.storage`: `provider`, `bucket`/`container`/`basePath`, `prefix` | POST, PATCH |
| **RAG** | `config.rag`: `postgresUri`, `vectorDbType` | POST, PATCH |
| **Other providers** | `config.openAiApiKey`, `config.anthropicApiKey`, `config.bedrock`, `config.customEndpoints`, etc. | POST, PATCH |

- **Create:** `POST /api/admin/tenants` with body `{ tenantId, name?, dbUri, config? }`. Validation (schema + connectivity) runs first; on success, tenant is created and cache/invalidations applied.
- **Update:** `PATCH /api/admin/tenants/:tenantId` with partial body (e.g. `{ config: { googleServiceKeyFile: "..." } }`). Merged with existing config; connectivity re-validated; optimistic lock via `If-Match` or `expectedVersion`.
- **Validate without persisting:** `POST /api/admin/tenants/validate` (create shape), `POST /api/admin/tenants/:tenantId/validate` (update shape).

### 11.2 Recommended operator workflow (production)

1. **Run user identity migration** in the system Mongo (see `docs/MIGRATION_USER_IDENTITY_INDEXES.md`) before enabling same-email-across-tenants.
2. **Create tenant (minimal):**  
   `POST /api/admin/tenants` with `tenantId`, `dbUri` (tenant Mongo), and optional `name`. Optionally include `config.storage` and `config.rag` if ready.
3. **Add Google/Vertex creds:**  
   `PATCH /api/admin/tenants/:tenantId` with `config.googleServiceKeyFile` set to:
   - Raw JSON string (inline),
   - Or base64-encoded JSON,
   - Or a server-accessible file path (e.g. in container).  
   Use `If-Match: <configVersion>` from the last GET to avoid overwriting concurrent edits.
4. **Add storage/RAG if not set at create:**  
   `PATCH` with `config.storage` and/or `config.rag`. Connectivity is re-checked on each persist.
5. **Smoke test:** Call ext/v2 with `X-Tenant-ID`, `X-User-Email`, etc.; create a convo, upload a file, and (if RAG) use `tool_resource=file_search` and confirm tenant isolation.
6. **Secret rotation:** Same as step 3 — PATCH the tenant with new `config.googleServiceKeyFile` (or other secret). Cache invalidation runs on success; next request uses new creds. Do **not** use `?secrets=1` in production for listing/GET; use it only in secure debugging.

### 11.3 Live credential and identity behavior

- **Credential edits:** Stored in system Mongo `tenants.config`. On successful PATCH/PUT, `TenantConfigService` cache for that tenant is cleared and provider caches (e.g. Google client) are invalidated. Next request loads fresh config and uses new creds. No restart required.
- **Tenant identity (ext/v2):** Users are resolved/created in the **system** User collection with `tenantId` set from `X-Tenant-ID`. Same email in different tenants yields distinct users. Proven by `requireExtUserAuth.identity.spec.js` and `mt.extv2.e2e.spec.js`.

---

## 12. Secrets and logging (production safety)

- **Storing raw JSON (e.g. Google service account):** `config.googleServiceKeyFile` is stored as provided (string) in the tenant document in **system Mongo**. Ensure Mongo is encrypted at rest and access is restricted. Do not log or expose config in responses unless intentionally debugging with `?secrets=1`.
- **API responses:** GET and list endpoints **redact** all secret keys (see `SECRET_KEYS` in `api/server/routes/admin/tenants.js`) unless the client sends `?secrets=1`. In production, do **not** use `?secrets=1`; use it only in secure, controlled debugging.
- **Audit log:** `adminTenantAuditLog` logs only `tenantId`, `action`, `configVersionBefore`, `configVersionAfter`, `requestId`. It does **not** log request body or config content. So secrets are never written to the audit log.
- **Error logs:** Route handlers use `logger.error('[admin/tenants] ...', e)` with the Error object only, not `req.body`. Validation/connectivity errors return redacted messages (see `validateTenantConfigConnectivity.js`). No intentional logging of secret values.
- **Unintentional exposure:** The only way secrets appear in API output is if the client explicitly requests `?secrets=1`. Enforce that admin clients and runbooks never use that in production.

---

## 13. Admin surface vs ext/v2 (routing recommendation)

- **Control plane (`/api/admin/*`):**
  - Strictly for tenant and config **control plane** operations (create/update/delete tenants, rotate secrets, change dbUri/storage/rag config).
  - Must be protected by:
    - `X-Admin-Auth: <ADMIN_AUTH_SECRET>` and `X-LibreChat-Role: ADMIN` injected only by a trusted gateway.
    - Optional `ADMIN_REQUIRE_INTERNAL_HEADER` for extra hardening.
    - Network-level/IP-based restrictions so only internal networks or services can reach `/api/admin/*`.
  - **Recommended deployment shape:**
    - Either a separate **internal hostname** (e.g. `admin-api.internal`) or a dedicated internal Ingress class.
    - Gateway configuration that:
      - Strips any inbound `X-Admin-Auth` / `X-LibreChat-Role` from untrusted clients.
      - Injects the correct headers only after authenticating an admin user/session.

- **Data plane (`/ext/v2/*`):**
  - Primary tenant/user **data plane** for external integrations.
  - Uses trusted headers like `X-User-Email`, `X-Tenant-ID`, `X-User-ID` set by an upstream that has already authenticated the caller.
  - Must not be used to mutate control-plane config (no tenant create/update/delete).
  - Public/external exposure is acceptable **only** via a gateway that:
    - Validates and sets the ext/v2 headers.
    - Blocks or strips untrusted spoofed tenant/user headers.

**Recommendation:** Keep `/api/admin/*` and `/ext/v2/*` **separate** in routing and exposure:
- `/ext/v2/*` → external data plane behind your integration gateway.
- `/api/admin/*` → internal control plane, reachable only by your WebApp backend or internal tooling, never directly from browsers or third-party clients.
