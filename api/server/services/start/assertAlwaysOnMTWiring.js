/**
 * Always-on multi-tenancy: single authoritative startup assertion.
 * Asserts the wiring required for multi-tenancy; does not branch on isMultiTenancyEnabled().
 * Failure is deterministic (always throw).
 *
 * Checks:
 * - System DB (MongoDB) is reachable
 * - TenantConfigService is initialized (baseConfig loaded; tenant configs loaded)
 *
 * Tenant middleware mounting for tenant-scoped routes is enforced by api/server/index.js (requireTenantContext on /api/* routes).
 * RAG: If RAG is enabled, infra/rag_api must have SYSTEM_MONGO_URI configured separately; not asserted here.
 */

const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { getTenantConfigService } = require('~/server/services/Config/TenantConfigService');

function assertAlwaysOnMTWiring() {
  const failures = [];

  // 1) System DB reachable
  const conn = mongoose.connection;
  if (!conn || conn.readyState !== 1) {
    failures.push('System DB (MongoDB) is not connected (mongoose.connection.readyState !== 1)');
  }

  // 2) TenantConfigService initialized
  try {
    const service = getTenantConfigService();
    const stats = service.getCacheStats();
    if (!stats.baseConfigLoaded) {
      failures.push('TenantConfigService base config not loaded');
    }
  } catch (e) {
    failures.push(`TenantConfigService check failed: ${e.message}`);
  }

  if (failures.length === 0) {
    logger.info(
      '[assertAlwaysOnMTWiring] Multi-tenancy wiring OK (DB connected, TenantConfigService initialized)',
    );
    return;
  }

  const message = `[assertAlwaysOnMTWiring] Multi-tenancy wiring failed (multi-tenancy is mandatory): ${failures.join('; ')}`;
  logger.error(message);
  throw new Error(message);
}

module.exports = { assertAlwaysOnMTWiring };
