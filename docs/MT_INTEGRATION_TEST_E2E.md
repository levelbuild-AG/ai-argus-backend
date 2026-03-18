# Multi-Tenancy E2E Integration Tests — Requirements and Hard Evidence

This document defines the **end-to-end routing tests** that prove multi-instance Mongo, RAG (Postgres), Meilisearch, Storage (Minio), and Redis all route correctly per tenant, and that **runtime config edits** change routing without restart.

---

## 1. Test scope

| Area | What is proven | Hard evidence |
|------|----------------|---------------|
| **Mongo** | Tenant A writes land in tenant-mongo-a only; tenant B in tenant-mongo-b. | Direct connection to each mongod: list collections / count documents; assert doc exists in correct host only. |
| **RAG (Postgres)** | Vectors for tenant A in pg-a; tenant B in pg-b. | SQL: `SELECT COUNT(*) FROM langchain_pg_embedding` (or equivalent) per DB; show file_id / metadata matches ingested file. |
| **Meilisearch** | Index separation by tenant (`convos_${tenantId}`). Tenant B search does not return tenant A data. | Search API + optional direct Meili index list; assert no cross-tenant results. |
| **Storage (Minio)** | Object keys include tenant prefix; per-tenant buckets or prefixes respected. | Minio/S3 `listObjectsV2`; assert key prefix `tenant/${tenantId}/` (or configured prefix). |
| **Redis** | Tenant keys use `tenant:${tenantId}:`; system keys use `system:`. | Redis `SCAN`; verify key prefixes. |
| **Runtime edit** | After PATCH tenant dbUri/postgresUri, next write lands in **new** destination without restart. | Same as above: direct DB/client checks after PATCH + write. |
| **Restart survival** | After restarting api (and optionally rag_api), routing unchanged; no bootstrap overwrite. | Restart containers; re-run one op per tenant; assert still correct. |

---

## 2. Test stack (docker-compose.mt-it.yml)

- **system-mongo** — System DB (users, tenants).
- **tenant-mongo-a** / **tenant-mongo-b** — Separate Mongo instances (different hosts).
- **pg-a** / **pg-b** — Postgres for RAG (tenant_a, tenant_b DBs or separate instances).
- **rag_api** — Wired to system-mongo; reads tenant RAG config; uses internal auth for cache invalidation.
- **meilisearch** — Index names `convos_${tenantId}`.
- **redis** — Tenant and system key prefixes.
- **minio** — Buckets `bucket-a`, `bucket-b` (or single bucket with tenant prefix); init via MC or entrypoint.
- **api** — LibreChat API; SYSTEM_MONGO_URI, RAG_API_URL, ADMIN_AUTH_SECRET, RAG_INTERNAL_AUTH_SECRET. Set **MT_E2E_INTERNAL_ROUTES=1** in this compose so the E2E-only internal route is mounted (not set in production).

---

## 3. Two tenants with truly different destinations

- **Tenant A:** `dbUri`: `mongodb://tenant-mongo-a:27017/tenantA_db`; `config.rag.postgresUri`: connection to pg-a; `config.storage`: minio bucket-a + prefix `tenantA/`.
- **Tenant B:** `dbUri`: `mongodb://tenant-mongo-b:27017/tenantB_db`; `config.rag.postgresUri`: pg-b; `config.storage`: bucket-b + prefix `tenantB/`.

**Requirement:** Use **different Mongo hosts** (two containers), not only different DB names, to prove multi-instance routing.

---

## 4. Mongo routing test (line refs + DB queries)

1. Create tenant A and B via admin API (different `dbUri` hosts).
2. Create test users in system DB with `tenantId: 'tenant-a'` and `tenantId: 'tenant-b'`; obtain JWT for each.
3. Perform tenant-scoped write: e.g. **create/update conversation** via `POST /api/convos/update` with corresponding JWT (and thus tenant context).
4. **Direct Mongo check:** Connect to `tenant-mongo-a` (e.g. `mongodb://localhost:27018` when mapped), list DB `tenantA_db`, collection `conversations` (or as per schema); assert document(s) exist for tenant A.
5. Connect to `tenant-mongo-b`; assert **no** conversation document that belongs to tenant A (and vice versa).

**Evidence:** Test output or log must show: collection name, DB name, host, and count per tenant DB.

---

## 5. RAG routing test (pg-a vs pg-b)

