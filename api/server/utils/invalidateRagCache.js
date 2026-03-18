/**
 * Call rag_api internal cache invalidation for a tenant.
 * Best-effort: log errors but do not throw (caller may include result in appliedInvalidations).
 *
 * @param {string} tenantId - Tenant ID to invalidate
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
const axios = require('axios');
const { logger } = require('@librechat/data-schemas');

const RAG_API_URL = process.env.RAG_API_URL;
const RAG_INTERNAL_AUTH_SECRET = process.env.RAG_INTERNAL_AUTH_SECRET;

async function invalidateRagCache(tenantId) {
  if (!RAG_API_URL || !RAG_INTERNAL_AUTH_SECRET || RAG_INTERNAL_AUTH_SECRET.length < 16) {
    logger.debug('[invalidateRagCache] Skipped: RAG_API_URL or RAG_INTERNAL_AUTH_SECRET not configured');
    return { ok: false, error: 'not_configured' };
  }
  const url = `${RAG_API_URL.replace(/\/$/, '')}/internal/cache/invalidate`;
  try {
    const res = await axios.post(
      url,
      { tenantId },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Auth': RAG_INTERNAL_AUTH_SECRET,
        },
        timeout: 10000,
        validateStatus: (status) => status < 500,
      },
    );
    if (res.status !== 200) {
      logger.warn(`[invalidateRagCache] rag_api returned ${res.status} for tenant ${tenantId}`);
      return { ok: false, error: res.data?.detail || `status ${res.status}` };
    }
    logger.debug(`[invalidateRagCache] Invalidated RAG cache for tenant ${tenantId}`);
    return { ok: true };
  } catch (err) {
    logger.warn(`[invalidateRagCache] Failed for tenant ${tenantId}:`, err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { invalidateRagCache };
