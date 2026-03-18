const { getTenantConfigService } = require('~/server/services/Config/TenantConfigService');
const { normalizeEndpointName } = require('librechat-data-provider');
const { logger } = require('@librechat/data-schemas');

/**
 * Get tenant-specific custom endpoint configuration.
 * 
 * ALWAYS-ON MULTI-TENANCY: Multi-tenancy is the only supported mode. Custom endpoint configs
 * must come from tenant config only. No process.env fallback. Fail-hard if tenantId missing.
 * 
 * @param {string} tenantId - Tenant ID (REQUIRED - no fallback)
 * @param {string} endpointId - Custom endpoint identifier (normalized endpoint name)
 * @returns {Promise<{ apiKey: string, baseURL: string, modelDefaults?: object, headers?: object } | null>}
 * @throws {Error} If tenantId missing
 */
async function getTenantCustomEndpointConfig(tenantId, endpointId) {
  // ALWAYS-ON: Require tenantId - no fallback
  if (!tenantId) {
    throw new Error(
      '[getTenantCustomEndpointConfig] Tenant ID is required for custom endpoint operations. ' +
      'Ensure requireTenantContext middleware runs before custom endpoint calls.'
    );
  }

  if (!endpointId) {
    throw new Error(
      '[getTenantCustomEndpointConfig] Endpoint ID is required.'
    );
  }

  const service = getTenantConfigService();
  const tenantConfig = await service.getTenantConfig(tenantId);
  
  // Custom endpoints: apiKey is in secrets, baseURL/headers/modelDefaults are in settings
  const customEndpointsSecrets = tenantConfig.secrets?.customEndpoints;
  const customEndpointsSettings = tenantConfig.settings?.customEndpoints;
  
  // Merge secrets and settings for lookup
  // Both must exist and have matching endpointIds
  if (!customEndpointsSecrets || !customEndpointsSettings || typeof customEndpointsSecrets !== 'object' || typeof customEndpointsSettings !== 'object') {
    return null;
  }
  
  const customEndpoints = Object.keys(customEndpointsSecrets).reduce((acc, endpointId) => {
    const secret = customEndpointsSecrets[endpointId];
    const setting = customEndpointsSettings[endpointId];
    if (secret && setting) {
      acc[endpointId] = {
        ...setting,
        apiKey: secret.apiKey,
      };
    }
    return acc;
  }, {});
  
  if (Object.keys(customEndpoints).length === 0) {
    return null;
  }

  // Normalize endpointId to match how it's stored
  const normalizedId = normalizeEndpointName(endpointId);
  const endpointConfig = customEndpoints[normalizedId];

  if (!endpointConfig) {
    return null;
  }

  // Strict runtime validation of shape (prevents malformed tenant config from causing silent drift)
  validateCustomEndpointConfigShape(tenantId, normalizedId, endpointConfig);

  const { apiKey, baseURL } = endpointConfig;

  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error(
      `Tenant '${tenantId}' has custom endpoint '${normalizedId}' configured but missing required field: apiKey`
    );
  }

  if (!baseURL || typeof baseURL !== 'string' || baseURL.trim() === '') {
    throw new Error(
      `Tenant '${tenantId}' has custom endpoint '${normalizedId}' configured but missing required field: baseURL`
    );
  }

  return {
    apiKey: apiKey.trim(),
    baseURL: baseURL.trim(),
    modelDefaults: endpointConfig.modelDefaults || undefined,
    headers: endpointConfig.headers || undefined,
  };
}

/**
 * Runtime validator for tenant custom endpoint config shape.
 * Requires baseURL; requires apiKey (no authless support for now).
 * Rejects unexpected types (e.g. headers must be object<string, string>).
 * @param {string} tenantId
 * @param {string} endpointId
 * @param {object} config
 * @throws {Error} If shape is invalid
 */
function validateCustomEndpointConfigShape(tenantId, endpointId, config) {
  if (!config || typeof config !== 'object') {
    throw new Error(
      `Tenant '${tenantId}' custom endpoint '${endpointId}' config must be an object`
    );
  }

  if (config.baseURL !== undefined && typeof config.baseURL !== 'string') {
    throw new Error(
      `Tenant '${tenantId}' custom endpoint '${endpointId}' baseURL must be a string`
    );
  }

  if (config.apiKey !== undefined && typeof config.apiKey !== 'string') {
    throw new Error(
      `Tenant '${tenantId}' custom endpoint '${endpointId}' apiKey must be a string`
    );
  }

  if (config.headers !== undefined) {
    if (typeof config.headers !== 'object' || config.headers === null || Array.isArray(config.headers)) {
      throw new Error(
        `Tenant '${tenantId}' custom endpoint '${endpointId}' headers must be a plain object`
      );
    }
    for (const [k, v] of Object.entries(config.headers)) {
      if (typeof k !== 'string' || typeof v !== 'string') {
        throw new Error(
          `Tenant '${tenantId}' custom endpoint '${endpointId}' headers must be object of string keys and string values`
        );
      }
    }
  }

  if (config.modelDefaults !== undefined && (typeof config.modelDefaults !== 'object' || config.modelDefaults === null || Array.isArray(config.modelDefaults))) {
    throw new Error(
      `Tenant '${tenantId}' custom endpoint '${endpointId}' modelDefaults must be a plain object`
    );
  }
}

/**
 * Invalidate per-tenant custom endpoint client cache (for Phase B config updates).
 * Currently no client cache in use; placeholder for consistency with other providers.
 * 
 * TODO (Phase B): When tenant configs can be updated at runtime, any per-tenant cached
 * custom endpoint clients must be invalidated on config update. Call this when tenant secrets change.
 * 
 * @param {string} [tenantId] - Optional tenant ID to clear, or clear all if omitted
 * @param {string} [endpointId] - Optional endpoint ID to clear specific endpoint, or all endpoints if omitted
 */
function invalidateTenantCustomEndpointClient(tenantId, endpointId) {
  if (tenantId && endpointId) {
    // Future: clear cache for specific tenant + endpoint
    logger.debug(
      `[invalidateTenantCustomEndpointClient] Cache invalidation requested for tenant '${tenantId}', endpoint '${endpointId}' (Phase B hook)`
    );
  } else if (tenantId) {
    // Future: clear cache for tenant
    logger.debug(
      `[invalidateTenantCustomEndpointClient] Cache invalidation requested for tenant '${tenantId}' (Phase B hook)`
    );
  } else {
    // Future: clear all
    logger.debug('[invalidateTenantCustomEndpointClient] Cache invalidation requested for all tenants (Phase B hook)');
  }
}

module.exports = {
  getTenantCustomEndpointConfig,
  invalidateTenantCustomEndpointClient,
};
