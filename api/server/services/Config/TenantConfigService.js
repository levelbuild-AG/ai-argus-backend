const { logger } = require('@librechat/data-schemas');
const { EModelEndpoint } = require('librechat-data-provider');
const loadCustomConfig = require('./loadCustomConfig');
const { Tenant } = require('~/db/models');
const { isMultiTenancyEnabled } = require('@librechat/api');

/**
 * Deep merge two objects, with tenant overrides taking precedence.
 * Arrays are replaced (not concatenated) for deterministic behavior.
 * 
 * @param {Object} base - Base configuration object
 * @param {Object} override - Override configuration object
 * @returns {Object} Merged configuration
 */
function deepMergeConfig(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return override !== undefined ? override : base;
  }

  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    return { ...override };
  }

  const merged = { ...base };

  for (const key in override) {
    if (override.hasOwnProperty(key)) {
      if (Array.isArray(override[key])) {
        // Arrays: replace entirely (don't concat)
        merged[key] = [...override[key]];
      } else if (
        override[key] !== null &&
        typeof override[key] === 'object' &&
        !Array.isArray(override[key]) &&
        base[key] !== null &&
        typeof base[key] === 'object' &&
        !Array.isArray(base[key])
      ) {
        // Objects: deep merge
        merged[key] = deepMergeConfig(base[key], override[key]);
      } else {
        // Primitives or null: override wins
        merged[key] = override[key];
      }
    }
  }

  return merged;
}

/**
 * Validate that enabled endpoints have required secrets
 * 
 * @param {string} tenantId - Tenant ID
 * @param {Object} settings - Merged settings config
 * @param {Object} secrets - Tenant secrets
 * @param {boolean} strict - If true, throw errors; if false, log warnings
 * @throws {Error} If strict=true and validation fails
 */
/**
 * Validate that enabled endpoints have required secrets
 * 
 * Always fails-fast (throws errors) - no non-strict mode.
 * 
 * @param {string} tenantId - Tenant ID
 * @param {Object} settings - Merged settings config
 * @param {Object} secrets - Tenant secrets
 * @throws {Error} If validation fails
 */
function validateTenantConfig(tenantId, settings, secrets) {
  const errors = [];

  // Endpoint validation rules: endpoint -> required secrets
  const endpointSecretRequirements = {
    [EModelEndpoint.google]: {
      required: ['googleServiceKeyFile', 'googleApiKey'], // At least one required
      atLeastOne: true,
    },
    [EModelEndpoint.openAI]: {
      required: ['openAiApiKey'],
      atLeastOne: false,
    },
    [EModelEndpoint.anthropic]: {
      required: ['anthropicApiKey'],
      atLeastOne: false,
    },
    // Add more endpoints as needed
  };

  // Check if endpoints are enabled in settings
  const endpoints = settings?.endpoints || {};
  
  for (const [endpoint, requirements] of Object.entries(endpointSecretRequirements)) {
    const endpointConfig = endpoints[endpoint];
    
    // Skip if endpoint is explicitly disabled
    if (endpointConfig === false || endpointConfig?.disabled === true) {
      continue;
    }

    // Check if endpoint is enabled (exists and not disabled)
    const isEnabled = endpointConfig !== undefined && endpointConfig !== null && endpointConfig !== false;
    
    if (isEnabled) {
      if (requirements.atLeastOne) {
        // At least one secret must be present
        const hasAnySecret = requirements.required.some((secretKey) => secrets[secretKey]);
        if (!hasAnySecret) {
          errors.push(
            `Tenant '${tenantId}' has endpoint '${endpoint}' enabled but missing required secrets: ${requirements.required.join(' or ')}`,
          );
        }
      } else {
        // All secrets must be present
        const missingSecrets = requirements.required.filter((secretKey) => !secrets[secretKey]);
        if (missingSecrets.length > 0) {
          errors.push(
            `Tenant '${tenantId}' has endpoint '${endpoint}' enabled but missing required secrets: ${missingSecrets.join(', ')}`,
          );
        }
      }
    }
  }

  // Always fail-fast (throw errors)
  if (errors.length > 0) {
    throw new Error(
      `Tenant configuration validation failed for tenant '${tenantId}':\n${errors.join('\n')}`,
    );
  }
}

