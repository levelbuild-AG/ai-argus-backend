# Multi-tenant integration test plan

Once tenant Mongo multi-instance routing is proven (see `TENANT_MONGO_ROUTING_PROOF.md`), these tests prove **routing**, **isolation**, and **runtime edits**.

---

## 1. Local test stack (docker-compose profile)

Minimum services for the integration-test profile:

| Service | Purpose |
|---------|---------|
| `system-mongo` | System DB (users, tenants collection) |
| `tenant-mongo-a` | Tenant A Mongo (separate mongod container) |
| `tenant-mongo-b` | Tenant B Mongo (separate mongod container) |
| `rag_api` | RAG service (reads tenant config from system Mongo) |
| `pg-a` | Postgres for tenant A RAG (or 1 Postgres with 2 DBs) |
| `pg-b` | Postgres for tenant B RAG |
| `meilisearch` | Search (index names `convos_${tenantId}`) |
| `redis` | Cache/session (tenant vs system key prefixes) |
| `minio` | S3-compatible storage + bucket(s) |
| `api` | LibreChat API (SYSTEM_MONGO_URI, RAG_API_URL, etc.) |

**Profile name:** e.g. `integration-test` or `mt-integration`. Run with:

```bash
docker compose --profile integration-test up -d
```

**Outline (compose snippet):**

```yaml
# Example outline - adapt to your compose file layout
services:
  system-mongo:
    image: mongo:7
    ports: ["27017:27017"]
    # ...

  tenant-mongo-a:
    image: mongo:7
    ports: ["27018:27017"]
    # ...

  tenant-mongo-b:
    image: mongo:7
    ports: ["27019:27017"]
    # ...

  pg-a:
    image: postgres:16
    environment: POSTGRES_DB: tenant_a
    # ...

  pg-b:
    image: postgres:16
    environment: POSTGRES_DB: tenant_b
    # ...

  meilisearch:
    image: getmeili/meilisearch:latest
    # ...

  redis:
    image: redis:7-alpine
    # ...

  minio:
    image: minio/minio
    command: server /data
    # create bucket(s) via init or MC

  rag_api:
    build: infra/rag_api
    environment:
      SYSTEM_MONGO_URI: mongodb://system-mongo:27017/LibreChat
      RAG_INTERNAL_AUTH_SECRET: ${RAG_INTERNAL_AUTH_SECRET}
    # ...

  api:
    build: .
    environment:
      SYSTEM_MONGO_URI: mongodb://system-mongo:27017/LibreChat
      RAG_API_URL: http://rag_api:8000
      RAG_INTERNAL_AUTH_SECRET: ${RAG_INTERNAL_AUTH_SECRET}
      ADMIN_AUTH_SECRET: ${ADMIN_AUTH_SECRET}
    depends_on: [system-mongo, rag_api]
    # ...
```

---

## 2. Test suite flow (Jest + supertest skeleton)

**Test file:** `api/server/routes/__tests__/mt.integration.spec.js` (or `api/__tests__/mt.integration.spec.js`).

### 2.1 Create tenant A/B via admin API

- Set headers: `X-LibreChat-Role: ADMIN`, `X-Admin-Auth: <ADMIN_AUTH_SECRET>`.
- Create tenant A with `dbUri` → `mongodb://tenant-mongo-a:27017/tenant_a` (or host per your compose).
- Create tenant B with `dbUri` → `mongodb://tenant-mongo-b:27017/tenant_b`.
- Set storage provider → minio with distinct prefixes (e.g. `tenant-a/`, `tenant-b/`).
- Assert 201 and response contains `tenantId`, `configVersion`.

### 2.2 Validate rejects invalid config

- POST `/api/admin/tenants/validate` or PATCH validate with invalid mongo URI (e.g. unreachable host).
- Assert 400 and validation/connectivity error; no tenant created/updated.

### 2.3 Persist + restart survival

- Create tenant via admin API.
- Restart API container (or re-init app in test harness).
- GET `/api/admin/tenants/:tenantId` with admin headers.
- Assert config unchanged and present (no overwrite from bootstrap).

