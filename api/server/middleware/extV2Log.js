const { logger } = require('@librechat/data-schemas');

// Structured logging for ext/v2 passthrough routes; avoids logging bodies.
function extV2Log({ label = 'ext_v2', internal = '' } = {}) {
  return function extV2LogMiddleware(req, res, next) {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationNs = Number(process.hrtime.bigint() - start);
      const durationMs = Math.round(durationNs / 1_000_000);
      const correlationId =
        req.headers['x-request-id'] || req.headers['x-correlation-id'] || req.headers['cf-ray'];
      logger.info({
        label,
        internal,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ms: durationMs,
        correlationId,
      });
    });
    next();
  };
}

module.exports = { extV2Log };
