# Package C (RAG-TENANT) — Implementation Summary

## Overview

Package C implements **tenant-specific Postgres routing for the vector store (RAG)**. Each tenant can now use its own Postgres database (internal Docker network or external managed) for vector embeddings, ensuring complete physical separation of RAG data.

## Implementation Date

Completed: 2026-02-16

## Architecture Decision

**Pattern 1 (Direct DB Read)**: `rag_api` reads tenant configuration directly from system MongoDB, avoiding HTTP roundtrips and M2M authentication complexity.

- **Tenant config location**: `tenant.config.rag.postgresUri` (infrastructure config, sensitive)
- **Connection routing**: Per-request resolution from tenant ID → Postgres URI
- **Pooling**: Per-tenant vector store instances cached in memory
- **Support**: Both internal (Docker network) and external (managed) Postgres hosts

## Changes Made

### 1. Tenant Schema Extension

**Modified**: `packages/data-schemas/src/schema/tenant.ts`

Added RAG configuration under `tenant.config.rag`:
```typescript
rag: {
  postgresUri: String,      // Tenant-specific Postgres connection string
  vectorDbType: String,     // Optional: 'pgvector' or 'atlas-mongo' (defaults to pgvector)
}
```

**Note**: This is infrastructure config (not a provider API key), but still sensitive and must be stored encrypted-at-rest.

### 2. API Side: X-Tenant-ID Header Forwarding

**Created**: `api/server/utils/ragApiClient.js`
- Helper function `getRagApiHeaders(req, additionalHeaders)` to add `X-Tenant-ID` header

**Modified**: All rag_api HTTP call sites:
- `api/app/clients/tools/util/ingestFiles.js` - Added tenantId parameter, uses headers helper
- `api/app/clients/tools/util/fileSearch.js` - Added tenantId parameter, uses headers helper
- `api/app/clients/tools/util/handleTools.js` - Passes tenantId to ingestFiles and fileSearch tools
- `api/server/services/Files/VectorDB/crud.js` - Uses `getRagApiHeaders` for delete/embed operations
- `packages/api/src/files/text.ts` - Uses `getRagApiHeaders` for text extraction
- `api/app/clients/prompts/createContextHandlers.js` - Uses `getRagApiHeaders` for context queries

**Key Behavior**:
- All rag_api calls include `X-Tenant-ID` header from `req.tenantContext.tenantId`
- No fallback if tenantId is missing (fail-fast)
- Tools receive tenantId from `handleTools` (which extracts from `req.tenantContext`)

### 3. rag_api: Tenant Configuration Service

**Created**: `infra/rag_api/app/services/tenant_config.py`

Direct MongoDB client for reading tenant RAG configuration:
- Connects to system MongoDB (via `SYSTEM_MONGO_URI` env var)
- Reads `tenant.config.rag.postgresUri` and `tenant.config.rag.vectorDbType`
- Returns `None` if tenant not found or RAG config not set
- Singleton pattern for connection reuse

**Environment Variable**:
- `SYSTEM_MONGO_URI`: Connection string to system MongoDB (where Tenant collection is stored)

### 4. rag_api: Tenant Vector Store Pool

**Created**: `infra/rag_api/app/services/tenant_vector_store_pool.py`

Per-tenant vector store pool manager:
- Caches vector store instances keyed by `tenantId`
- Resolves tenant → Postgres URI via `TenantConfigService`
- Creates vector store instances on-demand (lazy initialization)
- Supports `pgvector` (Postgres) and `atlas-mongo` (MongoDB Atlas) vector DB types
- Connection string conversion: `postgresql://` → `postgresql+psycopg2://` for langchain
- Per-tenant collection name: Uses same `COLLECTION_NAME` within each tenant's DB (no tenant prefix needed)

**Key Features**:
- Thread-safe (asyncio.Lock for concurrent access)
- Fail-hard if tenant has no RAG config
- Cache invalidation method (`invalidate_tenant`) for Phase B runtime updates

### 5. rag_api: Middleware Updates

**Modified**: `infra/rag_api/app/middleware.py`

