const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { createModels } = require('@librechat/data-schemas');
const { Tenant } = require('~/db/models');

/**
 * Masks credentials in MongoDB URI for safe logging
 * @param {string} uri - MongoDB URI
 * @returns {string} Masked URI
 */
function maskUri(uri) {
  if (!uri) return 'undefined';
  try {
    const url = new URL(uri);
    if (url.password) {
      url.password = '***';
    }
    // Mask username if it looks like credentials
    if (url.username && url.username.length > 3) {
      url.username = url.username.substring(0, 2) + '***';
    }
    return url.toString();
  } catch (e) {
    // If URI parsing fails, mask common patterns
    return uri.replace(/(:\/\/[^:]+:)([^@]+)(@)/, '$1***$3');
  }
}

/**
 * TenantConnectionManager - Manages MongoDB connections per tenant
 * 
 * HC-3: Each tenant gets a dedicated Connection object via mongoose.createConnection()
 * No model registration on global mongoose singleton for tenant-scoped models
 * 
 * Responsibilities:
 * - Lazy connection creation (only when tenant accessed)
 * - Connection caching per tenantId
 * - Connection lifecycle management (health checks, cleanup)
 * - Tenant dbUri resolution from system DB Tenant model
 */
class TenantConnectionManager {
  constructor() {
    // Map of tenantId -> mongoose.Connection
    this.connections = new Map();
    // Map of tenantId -> tenant-scoped models
    this.models = new Map();
    
    // Connection options (pool size, etc.) - explicitly passed to mongoose.createConnection()
    // Filter out undefined values to avoid passing invalid options
    const maxPoolSize = parseInt(process.env.MONGO_MAX_POOL_SIZE);
    const minPoolSize = parseInt(process.env.MONGO_MIN_POOL_SIZE);
    const maxConnecting = parseInt(process.env.MONGO_MAX_CONNECTING);
    const maxIdleTimeMS = parseInt(process.env.MONGO_MAX_IDLE_TIME_MS);
    const waitQueueTimeoutMS = parseInt(process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS);
    
    this.connectionOptions = {
      bufferCommands: false,
      ...(maxPoolSize ? { maxPoolSize } : { maxPoolSize: 10 }), // Default to 10 if not set
      ...(minPoolSize ? { minPoolSize } : {}),
      ...(maxConnecting ? { maxConnecting } : {}),
      ...(maxIdleTimeMS ? { maxIdleTimeMS } : {}),
      ...(waitQueueTimeoutMS ? { waitQueueTimeoutMS } : {}),
    };
  }

  /**
   * Get tenant's database URI from system DB Tenant model
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<string>} Database URI for the tenant
   */
  async getTenantDbUri(tenantId) {
    // Tenant model is from system connection (created via createModels on default mongoose in api/db/models.js)
    const tenant = await Tenant.findOne({ tenantId, status: 'active' });
    if (!tenant) {
      throw new Error(`Tenant '${tenantId}' not found or inactive`);
    }
    return tenant.dbUri;
  }