### 2.4 Routing proof (Mongo)

- Create user A with `tenantId: 'tenant-a'`, user B with `tenantId: 'tenant-b'` (or use existing user/tenant association).
- Write data via tenant models (e.g. create conversation) for tenant A and tenant B.
- Connect **directly** to `tenant-mongo-a` and assert conversation (or relevant doc) exists for A.
- Connect to `tenant-mongo-b` and assert no document from tenant A (and vice versa).

### 2.5 Meili isolation

- Create conversations in tenant A and tenant B.
- Search (Meili) as tenant A; assert results only from A (index `convos_tenant-a`).
- Assert tenant B’s index (`convos_tenant-b`) does not contain A’s data.

### 2.6 RAG isolation

- Ingest a file in tenant A; run RAG query; assert it works.
- Assert tenant B cannot see A’s data (different Postgres or schema).
- Optionally: direct DB query to `pg-a` vs `pg-b` to confirm rows per tenant.

### 2.7 Storage isolation

- Upload same filename for tenant A and tenant B (e.g. `report.pdf`).
- Assert object keys include tenant prefix (e.g. `tenant-a/...` vs `tenant-b/...`) and do not collide.

### 2.8 Redis namespacing

- Hit endpoints that use tenant-scoped Redis keys (e.g. convo access, concurrent limiter).
- Assert keys include `tenant:${tenantId}:` (or your prefix).
- For system keys (e.g. ban/violation), assert `system:` prefix.

### 2.9 Runtime edit

- PATCH tenant A (e.g. change storage prefix or dbUri).
- Validate endpoint first; then apply PATCH.
- Assert 200 and `appliedInvalidations` includes expected entries.
- Perform an operation (e.g. upload or convo create) and confirm new routing is used without restart.
- If RAG config changed, assert rag_api cache invalidation was called (e.g. next RAG request uses new config).

---

## 3. Skeleton test file (structure only)

```javascript
// api/server/routes/__tests__/mt.integration.spec.js
const request = require('supertest');
const { app } = require('~/server'); // or get app from index

const ADMIN_HEADERS = {
  'X-LibreChat-Role': 'ADMIN',
  'X-Admin-Auth': process.env.ADMIN_AUTH_SECRET || 'test-admin-secret-min-16-chars',
};

describe('MT integration', () => {
  beforeAll(async () => {
    // ensure DBs and services are up; optional seed
  });

  describe('admin tenant API', () => {
    it('creates tenant A and B with distinct mongo URIs', async () => {
      // POST /api/admin/tenants x2
    });
    it('validate rejects invalid mongo URI', async () => {
      // POST /api/admin/tenants/validate with bad URI
    });
  });

  describe('persist and restart', () => {
    it('tenant config survives API restart', async () => {
      // create → restart (or reinit) → GET
    });
  });

  describe('routing proof', () => {
    it('tenant A data lands in tenant-mongo-a only', async () => {
      // write as tenant A, assert in mongo A, not in mongo B
    });
  });

  describe('Meili isolation', () => {
    it('search returns only tenant index data', async () => {
      // convos A/B, search A
    });
  });

  describe('RAG isolation', () => {
    it('tenant B cannot query tenant A RAG data', async () => {
      // ingest A, query as B
    });
  });

  describe('storage isolation', () => {
    it('same filename different tenant has distinct keys', async () => {
      // upload A and B same name, check keys
    });
  });

  describe('Redis namespacing', () => {
    it('tenant keys include tenant prefix', async () => {
      // trigger tenant redis key, assert prefix
    });
  });

  describe('runtime edit', () => {
    it('PATCH tenant applies invalidations and new routing without restart', async () => {
      // PATCH → check appliedInvalidations → operate → confirm new config
    });
  });
});
```

---

## 4. CI

- Run this suite in CI when `docker compose --profile integration-test` (or equivalent) is available.
- Env: `ADMIN_AUTH_SECRET`, `RAG_INTERNAL_AUTH_SECRET`, and any DB URIs for the test stack.
