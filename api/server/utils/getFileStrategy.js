const { FileSources, FileContext } = require('librechat-data-provider');
const { getTenantStorageProvider } = require('~/server/utils/getTenantStorageConfig');

/**
 * Determines the appropriate file storage strategy based on file type, configuration, and tenant config.
 * 
 * CLEAN-SLATE MULTI-TENANCY: Tenant config overrides global config when tenantId is provided.
 * 
 * Priority order:
 * 1. Tenant storage provider override (if tenantId provided and tenant config specifies provider)
 * 2. Specific file type strategy from appConfig.fileStrategies
 * 3. Default strategy from appConfig.fileStrategies
 * 4. Legacy appConfig.fileStrategy
 * 5. FileSources.local as final fallback
 *
 * @param {AppConfig} appConfig - App configuration object containing fileStrategy and fileStrategies
 * @param {Object} options - File context options
 * @param {boolean} options.isAvatar - Whether this is an avatar upload
 * @param {boolean} options.isImage - Whether this is an image upload
 * @param {string} options.context - File context from FileContext enum
 * @param {string} [options.tenantId] - Tenant ID (optional, for tenant-specific provider override)
 * @returns {Promise<string>|string} Storage strategy to use (e.g., FileSources.local, 's3', 'azure')
 *
 * @example
 * // Legacy single strategy
 * getFileStrategy({ fileStrategy: 's3' }) // Returns 's3'
 *
 * @example
 * // Granular strategies
 * getFileStrategy(
 *   {
 *     fileStrategy: 's3',
 *     fileStrategies: { avatar: FileSources.local, document: 's3' }
 *   },
 *   { isAvatar: true }
 * ) // Returns FileSources.local
 *
 * @example
 * // Tenant override
 * await getFileStrategy(
 *   { fileStrategy: 's3' },
 *   { tenantId: 'tenant-123' }
 * ) // Returns tenant's storage.provider if configured, otherwise 's3'
 */
async function getFileStrategy(appConfig, { isAvatar = false, isImage = false, context = null, tenantId = null } = {}) {
  // CLEAN-SLATE MULTI-TENANCY: Fail-hard if tenantId is provided but invalid
  // This prevents accidental use in tenant-scoped paths without proper tenant context
  if (tenantId !== null && tenantId !== undefined) {
    if (typeof tenantId !== 'string' || tenantId.trim() === '') {
      const callsite = new Error().stack?.split('\n')[2]?.trim() || 'unknown';
      throw new Error(
        `[getFileStrategy] Invalid tenantId provided: must be a non-empty string. ` +
        `Callsite: ${callsite}. ` +
        `In clean-slate multi-tenancy mode, tenantId must be provided from req.tenantContext.tenantId.`
      );
    }
    tenantId = tenantId.trim(); // Normalize whitespace
  }
  
  // Step 1: Determine base strategy from appConfig
  let baseStrategy;
  
  // Fallback to legacy single strategy if no granular config
  if (!appConfig?.fileStrategies) {
    baseStrategy = appConfig.fileStrategy || FileSources.local; // Default to FileSources.local if undefined
  } else {
    const strategies = appConfig.fileStrategies;
    const defaultStrategy = strategies.default || appConfig.fileStrategy || FileSources.local;

    // Priority order for strategy selection:
    // 1. Specific file type strategy
    // 2. Default strategy from fileStrategies
    // 3. Legacy fileStrategy
    // 4. FileSources.local as final fallback

    if (isAvatar || context === FileContext.avatar) {
      baseStrategy = strategies.avatar || defaultStrategy;
    } else if (isImage || context === FileContext.image_generation) {
      baseStrategy = strategies.image || defaultStrategy;
    } else {
      // All other files (documents, attachments, etc.)
      baseStrategy = strategies.document || defaultStrategy;
    }
  }

  const selectedStrategy = baseStrategy || FileSources.local; // Final fallback to FileSources.local

  // Step 2: Apply tenant override if tenantId is provided
  if (tenantId) {
    try {
      const tenantProvider = await getTenantStorageProvider(tenantId, selectedStrategy);
      return tenantProvider;
    } catch (error) {
      // If tenant config lookup fails, log warning but continue with base strategy
      // This ensures we don't break if tenant config is temporarily unavailable
      const { logger } = require('@librechat/data-schemas');
      logger.warn(`[getFileStrategy] Failed to get tenant storage provider for tenant '${tenantId}': ${error.message}. Using base strategy: ${selectedStrategy}`);
      return selectedStrategy;
    }
  }

  return selectedStrategy;
}

module.exports = { getFileStrategy };
