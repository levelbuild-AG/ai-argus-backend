const { logger } = require('@librechat/data-schemas');
const { EModelEndpoint, AuthKeys } = require('librechat-data-provider');
const { getGoogleConfig, loadServiceKey } = require('@librechat/api');
const { GoogleClient } = require('~/app');
const { getTenantConfigService } = require('~/server/services/Config/TenantConfigService');

/**
 * Tenant-aware Google client cache
 * Maps tenantId -> GoogleClient instance
 */
const clientCache = new Map();

/**
 * Load Google credentials from tenant config.
 * Always uses tenant config (no process.env).
 *
 * @param {string} tenantId - Tenant ID
 * @returns {Promise<Object>} Google credentials object
 * @throws {Error} If tenant secrets missing
 */
async function loadTenantGoogleCredentials(tenantId) {
  const service = getTenantConfigService();
  const tenantConfig = await service.getTenantConfig(tenantId);
  const secrets = tenantConfig.secrets;

  // Validate at least one Google secret is present
  if (!secrets.googleServiceKeyFile && !secrets.googleApiKey) {
    throw new Error(
      `Tenant '${tenantId}' has Google endpoint enabled but missing required secrets: googleServiceKeyFile or googleApiKey`,
    );
  }

  let serviceKey = {};
  if (secrets.googleServiceKeyFile) {
    try {
      serviceKey = await loadServiceKey(secrets.googleServiceKeyFile) || {};
    } catch (error) {
      logger.error(`[tenantClient] Failed to load Google service key for tenant '${tenantId}':`, error.message);
      throw new Error(`Failed to load Google service key for tenant '${tenantId}': ${error.message}`);
    }
  }

  return {
    [AuthKeys.GOOGLE_SERVICE_KEY]: serviceKey,
    [AuthKeys.GOOGLE_API_KEY]: secrets.googleApiKey,
  };
}

/**
 * Get or create Google client for a tenant
 * 
 * Caches clients per tenantId to avoid recreating on every request.
 * 
 * TODO (Phase B): When tenant configs can be updated at runtime, this cache must be invalidated
 * on config updates. Call clearTenantGoogleClientCache(tenantId) when tenant secrets change.
 * 
 * @param {string} tenantId - Tenant ID
 * @param {Object} clientOptions - Google client options
 * @returns {Promise<GoogleClient>} Google client instance
 */
async function getTenantGoogleClient(tenantId, clientOptions) {
  // Check cache first
  const cacheKey = `${tenantId}:${JSON.stringify(clientOptions)}`;
  if (clientCache.has(cacheKey)) {
    return clientCache.get(cacheKey);
  }

  // Load credentials from tenant config
  const credentials = await loadTenantGoogleCredentials(tenantId);

  // Create client
  const client = new GoogleClient(credentials, clientOptions);

  // Cache client (limit cache size to prevent memory leaks)
  // TODO (Phase B): Invalidate cache when tenant secrets are updated at runtime
  if (clientCache.size < 100) {
    clientCache.set(cacheKey, client);
  }

  return client;
}

/**
 * Clear tenant Google client cache
 * 
 * @param {string} [tenantId] - Optional tenant ID to clear specific tenant's clients, or clear all if omitted
 */
function clearTenantGoogleClientCache(tenantId) {
  if (tenantId) {
    // Clear all cached clients for this tenant
    for (const [key] of clientCache.entries()) {
      if (key.startsWith(`${tenantId}:`)) {
        clientCache.delete(key);
      }
    }
    logger.debug(`[tenantClient] Cleared Google client cache for tenant '${tenantId}'`);
  } else {
    clientCache.clear();
    logger.debug('[tenantClient] Cleared all Google client cache');
  }
}

module.exports = {
  loadTenantGoogleCredentials,
  getTenantGoogleClient,
  clearTenantGoogleClientCache,
};
