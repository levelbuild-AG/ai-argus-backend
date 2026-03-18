const { getTenantAzureContainer, getTenantAzurePrefix } = require('~/server/utils/getTenantStorageConfig');
const { logger } = require('@librechat/data-schemas');

const systemContainer = process.env.AZURE_CONTAINER_NAME || 'files';

/**
 * Centralized Azure Blob Storage container and blob name routing for tenant-aware operations
 * 
 * CLEAN-SLATE MULTI-TENANCY: No legacy fallbacks. Tenant routing is mandatory and deterministic.
 * 
 * Priority order:
 * 1. Tenant override (from TenantConfigService)
 * 2. System default (process.env.AZURE_CONTAINER_NAME or 'files')
 * 3. Fail-hard if tenantId missing or container not configured
 * 
 * Physical separation:
 * - Per-tenant container (strongest isolation) OR
 * - Shared container with per-tenant prefix (always enforced)
 * 
 * Note: Azure blob names are just strings (no directory structure), but we use `/` as a delimiter
 * for logical organization. The prefix ensures tenant isolation even in shared containers.
 * 
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED - no fallback)
 * @param {string} params.basePath - Base path (e.g., 'images', 'documents', 'uploads')
 * @param {string} params.userId - User ID
 * @param {string} params.fileName - File name
 * @returns {Promise<{ container: string, blobName: string }>} Container and blob name with tenant routing applied
 * @throws {Error} If tenantId is missing or container not configured
 */
async function getTenantAzureContainerAndBlobName({ tenantId, basePath, userId, fileName }) {
  // Require tenantId - no fallback
  if (!tenantId) {
    throw new Error('Tenant ID is required for Azure Blob Storage operations. No legacy fallback supported.');
  }
  
  // Get tenant-specific container (falls back to system container if not configured)
  const container = await getTenantAzureContainer(tenantId, systemContainer);
  
  if (!container) {
    throw new Error(
      `Azure container not configured. Tenant '${tenantId}' has no storage.container configured and AZURE_CONTAINER_NAME is not set.`
    );
  }
  
  // Normalize and validate inputs to prevent path traversal
  const normalizedBasePath = basePath.replace(/[\/\\]/g, '').replace(/\.\./g, '');
  const normalizedUserId = userId.replace(/[\/\\]/g, '').replace(/\.\./g, '');
  const normalizedFileName = fileName.replace(/\.\./g, '').split('/').pop(); // Take only filename, not path
  
  if (!normalizedBasePath || !normalizedUserId || !normalizedFileName) {
    throw new Error(`Invalid Azure blob name components: basePath='${basePath}', userId='${userId}', fileName='${fileName}'`);
  }
  
  // Build base blob name: basePath/userId/fileName
  const baseBlobName = `${normalizedBasePath}/${normalizedUserId}/${normalizedFileName}`;
  
  // Get tenant prefix (normalized with trailing /)
  const configuredPrefix = await getTenantAzurePrefix(tenantId);
  
  let tenantPrefix;
  if (configuredPrefix) {
    // Use configured prefix (already normalized in getTenantAzurePrefix)
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
  if (tenantPrefix.includes('..') || baseBlobName.includes('..')) {
    throw new Error(`Path traversal detected in tenant prefix or blob name: prefix='${tenantPrefix}', blobName='${baseBlobName}'`);
  }
  
  // Construct final blob name: tenantPrefix + baseBlobName
  const blobName = tenantPrefix + baseBlobName;
  
  return { container, blobName };
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
      `Tenant ID required for Azure Blob Storage operation '${operation}'. ` +
      `Ensure requireTenantContext middleware runs before this operation.`
    );
  }
}

module.exports = {
  getTenantAzureContainerAndBlobName,
  requireTenantId,
};
