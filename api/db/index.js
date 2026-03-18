const mongoose = require('mongoose');
const { createModels } = require('@librechat/data-schemas');
const { connectDb } = require('./connect');
const indexSync = require('./indexSync');
const { getTenantConnectionManager } = require('./TenantConnectionManager');

// Create system models on default mongoose connection
// NOTE: Tenant-scoped models are created on tenant connections separately
createModels(mongoose);

module.exports = {
  connectDb,
  indexSync,
  getTenantConnectionManager,
};
