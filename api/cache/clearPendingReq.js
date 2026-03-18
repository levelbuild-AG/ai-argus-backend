const { isEnabled } = require('@librechat/api');
const { Time, CacheKeys } = require('librechat-data-provider');
const getLogStores = require('./getLogStores');
const { requireTenantRedisPrefix } = require('./tenantRedisKey');

const { USE_REDIS, LIMIT_CONCURRENT_MESSAGES } = process.env ?? {};

/**
 * Clear or decrement pending requests from the cache (tenant-scoped).
 * Requires tenantId; throws if missing. Callers must pass explicit tenantId from req.tenantContext.tenantId.
 *
 * @module clearPendingReq
 * @param {Object} params - The parameters object.
 * @param {string} params.userId - The user ID for which the pending requests are to be cleared or decremented.
 * @param {string} params.tenantId - Tenant ID (required for tenant-scoped key; from req.tenantContext.tenantId).
 * @param {Object} [params.cache] - An optional cache object to use. If not provided, a default cache will be fetched using getLogStores.
 */
const clearPendingReq = async ({ userId, tenantId, cache: _cache }) => {
  if (!userId) {
    return;
  } else if (!isEnabled(LIMIT_CONCURRENT_MESSAGES)) {
    return;
  }

  const namespace = CacheKeys.PENDING_REQ;
  const cache = _cache ?? getLogStores(namespace);

  if (!cache) {
    return;
  }

  const prefix = requireTenantRedisPrefix(tenantId, 'clearPendingReq');
  const key = `${prefix}${isEnabled(USE_REDIS) ? namespace : ''}:${userId ?? ''}`;
  const currentReq = +((await cache.get(key)) ?? 0);

  if (currentReq && currentReq >= 1) {
    await cache.set(key, currentReq - 1, Time.ONE_MINUTE);
  } else {
    await cache.delete(key);
  }
};

module.exports = clearPendingReq;
