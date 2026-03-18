require('dotenv').config();
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', '..', '..') });
const { logger } = require('@librechat/data-schemas');
const { connectDb } = require('~/db');
const { getTenantConfigService } = require('~/server/services/Config/TenantConfigService');

/**
 * Initialize tenant configuration service at startup. Always runs (cannot be skipped).
 * 1. Loads base librechat.yaml config
 * 2. Loads all active tenants from system DB and caches configs
 * 3. Fail-fast on invalid tenant configs
 * Called from api/server/index.js: await initializeTenantConfigs() before routes and before assertAlwaysOnMTWiring().
 */
async function initializeTenantConfigs() {
  try {
    logger.info('[tenantConfigInit] Initializing tenant configuration service');

    // Ensure DB connection is established
    await connectDb();

    const service = getTenantConfigService();
    
    // Load all tenant configs (validates and caches)
    await service.loadAllTenantConfigs();

    logger.info('[tenantConfigInit] Tenant configuration service initialized successfully');
  } catch (error) {
    logger.error('[tenantConfigInit] Failed to initialize tenant configuration service:', error);
    throw error; // Fail fast - don't start server with invalid tenant configs
  }
}

// Run if called directly (for testing)
if (require.main === module) {
  initializeTenantConfigs()
    .then(() => {
      logger.info('Tenant config initialization completed');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Tenant config initialization failed:', error);
      process.exit(1);
    });
}

module.exports = { initializeTenantConfigs };
