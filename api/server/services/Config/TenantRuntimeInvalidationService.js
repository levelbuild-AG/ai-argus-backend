/**
 * Central "tenant config changed" hook for Phase B runtime edits.
 * All invalidation after tenant create/update/delete goes through this service.
 * Returns appliedInvalidations: array of { target, status: 'ok'|'failed', detail?: string }.
 *
 * @param {string} tenantId - Tenant ID
 * @param {Object} diff - { dbUriChanged, configChanged: { rag, storage, openai, anthropic, google, bedrock, customEndpoints } }
 * @returns {Promise<Array<{ target: string, status: 'ok'|'failed', detail?: string }>>} appliedInvalidations
 */
const { logger } = require('@librechat/data-schemas');

function pushOk(applied, target, detail) {
  applied.push({ target, status: 'ok', ...(detail != null && { detail }) });
}
function pushFailed(applied, target, detail) {
  applied.push({ target, status: 'failed', ...(detail != null && { detail }) });
}
const { getTenantConfigService } = require('~/server/services/Config/TenantConfigService');
const { getTenantConnectionManager } = require('~/db/TenantConnectionManager');
const { invalidateRagCache } = require('~/server/utils/invalidateRagCache');
const { clearTenantOpenAIClientCache } = require('~/server/services/Endpoints/openAI/tenantClient');
const { clearTenantAnthropicClientCache } = require('~/server/services/Endpoints/anthropic/tenantClient');
const { clearTenantGoogleClientCache } = require('~/server/services/Endpoints/google/tenantClient');
const { invalidateTenantBedrockClient } = require('~/server/services/Endpoints/bedrock/tenantClient');
const { invalidateTenantCustomEndpointClient } = require('~/server/services/Endpoints/custom/tenantConfig');

/**
 * @param {string} tenantId
 * @param {{ dbUriChanged?: boolean, configChanged?: { rag?: boolean, storage?: boolean, openai?: boolean, anthropic?: boolean, google?: boolean, bedrock?: boolean, customEndpoints?: boolean } }} diff
 * @returns {Promise<Array<{ target: string, status: 'ok'|'failed', detail?: string }>>}
 */
async function onTenantConfigChanged(tenantId, diff = {}) {
  const applied = [];

  getTenantConfigService().clearCache(tenantId);
  pushOk(applied, 'tenantConfigCache');

  if (diff.dbUriChanged) {
    try {
      await getTenantConnectionManager().closeConnection(tenantId);
      pushOk(applied, 'tenantMongoConnection', 'closed');
    } catch (err) {
      logger.warn('[TenantRuntimeInvalidationService] closeConnection failed', { tenantId, error: err.message });
      pushFailed(applied, 'tenantMongoConnection', err.message);
    }
  }

  const cc = diff.configChanged || {};
  if (cc.openai) {
    try {
      clearTenantOpenAIClientCache(tenantId);
      pushOk(applied, 'openai');
    } catch (e) {
      pushFailed(applied, 'openai', e.message);
    }
  }
  if (cc.anthropic) {
    try {
      clearTenantAnthropicClientCache(tenantId);
      pushOk(applied, 'anthropic');
    } catch (e) {
      pushFailed(applied, 'anthropic', e.message);
    }
  }
  if (cc.google) {
    try {
      clearTenantGoogleClientCache(tenantId);
      pushOk(applied, 'google');
    } catch (e) {
      pushFailed(applied, 'google', e.message);
    }
  }
  if (cc.bedrock) {
    try {
      invalidateTenantBedrockClient(tenantId);
      pushOk(applied, 'bedrock');
    } catch (e) {
      pushFailed(applied, 'bedrock', e.message);
    }
  }
  if (cc.customEndpoints) {
    try {
      invalidateTenantCustomEndpointClient(tenantId);
      pushOk(applied, 'customEndpoints');
    } catch (e) {
      pushFailed(applied, 'customEndpoints', e.message);
    }
  }

  if (cc.rag) {
    const result = await invalidateRagCache(tenantId);
    if (result.ok) {
      pushOk(applied, 'rag_api');
    } else {
      pushFailed(applied, 'rag_api', result.error || 'error');
    }
  }

  if (cc.storage) {
    pushOk(applied, 'storage', 'no-cache');
  }

  return applied;
}

/**
 * Build diff from previous and next tenant doc (for PUT/PATCH).
 * @param {Object} previous - Lean tenant doc before update
 * @param {Object} next - Config after update (merged for PATCH)
 * @returns {{ dbUriChanged: boolean, configChanged: Object }}
 */
function buildConfigDiff(previous, next) {
  const dbUriChanged = previous.dbUri !== next.dbUri;
  const prevConfig = previous.config || {};
  const nextConfig = next.config || {};
  const configChanged = {
    rag: JSON.stringify(prevConfig.rag) !== JSON.stringify(nextConfig.rag),
    storage: JSON.stringify(prevConfig.storage) !== JSON.stringify(nextConfig.storage),
    openai: String(prevConfig.openAiApiKey) !== String(nextConfig.openAiApiKey),
    anthropic: String(prevConfig.anthropicApiKey) !== String(nextConfig.anthropicApiKey),
    google: String(prevConfig.googleApiKey) !== String(nextConfig.googleApiKey) || String(prevConfig.googleServiceKeyFile) !== String(nextConfig.googleServiceKeyFile),
    bedrock: JSON.stringify(prevConfig.bedrock || {}) !== JSON.stringify(nextConfig.bedrock || {}),
    customEndpoints: JSON.stringify(prevConfig.customEndpoints || {}) !== JSON.stringify(nextConfig.customEndpoints || {}),
  };
  return { dbUriChanged, configChanged };
}

/**
 * Invalidation for create (new tenant has no prior caches; only clear config so next getTenantConfig loads the new doc).
 */
function onTenantCreated(tenantId) {
  getTenantConfigService().clearCache(tenantId);
  return [{ target: 'tenantConfigCache', status: 'ok' }];
}

/**
 * Full invalidation for delete (all caches for this tenant).
 */
async function onTenantDeleted(tenantId) {
  const applied = [];
  getTenantConfigService().clearCache(tenantId);
  pushOk(applied, 'tenantConfigCache');
  try {
    await getTenantConnectionManager().closeConnection(tenantId);
    pushOk(applied, 'tenantMongoConnection', 'closed');
  } catch (err) {
    pushFailed(applied, 'tenantMongoConnection', err.message);
  }
  try { clearTenantOpenAIClientCache(tenantId); pushOk(applied, 'openai'); } catch (_) { pushFailed(applied, 'openai', _.message); }
  try { clearTenantAnthropicClientCache(tenantId); pushOk(applied, 'anthropic'); } catch (_) { pushFailed(applied, 'anthropic', _.message); }
  try { clearTenantGoogleClientCache(tenantId); pushOk(applied, 'google'); } catch (_) { pushFailed(applied, 'google', _.message); }
  try { invalidateTenantBedrockClient(tenantId); pushOk(applied, 'bedrock'); } catch (_) { pushFailed(applied, 'bedrock', _.message); }
  try { invalidateTenantCustomEndpointClient(tenantId); pushOk(applied, 'customEndpoints'); } catch (_) { pushFailed(applied, 'customEndpoints', _.message); }
  const ragResult = await invalidateRagCache(tenantId);
  if (ragResult.ok) pushOk(applied, 'rag_api'); else pushFailed(applied, 'rag_api', ragResult.error || 'error');
  pushOk(applied, 'storage', 'no-cache');
  return applied;
}

module.exports = {
  onTenantConfigChanged,
  onTenantCreated,
  onTenantDeleted,
  buildConfigDiff,
};
