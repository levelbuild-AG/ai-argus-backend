const { getTenantContext } = require('~/server/middleware/tenantContext');
const { getTenantConnectionManager } = require('./TenantConnectionManager');
const { isMultiTenancyEnabled } = require('@librechat/api');

/**
 * Get tenant-scoped models for the current request's tenant
 * 
 * Uses tenant context from AsyncLocalStorage (set by middleware).
 * When multi-tenancy is disabled, returns system models (backward compatibility).
 * 
 * @returns {Promise<Object>} Tenant-scoped models (Conversation, Message, File, etc.)
 */
async function getTenantModels() {
  // If multi-tenancy is disabled, return system models (backward compatibility)
  if (!isMultiTenancyEnabled()) {
    const { createModels } = require('@librechat/data-schemas');
    const mongoose = require('mongoose');
    return createModels(mongoose);
  }

  const tenantContext = getTenantContext();
  if (!tenantContext || !tenantContext.tenantId) {
    throw new Error('Tenant context not available. Ensure requireTenantContext middleware is applied.');
  }

  const manager = getTenantConnectionManager();
  return manager.getModels(tenantContext.tenantId);
}

/**
 * Get tenant's database connection for the current request's tenant.
 * Uses tenant context from AsyncLocalStorage. Throws if not available.
 *
 * @returns {Promise<mongoose.Connection>} Tenant's MongoDB connection
 */
async function getTenantDb() {
  const tenantContext = getTenantContext();
  if (!tenantContext || !tenantContext.tenantId) {
    throw new Error('Tenant context not available. Ensure requireTenantContext middleware is applied.');
  }

  const manager = getTenantConnectionManager();
  return manager.getTenantDb(tenantContext.tenantId);
}

/**
 * Get tenant configuration for the current request's tenant.
 * Uses tenant context from AsyncLocalStorage. Throws if not available.
 *
 * @returns {Promise<Object>} Tenant runtime configuration { settings, secrets }
 */
async function getTenantConfig() {
  const tenantContext = getTenantContext();
  if (!tenantContext || !tenantContext.tenantId) {
    throw new Error('Tenant context not available. Ensure requireTenantContext middleware is applied.');
  }

  const { getTenantConfigService } = require('~/server/services/Config/TenantConfigService');
  const service = getTenantConfigService();
  return service.getTenantConfig(tenantContext.tenantId);
}

/**
 * Get tenant ID from request context
 * 
 * @param {Express.Request} req - Express request object
 * @returns {string|null} Tenant ID or null if not available
 */
function getTenantIdFromReq(req) {
  if (!isMultiTenancyEnabled()) {
    return null;
  }
  
  const tenantContext = getTenantContext();
  return tenantContext?.tenantId || req.user?.tenantId || null;
}

/**
 * Get tenant configuration from request context.
 *
 * @param {Express.Request} req - Express request object
 * @returns {Promise<Object>} Tenant runtime configuration { settings, secrets }
 */
async function getTenantConfigFromReq(req) {
  const tenantId = getTenantIdFromReq(req);
  if (!tenantId) {
    throw new Error('Tenant ID not available in request context');
  }

  const { getTenantConfigService } = require('~/server/services/Config/TenantConfigService');
  const service = getTenantConfigService();
  return service.getTenantConfig(tenantId);
}

module.exports = {
  getTenantModels,
  getTenantDb,
  getTenantConfig,
  getTenantIdFromReq,
  getTenantConfigFromReq,
};
