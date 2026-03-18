require('dotenv').config();
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', '..', '..') });
const { logger } = require('@librechat/data-schemas');
const { connectDb } = require('~/db');
const { Tenant } = require('~/db/models');

/**
 * Seed script to create/update the legacy tenant.
 * 
 * This script is idempotent - it can be run multiple times safely.
 * 
 * HC-2: Legacy tenant uses MONGO_URI (separate from SYSTEM_MONGO_URI if set).
 * Legacy tenant points to the current database where tenant data already exists.
 */
async function seedLegacyTenant() {
  try {
    await connectDb();
    logger.info('Connected to system database');

    const MONGO_URI = process.env.MONGO_URI;
    if (!MONGO_URI) {
      throw new Error('MONGO_URI environment variable is required');
    }

    const legacyTenantId = 'legacy';

    // Create-if-missing only: do not overwrite existing tenant config (runtime API may have changed it).
    // Idempotent and non-fatal: if tenant exists, skip and return (never exit or throw).
    const existing = await Tenant.findOne({ tenantId: legacyTenantId });
    if (existing) {
      logger.info(`Legacy tenant already exists, skipping seed (no overwrite): ${existing.tenantId}`);
      return;
    }

    const result = await Tenant.create({
      tenantId: legacyTenantId,
      name: 'Legacy Tenant',
      dbUri: MONGO_URI, // Legacy tenant uses MONGO_URI (current database)
      status: 'active',
      config: {},
    });

    logger.info(`Legacy tenant created: ${result.tenantId}`);
    logger.info(`Legacy tenant DB URI: ${result.dbUri}`);
    logger.info(`System DB URI: ${process.env.SYSTEM_MONGO_URI || MONGO_URI} (${process.env.SYSTEM_MONGO_URI ? 'SYSTEM_MONGO_URI' : 'MONGO_URI fallback'})`);
  } catch (error) {
    logger.error('Error seeding legacy tenant:', error);
    throw error;
  }
}

// Run if called directly (script mode): exit after promise settles; never exit from inside seedLegacyTenant
if (require.main === module) {
  seedLegacyTenant()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { seedLegacyTenant };
