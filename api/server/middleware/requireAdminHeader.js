/**
 * Admin-only middleware: requires optional role header + shared secret.
 * Role must NOT be derived from LibreChat user records.
 * Only a trusted edge (e.g. WebApp/ext-v2 gateway) should inject these headers.
 *
 * Headers:
 * - X-LibreChat-Role: ADMIN (or X-Role: admin) — indicates admin
 * - X-Admin-Auth: <ADMIN_AUTH_SECRET> — proves request is from trusted upstream
 *
 * Uses constant-time comparison for secret (timing leak hardening).
 * If either is missing or invalid → 403.
 */
const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');

const ROLE_HEADER = process.env.ADMIN_ROLE_HEADER || 'X-LibreChat-Role';
const AUTH_HEADER = process.env.ADMIN_AUTH_HEADER || 'X-Admin-Auth';
const ADMIN_ROLE_VALUE = (process.env.ADMIN_ROLE_VALUE || 'ADMIN').toUpperCase();

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function requireAdminHeader(req, res, next) {
  const secret = process.env.ADMIN_AUTH_SECRET;
  if (!secret || secret.length < 16) {
    logger.warn('[requireAdminHeader] ADMIN_AUTH_SECRET not set or too short; admin routes disabled');
    return res.status(503).json({
      error: 'Admin API not configured',
      hint: 'Set a strong ADMIN_AUTH_SECRET in the API environment to enable /api/admin routes.',
    });
  }

  const role = req.get(ROLE_HEADER);
  const auth = req.get(AUTH_HEADER);

  if (!auth || !timingSafeEqual(auth, secret)) {
    return res.status(403).json({
      error: 'Forbidden',
      hint: 'Admin auth failed. Ensure X-Admin-Auth matches ADMIN_AUTH_SECRET configured in the API container.',
    });
  }
  if (!role || String(role).toUpperCase() !== ADMIN_ROLE_VALUE) {
    return res.status(403).json({
      error: 'Forbidden',
      hint: `Admin role required. Ensure ${ROLE_HEADER} is set to ${ADMIN_ROLE_VALUE} by a trusted proxy.`,
    });
  }

  // Optional: require a third header (e.g. X-Internal-Request: 1) for extra hardening
  const internalHeader = process.env.ADMIN_REQUIRE_INTERNAL_HEADER;
  if (internalHeader) {
    const value = req.get(internalHeader);
    if (!value || value.trim() === '') {
      return res.status(403).json({ error: 'Forbidden: internal request header required' });
    }
  }

  next();
}

module.exports = requireAdminHeader;
