require('dotenv').config();
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', '..', '..') });
const { logger } = require('@librechat/data-schemas');
const { connectDb } = require('~/db');
const { User } = require('~/db/models');

/**
 * Get system database URI (same logic as connect.js)
 * HC-2: Migrations should use SYSTEM_MONGO_URI when set, fallback to MONGO_URI
 */
function getSystemDbUri() {
  return process.env.SYSTEM_MONGO_URI || process.env.MONGO_URI;
}

/**
 * Migration script to add tenantId to existing users.
 * 
 * HC-1: Backward-compatible migration
 * - Sets tenantId='legacy' where tenantId is missing or null
 * - Does NOT overwrite existing tenantId values (idempotent)
 * - Can be run multiple times safely
 */
async function addTenantIdToUsers() {
  try {
    await connectDb();
    logger.info('Connected to database');

    // Find users without tenantId (null, undefined, or missing)
    // Using $or to catch all cases: null, undefined, or field doesn't exist
    const query = {
      $or: [
        { tenantId: { $exists: false } },
        { tenantId: null },
        { tenantId: '' },
      ],
    };

    // Update only users without tenantId (does not overwrite existing values)
    const result = await User.updateMany(
      query,
      {
        $set: {
          tenantId: 'legacy',
        },
      },
    );

    logger.info(`Migration completed:`);
    logger.info(`  - Users updated: ${result.modifiedCount}`);
    logger.info(`  - Users matched: ${result.matchedCount}`);
    logger.info(`  - Users already had tenantId: ${result.matchedCount - result.modifiedCount}`);

    // Verify migration
    const usersWithoutTenantId = await User.countDocuments({
      $or: [
        { tenantId: { $exists: false } },
        { tenantId: null },
        { tenantId: '' },
      ],
    });

    if (usersWithoutTenantId > 0) {
      logger.warn(`Warning: ${usersWithoutTenantId} users still without tenantId`);
    } else {
      logger.info('✓ All users now have tenantId');
    }

    // Show sample of migrated users
    const sampleUsers = await User.find({ tenantId: 'legacy' })
      .select('email tenantId')
      .limit(5)
      .lean();
    
    if (sampleUsers.length > 0) {
      logger.info('Sample migrated users:');
      sampleUsers.forEach((user) => {
        logger.info(`  - ${user.email}: tenantId=${user.tenantId}`);
      });
    }

    process.exit(0);
  } catch (error) {
    logger.error('Error in migration:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  addTenantIdToUsers();
}

module.exports = { addTenantIdToUsers };