  /**
   * Get or create a MongoDB connection for a tenant
   * HC-3: Uses mongoose.createConnection() to create dedicated Connection object
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<mongoose.Connection>} Tenant's MongoDB connection
   */
  async getConnection(tenantId) {
    // Return cached connection if available and healthy
    if (this.connections.has(tenantId)) {
      const conn = this.connections.get(tenantId);
      if (conn.readyState === 1) {
        // Connection is ready
        return conn;
      }
      // Connection is disconnected, remove from cache
      logger.warn(`[TenantConnectionManager] Connection for tenant '${tenantId}' is disconnected, will recreate`);
      this.connections.delete(tenantId);
      this.models.delete(tenantId);
    }

    // Resolve tenant dbUri from system DB
    let dbUri;
    try {
      dbUri = await this.getTenantDbUri(tenantId);
    } catch (error) {
      logger.error(`[TenantConnectionManager] Failed to resolve dbUri for tenant '${tenantId}':`, error.message);
      throw error;
    }

    // Create new connection using mongoose.createConnection() (HC-3)
    // This creates a separate Connection object, not the global mongoose.connection
    try {
      logger.info(`[TenantConnectionManager] Creating connection for tenant '${tenantId}'`);
      logger.debug(`[TenantConnectionManager] Tenant DB URI: ${maskUri(dbUri)}`);

      const conn = mongoose.createConnection(dbUri, this.connectionOptions);
      
      // Store tenantId on connection for use in hooks/plugins
      conn._tenantId = tenantId;
      
      // Set up connection event handlers
      conn.on('connected', () => {
        logger.info(`[TenantConnectionManager] Connected to tenant DB: ${tenantId}`);
      });

      conn.on('error', (err) => {
        logger.error(`[TenantConnectionManager] Connection error for tenant '${tenantId}':`, err.message);
      });

      conn.on('disconnected', () => {
        logger.warn(`[TenantConnectionManager] Disconnected from tenant DB: ${tenantId}`);
        // Remove from cache on disconnect
        this.connections.delete(tenantId);
        this.models.delete(tenantId);
      });

      // Wait for connection to be ready
      await conn.asPromise();

      // Cache connection
      this.connections.set(tenantId, conn);

      // Create tenant-scoped models on this connection
      // NOTE: System models (User, Tenant) are NOT created here - they use system connection
      const tenantModels = createModels(conn);
      
      // Override Meilisearch plugin methods to use tenant-specific indexes
      if (tenantModels.Conversation && process.env.MEILI_HOST && process.env.MEILI_MASTER_KEY) {
        const { overrideMeiliPluginForTenants } = require('~/server/services/Meilisearch/overrideMeiliPlugin');
        overrideMeiliPluginForTenants(tenantModels.Conversation.schema, 'convos');
      }
      
      this.models.set(tenantId, tenantModels);

      logger.info(`[TenantConnectionManager] Connection established for tenant '${tenantId}'`);
      return conn;
    } catch (error) {
      logger.error(`[TenantConnectionManager] Failed to create connection for tenant '${tenantId}':`, error.message);
      // Don't crash server - log error and throw
      throw new Error(`Failed to connect to tenant database: ${error.message}`);
    }
  }

  /**
   * Get tenant-scoped models for a tenant
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<Object>} Tenant-scoped models (Conversation, Message, File, etc.)
   */
  async getModels(tenantId) {
    // Ensure connection exists
    await this.getConnection(tenantId);
    return this.models.get(tenantId);
  }

  /**
   * Get tenant's database connection
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<mongoose.Connection>} Tenant's MongoDB connection
   */
  async getTenantDb(tenantId) {
    return this.getConnection(tenantId);
  }

  /**
   * Close connection for a tenant (cleanup)
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<void>}
   */
  async closeConnection(tenantId) {
    if (this.connections.has(tenantId)) {
      const conn = this.connections.get(tenantId);
      try {
        await conn.close();
        logger.info(`[TenantConnectionManager] Closed connection for tenant '${tenantId}'`);
      } catch (error) {
        logger.error(`[TenantConnectionManager] Error closing connection for tenant '${tenantId}':`, error.message);
      }
      this.connections.delete(tenantId);
      this.models.delete(tenantId);
    }
  }

  /**
   * Get all active tenant connections (for monitoring)
   * @returns {Array<{tenantId: string, readyState: number}>}
   */
  getActiveConnections() {
    const active = [];
    for (const [tenantId, conn] of this.connections.entries()) {
      active.push({
        tenantId,
        readyState: conn.readyState,
        host: conn.host,
        name: conn.name,
      });
    }
    return active;
  }
}

// Singleton instance
let instance = null;

/**
 * Get the TenantConnectionManager singleton instance
 * @returns {TenantConnectionManager}
 */
function getTenantConnectionManager() {
  if (!instance) {
    instance = new TenantConnectionManager();
  }
  return instance;
}

module.exports = {
  TenantConnectionManager,
  getTenantConnectionManager,
};
