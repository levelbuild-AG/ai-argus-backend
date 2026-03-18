/**
 * Audit log for admin tenant config actions. No secrets; tenantId, action, configVersion, requestId only.
 */
const { logger } = require('@librechat/data-schemas');

function auditLog(payload) {
  const { tenantId, action, configVersionBefore, configVersionAfter, requestId } = payload;
  logger.info('[admin/tenants audit]', {
    tenantId: tenantId ?? undefined,
    action,
    configVersionBefore: configVersionBefore ?? undefined,
    configVersionAfter: configVersionAfter ?? undefined,
    requestId: requestId ?? undefined,
  });
}

module.exports = { auditLog };
