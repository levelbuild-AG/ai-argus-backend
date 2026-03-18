const path = require('path');
const { getTenantLocalBasePath, getTenantLocalPrefix } = require('~/server/utils/getTenantStorageConfig');
const { logger } = require('@librechat/data-schemas');
const paths = require('~/config/paths');

/**
 * Centralized local storage path routing for tenant-aware operations
 * 
 * CLEAN-SLATE MULTI-TENANCY: No legacy fallbacks. Tenant routing is mandatory and deterministic.
 * 
 * Priority order:
 * 1. Tenant override (from TenantConfigService)
 * 2. System default (appConfig.paths.publicPath, appConfig.paths.uploads)
 * 3. Fail-hard if tenantId missing or basePath not configured
 * 
 * Physical separation:
 * - Per-tenant basePath (strongest) OR
 * - Shared basePath with per-tenant prefix (always enforced)
 * 
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED - no fallback)
 * @param {string} params.basePath - Base path (e.g., 'images', 'documents', 'uploads')
 * @param {string} params.userId - User ID
 * @param {string} params.fileName - File name
 * @param {Object} params.appConfig - App config (for system defaults)
 * @returns {Promise<{ fullPath: string, relativePath: string, baseDirectory: string }>} Paths with tenant routing applied
 * @throws {Error} If tenantId is missing or basePath not configured
 */
async function getTenantLocalPath({ tenantId, basePath, userId, fileName, appConfig }) {
  // Require tenantId - no fallback
  if (!tenantId) {
    throw new Error('Tenant ID is required for local storage operations. No legacy fallback supported.');
  }
  
  if (!appConfig || !appConfig.paths) {
    throw new Error('App config with paths is required for local storage operations.');
  }

  // Normalize and validate inputs to prevent path traversal
  const normalizedBasePath = basePath.replace(/[\/\\]/g, '').replace(/\.\./g, '');
  const normalizedUserId = userId.replace(/[\/\\]/g, '').replace(/\.\./g, '');
  const normalizedFileName = fileName.replace(/\.\./g, '').split('/').pop(); // Take only filename, not path
  
  if (!normalizedBasePath || !normalizedUserId || !normalizedFileName) {
    throw new Error(`Invalid local path components: basePath='${basePath}', userId='${userId}', fileName='${fileName}'`);
  }
  
  // Get tenant-specific basePath (falls back to system basePath if not configured)
  const systemBasePath = normalizedBasePath === 'images' 
    ? appConfig.paths.imageOutput || paths.publicPath
    : appConfig.paths.uploads || paths.uploads;
  
  const tenantBasePath = await getTenantLocalBasePath(tenantId, systemBasePath);
  
  if (!tenantBasePath) {
    throw new Error(
      `Local storage basePath not configured. Tenant '${tenantId}' has no storage.basePath configured and system paths are not set.`
    );
  }
  
  // Get tenant prefix (normalized with trailing /)
  const configuredPrefix = await getTenantLocalPrefix(tenantId);
  
  let tenantPrefix;
  if (configuredPrefix) {
    // Use configured prefix (already normalized in getTenantLocalPrefix)
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
  if (tenantPrefix.includes('..') || normalizedBasePath.includes('..') || normalizedUserId.includes('..') || normalizedFileName.includes('..')) {
    throw new Error(`Path traversal detected in tenant prefix or path components`);
  }
  
  // Construct directory path: tenantBasePath/tenantPrefix/basePath/userId
  const directoryPath = path.join(tenantBasePath, tenantPrefix, normalizedBasePath, normalizedUserId);
  
  // Construct full file path: directoryPath/fileName
  const fullPath = path.join(directoryPath, normalizedFileName);
  
  // Construct relative path: tenantPrefix/basePath/userId/fileName (for URL/filepath storage)
  const relativePath = path.posix.join('/', tenantPrefix, normalizedBasePath, normalizedUserId, normalizedFileName);
  
  return {
    fullPath,
    relativePath,
    baseDirectory: directoryPath,
  };
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
      `Tenant ID required for local storage operation '${operation}'. ` +
      `Ensure requireTenantContext middleware runs before this operation.`
    );
  }
}

module.exports = {
  getTenantLocalPath,
  requireTenantId,
};
