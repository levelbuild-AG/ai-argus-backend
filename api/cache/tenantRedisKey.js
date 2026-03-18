/**
 * Redis/cache key prefixes for multi-tenancy.
 * Two explicit modes: tenant-scoped (requires tenantId, throws if missing) and system-scoped (no tenantId).
 */

/**
 * Tenant-scoped Redis key prefix. Use only for tenant-scoped data (e.g. convo access, concurrent limiter).
 * Validates tenantId and throws if missing or invalid — no silent fallback.
 *
 * @param {string} tenantId - Tenant ID (from req.tenantContext.tenantId; middleware must extract and pass explicitly).
 * @param {string} callsite - Caller identifier for error messages (e.g. 'convoAccess', 'clearPendingReq').
 * @returns {string} `tenant:${tenantId}:`
 * @throws {Error} If tenantId is missing, not a string, or empty after trim.
 */
function requireTenantRedisPrefix(tenantId, callsite) {
  if (tenantId == null || typeof tenantId !== 'string') {
    throw new Error(
      `[${callsite}] Tenant ID is required for tenant-scoped Redis key. Ensure requireTenantContext runs before this middleware and pass tenantId explicitly.`,
    );
  }
  const trimmed = tenantId.trim();
  if (trimmed === '') {
    throw new Error(
      `[${callsite}] Tenant ID must be a non-empty string for tenant-scoped Redis key.`,
    );
  }
  return `tenant:${trimmed}:`;
}

/**
 * System-scoped Redis key prefix. Use for security/rate-limit style data (bans, violations)
 * that must not be tenant-bypassable and may run before tenant context exists (e.g. auth routes).
 *
 * @returns {string} `system:`
 */
function getSystemRedisPrefix() {
  return 'system:';
}

module.exports = { requireTenantRedisPrefix, getSystemRedisPrefix };
