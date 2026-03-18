const { AsyncLocalStorage } = require('async_hooks');
const { logger } = require('@librechat/data-schemas');
const { SystemRoles } = require('librechat-data-provider');
const { Tenant } = require('~/db/models');

/**
 * AsyncLocalStorage for tenant context propagation across async operations
 */
const tenantContextStorage = new AsyncLocalStorage();

/**
 * Get current tenant context from AsyncLocalStorage
 * @returns {Object|undefined} Current tenant context or undefined
 */
function getTenantContext() {
  return tenantContextStorage.getStore();
}

/**
 * Optional tenant context middleware (global, non-blocking)
 * 
 * Extracts tenant ID from req.user.tenantId if available.
 * Does not fail if tenant context cannot be established.
 * Used globally to set context when available, but doesn't block requests.
 * 
 * Mount order: After auth middleware, before tenant-scoped routes
 */
function optionalTenantContext(req, res, next) {
  let tenantId = req.user?.tenantId;

  // Break-glass override: X-Tenant-ID header allowed only for system admin (admin tooling only)
  if (!tenantId && req.user?.role === SystemRoles.ADMIN) {
    tenantId = req.headers['x-tenant-id'];
    if (tenantId) {
      logger.debug(`[optionalTenantContext] Admin override using X-Tenant-ID header: ${tenantId}`);
    }
  }

  if (tenantId) {
    const tenantContext = {
      tenantId,
      userId: req.user?.id,
      requestId: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    };

    tenantContextStorage.run(tenantContext, () => {
      req.tenantContext = tenantContext;
      next();
    });
  } else {
    // No tenant context available, but continue (for auth routes, health checks, etc.)
    next();
  }
}

/**
 * Required tenant context middleware (strict enforcement)
 * 
 * Enforces that tenant context must be present.
 * Validates tenant exists and is active.
 * Fails with 400/403 if tenant context cannot be established.
 * 
 * Mount order: On tenant-scoped routes only
 */
async function requireTenantContext(req, res, next) {
  if (process.env.MT_E2E_INTERNAL_ROUTES === '1') {
    logger.debug('[MT-IT][requireTenantContext] enter', {
      path: req.originalUrl,
      hasUser: Boolean(req.user),
      userId: req.user?._id || req.user?.id || null,
      userTenantId: req.user?.tenantId || null,
      headerTenantId: req.headers['x-tenant-id'] || null,
    });
  }
  let tenantId = req.user?.tenantId;
  const headerTenantId = req.headers['x-tenant-id'];

  // If user already has a tenantId and a different X-Tenant-ID is provided by a non-admin,
  // treat this as a spoof attempt and reject loudly.
  if (
    tenantId &&
    headerTenantId &&
    headerTenantId !== tenantId &&
    req.user?.role !== SystemRoles.ADMIN
  ) {
    logger.warn(
      `[requireTenantContext] Header tenant mismatch for user ${
        req.user?._id || req.user?.id || 'unknown'
      } (userTenantId=${tenantId}, headerTenantId=${headerTenantId})`,
    );
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Tenant header does not match user tenant',
    });
  }

  // Break-glass override: X-Tenant-ID header allowed only for system admin (admin tooling)
  if (!tenantId && headerTenantId && req.user?.role === SystemRoles.ADMIN) {
    tenantId = headerTenantId;
    logger.debug(
      `[requireTenantContext] Admin override using X-Tenant-ID header: ${tenantId} (role=${
        req.user?.role || 'none'
      })`,
    );
  }

  // If user has no tenantId, reject on tenant-scoped routes
  if (!tenantId) {
    const userId = req.user?._id || req.user?.id || 'unknown';
    const userTenantId = req.user?.tenantId || null;

    logger.warn(
      `[requireTenantContext] Missing tenantId for user ${userId} (userTenantId=${userTenantId ||
        'null'} headerTenantId=${headerTenantId || 'null'})`,
    );

    const base = {
      error: 'Tenant ID required',
      message: 'User must be assigned to a tenant to access this resource',
    };

    // In MT E2E stack, include debug payload so tests can assert precisely
    if (process.env.MT_E2E_INTERNAL_ROUTES === '1') {
      return res.status(400).json({
        ...base,
        debug: { userId, userTenantId, headerTenantId },
      });
    }

    return res.status(400).json(base);
  }

  // Validate tenant exists and is active
  try {
    const tenant = await Tenant.findOne({ tenantId, status: 'active' });
    if (!tenant) {
      logger.warn(`[requireTenantContext] Invalid or inactive tenant: ${tenantId}`);
      return res.status(403).json({
        error: 'Invalid tenant',
        message: `Tenant '${tenantId}' not found or inactive`,
      });
    }

    const tenantContext = {
      tenantId,
      userId: req.user?.id,
      requestId: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    };

    tenantContextStorage.run(tenantContext, () => {
      req.tenantContext = tenantContext;
      next();
    });
  } catch (error) {
    logger.error('[requireTenantContext] Error validating tenant:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to validate tenant',
    });
  }
}

module.exports = {
  optionalTenantContext,
  requireTenantContext,
  getTenantContext,
};