- Extracts `X-Tenant-ID` header and stores in `request.state.tenant_id`
- **Fail-hard**: Returns 400 if `X-Tenant-ID` is missing (except `/health`, `/docs`, `/openapi.json`)
- Normalizes tenant ID to lowercase
- No fallback to global connection string

### 6. rag_api: Route Updates

**Created**: `infra/rag_api/app/utils/tenant_store.py`
- Helper function `get_tenant_vector_store(request)` to get tenant-specific vector store
- Extracts tenant_id from `request.state.tenant_id`
- Returns HTTPException with clear error if tenant has no RAG config

**Modified**: `infra/rag_api/app/routes/document_routes.py`

All routes now use tenant-specific vector stores:
- `GET /ids` - Uses tenant store
- `GET /documents` - Uses tenant store
- `DELETE /documents` - Uses tenant store
- `POST /query` - Uses tenant store
- `POST /query_multiple` - Uses tenant store
- `GET /documents/{id}/context` - Uses tenant store
- `POST /embed` - Uses tenant store (via `store_data_in_vector_db`)
- `POST /local/embed` - Uses tenant store (via `store_data_in_vector_db`)
- `POST /embed-upload` - Uses tenant store (via `store_data_in_vector_db`)

**Helper Function Updates**:
- `store_data_in_vector_db()` - Now requires `vector_store` parameter (tenant-specific)
- `_process_documents_async_pipeline()` - Already accepts `vector_store` parameter
- `_process_documents_batched_sync()` - Already accepts `vector_store` parameter
- `get_cached_query_embedding()` - Uses global `embeddings` (not tenant-specific, correct)

### 7. Cache Invalidation Hook (Phase B)

**Created**: `infra/rag_api/app/services/cache_invalidation.py`

Stub for runtime config updates:
- `invalidate_tenant_rag_cache(tenant_id)` - Invalidates cached vector store
- Call this when `tenant.config.rag.postgresUri` is updated at runtime
- Phase B implementation will call this automatically

## Tenant Isolation Guarantees

1. **Physical Separation**: Each tenant uses its own Postgres database
2. **No Cross-Tenant Leakage**: Vector store queries are scoped to tenant DB
3. **No Global Fallback**: Fail-hard if tenant has no RAG config (no `CONNECTION_STRING` fallback)
4. **Explicit Routing**: All requests require `X-Tenant-ID` header
5. **Deterministic**: Tenant → Postgres URI resolution is explicit and cached

## Configuration

### Tenant Configuration (MongoDB)

```javascript
{
  tenantId: "acme",
  config: {
    rag: {
      postgresUri: "postgresql://user:pass@postgres-acme:5432/vectordb",
      vectorDbType: "pgvector"  // Optional, defaults to "pgvector"
    }
  }
}
```

### rag_api Environment Variables

- `SYSTEM_MONGO_URI`: Connection string to system MongoDB (required)
- `COLLECTION_NAME`: Collection/table name within each tenant DB (defaults to "testcollection")
- `ATLAS_SEARCH_INDEX`: Search index name for Atlas MongoDB (if using atlas-mongo)

## Fail-Fast Behavior

1. **Missing X-Tenant-ID**: Returns 400 with clear error message
2. **Tenant Not Found**: Returns 400 "Tenant '{tenantId}' not found or not active"
3. **No RAG Config**: Returns 400 "Tenant '{tenantId}' has no RAG configuration. RAG features require tenant.config.rag.postgresUri to be set."
4. **Invalid Postgres URI**: Raises ValueError during vector store creation (returns 500)

## Backward Compatibility

- **Single-tenant mode**: Not supported - multi-tenancy is always-on
- **Legacy tenants**: Must have `tenant.config.rag.postgresUri` set to use RAG features
- **Health check**: `/health` endpoint exempt from tenant ID requirement

## Testing Checklist

- [ ] Two tenants with different Postgres URIs → embeddings stored in correct DBs
- [ ] Query same file_id in both tenants → only sees that tenant's embeddings
- [ ] Tenant without RAG config → fails with clear error (no silent fallback)
- [ ] Missing X-Tenant-ID header → returns 400
- [ ] Internal Postgres (Docker hostname) → works correctly
- [ ] External Postgres (managed DB) → works correctly
- [ ] Cache invalidation → vector store recreated after invalidation

