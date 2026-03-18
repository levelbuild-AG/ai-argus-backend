const { getTenantFirebasePrefix } = require('~/server/utils/getTenantStorageConfig');
const { logger } = require('@librechat/data-schemas');

/**
 * Centralized Firebase Storage path routing for tenant-aware operations
 * 
 * CLEAN-SLATE MULTI-TENANCY: No legacy fallbacks. Tenant routing is mandatory and deterministic.
 * 
 * Priority order:
 * 1. Tenant override (from TenantConfigService)
 * 2. System default (no prefix)
 * 3. Fail-hard if tenantId missing
 * 
 * Physical separation:
 * - Shared Firebase Storage bucket with per-tenant prefix (always enforced)
 * - Prefix format: `tenant/${tenantId}/` (default) or configured prefix
 * 
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED - no fallback)
 * @param {string} params.basePath - Base path (e.g., 'images', 'documents', 'uploads')
 * @param {string} params.userId - User ID
 * @param {string} params.fileName - File name
 * @returns {Promise<string>} Firebase Storage path with tenant prefix applied
 * @throws {Error} If tenantId is missing or invalid
 */
async function getTenantFirebasePath({ tenantId, basePath, userId, fileName }) {
  // Require tenantId - no fallback
  if (!tenantId) {
    throw new Error('Tenant ID is required for Firebase Storage operations. No legacy fallback supported.');
  }
  
  // Normalize and validate inputs to prevent path traversal
  const normalizedBasePath = basePath.replace(/[\/\\]/g, '').replace(/\.\./g, '');
  const normalizedUserId = userId.replace(/[\/\\]/g, '').replace(/\.\./g, '');
  const normalizedFileName = fileName.replace(/\.\./g, '').split('/').pop(); // Take only filename, not path
  
  if (!normalizedBasePath || !normalizedUserId || !normalizedFileName) {
    throw new Error(`Invalid Firebase path components: basePath='${basePath}', userId='${userId}', fileName='${fileName}'`);
  }
  
  // Build base path: basePath/userId/fileName
  const baseStoragePath = `${normalizedBasePath}/${normalizedUserId}/${normalizedFileName}`;
  
  // Get tenant prefix (normalized with trailing /)
  const configuredPrefix = await getTenantFirebasePrefix(tenantId);
  
  let tenantPrefix;
  if (configuredPrefix) {
    // Use configured prefix (already normalized in getTenantFirebasePrefix)
    tenantPrefix = configuredPrefix;
  } else {
    // Default prefix: tenant/${tenantId}/
    tenantPrefix = `tenant/${tenantId}/`;
  }
  
  // Guardrail: Ensure prefix is not empty or root
  if (!tenantPrefix || tenantPrefix === '/' || tenantPrefix === '') {
    throw new Error(`Invalid tenant prefix for tenant '${tenantId}': prefix must be non-empty`);
  }
  
  // Guardrail: Reject path traversal attempts
  if (tenantPrefix.includes('..') || baseStoragePath.includes('..')) {
    throw new Error(`Path traversal detected in tenant prefix or path: prefix='${tenantPrefix}', path='${baseStoragePath}'`);
  }
  
  // Construct final Firebase Storage path: tenantPrefix + baseStoragePath
  const storagePath = tenantPrefix + baseStoragePath;
  
  return storagePath;
}

/**
 * Validate that tenant ID is present for tenant-scoped operations
 * 
 * @param {string|null} tenantId - Tenant ID
 * @param {string} operation - Operation name for error message
 * @throws {Error} If tenantId is missing
 */
function requireTenantId(tenantId, operation) {
  if (!tenantId) {
    throw new Error(
      `Tenant ID required for Firebase Storage operation '${operation}'. ` +
      `Ensure requireTenantContext middleware runs before this operation.`
    );
  }
}

module.exports = {
  getTenantFirebasePath,
  requireTenantId,
};
