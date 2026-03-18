/**
 * Internal admin routes for MT E2E tests only.
 * Mounted only when MT_E2E_INTERNAL_ROUTES=1 (set in docker-compose.mt-it.yml). Otherwise not mounted (404).
 * MT_IT_LIVE is a Jest/test-runner convention only; do not use as server-side gate.
 * Used to set Redis keys with exact format so tests can assert deterministically without
 * calling /api/edit (which would require model/endpoint and could hit external providers).
 *
 * POST /api/admin/internal/mt-e2e/trigger-redis-keys
 * Body: { tenantId, userId, conversationId }
 * Sets: tenant key (convo_access authorized) and system key (violation count for same userId).
 * Returns: 204 No Content.
 */
const express = require('express');
const { ViolationTypes, Time } = require('librechat-data-provider');
const { isEnabled } = require('@librechat/api');
const getLogStores = require('~/cache/getLogStores');
const { requireTenantRedisPrefix, getSystemRedisPrefix } = require('~/cache/tenantRedisKey');

const router = express.Router();
const CONVO_ACCESS = ViolationTypes.CONVO_ACCESS;

function mtE2eGuard(req, res, next) {
  if (process.env.MT_E2E_INTERNAL_ROUTES === '1') {
    return next();
  }
  return res.status(404).end();
}

router.use(mtE2eGuard);

/**
 * Trigger tenant + system Redis keys with the same format as validateConvoAccess / logViolation.
 * USE_REDIS=true key format (from convoAccess.js and logViolation.js):
 * - Tenant: tenant:${tenantId}:convo_access:${userId}:${conversationId}
 * - System: system:convo_access:${userId}
 */
router.post('/trigger-redis-keys', async (req, res) => {
  try {
    const { tenantId, userId, conversationId } = req.body || {};
    if (
      typeof tenantId !== 'string' ||
      typeof userId !== 'string' ||
      typeof conversationId !== 'string' ||
      tenantId.trim() === '' ||
      userId.trim() === '' ||
      conversationId.trim() === ''
    ) {
      return res.status(400).json({ error: 'tenantId, userId, conversationId required' });
    }

    const cache = getLogStores(CONVO_ACCESS);
    const violationLogs = getLogStores(CONVO_ACCESS);
    const logs = getLogStores(ViolationTypes.GENERAL);
    const systemPrefix = getSystemRedisPrefix();
    const tenantPrefix = requireTenantRedisPrefix(tenantId, 'mt-e2e-internal');

    const useRedis = isEnabled(process.env.USE_REDIS);
    const tenantKey = `${tenantPrefix}${useRedis ? CONVO_ACCESS : ''}:${userId}:${conversationId}`;
    const systemKey = systemPrefix + (useRedis ? `${CONVO_ACCESS}:${userId}` : userId);

    if (cache) {
      await cache.set(tenantKey, 'authorized', Time.TEN_MINUTES);
    }
    const current = (await violationLogs.get(systemKey)) ?? 0;
    await violationLogs.set(systemKey, +current + 1);
    const userLogs = (await logs.get(systemKey)) ?? [];
    userLogs.push({ type: CONVO_ACCESS, date: new Date().toISOString() });
    await logs.set(systemKey, userLogs);

    return res.status(200).json({
      written: [
        { key: tenantKey, value: 'authorized' },
        { key: systemKey, value: String(+current + 1) },
      ],
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
