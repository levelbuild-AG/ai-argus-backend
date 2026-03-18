require('dotenv').config();
const { isEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');

const mongoose = require('mongoose');
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  throw new Error('Please define the MONGO_URI environment variable');
}

/**
 * System Database URI (HC-2: System DB vs Tenant DB separation)
 * 
 * - If SYSTEM_MONGO_URI is set, system DB uses it (for Users, Tenants, Sessions, etc.)
 * - If not set, system DB falls back to MONGO_URI (backward compatible)
 * - Tenant DB URIs come from Tenant.dbUri (per tenant)
 * - Legacy tenant uses MONGO_URI (same as system DB fallback, but separate connection object)
 */
const SYSTEM_MONGO_URI = process.env.SYSTEM_MONGO_URI || MONGO_URI;
/** The maximum number of connections in the connection pool. */
const maxPoolSize = parseInt(process.env.MONGO_MAX_POOL_SIZE) || undefined;
/** The minimum number of connections in the connection pool. */
const minPoolSize = parseInt(process.env.MONGO_MIN_POOL_SIZE) || undefined;
/** The maximum number of connections that may be in the process of being established concurrently by the connection pool. */
const maxConnecting = parseInt(process.env.MONGO_MAX_CONNECTING) || undefined;
/** The maximum number of milliseconds that a connection can remain idle in the pool before being removed and closed. */
const maxIdleTimeMS = parseInt(process.env.MONGO_MAX_IDLE_TIME_MS) || undefined;
/** The maximum time in milliseconds that a thread can wait for a connection to become available. */
const waitQueueTimeoutMS = parseInt(process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS) || undefined;
/** Set to false to disable automatic index creation for all models associated with this connection. */
const autoIndex =
  process.env.MONGO_AUTO_INDEX != undefined
    ? isEnabled(process.env.MONGO_AUTO_INDEX) || false
    : undefined;

/** Set to `false` to disable Mongoose automatically calling `createCollection()` on every model created on this connection. */
const autoCreate =
  process.env.MONGO_AUTO_CREATE != undefined
    ? isEnabled(process.env.MONGO_AUTO_CREATE) || false
    : undefined;
/**
 * Global is used here to maintain a cached connection across hot reloads
 * in development. This prevents connections growing exponentially
 * during API Route usage.
 */
let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function connectDb() {
  if (cached.conn && cached.conn?._readyState === 1) {
    return cached.conn;
  }

  const disconnected = cached.conn && cached.conn?._readyState !== 1;
  if (!cached.promise || disconnected) {
    const opts = {
      bufferCommands: false,
      ...(maxPoolSize ? { maxPoolSize } : {}),
      ...(minPoolSize ? { minPoolSize } : {}),
      ...(maxConnecting ? { maxConnecting } : {}),
      ...(maxIdleTimeMS ? { maxIdleTimeMS } : {}),
      ...(waitQueueTimeoutMS ? { waitQueueTimeoutMS } : {}),
      ...(autoIndex != undefined ? { autoIndex } : {}),
      ...(autoCreate != undefined ? { autoCreate } : {}),
      // useNewUrlParser: true,
      // useUnifiedTopology: true,
      // bufferMaxEntries: 0,
      // useFindAndModify: true,
      // useCreateIndex: true
    };
    logger.info('Mongo Connection options');
    logger.info(JSON.stringify(opts, null, 2));
    logger.info(`System DB URI: ${SYSTEM_MONGO_URI === MONGO_URI ? 'MONGO_URI (fallback)' : 'SYSTEM_MONGO_URI'}`);
    mongoose.set('strictQuery', true);
    // System DB connection uses SYSTEM_MONGO_URI (or MONGO_URI fallback)
    cached.promise = mongoose.connect(SYSTEM_MONGO_URI, opts).then((mongoose) => {
      return mongoose;
    });
  }
  cached.conn = await cached.promise;

  return cached.conn;
}

/**
 * Get the system database URI (for reference, not for direct connection)
 * Tenant connections are created separately via TenantConnectionManager
 */
function getSystemDbUri() {
  return SYSTEM_MONGO_URI;
}

module.exports = {
  connectDb,
  getSystemDbUri,
};