1. Ingest a small text file for **tenant A** via the same API path the app uses (e.g. RAG embed endpoint with `X-Tenant-ID: tenant-a` and JWT).
2. Query context/search for tenant A; assert expected snippet returned.
3. **Direct SQL:** Connect to **pg-a**, run `SELECT COUNT(*) FROM langchain_pg_embedding` (or equivalent table) WHERE metadata/file_id matches ingested file; assert count ≥ 1.
4. Connect to **pg-b**; assert count 0 for that file_id (tenant A data not in pg-b).
5. Repeat for tenant B: ingest for B, query for B, assert vectors in **pg-b** only.

**Evidence:** SQL query result (counts) printed or asserted in test.

---

## 6. Meilisearch tenant index test

1. Create conversation (or indexed entity) for tenant A with a **unique searchable term** (e.g. title or message).
2. Create conversation for tenant B with different content.
3. Search via app endpoint (or Meili wrapper) as **tenant A** for the unique term; assert only A’s result returned.
4. Search as **tenant B**; assert A’s result is **not** returned (index separation).
5. Optionally: query Meili API for index list; confirm `convos_tenant-a` and `convos_tenant-b` exist and documents in correct index.

**Evidence:** Search response and/or index listing in test output.

---

## 7. Storage routing test (Minio)

1. Upload a file for tenant A and tenant B via normal file endpoint (with tenant context / JWT).
2. Use Minio client or AWS SDK `listObjectsV2` against Minio.
3. Assert tenant A object key starts with `tenant/tenant-a/` (or configured prefix).
4. Assert tenant B object key starts with `tenant/tenant-b/` (or configured prefix).
5. If using per-tenant buckets, assert objects in bucket-a and bucket-b respectively.

**Evidence:** List of object keys (or log) showing prefix and bucket.

---

## 8. Redis namespacing test

1. Use the **E2E-only internal endpoint** to set Redis keys with the same format as production (`validateConvoAccess` / `logViolation`), so the test does not call `/api/edit/openAI` (which could hit external providers).
2. **Internal endpoint:** `POST /api/admin/internal/mt-e2e/trigger-redis-keys`  
   - **Availability:** Only when **MT_E2E_INTERNAL_ROUTES=1** (set in `docker-compose.mt-it.yml` for the api service). Otherwise the route is not mounted (404). **MT_IT_LIVE** is a Jest/test-runner convention only; it is not a server-side gate.  
   - **Body:** `{ tenantId, userId, conversationId }`.  
   - **Purpose:** Writes the exact tenant and system keys used by convo access/violation so E2E can assert deterministically.  
   - **Not mounted in production** (do not set MT_E2E_INTERNAL_ROUTES in normal compose/k8s).
3. With `USE_REDIS=true` (E2E compose), key format:  
   - Tenant: `tenant:${tenantId}:convo_access:${userId}:${conversationId}` (value: `authorized`).  
   - System: `system:convo_access:${userId}` (value: violation count, numeric).
4. Test calls the internal endpoint with admin headers, then asserts `redis.get(expectedTenantKey) === 'authorized'` and `redis.get(expectedSystemKey)` is a number.

**Evidence:** Exact key strings asserted; no dependency on edit route or external LLM.

---

## 9. Runtime config edit test

1. For tenant A: perform tenant-scoped write (e.g. create conversation); confirm it lands in tenant-mongo-a (and RAG in pg-a if applicable).
2. **PATCH** tenant A: set `dbUri` to a **different Mongo instance** (e.g. `mongodb://tenant-mongo-b:27017/tenantA_secondary`) so that tenant A’s next writes go to tenant-mongo-b.
3. Perform another tenant-scoped write for tenant A.
4. Assert the **second** write is in **tenant-mongo-b** (e.g. in `tenantA_secondary` DB on tenant-mongo-b), not in tenant-mongo-a.
5. For RAG: PATCH tenant A’s `config.rag.postgresUri` from pg-a to pg-b; ingest again for tenant A; assert new vectors in **pg-b** only (no restart).

**Evidence:** Direct DB/client checks before and after PATCH; document/vector counts per host/DB.

---

## 10. Restart-survival test

1. After creating tenants and performing tenant ops (Mongo + optionally RAG/Meili/Storage).
2. **Restart** `api` container (and optionally `rag_api`).
3. Re-run one operation per tenant (e.g. create convo or list convos).
4. Assert routing still correct (e.g. convo still in correct tenant Mongo; no reversion to default).

