const { EModelEndpoint } = require('librechat-data-provider');
const { getTenantConfigService } = require('~/server/services/Config/TenantConfigService');

/**
 * Load OpenAI credentials for a tenant (openAI endpoint only).
 * Always returns openAiApiKey from tenant config (no process.env).
 *
 * @param {string} tenantId - Tenant ID
 * @returns {Promise<{ openAiApiKey: string }>}
 * @throws {Error} If tenant openAiApiKey missing
 */
async function loadTenantOpenAICredentials(tenantId) {
  const service = getTenantConfigService();
  const tenantConfig = await service.getTenantConfig(tenantId);
  const openAiApiKey = tenantConfig.secrets?.openAiApiKey;

  if (openAiApiKey == null || openAiApiKey === '') {
    throw new Error(
      `Tenant '${tenantId}' has OpenAI endpoint enabled but missing required secret: openAiApiKey`,
    );
  }

  return { openAiApiKey };
}

/**
 * Clear any per-tenant OpenAI client cache (for Phase B config updates).
 * Currently no client cache in use; placeholder for consistency with Google.
 *
 * TODO (Phase B): When tenant configs can be updated at runtime, any per-tenant cached
 * OpenAI clients must be invalidated on config update. Call this when tenant secrets change.
 *
 * @param {string} [tenantId] - Optional tenant ID to clear, or clear all if omitted
 */
function clearTenantOpenAIClientCache(tenantId) {
  // No cache yet; document for Phase B
  if (tenantId) {
    // Future: clear cache for tenantId
  } else {
    // Future: clear all
  }
}

module.exports = {
  loadTenantOpenAICredentials,
  clearTenantOpenAIClientCache,
};