/**
 * TenantConfigService - Manages tenant-specific runtime configuration
 * 
 * Phase A: Startup-loaded configuration (restart required to change)
 * Phase B: Runtime updates will be added later
 * 
 * Responsibilities:
 * - Load base librechat.yaml once
 * - Merge tenant-specific overrides
 * - Validate enabled endpoints have required secrets
 * - Cache configs per tenant in memory
 */
class TenantConfigService {
  constructor() {
    // Base config loaded from librechat.yaml
    this.baseConfig = null;
    
    // Cache: tenantId -> TenantRuntimeConfig
    this.configCache = new Map();
    
    // TODO: Future Phase B - consider adding non-strict validation mode behind a clearly named,
    // temporary env var (e.g., TENANT_CONFIG_VALIDATE_NON_STRICT) for migration scenarios.
    // Default must always be strict (fail-fast) to prevent misconfigured tenants.
  }

  /**
   * Initialize the service by loading base config
   * Must be called before building tenant configs
   */
  async initialize() {
    if (this.baseConfig !== null) {
      return; // Already initialized
    }

    logger.info('[TenantConfigService] Loading base configuration from librechat.yaml');
    this.baseConfig = (await loadCustomConfig(false)) ?? {};
    logger.info('[TenantConfigService] Base configuration loaded');
  }

  /**
   * Build tenant runtime config from base config + tenant overrides
   * 
   * @param {Object} tenant - Tenant document from DB
   * @returns {Object} TenantRuntimeConfig { settings, secrets }
   */
  buildTenantConfig(tenant) {
    if (!this.baseConfig) {
      throw new Error('TenantConfigService not initialized. Call initialize() first.');
    }

    const tenantId = tenant.tenantId;
    const tenantOverrides = tenant.config?.librechatSettings || {};
    
    // Deep merge tenant overrides over base config
    const mergedSettings = deepMergeConfig(this.baseConfig, tenantOverrides);
    
    // Extract custom endpoints: split secrets (apiKey) from settings (baseURL, headers, modelDefaults)
    const customEndpointsRaw = tenant.config?.customEndpoints;
    const customEndpointsSecrets = customEndpointsRaw ? {} : null;
    const customEndpointsSettings = customEndpointsRaw ? {} : null;
    
    if (customEndpointsRaw && typeof customEndpointsRaw === 'object') {
      for (const [endpointId, config] of Object.entries(customEndpointsRaw)) {
        if (config && typeof config === 'object') {
          // apiKey is secret
          customEndpointsSecrets[endpointId] = {
            apiKey: config.apiKey,
          };
          // baseURL, headers, modelDefaults are config (non-secret)
          customEndpointsSettings[endpointId] = {
            baseURL: config.baseURL,
            headers: config.headers,
            modelDefaults: config.modelDefaults,
          };
        }
      }
    }
    
    // Extract secrets from tenant config
    const secrets = {
      googleServiceKeyFile: tenant.config?.googleServiceKeyFile,
      googleApiKey: tenant.config?.googleApiKey,
      openAiApiKey: tenant.config?.openAiApiKey,
      anthropicApiKey: tenant.config?.anthropicApiKey,
      fluxApiKey: tenant.config?.fluxApiKey,
      bedrock: tenant.config?.bedrock || null, // Structured Bedrock config
      customEndpoints: customEndpointsSecrets, // Only apiKey stored here (secret)
      // Add more provider secrets as needed
    };
    
    // Extract infrastructure config (RAG, storage, etc.)
    const infrastructure = {
      rag: tenant.config?.rag || null,
      storage: tenant.config?.storage || null,
    };

    // Merge custom endpoint settings into mergedSettings (non-secret fields)
    if (customEndpointsSettings && Object.keys(customEndpointsSettings).length > 0) {
      mergedSettings.customEndpoints = customEndpointsSettings;
    }

    return {
      settings: mergedSettings,
      secrets,
      infrastructure,
    };
  }

