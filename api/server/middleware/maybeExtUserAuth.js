const { logger } = require('@librechat/data-schemas');
const { findUser } = require('~/models');

const OPTIONAL_ID_HEADER = 'x-user-id';

const normalize = (user) => {
  if (!user) return null;
  if (user._id && !user.id && typeof user._id.toString === 'function') {
    user.id = user._id.toString();
  }
  return user;
};

const isMongoId = (value = '') => /^[a-f0-9]{24}$/i.test(String(value).trim());

async function maybeExtUserAuth(req, res, next) {
  const externalId = req.headers?.[OPTIONAL_ID_HEADER];
  if (!externalId) {
    return next();
  }

  try {
    let user = null;
    const trimmed = String(externalId).trim();

    if (isMongoId(trimmed)) {
      user = await findUser({ _id: trimmed });
    }

    if (!user) {
      user = await findUser({ platformUserId: trimmed });
    }

    user = normalize(user);
    if (user) {
      req.user = user;
    }
    return next();
  } catch (error) {
    logger.error('[maybeExtUserAuth] Error', error);
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to authorize external user' });
  }
}

module.exports = maybeExtUserAuth;
