const { logger } = require('@librechat/data-schemas');
const { SystemRoles } = require('librechat-data-provider');
const { findUser, createUser, updateUser } = require('~/models');
const { User } = require('~/db/models');

const REQUIRED_ID_HEADER = 'x-user-id';
const REQUIRED_EMAIL_HEADER = 'x-user-email';
const OPTIONAL_NAME_HEADER = 'x-user-name';

/** When x-user-id is missing, we use normalized email as external id (email-only auth). */
const normalizeEmail = (v) => (v == null ? '' : String(v).trim().toLowerCase());

const normalize = (user) => {
  if (!user) return null;
  if (user._id && !user.id && typeof user._id.toString === 'function') {
    user.id = user._id.toString();
  }
  return user;
};

const dedupeKeyError = (error) => Boolean(error) && (error.code === 11000 || error?.message?.includes('E11000'));

const isMongoId = (value = '') => /^[a-f0-9]{24}$/i.test(String(value).trim());

const buildUsername = (email, externalId, providedName) => {
  if (providedName && providedName.trim()) {
    return providedName.trim().slice(0, 64);
  }
  if (email && email.includes('@')) {
    return email.split('@')[0].slice(0, 64);
  }
  return externalId.slice(0, 64);
};

async function ensureUser({ externalId, email, name }) {
  let user = null;
  
  // Normalize both for comparison (email is already lowercase from normalizeEmail, but externalId might not be)
  const normalizedEmail = email.toLowerCase();
  const normalizedExternalId = String(externalId).toLowerCase().trim();
  
  // For email-only auth (when externalId equals email), prioritize finding oldest user by email
  // This ensures we always resolve to the same (oldest) account when multiple users share an email
  const isEmailOnlyAuth = normalizedExternalId === normalizedEmail;
  
  if (isEmailOnlyAuth && email) {
    // Find the oldest user with that email (sorted by createdAt ascending)
    // Use case-insensitive regex query to handle any casing in database
    const users = await User.find({ 
      email: { $regex: new RegExp(`^${normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
    })
      .sort({ createdAt: 1 }) // Sort by createdAt ascending (oldest first)
      .limit(1)
      .lean();
    user = users.length > 0 ? users[0] : null;
    
    if (user) {
      logger.info(`[requireExtUserAuth] Found user by email (email-only auth): ${user._id}, email: ${user.email}, createdAt: ${user.createdAt}, provider: ${user.provider || 'unknown'}`);
    } else {
      logger.info(`[requireExtUserAuth] No user found by email (email-only auth): ${normalizedEmail} - will create new user`);
    }
  } else {
    // For explicit externalId (not email), try platformUserId lookup first
    logger.info(`[requireExtUserAuth] Explicit externalId provided (not email-only): ${externalId}`);
    user = await findUser({ platformUserId: externalId });
    // If not found and email provided, fallback to oldest user by email (case-insensitive)
    if (!user && email) {
      const users = await User.find({ 
        email: { $regex: new RegExp(`^${normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
      })
        .sort({ createdAt: 1 })
        .limit(1)
        .lean();
      user = users.length > 0 ? users[0] : null;
      
      if (user) {
        logger.info(`[requireExtUserAuth] Found user by email (fallback): ${user._id}, email: ${user.email}, createdAt: ${user.createdAt}, provider: ${user.provider || 'unknown'}`);
      }
    }
  }

  if (user) {
    const updates = {};
    if (!user.platformUserId) {
      updates.platformUserId = externalId;
    }
    if (!user.role) {
      updates.role = SystemRoles.USER;
    }
    if (Object.keys(updates).length) {
      await updateUser(user._id?.toString() || user.id, updates);
      Object.assign(user, updates);
    }
    return normalize(user);
  }

  const username = buildUsername(email, externalId, name);
  logger.info(`[requireExtUserAuth] Creating new user - email: ${email}, externalId: ${externalId}, username: ${username}`);
  try {
    const created = await createUser(
      {
        username,
        email,
        emailVerified: true,
        provider: 'external_v2',
        platformUserId: externalId,
        role: SystemRoles.USER,
      },
      undefined,
      true,
      true,
    );
    logger.info(`[requireExtUserAuth] Created new user - id: ${created._id || created.id}, email: ${created.email}`);
    return normalize(created);
  } catch (error) {
    if (dedupeKeyError(error)) {
      logger.info(`[requireExtUserAuth] Duplicate key error, retrying lookup - email: ${email}, externalId: ${externalId}`);
      // Retry: for email-only auth, find oldest by email; otherwise try platformUserId first
      let retry = null;
      const normalizedEmail = email.toLowerCase();
      const normalizedExternalId = String(externalId).toLowerCase().trim();
      const isEmailOnlyAuth = normalizedExternalId === normalizedEmail;
      
      if (isEmailOnlyAuth && email) {
        // Email-only auth: find oldest user by email (case-insensitive)
        const users = await User.find({ 
          email: { $regex: new RegExp(`^${normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
        })
          .sort({ createdAt: 1 })
          .limit(1)
          .lean();
        retry = users.length > 0 ? users[0] : null;
        if (retry) {
          logger.info(`[requireExtUserAuth] Retry found user by email: ${retry._id}, email: ${retry.email}, createdAt: ${retry.createdAt}`);
        }
      } else {
        // Explicit externalId: try platformUserId first, then fallback to oldest by email (case-insensitive)
        retry = await findUser({ platformUserId: externalId });
        if (!retry && email) {
          const users = await User.find({ 
            email: { $regex: new RegExp(`^${normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
          })
            .sort({ createdAt: 1 })
            .limit(1)
            .lean();
          retry = users.length > 0 ? users[0] : null;
          if (retry) {
            logger.info(`[requireExtUserAuth] Retry found user by email (fallback): ${retry._id}, email: ${retry.email}`);
          }
        }
      }
      
      if (retry) {
        return normalize(retry);
      }
    }
    logger.error('[requireExtUserAuth] Failed to create user', error);
    throw error;
  }
}

async function requireExtUserAuth(req, res, next) {
  try {
    const rawId = req.headers?.[REQUIRED_ID_HEADER];
    const rawEmail = req.headers?.[REQUIRED_EMAIL_HEADER];
    const name = req.headers?.[OPTIONAL_NAME_HEADER];

    const email = normalizeEmail(rawEmail);
    if (!email || !email.includes('@')) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Missing required headers' });
    }

    // When x-user-id is missing, use normalized email as external id (email-only auth).
    const externalId = rawId != null && String(rawId).trim() !== ''
      ? String(rawId).trim()
      : email;

    logger.info(`[requireExtUserAuth] Auth request - email: ${email}, externalId: ${externalId}, hasXUserId: ${rawId != null && String(rawId).trim() !== ''}`);

    let user = null;

    // If header looks like a Mongo ObjectId, prefer direct lookup to respect existing ownership.
    if (isMongoId(externalId)) {
      user = await findUser({ _id: externalId });
      user = normalize(user);
    }

    if (!user) {
      user = await ensureUser({ externalId, email, name });
    }
    if (!user) {
      logger.warn(`[requireExtUserAuth] Unable to resolve user - email: ${email}, externalId: ${externalId}`);
      return res.status(401).json({ error: 'Unauthorized', message: 'Unable to resolve user' });
    }

    logger.info(`[requireExtUserAuth] Authenticated user - id: ${user._id || user.id}, email: ${user.email}, provider: ${user.provider || 'unknown'}`);
    req.user = user;
    return next();
  } catch (error) {
    logger.error('[requireExtUserAuth] Error', error);
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to authorize external user' });
  }
}

module.exports = requireExtUserAuth;