Validates: persistence (DB-backed tenant config); no bootstrap overwrite of tenant config.

---

## 11. Test split and CI

- **mt.admin.spec.js** — Unit tests only; no external stack. Always runs in CI. Tests: 403 without auth, 403 with wrong secret, optional schema validation.
- **mt.e2e.spec.js** — E2E routing tests. **Requires** stack (`MT_IT_LIVE=1` and API_URL). If `MT_IT_LIVE=1` is set but stack is not reachable, the suite **fails** (e.g. fail in `beforeAll` with clear message) so CI does not falsely pass.

---

## 12. Test split and dependency proof

- **mt.admin.spec.js** — Unit tests only (403 without auth, wrong secret). No stack. Always runs.
- **mt.e2e.spec.js** — E2E routing tests. Requires `MT_IT_LIVE=1` (Jest env) and stack. If `MT_IT_LIVE=1` and API is unreachable, **beforeAll** fails the suite (no silent skip).

**Where the test runs:** Jest is invoked from the **api** workspace (`api/package.json` script `"test": "cross-env NODE_ENV=test jest"`). The repo uses **npm workspaces** (root `package.json` has `"workspaces": ["api", "client", "packages/*"]`).

**E2E dependencies:** `pg`, `ioredis`, `@aws-sdk/client-s3`, `form-data`, `mongodb` driver, etc. are declared in **api/package.json** (dependencies and devDependencies). After **`npm ci`** at repo root, workspace dependencies are installed (devDependencies such as `pg` are hoisted to root `node_modules` or installed in `api/node_modules`). **Proof:** From repo root after `npm ci`, run: `node -e "require('pg'); console.log('pg ok')"` — it must print `pg ok`.

**Canonical E2E command from repo root:**  
`npm run test:mt-e2e`  
(This runs `npm --workspace api run test -- mt.e2e.spec.js`.)

Optional restart test: set `MT_IT_RESTART=1` and ensure `MT_IT_COMPOSE_FILE` points at repo-root `docker-compose.mt-it.yml`.

### Run E2E by environment

**PowerShell (Windows):**
```powershell
cd c:\Coding\ai-argus-backend
$env:MT_IT_LIVE="1"
$env:API_URL="http://localhost:3081"
$env:ADMIN_AUTH_SECRET="admin-auth-secret-min-16-chars"
npm run test:mt-e2e
```

**cmd.exe (Windows):**
```cmd
cd c:\Coding\ai-argus-backend
set MT_IT_LIVE=1
set API_URL=http://localhost:3081
set ADMIN_AUTH_SECRET=admin-auth-secret-min-16-chars
npm run test:mt-e2e
```

**Bash (WSL / Linux / macOS):**
```bash
cd /path/to/ai-argus-backend
export MT_IT_LIVE=1
export API_URL=http://localhost:3081
export ADMIN_AUTH_SECRET=admin-auth-secret-min-16-chars
npm run test:mt-e2e
```

## 13. Green run transcript

**Exact runbook:**

1. **Install dependencies (once):** From repo root: `npm ci`
2. **Start stack:** From repo root: `docker compose -f docker-compose.mt-it.yml up -d`
3. **Run E2E:** From repo root: `npm run test:mt-e2e` (with env vars set as above for your shell)

After implementation, a green run shows all e2e tests passing with hard evidence (Mongo/Postgres/Redis/Minio/Meili assertions) in the test output.

---

## 15. Diagnosing 403 on /api/admin/tenants (Admin Auth Drift)

If `mt.e2e.spec.js` fails with a message like:

> `Admin API returned 403; stack may be down or auth wrong`

the most likely cause is an **ADMIN_AUTH_SECRET mismatch** between the host environment and the `mt-it-api` container.

### 15.1 Inspect ADMIN_AUTH_SECRET in the running api container

Run this from the repo root after the stack is up:

**Bash (Git Bash / Linux / macOS)**

```bash
docker compose -f docker-compose.mt-it.yml exec -T api sh -lc 'echo "ADMIN_AUTH_SECRET=$ADMIN_AUTH_SECRET"'
```

**PowerShell (Windows)**

```powershell
docker compose -f docker-compose.mt-it.yml exec -T api sh -lc 'echo "ADMIN_AUTH_SECRET=$ADMIN_AUTH_SECRET"'
```

