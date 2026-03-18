/**
 * Get tenant-scoped models from request context.
 * Always uses tenant context (set by requireTenantContext). Throws if context not available.
 *
 * @param {Express.Request} req - Express request object (must have tenant context)
 * @returns {Promise<Object>} Tenant-scoped models (Conversation, Message, File, etc.)
 */
const { getTenantModels } = require('~/db/tenantHelpers');

async function getModelsFromReq(req) {
  return getTenantModels();
}

module.exports = getModelsFromReq;
