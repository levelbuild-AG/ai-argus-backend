const { getTenantConfigService } = require('~/server/services/Config/TenantConfigService');
const { logger } = require('@librechat/data-schemas');

/**
 * Load Bedrock credentials for a tenant.
 * 
 * ALWAYS-ON MULTI-TENANCY: Multi-tenancy is the only supported mode. Bedrock credentials must come from tenant config only.
 * No process.env fallback. Fail-hard if tenantId or credentials missing.
 * 
 * @param {string} tenantId - Tenant ID (REQUIRED - no fallback)
 * @returns {Promise<{ accessKeyId: string, secretAccessKey: string, sessionToken?: string, region: string, endpointHost?: string, roleArn?: string }>}
 * @throws {Error} If tenantId missing or tenant Bedrock credentials missing
 */
async function loadTenantBedrockCredentials(tenantId) {
  // ALWAYS-ON: Require tenantId - no fallback
  if (!tenantId) {
    throw new Error(
      '[loadTenantBedrockCredentials] Tenant ID is required for Bedrock operations. ' +
      'Ensure requireTenantContext middleware runs before Bedrock endpoint calls.'
    );
  }

  const service = getTenantConfigService();
  const tenantConfig = await service.getTenantConfig(tenantId);
  const bedrockConfig = tenantConfig.secrets?.bedrock;

  if (!bedrockConfig) {
    throw new Error(
      `Tenant '${tenantId}' has Bedrock endpoint enabled but missing required secret: bedrock. ` +
      `Tenant config must include secrets.bedrock with accessKeyId, secretAccessKey, and region.`
    );
  }

  // Validate required fields
  const { accessKeyId, secretAccessKey, region } = bedrockConfig;
  
  if (!accessKeyId || accessKeyId.trim() === '') {
    throw new Error(
      `Tenant '${tenantId}' has Bedrock endpoint enabled but missing required secret: bedrock.accessKeyId`
    );
  }

  if (!secretAccessKey || secretAccessKey.trim() === '') {
    throw new Error(
      `Tenant '${tenantId}' has Bedrock endpoint enabled but missing required secret: bedrock.secretAccessKey`
    );
  }

  if (!region || region.trim() === '') {
    throw new Error(
      `Tenant '${tenantId}' has Bedrock endpoint enabled but missing required secret: bedrock.region`
    );
  }

  return {
    accessKeyId: accessKeyId.trim(),
    secretAccessKey: secretAccessKey.trim(),
    sessionToken: bedrockConfig.sessionToken?.trim() || undefined,
    region: region.trim(),
    endpointHost: bedrockConfig.endpointHost?.trim() || undefined,
    roleArn: bedrockConfig.roleArn?.trim() || undefined,
  };
}

/**
 * Invalidate per-tenant Bedrock client cache (for Phase B config updates).
 * Currently no client cache in use; placeholder for consistency with other providers.
 * 
 * TODO (Phase B): When tenant configs can be updated at runtime, any per-tenant cached
 * Bedrock clients must be invalidated on config update. Call this when tenant secrets change.
 * 
 * @param {string} [tenantId] - Optional tenant ID to clear, or clear all if omitted
 */
function invalidateTenantBedrockClient(tenantId) {
  if (tenantId) {
    // Future: clear cache for tenantId
    logger.debug(`[invalidateTenantBedrockClient] Cache invalidation requested for tenant '${tenantId}' (Phase B hook)`);
  } else {
    // Future: clear all
    logger.debug('[invalidateTenantBedrockClient] Cache invalidation requested for all tenants (Phase B hook)');
  }
}

module.exports = {
  loadTenantBedrockCredentials,
  invalidateTenantBedrockClient,
};