This prints the value of `ADMIN_AUTH_SECRET` **inside the container**. For MT-IT, `docker-compose.mt-it.yml` pins it to:

```text
ADMIN_AUTH_SECRET=admin-auth-secret-min-16-chars
```

### 15.2 Set host environment to match (per shell)

Once you know the container’s `ADMIN_AUTH_SECRET` value, set your host environment to the **same** value before running `npm run test:mt-e2e`.

**PowerShell (Windows)**

```powershell
cd c:\Coding\ai-argus-backend
$env:MT_IT_LIVE      = "1"
$env:API_URL         = "http://localhost:3081"
$env:ADMIN_AUTH_SECRET = "<value printed from container>"
npm run test:mt-e2e
```

**Git Bash / Linux / macOS**

```bash
cd /path/to/ai-argus-backend
export MT_IT_LIVE=1
export API_URL=http://localhost:3081
export ADMIN_AUTH_SECRET="<value printed from container>"
npm run test:mt-e2e
```

**Windows cmd.exe**

```bat
cd c:\Coding\ai-argus-backend
set MT_IT_LIVE=1
set API_URL=http://localhost:3081
set ADMIN_AUTH_SECRET=<value printed from container>
npm run test:mt-e2e
```

> Note: In **Git Bash** on Windows, use the `export` syntax shown above (do **not** use PowerShell-style `$env:` assignments inside bash).

### 13.1 Troubleshooting (Windows `npm ci` / EPERM)

If `npm ci` fails on Windows with `EPERM` (file in use) or similar:

1. Close all Node/VSCode/Cursor terminals using this repo; stop any dev servers (`npm run backend:dev`, etc.).
2. Ensure no antivirus is locking files in `node_modules` (add the repo folder as an exclusion if needed).
3. From **repo root**, run:
   - PowerShell: `rm -Recurse -Force node_modules; rm package-lock.json`  
     (or `git clean -xdf` to fully reset untracked files)
   - Then: `npm cache verify`
4. Retry: `npm ci` from repo root (not inside `api/`), so workspace devDependencies (including `cross-env`, `jest`, `pg`) are installed once at the top level.
5. As a last resort: reboot and rerun steps 1–4.

---

## 14. Axon / grep proof bundle

**Mount chain (internal E2E route):**  
`api/server/index.js` → `app.use('/api/admin', requireAdminHeader, adminRateLimiter, routes.admin)` → `api/server/routes/admin/index.js` → only when `MT_E2E_INTERNAL_ROUTES=== '1'`: `router.use('/internal/mt-e2e', internal)`. Internal router uses same `requireTenantRedisPrefix`, `getSystemRedisPrefix` as `convoAccess.js` / `logViolation.js`.

**Grep proof — internal route only behind MT_E2E_INTERNAL_ROUTES:**  
`api/server/routes/admin/index.js`: `if (process.env.MT_E2E_INTERNAL_ROUTES === '1')` before mounting internal.  
`api/server/routes/admin/internal.js`: `mtE2eGuard` checks only `MT_E2E_INTERNAL_ROUTES === '1'`.

**Storage key mapping:**  
- `/api/files` (message_file) → `processAgentFileUpload` → strategy `handleFileUpload` → `uploadFileToS3` → `getTenantS3BucketAndKey({ tenantId, basePath: 'uploads', userId, fileName: file_id__originalname })` → key = `tenantPrefix + basePath/userId/fileName`.  
- Response: `res.status(200).json({ message, ...result })` with `result` from `createFile` (lean doc: `file_id`, `filepath`, `filename`, …). `filepath` is the signed S3 URL; key can be derived with `extractKeyFromS3Url(filepath)` (path-style: pathname = `bucket/key`, so strip bucket prefix for ListObjects key).

**Invalidation chain:**  
PATCH/PUT in `api/server/routes/admin/tenants.js` → `onTenantConfigChanged(tenantId, buildConfigDiff(current, nextDoc))` → `TenantRuntimeInvalidationService.onTenantConfigChanged` returns `appliedInvalidations`: array of `{ target, status: 'ok'|'failed', detail?: string }`. RAG: `invalidateRagCache(tenantId)` → push `{ target: 'rag_api', status: 'ok' }` or `{ target: 'rag_api', status: 'failed', detail }`.
