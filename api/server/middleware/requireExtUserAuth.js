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

async function ensureUser({ externalId, email, name, tenantId }) {
  let user = null;
  
  // Normalize both for comparison (email is already lowercase from normalizeEmail, but externalId might not be)
  const normalizedEmail = email.toLowerCase();
  const normalizedExternalId = String(externalId).toLowerCase().trim();
  
  // For email-only auth (when externalId equals email), prioritize finding oldest user by email
  // This ensures we always resolve to the same (oldest) account when multiple users share an email
  const isEmailOnlyAuth = normalizedExternalId === normalizedEmail;
  
  const emailQuery = {
    email: {
      $regex: new RegExp(`^${normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    },
  };

  // Helper: find by (tenantId, email) first; if none, fall back to legacy/unbound user by email
  const findUserByTenantAndEmail = async () => {
    if (!email) {
      return null;
    }

    if (tenantId) {
      // First, look for a user already bound to this tenant
      const scoped = await User.find({ tenantId, ...emailQuery })
        .sort({ createdAt: 1 })
        .limit(1)
        .lean();
      if (scoped.length > 0) {
        return scoped[0];
      }

      // Fallback: look for a legacy/unbound user with this email to upgrade on first bind
      const legacy = await User.find({
        tenantId: { $in: [null, '', 'legacy'] },
        ...emailQuery,
      })
        .sort({ createdAt: 1 })
        .limit(1)
        .lean();
      if (legacy.length > 0) {
        return legacy[0];
      }
      return null;
    }

    // No tenant context: preserve legacy behavior (global oldest-by-email)
    const global = await User.find(emailQuery).sort({ createdAt: 1 }).limit(1).lean();
    return global.length > 0 ? global[0] : null;
  };

  if (isEmailOnlyAuth && email) {
    user = await findUserByTenantAndEmail();

    if (user) {
      logger.info(
        `[requireExtUserAuth] Found user by email (email-only auth): ${user._id}, email: ${user.email}, createdAt: ${user.createdAt}, provider: ${
          user.provider || 'unknown'
        }, tenantId: ${user.tenantId || 'none'}`,
      );
    } else {
      logger.info(
        `[requireExtUserAuth] No user found by email (email-only auth): ${normalizedEmail} (tenantId=${tenantId ||
          'none'}) - will create new user`,
      );
    }
  } else {
    // For explicit externalId (not email), try tenant-scoped platformUserId lookup first when tenantId is available
    logger.info(
      `[requireExtUserAuth] Explicit externalId provided (not email-only): ${externalId} (tenantId=${tenantId ||
        'none'})`,
    );
    if (tenantId) {
      user = await findUser({ tenantId, platformUserId: externalId });
    } else {
      user = await findUser({ platformUserId: externalId });
    }

    // If not found and email provided, fallback to tenant-aware email lookup
    if (!user && email) {
      user = await findUserByTenantAndEmail();
      if (user) {
        logger.info(
          `[requireExtUserAuth] Found user by email (fallback): ${user._id}, email: ${user.email}, createdAt: ${user.createdAt}, provider: ${
            user.provider || 'unknown'
          }, tenantId: ${user.tenantId || 'none'}`,
        );
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
        ...(tenantId && { tenantId }),
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
        retry = await findUserByTenantAndEmail();
        if (retry) {
          logger.info(
            `[requireExtUserAuth] Retry found user by email: ${retry._id}, email: ${retry.email}, createdAt: ${retry.createdAt}, tenantId: ${
              retry.tenantId || 'none'
            }`,
          );
        }
      } else {
        if (tenantId) {
          retry = await findUser({ tenantId, platformUserId: externalId });
        } else {
          retry = await findUser({ platformUserId: externalId });
        }

        if (!retry && email) {
          retry = await findUserByTenantAndEmail();
          if (retry) {
            logger.info(
              `[requireExtUserAuth] Retry found user by email (fallback): ${retry._id}, email: ${retry.email}, tenantId: ${retry.tenantId ||
                'none'}`,
            );
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

    logger.info(
      `[requireExtUserAuth] Auth request - email: ${email}, externalId: ${externalId}, hasXUserId: ${
        rawId != null && String(rawId).trim() !== ''
      }`,
    );

    // Trusted tenant header (ext/v2 MT binding). We use this for tenant-scoped identity resolution
    // before we bind it onto the user record below.
    const headerTenant = (req.headers['x-tenant-id'] || '').toString().trim().toLowerCase() || null;

    let user = null;

    // If header looks like a Mongo ObjectId, prefer direct lookup to respect existing ownership.
    if (isMongoId(externalId)) {
      // When an explicit Mongo ObjectId is provided, we still respect it globally,
      // but later tenant binding logic will reject mismatched headerTenant vs user.tenantId.
      user = await findUser({ _id: externalId });
      user = normalize(user);
    }

    if (!user) {
      user = await ensureUser({ externalId, email, name, tenantId: headerTenant });
    }
    if (!user) {
      logger.warn(
        `[requireExtUserAuth] Unable to resolve user - email: ${email}, externalId: ${externalId}`,
      );
      return res.status(401).json({ error: 'Unauthorized', message: 'Unable to resolve user' });
    }

    // Multi-tenancy: bind tenant from trusted header when provided.
    // For ext/v2, treat 'legacy' as effectively unbound (migration placeholder).
    const currentTenantRaw = (user.tenantId || '').toString().trim().toLowerCase();
    const currentTenant =
      currentTenantRaw === 'legacy' || currentTenantRaw === ''
        ? ''
        : currentTenantRaw;

    logger.info('[MT-IT][requireExtUserAuth] tenant compare', {
      headerTenant,
      currentTenantRaw,
      currentTenantNormalized: currentTenant,
      userId: user._id || user.id || null,
    });

    if (headerTenant) {
      if (currentTenant && currentTenant !== headerTenant) {
        logger.warn(
          `[requireExtUserAuth] Tenant mismatch for user ${user._id || user.id}: currentTenant=${currentTenant}, headerTenant=${headerTenant}`,
        );
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Tenant header does not match user tenant',
        });
      }

      if (!currentTenant) {
        try {
          await updateUser(user._id?.toString() || user.id, { tenantId: headerTenant });
          user.tenantId = headerTenant;
          logger.info(
            `[requireExtUserAuth] Bound tenant ${headerTenant} to user ${user._id || user.id}`,
          );
        } catch (err) {
          logger.error(
            `[requireExtUserAuth] Failed to bind tenant ${headerTenant} to user ${
              user._id || user.id
            }`,
            err,
          );
          return res
            .status(500)
            .json({ error: 'Internal Server Error', message: 'Failed to bind tenant' });
        }
      }
    }

    logger.info(
      `[requireExtUserAuth] Authenticated user - id: ${user._id || user.id}, email: ${
        user.email
      }, provider: ${user.provider || 'unknown'}, tenantId: ${user.tenantId || 'none'}`,
    );
    req.user = user;
    return next();
  } catch (error) {
    logger.error('[requireExtUserAuth] Error', error);
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to authorize external user' });
  }
}

module.exports = requireExtUserAuth;
module.exports.ensureUser = ensureUser;
