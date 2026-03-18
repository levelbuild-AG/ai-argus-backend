const { getTenantConfigService } = require('~/server/services/Config/TenantConfigService');

/**
 * Load Anthropic credentials for a tenant.
 * Always returns anthropicApiKey from tenant config (no process.env).
 *
 * @param {string} tenantId - Tenant ID
 * @returns {Promise<{ anthropicApiKey: string }>}
 * @throws {Error} If tenant anthropicApiKey missing
 */
async function loadTenantAnthropicCredentials(tenantId) {
  const service = getTenantConfigService();
  const tenantConfig = await service.getTenantConfig(tenantId);
  const anthropicApiKey = tenantConfig.secrets?.anthropicApiKey;

  if (anthropicApiKey == null || anthropicApiKey === '') {
    throw new Error(
      `Tenant '${tenantId}' has Anthropic endpoint enabled but missing required secret: anthropicApiKey`,
    );
  }

  return { anthropicApiKey };
}

/**
 * Clear any per-tenant Anthropic client cache (for Phase B config updates).
 * Currently no client cache in use; placeholder for consistency with Google/OpenAI.
 *
 * TODO (Phase B): When tenant configs can be updated at runtime, any per-tenant cached
 * Anthropic clients must be invalidated on config update. Call this when tenant secrets change.
 *
 * @param {string} [tenantId] - Optional tenant ID to clear, or clear all if omitted
 */
function clearTenantAnthropicClientCache(tenantId) {
  if (tenantId) {
    // Future: clear cache for tenantId
  } else {
    // Future: clear all
  }
}

module.exports = {
  loadTenantAnthropicCredentials,
  clearTenantAnthropicClientCache,
};
