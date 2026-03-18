const { requireTenantContext } = require('./tenantContext');

/**
 * Wrapper middleware for ext/v2 routes that ensures correct order:
 * 1. requireExtUserAuth runs first (inside route file, sets req.user)
 * 2. requireTenantContext runs second (validates tenant from req.user.tenantId)
 * 
 * This wrapper is applied AFTER requireExtUserAuth in route files.
 * Public routes (/health, /meta) bypass this entirely by not applying this middleware.
 */
function extV2RequireTenantContext(req, res, next) {
  // Handle public paths: /ext/v2/health and /ext/v2/meta don't require tenant context
  // These routes don't have requireExtUserAuth, so they bypass this middleware entirely
  // But if somehow they reach here, we check the path
  const fullPath = req.baseUrl + req.path;
  if (fullPath === '/ext/v2/health' || fullPath === '/ext/v2/meta') {
    return next();
  }

  // For all other ext/v2 routes, enforce tenant context
  return requireTenantContext(req, res, next);
}

module.exports = extV2RequireTenantContext;
