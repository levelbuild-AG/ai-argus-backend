const { getTenantS3Bucket, getTenantS3Prefix } = require('~/server/utils/getTenantStorageConfig');
const { logger } = require('@librechat/data-schemas');

const systemBucket = process.env.AWS_BUCKET_NAME;

/**
 * Centralized S3 bucket and key routing for tenant-aware operations
 * 
 * CLEAN-SLATE MULTI-TENANCY: No legacy fallbacks. Tenant routing is mandatory and deterministic.
 * 
 * Priority order:
 * 1. Tenant override (from TenantConfigService)
 * 2. System default (process.env.AWS_BUCKET_NAME)
 * 3. Fail-hard if tenantId missing or bucket not configured
 * 
 * Physical separation:
 * - Per-tenant bucket (strongest) OR
 * - Shared bucket with per-tenant prefix (always enforced)
 * 
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED - no fallback)
 * @param {string} params.basePath - Base path (e.g., 'images', 'documents')
 * @param {string} params.userId - User ID
 * @param {string} params.fileName - File name
 * @returns {Promise<{ bucket: string, key: string }>} Bucket and key with tenant routing applied
 * @throws {Error} If tenantId is missing or bucket not configured
 */
async function getTenantS3BucketAndKey({ tenantId, basePath, userId, fileName }) {
  // Require tenantId - no fallback
  if (!tenantId) {
    throw new Error('Tenant ID is required for S3 operations. No legacy fallback supported.');
  }
  
  // Get tenant-specific bucket (falls back to system bucket if not configured)
  const bucket = await getTenantS3Bucket(tenantId, systemBucket);
  
  if (!bucket) {
    throw new Error(
      `S3 bucket not configured. Tenant '${tenantId}' has no storage.bucket configured and AWS_BUCKET_NAME is not set.`
    );
  }

  // Normalize and validate inputs to prevent path traversal
  const normalizedBasePath = basePath.replace(/[\/\\]/g, '').replace(/\.\./g, '');
  const normalizedUserId = userId.replace(/[\/\\]/g, '').replace(/\.\./g, '');
  const normalizedFileName = fileName.replace(/\.\./g, '').split('/').pop(); // Take only filename, not path
  
  if (!normalizedBasePath || !normalizedUserId || !normalizedFileName) {
    throw new Error(`Invalid S3 key components: basePath='${basePath}', userId='${userId}', fileName='${fileName}'`);
  }
  
  // Build base key: basePath/userId/fileName
  const baseKey = `${normalizedBasePath}/${normalizedUserId}/${normalizedFileName}`;
  
  // Get tenant prefix (normalized with trailing /)
  const configuredPrefix = await getTenantS3Prefix(tenantId);
  
  let tenantPrefix;
  if (configuredPrefix) {
    // Use configured prefix (already normalized in getTenantS3Prefix)
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
  if (tenantPrefix.includes('..') || baseKey.includes('..')) {
    throw new Error(`Path traversal detected in tenant prefix or key: prefix='${tenantPrefix}', key='${baseKey}'`);
  }
  
  // Construct final key: tenantPrefix + baseKey
  const key = tenantPrefix + baseKey;
  
  return { bucket, key };
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
      `Tenant ID required for S3 operation '${operation}'. ` +
      `Ensure requireTenantContext middleware runs before this operation.`
    );
  }
}

module.exports = {
  getTenantS3BucketAndKey,
  requireTenantId,
};