  /**
   * Load and cache config for a tenant
   * 
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<Object>} TenantRuntimeConfig
   */
  async loadTenantConfig(tenantId) {
    if (this.configCache.has(tenantId)) {
      return this.configCache.get(tenantId);
    }

    const tenant = await Tenant.findOne({ tenantId, status: 'active' });
    if (!tenant) {
      throw new Error(`Tenant '${tenantId}' not found or inactive`);
    }

    const config = this.buildTenantConfig(tenant);
    
    // Validate config (always fail-fast)
    validateTenantConfig(tenantId, config.settings, config.secrets);
    
    // Cache config
    this.configCache.set(tenantId, config);
    
    logger.debug(`[TenantConfigService] Loaded and cached config for tenant '${tenantId}'`);
    
    return config;
  }

  /**
   * Load and cache configs for all active tenants at startup
   * 
   * @returns {Promise<void>}
   */
  async loadAllTenantConfigs() {
    await this.initialize();

    const tenants = await Tenant.find({ status: 'active' });
    logger.info(`[TenantConfigService] Loading configs for ${tenants.length} active tenant(s)`);

    const errors = [];
    
    for (const tenant of tenants) {
      try {
        await this.loadTenantConfig(tenant.tenantId);
      } catch (error) {
        errors.push({ tenantId: tenant.tenantId, error: error.message });
        logger.error(`[TenantConfigService] Failed to load config for tenant '${tenant.tenantId}':`, error.message);
      }
    }

    // Always fail-fast if any tenant config failed to load
    if (errors.length > 0) {
      throw new Error(
        `Failed to load tenant configs:\n${errors.map((e) => `  - ${e.tenantId}: ${e.error}`).join('\n')}`,
      );
    }

    logger.info(`[TenantConfigService] Successfully loaded configs for ${this.configCache.size} tenant(s)`);
  }

  /**
   * Get tenant config (from cache or load if needed)
   * 
   * IMPORTANT: When multi-tenancy is enabled, this method NEVER calls getAppConfig().
   * It uses cached merged tenant configs only. getAppConfig() is only called when
   * multi-tenancy is disabled (for backward compatibility).
   * 
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<Object>} TenantRuntimeConfig
   */
  async getTenantConfig(tenantId) {
    if (!isMultiTenancyEnabled()) {
      // When multi-tenancy disabled, return current single-tenant config
      // Note: This is called with 'legacy' tenantId when flag disabled, but we return system config
      const { getAppConfig } = require('./app');
      const appConfig = await getAppConfig();
      return {
        settings: appConfig,
        secrets: {}, // No tenant secrets when disabled - use process.env directly
      };
    }

    // Multi-tenancy enabled: use cached merged tenant configs only
    // NEVER calls getAppConfig() - uses baseConfig + tenant overrides
    if (!this.baseConfig) {
      await this.initialize();
    }

    return this.loadTenantConfig(tenantId);
  }

  /**
   * Clear config cache (useful for testing or Phase B runtime updates)
   * 
   * @param {string} [tenantId] - Optional tenant ID to clear specific config, or clear all if omitted
   */
  clearCache(tenantId) {
    if (tenantId) {
      this.configCache.delete(tenantId);
      logger.debug(`[TenantConfigService] Cleared cache for tenant '${tenantId}'`);
    } else {
      this.configCache.clear();
      logger.debug('[TenantConfigService] Cleared all config cache');
    }
  }

  /**
   * Get cache statistics (for monitoring)
   * 
   * @returns {Object} Cache stats
   */
  getCacheStats() {
    return {
      cachedTenants: Array.from(this.configCache.keys()),
      cacheSize: this.configCache.size,
      baseConfigLoaded: this.baseConfig !== null,
    };
  }
}

// Singleton instance
let instance = null;

/**
 * Get the TenantConfigService singleton instance
 * @returns {TenantConfigService}
 */
function getTenantConfigService() {
  if (!instance) {
    instance = new TenantConfigService();
  }
  return instance;
}

module.exports = {
  TenantConfigService,
  getTenantConfigService,
  deepMergeConfig,
  validateTenantConfig,
};
