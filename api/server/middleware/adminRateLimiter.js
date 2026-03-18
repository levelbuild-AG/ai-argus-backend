/**
 * In-memory rate limiter for /api/admin/*.
 * Limits by IP (or X-Forwarded-For). Redis-backed limiter can be added later.
 */
const rateLimit = require('express-rate-limit');

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many admin requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.socket?.remoteAddress || 'unknown',
});

module.exports = adminLimiter;
