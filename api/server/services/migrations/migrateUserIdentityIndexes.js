const path = require('path');

// Load .env from repo root then api/ so the script works regardless of cwd
const apiDir = path.resolve(__dirname, '..', '..', '..');
const repoRoot = path.join(apiDir, '..');
require('dotenv').config({ path: path.join(repoRoot, '.env') });
require('dotenv').config({ path: path.join(apiDir, '.env') });

// Resolve Mongo URI before requiring ~/db (connect.js throws if MONGO_URI is missing)
// Order: MONGO_URI, then SYSTEM_MONGO_URI. Set MONGO_URI so connect.js receives a value.
const MONGO_URI = process.env.MONGO_URI || process.env.SYSTEM_MONGO_URI;
const MONGO_URI_SOURCE = process.env.MONGO_URI ? 'MONGO_URI' : (process.env.SYSTEM_MONGO_URI ? 'SYSTEM_MONGO_URI' : null);

if (!MONGO_URI || typeof MONGO_URI !== 'string' || !MONGO_URI.trim()) {
  console.error('[migrateUserIdentityIndexes] Missing Mongo connection string.');
  console.error('Set one of these (in the environment or in api/.env):');
  console.error('  MONGO_URI          - system Mongo URI');
  console.error('  SYSTEM_MONGO_URI   - system Mongo URI (fallback if MONGO_URI not set)');
  process.exit(1);
}
process.env.MONGO_URI = MONGO_URI;

require('module-alias')({ base: apiDir });
const { logger } = require('@librechat/data-schemas');
const { connectDb } = require('~/db');
const { User } = require('~/db/models');

const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');

const LEGACY_INDEX_NAMES = ['email_1', 'platformUserId_1'];
const COMPOUND_EMAIL_SPEC = { tenantId: 1, email: 1 };
const COMPOUND_PLATFORM_USER_ID_SPEC = { tenantId: 1, platformUserId: 1 };
const INDEX_OPTS = { unique: true, sparse: true };

function indexMatches(spec, keyPattern) {
  if (!keyPattern || typeof keyPattern !== 'object') return false;
  const keys = Object.keys(spec);
  return keys.every((k) => keyPattern[k] === spec[k]);
}

async function migrateUserIdentityIndexes() {
  try {
    logger.info(`[migrateUserIdentityIndexes] Using connection string from: ${MONGO_URI_SOURCE}`);
    await connectDb();
    logger.info('[migrateUserIdentityIndexes] Connected to database (system Mongo)');
    if (DRY_RUN) logger.info('[migrateUserIdentityIndexes] DRY RUN — no changes will be applied');

    const collection = User.collection;
    const indexes = await collection.indexes();
    const indexNames = indexes.map((idx) => idx.name);
    logger.info('[migrateUserIdentityIndexes] Current indexes:', indexNames.join(', ') || '(none)');

    // Drop old global unique indexes if they exist
    for (const name of LEGACY_INDEX_NAMES) {
      if (indexNames.includes(name)) {
        logger.info(`[migrateUserIdentityIndexes] Would drop index '${name}'`);
        if (!DRY_RUN) {
          try {
            await collection.dropIndex(name);
            logger.info(`[migrateUserIdentityIndexes] Dropped index '${name}'`);
          } catch (err) {
            logger.error(`[migrateUserIdentityIndexes] Failed to drop index '${name}'`, err.message);
            process.exit(1);
          }
        }
      }
    }

    // Create compound indexes if not already present (idempotent)
    const hasEmailCompound = indexes.some(
      (idx) => indexMatches(COMPOUND_EMAIL_SPEC, idx.key),
    );
    const hasPlatformUserIdCompound = indexes.some(
      (idx) => indexMatches(COMPOUND_PLATFORM_USER_ID_SPEC, idx.key),
    );

    if (!hasEmailCompound) {
      logger.info('[migrateUserIdentityIndexes] Would create compound index (tenantId, email)');
      if (!DRY_RUN) {
        await collection.createIndex(COMPOUND_EMAIL_SPEC, INDEX_OPTS);
        logger.info('[migrateUserIdentityIndexes] Created index (tenantId, email)');
      }
    } else {
      logger.info('[migrateUserIdentityIndexes] Compound index (tenantId, email) already exists');
    }

    if (!hasPlatformUserIdCompound) {
      logger.info('[migrateUserIdentityIndexes] Would create compound index (tenantId, platformUserId)');
      if (!DRY_RUN) {
        await collection.createIndex(COMPOUND_PLATFORM_USER_ID_SPEC, INDEX_OPTS);
        logger.info('[migrateUserIdentityIndexes] Created index (tenantId, platformUserId)');
      }
    } else {
      logger.info('[migrateUserIdentityIndexes] Compound index (tenantId, platformUserId) already exists');
    }

    if (DRY_RUN) logger.info('[migrateUserIdentityIndexes] Dry run finished (exit 0)');
    else logger.info('[migrateUserIdentityIndexes] Migration completed successfully');
    process.exit(0);
  } catch (error) {
    logger.error('[migrateUserIdentityIndexes] Error during migration', error);
    process.exit(1);
  }
}

if (require.main === module) {
  migrateUserIdentityIndexes();
}

module.exports = { migrateUserIdentityIndexes };

