/**
 * Redact credentials from URI in error messages (no passwords in API response or logs).
 */
function safeMessage(check, rawMessage) {
  if (!rawMessage || typeof rawMessage !== 'string') return `${check} check failed`;
  if (/[:/][/]|[^@]+@/.test(rawMessage)) {
    return `${check} check failed (credentials redacted)`;
  }
  return rawMessage;
}

/** Strict timeout for all connectivity checks (ms). */
const CONNECTIVITY_TIMEOUT_MS = 5000;

/**
 * Tier 2: Live connectivity checks for tenant config.
 * Runs preflight checks (Mongo, Postgres) with strict timeouts. If any check fails, caller must NOT persist the config.
 * Error messages must NOT include full URIs with passwords (redacted).
 *
 * @param {string} tenantId - Tenant ID (for logging)
 * @param {Object} payload - Tenant document payload (tenantId, dbUri, config)
 * @returns {Promise<{ valid: boolean, errors: Array<{ check: string, message: string }> }>}
 */
async function validateTenantConfigConnectivity(tenantId, payload) {
  const errors = [];
  const dbUri = payload.dbUri || payload.mongodb?.uri;

  if (dbUri) {
    try {
      const mongoose = require('mongoose');
      const conn = await mongoose.createConnection(dbUri, { serverSelectionTimeoutMS: CONNECTIVITY_TIMEOUT_MS }).asPromise();
      await conn.close();
    } catch (e) {
      errors.push({ check: 'mongodb', message: safeMessage('mongodb', e.message) });
    }
  }

  const postgresUri = payload.config?.rag?.postgresUri;
  if (postgresUri) {
    try {
      const { Client } = require('pg');
      const client = new Client({ connectionString: postgresUri, connectionTimeoutMillis: CONNECTIVITY_TIMEOUT_MS });
      await client.connect();
      await client.end();
    } catch (e) {
      if (e.code === 'MODULE_NOT_FOUND') {
        // pg optional; skip postgres connectivity check
      } else {
        errors.push({ check: 'postgres', message: safeMessage('postgres', e.message) });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = { validateTenantConfigConnectivity };
