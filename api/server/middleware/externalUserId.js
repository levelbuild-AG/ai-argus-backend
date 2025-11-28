const crypto = require('crypto');
const { URL } = require('url');
const { logger } = require('@librechat/data-schemas');
const { findUser, createUser } = require('~/models');

const QUERY_KEY = 'external_user_id';
const HEADER_KEY = 'x-user-id';
const COOKIE_KEY = 'lb_external_user_id';
const SYNTHETIC_EMAIL_DOMAIN = 'levelbuild-embedded.local';

const getCookieOptions = (req) => {
  const isSecure = Boolean(req?.secure || req?.headers?.['x-forwarded-proto'] === 'https');
  return {
    httpOnly: true,
    sameSite: isSecure ? 'None' : 'Lax',
    secure: isSecure,
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    path: '/',
  };
};

const sanitizeExternalId = (value) => {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value[0]?.trim() ?? '';
  }
  return value ? String(value).trim() : '';
};

const getRefererExternalId = (req) => {
  const refererHeader = req?.headers?.referer || req?.headers?.referrer;
  if (!refererHeader) {
    return '';
  }

  try {
    const parsed = new URL(refererHeader);
    if (req?.headers?.host && parsed.host !== req.headers.host) {
      return '';
    }
    return sanitizeExternalId(parsed.searchParams.get(QUERY_KEY));
  } catch (error) {
    return '';
  }
};

const slugify = (value) =>
  value
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);

const buildSyntheticIdentity = (externalUserId) => {
  const safeId = slugify(externalUserId) || 'user';
  const hash = crypto.createHash('sha256').update(externalUserId).digest('hex').slice(0, 12);
  const baseUsername = `lb-${safeId}-${hash}`;
  const username = baseUsername.slice(0, 30);
  const email = `${hash}@${SYNTHETIC_EMAIL_DOMAIN}`;
  return { username, email };
};

const normalizeUser = (user) => {
  if (!user) {
    return null;
  }

  if (user._id && !user.id && typeof user._id.toString === 'function') {
    user.id = user._id.toString();
  }

  return user;
};

const isDuplicateKeyError = (error) => {
  return Boolean(error) && (error.code === 11000 || error?.message?.includes('E11000'));
};

const createPlatformUser = async (externalUserId) => {
  const { username, email } = buildSyntheticIdentity(externalUserId);
  return createUser(
    {
      username,
      email,
      emailVerified: true,
      provider: 'platform',
      platformUserId: externalUserId,
    },
    undefined,
    true,
    true,
  );
};

const resolveExternalUser = async (externalUserId) => {
  const existing = await findUser({ platformUserId: externalUserId });
  if (existing) {
    return existing;
  }

  try {
    return await createPlatformUser(externalUserId);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return await findUser({ platformUserId: externalUserId });
    }
    throw error;
  }
};

const externalUserIdMiddleware = async (req, res, next) => {
  try {
    const queryValue = sanitizeExternalId(req.query?.[QUERY_KEY]);
    const headerValue = sanitizeExternalId(req.headers?.[HEADER_KEY]);
    const cookieValue = sanitizeExternalId(req.cookies?.[COOKIE_KEY]);
    const refererValue = getRefererExternalId(req);
    const externalUserId = queryValue || headerValue || cookieValue || refererValue;

    if (!externalUserId) {
      return next();
    }

    req.externalUserId = externalUserId;
    logger.info(`[externalUserIdMiddleware] matched ${externalUserId} on ${req.path}`);

    if ((queryValue || headerValue) && externalUserId !== cookieValue && typeof res?.cookie === 'function') {
      res.cookie(COOKIE_KEY, externalUserId, getCookieOptions(req));
    }

    if (req.user?.platformUserId === externalUserId) {
      return next();
    }

    const user = await resolveExternalUser(externalUserId);

    if (!user) {
      return next();
    }

    req.user = normalizeUser(user);

    return next();
  } catch (error) {
    logger.error('[externalUserIdMiddleware] Failed to resolve external user', error);
    return next(error);
  }
};

module.exports = externalUserIdMiddleware;
