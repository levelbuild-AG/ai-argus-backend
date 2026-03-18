/**
 * Helper utilities for making requests to rag_api with tenant context
 */

const { logger } = require('@librechat/data-schemas');

/**
 * Get headers for rag_api requests, including X-Tenant-ID (required in multi-tenant mode)
 * 
 * CRITICAL: In multi-tenant mode, tenantId is required. This function throws if missing.
 * 
 * Supports two patterns:
 * 1. Request-path: `getRagApiHeaders(req, additionalHeaders, callsite)` - extracts tenantId from req.tenantContext
 * 2. CRUD layer: `getRagApiHeaders({ tenantId }, additionalHeaders, callsite)` - uses explicit tenantId
 * 
 * @param {Object|Object} reqOrTenantId - Express request object OR object with { tenantId }
 * @param {Object} additionalHeaders - Additional headers to include
 * @param {string} [callsite] - Optional callsite identifier for error messages
 * @returns {Object} Headers object with X-Tenant-ID
 * @throws {Error} If tenantId is missing (multi-tenant mode always-on)
 */
function getRagApiHeaders(reqOrTenantId, additionalHeaders = {}, callsite = 'unknown') {
  const headers = {
    ...additionalHeaders,
  };

  // Extract tenant ID: support both req object and explicit { tenantId } object
  let tenantId;
  if (reqOrTenantId?.tenantContext?.tenantId) {
    // Pattern 1: Request-path usage (req object)
    tenantId = reqOrTenantId.tenantContext.tenantId;
  } else if (reqOrTenantId?.tenantId) {
    // Pattern 2: CRUD layer usage (explicit tenantId object)
    tenantId = reqOrTenantId.tenantId;
  } else {
    // Fallback: try direct string (for backward compatibility, but not recommended)
    tenantId = typeof reqOrTenantId === 'string' ? reqOrTenantId : null;
  }
  
  // Strict validation: reject empty, whitespace-only, or non-string values
  if (!tenantId || typeof tenantId !== 'string' || tenantId.trim() === '') {
    const error = new Error(
      `X-Tenant-ID header required for rag_api request (callsite: ${callsite}). ` +
      `Multi-tenancy is always-on; provide tenantId explicitly or ensure requireTenantContext middleware runs before this call. ` +
      `Received: ${tenantId === null || tenantId === undefined ? 'null/undefined' : `'${tenantId}'`}`
    );
    logger.error(`[ragApiClient] ${error.message}`);
    throw error;
  }
  
  // Normalize tenantId (trim whitespace)
  tenantId = tenantId.trim();

  headers['X-Tenant-ID'] = tenantId;
  return headers;
}

module.exports = { getRagApiHeaders };
