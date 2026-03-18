# Pre-production validation checklist (ext/v2 MT rollout)

Use this on rollout day (or the day before) to confirm release gates, migrations, env, tenant creation, and smoke tests. Keep it crisp and operational.

---

## 0. Release gate tests (must be green before rollout)

- [ ] **ext/v2 MT E2E:** `mt.extv2.e2e.spec.js` — **14/14** (run against staging or target env; see `api/server/routes/__tests__/mt.extv2.e2e.spec.js`).  
- [ ] **Identity unit:** `requireExtUserAuth.identity.spec.js` — **3/3** (run: `npx jest server/middleware/requireExtUserAuth.identity.spec.js --runInBand --no-cache` from `api/`).  
- [ ] **Tenant config contract** (if using admin API in production): `tenantConfig.contract.e2e.spec.js` — green.  
- Do **not** proceed to production rollout if any of these are red.

---

## 1. Migrations

- [ ] **User identity indexes**  
  - Backup system Mongo (or at least `users` collection).  
  - Ensure `MONGO_URI` or `SYSTEM_MONGO_URI` is set (e.g. in `api/.env` or repo root `.env`).  
  - **Dry run** (from repo root):  
    `node api/server/services/migrations/migrateUserIdentityIndexes.js --dry-run`  
    Confirm logs show intended drops/creates and `Using connection string from: MONGO_URI` or `SYSTEM_MONGO_URI`.  
  - **Real run** (from repo root):  
    `node api/server/services/migrations/migrateUserIdentityIndexes.js`  
    Exit 0.  
  - **Verify:** Re-run with `--dry-run` and confirm both compound indexes “already exists”.  
  - See `docs/MIGRATION_USER_IDENTITY_INDEXES.md`.

---

## 2. Env requirements

- [ ] **API**  
  - `MULTI_TENANCY_ENABLED=true`  
  - `MONGO_URI` / `SYSTEM_MONGO_URI` → system Mongo (Users, Tenants).  
  - `ADMIN_AUTH_SECRET` set (min 16 chars); admin routes return 503 if missing/short.  
  - `RAG_API_URL` and `RAG_INTERNAL_AUTH_SECRET` if using RAG (must match rag_api).  
  - Any provider/env used by tenants (e.g. Google, storage) consistent with deployment.
- [ ] **rag_api** (if used)  
  - `RAG_INTERNAL_AUTH_SECRET` matches API.  
  - Postgres/vector DB reachable from rag_api.
- [ ] **Admin gateway**  
  - `/api/admin/*` only reachable via trusted proxy that injects `X-LibreChat-Role`, `X-Admin-Auth` (and optionally `X-Internal-Request` or IP allowlist).  
  - Public clients cannot send these headers (stripped at edge).

---

## 3. Tenant creation

- [ ] Create at least one tenant via `POST /api/admin/tenants` with:  
  - `tenantId`, `dbUri` (tenant Mongo), optional `name`.  
- [ ] Optional: set `config.storage`, `config.rag` if using files/RAG.  
- [ ] Optional: set `config.googleServiceKeyFile` (or other provider secrets) via `PATCH /api/admin/tenants/:tenantId`.  
- [ ] Confirm 201 (create) and 200 (PATCH); no 400/409.  
- [ ] Do **not** use `?secrets=1` in production when listing/GET tenants.

---

## 4. First-tenant smoke tests

- [ ] **Health:** `GET /ext/v2/health` → 200, `{ status: 'ok' }`.  
- [ ] **Identity + convo:**  
  - Request with headers: `X-User-Email`, `X-Tenant-ID` (= the created tenant), optional `X-User-ID`.  
  - `POST /ext/v2/convos/update` (or agents/chat) → success; convo lands in tenant Mongo only (check tenant DB).  
- [ ] **Storage:** `POST /ext/v2/files` (non-RAG) → file under correct bucket/prefix for that tenant.  
- [ ] **RAG (if configured):** `POST /ext/v2/files` with `tool_resource=file_search` → embeddings in tenant RAG DB only (check by `file_id` in pgvector).  
- [ ] **Search:** `GET /ext/v2/convos?search=...` → only that tenant’s convos.

---

## 5. Secret rotation smoke test

- [ ] **Rotate a tenant secret** (e.g. `config.googleServiceKeyFile` or another key) via `PATCH /api/admin/tenants/:tenantId` with `If-Match: <configVersion>`.  
- [ ] Confirm 200 and `appliedInvalidations` includes tenant config (and provider cache if applicable).  
- [ ] Next ext/v2 request that uses that provider succeeds with new creds (no restart).

---

## 6. Identity smoke test

- [ ] Same email, two tenants:  
  - Call ext/v2 with `X-User-Email: same@example.com`, `X-Tenant-ID: tenant-a` → user created/bound to tenant-a.  
  - Call ext/v2 with `X-User-Email: same@example.com`, `X-Tenant-ID: tenant-b` → distinct user for tenant-b.  
- [ ] No 403 “Tenant header does not match” when using the correct tenant for each user.

---

## 7. Rollback checks

- [ ] **Rollback plan documented:**  
  - Revert API to previous version (without same-email-across-tenants code) if needed.  
  - User index migration has no automatic rollback; reverting app may require manual index reversion if you must restore global unique email/platformUserId (see `docs/MIGRATION_USER_IDENTITY_INDEXES.md`).  
- [ ] **Tenant config:** No automated rollback of tenant documents. Backup system Mongo before migration; restore from backup only if necessary and with a clear procedure.

---

## 8. Sign-off

- [ ] Migrations run and verified.  
- [ ] Env and admin gateway confirmed.  
- [ ] At least one tenant created and smoke tests (convo, storage, optional RAG, identity) passed.  
- [ ] Secret rotation and identity smoke tests passed.  
- [ ] Rollback plan and backup location recorded.

**Date:** _______________  
**Environment:** _______________  
**Completed by:** _______________

---

**See also:** `docs/PACKAGE_4_DEPLOYMENT_PREP.md` for architecture, sizing, infra requirements, and final decision framing (what can be deployed now, what must stay disabled, what would be unsafe if ignored).
