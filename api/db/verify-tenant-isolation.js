/**
 * Verification script for tenant model isolation
 * 
 * This script verifies that:
 * 1. Tenant models are created on tenant connections (not system connection)
 * 2. Models are cached per tenantId correctly
 * 3. Multi-tenancy disabled mode doesn't create tenant connections
 * 
 * Usage:
 *   MULTI_TENANCY_ENABLED=true node api/db/verify-tenant-isolation.js
 */

require('dotenv').config();
const path = require('path');

// Set up module alias resolution (mimics server setup)
// ~/ resolves to api/ directory
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id.startsWith('~/')) {
    const apiRoot = path.resolve(__dirname, '..');
    const resolvedPath = path.join(apiRoot, id.replace('~/', ''));
    return originalRequire.call(this, resolvedPath);
  }
  return originalRequire.call(this, id);
};

const mongoose = require('mongoose');
const { connectDb } = require('./connect');
const { getTenantConnectionManager } = require('./TenantConnectionManager');
const { getTenantModels, getTenantDb } = require('./tenantHelpers');
const apiUtils = require('@librechat/api');
const isMultiTenancyEnabled = apiUtils.isMultiTenancyEnabled || (() => {
  const enabled = process.env.MULTI_TENANCY_ENABLED;
  return enabled === 'true' || enabled === true;
});
const { Tenant } = require('~/db/models');

