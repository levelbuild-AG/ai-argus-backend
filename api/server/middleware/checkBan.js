const { Keyv } = require('keyv');
const uap = require('ua-parser-js');
const { logger } = require('@librechat/data-schemas');
const { isEnabled, keyvMongo } = require('@librechat/api');
const { ViolationTypes } = require('librechat-data-provider');
const { removePorts } = require('~/server/utils');
const denyRequest = require('./denyRequest');
const { getLogStores } = require('~/cache');
const { getSystemRedisPrefix } = require('~/cache/tenantRedisKey');
const { findUser } = require('~/models');

const banCache = new Keyv({ store: keyvMongo, namespace: ViolationTypes.BAN, ttl: 0 });
const message = 'Your account has been temporarily banned due to violations of our service.';

// Dev-only ban bypass flag. Default is false; when explicitly set to "true" in
// local/dev, we skip ban enforcement but keep all other middleware behavior.
const DEV_DISABLE_BAN_CHECK = process.env.DEV_DISABLE_BAN_CHECK === 'true';
let devBypassWarned = false;

/**
 * Respond to the request if the user is banned.
 *
 * @async
 * @function
 * @param {Object} req - Express Request object.
 * @param {Object} res - Express Response object.
 *
 * @returns {Promise<Object>} - Returns a Promise which when resolved sends a response status of 403 with a specific message if request is not of api/ask or api/edit types. If it is, calls `denyRequest()` function.
 */
const banResponse = async (req, res) => {
  const ua = uap(req.headers['user-agent']);
  const { baseUrl } = req;
  if (!ua.browser.name) {
    return res.status(403).json({ message });
  } else if (baseUrl === '/api/ask' || baseUrl === '/api/edit') {
    return await denyRequest(req, res, { type: ViolationTypes.BAN });
  }

  return res.status(403).json({ message });
};

/**
 * Checks if the source IP or user is banned or not.
 *
 * @async
 * @function
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @param {import('express').NextFunction} next - Next middleware function.
 *
 * @returns {Promise<function|Object>} - Returns a Promise which when resolved calls next middleware if user or source IP is not banned. Otherwise calls `banResponse()` and sets ban details in `banCache`.
 */
const checkBan = async (req, res, next = () => {}) => {
  try {
    const { BAN_VIOLATIONS } = process.env ?? {};

    // Dev-only ban bypass for local/dev canonical stack.
    if (DEV_DISABLE_BAN_CHECK) {
      if (!devBypassWarned) {
        logger.warn(
          '[checkBan] DEV_DISABLE_BAN_CHECK=true – ban enforcement is DISABLED for this process (dev-only).',
        );
        devBypassWarned = true;
      }
      return next();
    }

    // In MT E2E stack, skip ban checks entirely to avoid test flakiness.
    if (process.env.MT_E2E_INTERNAL_ROUTES === '1') {
      return next();
    }

    if (!isEnabled(BAN_VIOLATIONS)) {
      return next();
    }

    req.ip = removePorts(req);
    let userId = req.user?.id ?? req.user?._id ?? null;

    if (!userId && req?.body?.email) {
      const user = await findUser({ email: req.body.email }, '_id');
      userId = user?._id ? user._id.toString() : userId;
    }

    if (!userId && !req.ip) {
      return next();
    }

    let cachedIPBan;
    let cachedUserBan;

    const systemPrefix = getSystemRedisPrefix();
    let ipKey = '';
    let userKey = '';

    if (req.ip) {
      ipKey = systemPrefix + (isEnabled(process.env.USE_REDIS) ? `ban_cache:ip:${req.ip}` : req.ip);
      cachedIPBan = await banCache.get(ipKey);
    }

    if (userId) {
      userKey = systemPrefix + (isEnabled(process.env.USE_REDIS) ? `ban_cache:user:${userId}` : userId);
      cachedUserBan = await banCache.get(userKey);
    }

    const cachedBan = cachedIPBan || cachedUserBan;

    if (cachedBan) {
      req.banned = true;
      return await banResponse(req, res);
    }

    const banLogs = getLogStores(ViolationTypes.BAN);
    const duration = banLogs.opts.ttl;

    if (duration <= 0) {
      return next();
    }

    let ipBan;
    let userBan;

    if (req.ip) {
      ipBan = await banLogs.get(systemPrefix + req.ip);
    }

    if (userId) {
      userBan = await banLogs.get(systemPrefix + userId);
    }

    const isBanned = !!(ipBan || userBan);

    if (!isBanned) {
      return next();
    }

    const timeLeft = Number(isBanned.expiresAt) - Date.now();

    if (timeLeft <= 0 && ipKey) {
      await banLogs.delete(ipKey);
    }

    if (timeLeft <= 0 && userKey) {
      await banLogs.delete(userKey);
      return next();
    }

    if (ipKey) {
      banCache.set(ipKey, isBanned, timeLeft);
    }

    if (userKey) {
      banCache.set(userKey, isBanned, timeLeft);
    }

    req.banned = true;
    return await banResponse(req, res);
  } catch (error) {
    logger.error('Error in checkBan middleware:', error);
    return next(error);
  }
};

module.exports = checkBan;
