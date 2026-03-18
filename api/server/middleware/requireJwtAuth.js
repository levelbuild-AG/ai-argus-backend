const cookies = require('cookie');
const passport = require('passport');
const { isEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');

/**
 * Custom Middleware to handle JWT authentication, with support for OpenID token reuse
 * Switches between JWT and OpenID authentication based on cookies and environment settings
 */
const requireJwtAuth = (req, res, next) => {
  if (req.user) {
    return next();
  }
  if (process.env.MT_E2E_INTERNAL_ROUTES === '1') {
    logger.debug('[MT-IT][requireJwtAuth] enter', {
      path: req.originalUrl,
      hasAuthHeader: Boolean(req.headers.authorization),
    });
  }
  // Check if token provider is specified in cookies
  const cookieHeader = req.headers.cookie;
  const tokenProvider = cookieHeader ? cookies.parse(cookieHeader).token_provider : null;

  // Use OpenID authentication if token provider is OpenID and OPENID_REUSE_TOKENS is enabled
  if (tokenProvider === 'openid' && isEnabled(process.env.OPENID_REUSE_TOKENS)) {
    return passport.authenticate('openidJwt', { session: false }, (err, user) => {
      if (process.env.MT_E2E_INTERNAL_ROUTES === '1') {
        logger.debug('[MT-IT][requireJwtAuth] openid result', {
          path: req.originalUrl,
          err: err ? err.message : null,
          hasUser: Boolean(user),
        });
      }
      if (err || !user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      req.user = user;
      if (process.env.MT_E2E_INTERNAL_ROUTES === '1') {
        logger.debug('[MT-IT][requireJwtAuth] success', {
          path: req.originalUrl,
          userId: user?._id || user?.id || null,
          tenantId: user?.tenantId || null,
        });
      }
      return next();
    })(req, res, next);
  }

  // Default to standard JWT authentication
  return passport.authenticate('jwt', { session: false }, (err, user) => {
    if (process.env.MT_E2E_INTERNAL_ROUTES === '1') {
      logger.debug('[MT-IT][requireJwtAuth] jwt result', {
        path: req.originalUrl,
        err: err ? err.message : null,
        hasUser: Boolean(user),
      });
    }
    if (err || !user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = user;
    if (process.env.MT_E2E_INTERNAL_ROUTES === '1') {
      logger.debug('[MT-IT][requireJwtAuth] success', {
        path: req.originalUrl,
        userId: user?._id || user?.id || null,
        tenantId: user?.tenantId || null,
      });
    }
    return next();
  })(req, res, next);
};

module.exports = requireJwtAuth;