## Files Created

### API Side
- `api/server/utils/ragApiClient.js` - Helper for X-Tenant-ID header

### rag_api Side
- `infra/rag_api/app/services/tenant_config.py` - MongoDB client for tenant config
- `infra/rag_api/app/services/tenant_vector_store_pool.py` - Per-tenant vector store pool
- `infra/rag_api/app/utils/tenant_store.py` - Route helper for getting tenant store
- `infra/rag_api/app/services/cache_invalidation.py` - Cache invalidation hook
- `api/server/services/RAG/PACKAGE_C_RAG_TENANT_SUMMARY.md` - This document

## Files Modified

### API Side
- `packages/data-schemas/src/schema/tenant.ts` - Added `rag.postgresUri` and `rag.vectorDbType`
- `api/app/clients/tools/util/ingestFiles.js` - Added tenantId parameter and header
- `api/app/clients/tools/util/fileSearch.js` - Added tenantId parameter and header
- `api/app/clients/tools/util/handleTools.js` - Passes tenantId to tools
- `api/server/services/Files/VectorDB/crud.js` - Uses `getRagApiHeaders`
- `packages/api/src/files/text.ts` - Uses `getRagApiHeaders`
- `api/app/clients/prompts/createContextHandlers.js` - Uses `getRagApiHeaders`

### rag_api Side
- `infra/rag_api/app/middleware.py` - Extracts X-Tenant-ID, fail-hard if missing
- `infra/rag_api/app/routes/document_routes.py` - All routes use tenant-specific stores

## Course Corrections Applied (2026-02-16)

### 1. Wording Updates
- ✅ Changed "Ready for production deployment" → "Ready for integration testing / staging"
- ✅ Added explicit note about remaining subsystems requiring tenant routing

### 2. Bounded Cache + Eviction
- ✅ Added `MAX_TENANT_VECTOR_STORES` env var (default: 200)
- ✅ Implemented LRU eviction (`_access_times` tracking)
- ✅ `_evict_oldest()` method removes least recently used tenant stores when cache is full

### 3. SYSTEM_MONGO_URI Verification
- ✅ Added `SYSTEM_MONGO_URI` and `SYSTEM_MONGO_DB` to `docker-compose.yml` rag_api service
- ✅ Confirmed `TenantConfigService` uses system MongoDB (not tenant DBs)
- ✅ Database name extraction prioritizes `SYSTEM_MONGO_DB` env var

### 4. TenantId Requirement Enforcement
- ✅ `getRagApiHeaders()` now throws if `tenantId` missing (fail-hard)
- ✅ Added callsite identifiers to all `getRagApiHeaders()` calls for debugging
- ✅ Error messages indicate which callsite attempted the call

### 5. Documentation Alignment
- ✅ Verification report updated with "ready for integration testing" wording
- ✅ Summary document updated with course corrections section

## Next Steps

After Package C:
- **Verification**: Run integration tests to verify tenant isolation
- **Monitoring**: Add metrics/logging for per-tenant vector store operations
- **Phase B**: Implement runtime config update endpoint that calls `invalidate_tenant_rag_cache`
- **Documentation**: Update deployment docs with `SYSTEM_MONGO_URI` requirement

## Critical Requirements Met

✅ **No global CONNECTION_STRING fallback** - Fail-hard if tenant has no RAG config  
✅ **Fail hard if tenant has no RAG config** - Clear error messages, no silent skipping  
✅ **Vector store pool keyed by tenantId** - Thread-safe caching per tenant  
✅ **Cache invalidation stub available** - `invalidate_tenant_rag_cache()` ready for Phase B  
✅ **No AsyncLocalStorage reliance** - Uses request.state.tenant_id (FastAPI pattern)  
✅ **Support internal and external Postgres** - No assumptions about host location  
✅ **Deterministic routing** - Explicit tenant → Postgres URI resolution  