async function verifyTenantIsolation() {
  console.log('='.repeat(80));
  console.log('Tenant Isolation Verification');
  console.log('='.repeat(80));
  console.log(`MULTI_TENANCY_ENABLED: ${isMultiTenancyEnabled()}`);
  console.log('');

  // Connect to system DB first
  await connectDb();
  console.log('✓ Connected to system DB');

  // Ensure we have test tenants
  const MONGO_URI = process.env.MONGO_URI;
  if (!MONGO_URI) {
    throw new Error('MONGO_URI not set');
  }

  // Create or update test tenants
  const legacyTenant = await Tenant.findOneAndUpdate(
    { tenantId: 'legacy' },
    {
      tenantId: 'legacy',
      name: 'Legacy Tenant',
      dbUri: MONGO_URI,
      status: 'active',
      config: {},
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  console.log('✓ Legacy tenant ready');

  // For acme tenant, use a different database name (same server, different DB)
  // This simulates separate tenant databases
  const acmeDbUri = MONGO_URI.replace(/\/[^\/]+$/, '/acme_test');
  const acmeTenant = await Tenant.findOneAndUpdate(
    { tenantId: 'acme' },
    {
      tenantId: 'acme',
      name: 'Acme Corp',
      dbUri: acmeDbUri,
      status: 'active',
      config: {},
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  console.log('✓ Acme tenant ready');
  console.log('');

  if (!isMultiTenancyEnabled()) {
    console.log('⚠ Multi-tenancy is DISABLED - testing backward compatibility');
    console.log('');

    // Test that getTenantDb returns system connection
    const systemDb = await getTenantDb();
    const systemConnection = mongoose.connection;
    
    console.log('Verification 3: Multi-tenancy disabled behavior');
    console.log(`  getTenantDb() === mongoose.connection: ${systemDb === systemConnection}`);
    console.log(`  System connection readyState: ${systemConnection.readyState}`);
    console.log('');

    if (systemDb !== systemConnection) {
      throw new Error('FAIL: getTenantDb() should return system connection when multi-tenancy disabled');
    }

    // Test that no tenant connections were created
    const manager = getTenantConnectionManager();
    const activeConnections = manager.getActiveConnections();
    console.log(`  Active tenant connections: ${activeConnections.length}`);
    
    if (activeConnections.length > 0) {
      throw new Error('FAIL: No tenant connections should be created when multi-tenancy disabled');
    }

    console.log('✓ Multi-tenancy disabled mode verified');
    console.log('');
    console.log('='.repeat(80));
    console.log('VERIFICATION COMPLETE (Multi-tenancy disabled mode)');
    console.log('='.repeat(80));
    return;
  }

  console.log('Multi-tenancy is ENABLED - testing tenant isolation');
  console.log('');

  const manager = getTenantConnectionManager();

  // Verification 1: Prove tenant models are created on tenant connections
  console.log('Verification 1: Tenant model connection binding');
  console.log('-'.repeat(80));

  // Get connections for both tenants
  const legacyConn = await manager.getTenantDb('legacy');
  const acmeConn = await manager.getTenantDb('acme');

  console.log(`  Legacy connection object: ${legacyConn.constructor.name}`);
  console.log(`  Acme connection object: ${acmeConn.constructor.name}`);
  console.log(`  legacyConn !== acmeConn: ${legacyConn !== acmeConn}`);
  console.log(`  Legacy connection readyState: ${legacyConn.readyState}`);
  console.log(`  Acme connection readyState: ${acmeConn.readyState}`);

  if (legacyConn === acmeConn) {
    throw new Error('FAIL: Legacy and Acme connections should be different objects');
  }

  // Get models for both tenants
  const legacyModels = await manager.getModels('legacy');
  const acmeModels = await manager.getModels('acme');

  // Check Conversation model connection binding
  const legacyConversation = legacyModels.Conversation;
  const acmeConversation = acmeModels.Conversation;

  console.log(`  Legacy Conversation model exists: ${!!legacyConversation}`);
  console.log(`  Acme Conversation model exists: ${!!acmeConversation}`);

  // Check model.db property (Mongoose models expose their connection via .db)
  const legacyModelDb = legacyConversation.db;
  const acmeModelDb = acmeConversation.db;

  console.log(`  Legacy Conversation.db === legacyConn: ${legacyModelDb === legacyConn}`);
  console.log(`  Acme Conversation.db === acmeConn: ${acmeModelDb === acmeConn}`);

  // Alternative check via collection.conn
  const legacyModelConn = legacyConversation.collection?.conn || legacyConversation.db;
  const acmeModelConn = acmeConversation.collection?.conn || acmeConversation.db;

  console.log(`  Legacy Conversation.collection.conn === legacyConn: ${legacyModelConn === legacyConn}`);
  console.log(`  Acme Conversation.collection.conn === acmeConn: ${acmeModelConn === acmeConn}`);

  if (legacyModelDb !== legacyConn) {
    throw new Error('FAIL: Legacy Conversation model should be bound to legacy connection');
  }

  if (acmeModelDb !== acmeConn) {
    throw new Error('FAIL: Acme Conversation model should be bound to acme connection');
  }

  // Verify models are different objects (not shared)
  console.log(`  legacyModels.Conversation !== acmeModels.Conversation: ${legacyConversation !== acmeConversation}`);

  if (legacyConversation === acmeConversation) {
    throw new Error('FAIL: Legacy and Acme Conversation models should be different objects');
  }

  console.log('✓ Verification 1 PASSED: Tenant models are correctly bound to tenant connections');
  console.log('');

  // Verification 2: Confirm model caching per tenantId
  console.log('Verification 2: Model caching per tenantId');
  console.log('-'.repeat(80));

  // Get models again - should return cached versions
  const legacyModels2 = await manager.getModels('legacy');
  const acmeModels2 = await manager.getModels('acme');

  console.log(`  First call legacyModels === second call: ${legacyModels === legacyModels2}`);
  console.log(`  First call acmeModels === second call: ${acmeModels === acmeModels2}`);

  if (legacyModels !== legacyModels2) {
    throw new Error('FAIL: Legacy models should be cached and return same object');
  }

  if (acmeModels !== acmeModels2) {
    throw new Error('FAIL: Acme models should be cached and return same object');
  }

  // Verify models are stored in manager's models Map
  const cachedLegacyModels = manager.models.get('legacy');
  const cachedAcmeModels = manager.models.get('acme');

  console.log(`  Cached legacy models exist: ${!!cachedLegacyModels}`);
  console.log(`  Cached acme models exist: ${!!cachedAcmeModels}`);
  console.log(`  Cached legacy === returned: ${cachedLegacyModels === legacyModels}`);
  console.log(`  Cached acme === returned: ${cachedAcmeModels === acmeModels}`);

  if (cachedLegacyModels !== legacyModels) {
    throw new Error('FAIL: Cached legacy models should match returned models');
  }

  if (cachedAcmeModels !== acmeModels) {
    throw new Error('FAIL: Cached acme models should match returned models');
  }

  // Verify models are tied to same connection objects
  console.log(`  Cached legacy models Conversation.db === legacyConn: ${cachedLegacyModels.Conversation.db === legacyConn}`);
  console.log(`  Cached acme models Conversation.db === acmeConn: ${cachedAcmeModels.Conversation.db === acmeConn}`);

  console.log('✓ Verification 2 PASSED: Models are cached per tenantId and tied to connection');
  console.log('');

  // Summary
  console.log('='.repeat(80));
  console.log('VERIFICATION SUMMARY');
  console.log('='.repeat(80));
  console.log('✓ Tenant connections are distinct objects');
  console.log('✓ Tenant models are bound to correct tenant connections');
  console.log('✓ Models are cached per tenantId');
  console.log('✓ Cached models reference correct connection objects');
  console.log('='.repeat(80));
  console.log('ALL VERIFICATIONS PASSED ✅');
  console.log('='.repeat(80));
}

// Run verification
verifyTenantIsolation()
  .then(() => {
    console.log('');
    console.log('Verification completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('');
    console.error('VERIFICATION FAILED ❌');
    console.error(error.message);
    console.error('');
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  });
