const { getTenantConfigService } = require('~/server/services/Config/TenantConfigService');
const { logger } = require('@librechat/data-schemas');

/**
 * Get tenant-specific storage configuration
 * 
 * Returns storage config from tenant config if present, otherwise returns null
 * (caller should fall back to global config).
 * 
 * @param {string} tenantId - Tenant ID
 * @returns {Promise<Object|null>} Storage config object or null
 */
async function getTenantStorageConfig(tenantId) {
  if (!tenantId) {
    return null;
  }

  try {
    const tenantConfig = await getTenantConfigService().getTenantConfig(tenantId);
    return tenantConfig.infrastructure?.storage || null;
  } catch (error) {
    logger.error(`[getTenantStorageConfig] Error loading tenant config for '${tenantId}':`, error.message);
    return null;
  }
}

/**
 * Get tenant-specific storage provider (overrides global fileStrategy if present)
 * 
 * @param {string} tenantId - Tenant ID
 * @param {string} globalFileStrategy - Global file strategy from appConfig
 * @returns {Promise<string>} Storage provider to use
 */
async function getTenantStorageProvider(tenantId, globalFileStrategy) {
  const storageConfig = await getTenantStorageConfig(tenantId);
  
  if (storageConfig?.provider) {
    return storageConfig.provider;
  }
  
  return globalFileStrategy;
}

/**
 * Get tenant-specific S3 bucket name
 * 
 * @param {string} tenantId - Tenant ID
 * @param {string} globalBucket - Global bucket from process.env.AWS_BUCKET_NAME
 * @returns {Promise<string>} Bucket name to use
 */
async function getTenantS3Bucket(tenantId, globalBucket) {
  const storageConfig = await getTenantStorageConfig(tenantId);
  
  if (storageConfig?.provider === 's3' && storageConfig.bucket) {
    return storageConfig.bucket;
  }
  
  return globalBucket;
}

/**
 * Get tenant-specific S3 key prefix
 * 
 * @param {string} tenantId - Tenant ID
 * @returns {Promise<string>} Prefix to prepend to S3 keys (empty string if none)
 */
async function getTenantS3Prefix(tenantId) {
  const storageConfig = await getTenantStorageConfig(tenantId);
  
  if (storageConfig?.provider === 's3' && storageConfig.prefix) {
    // Ensure prefix ends with '/' if not empty
    return storageConfig.prefix.endsWith('/') ? storageConfig.prefix : `${storageConfig.prefix}/`;
  }
  
  return '';
}

/**
 * Get tenant-specific Azure container name
 * 
 * @param {string} tenantId - Tenant ID
 * @param {string} globalContainer - Global container from Azure config
 * @returns {Promise<string>} Container name to use
 */
async function getTenantAzureContainer(tenantId, globalContainer) {
  const storageConfig = await getTenantStorageConfig(tenantId);
  
  if (storageConfig?.provider === 'azure_blob' && storageConfig.container) {
    return storageConfig.container;
  }
  
  return globalContainer;
}

/**
 * Get tenant-specific Azure blob prefix
 * 
 * @param {string} tenantId - Tenant ID
 * @returns {Promise<string>} Prefix to prepend to blob names (empty string if none)
 */
async function getTenantAzurePrefix(tenantId) {
  const storageConfig = await getTenantStorageConfig(tenantId);
  
  if (storageConfig?.provider === 'azure_blob' && storageConfig.prefix) {
    return storageConfig.prefix.endsWith('/') ? storageConfig.prefix : `${storageConfig.prefix}/`;
  }
  
  return '';
}

/**
 * Get tenant-specific local storage base path
 * 
 * @param {string} tenantId - Tenant ID
 * @param {string} globalBasePath - Global base path from appConfig.paths
 * @returns {Promise<string>} Base path to use
 */
async function getTenantLocalBasePath(tenantId, globalBasePath) {
  const storageConfig = await getTenantStorageConfig(tenantId);
  
  if (storageConfig?.provider === 'local' && storageConfig.basePath) {
    return storageConfig.basePath;
  }
  
  return globalBasePath;
}

/**
 * Get tenant-specific local storage prefix
 * 
 * @param {string} tenantId - Tenant ID
 * @returns {Promise<string>} Prefix to prepend to local paths (empty string if none)
 */
async function getTenantLocalPrefix(tenantId) {
  const storageConfig = await getTenantStorageConfig(tenantId);
  
  if (storageConfig?.provider === 'local' && storageConfig.prefix) {
    return storageConfig.prefix.endsWith('/') ? storageConfig.prefix : `${storageConfig.prefix}/`;
  }
  
  return '';
}

/**
 * Get tenant-specific Firebase Storage prefix
 * 
 * @param {string} tenantId - Tenant ID
 * @returns {Promise<string>} Prefix to prepend to Firebase Storage paths (empty string if none)
 */
async function getTenantFirebasePrefix(tenantId) {
  const storageConfig = await getTenantStorageConfig(tenantId);
  
  if (storageConfig?.provider === 'firebase' && storageConfig.prefix) {
    return storageConfig.prefix.endsWith('/') ? storageConfig.prefix : `${storageConfig.prefix}/`;
  }
  
  return '';
}

module.exports = {
  getTenantStorageConfig,
  getTenantStorageProvider,
  getTenantS3Bucket,
  getTenantS3Prefix,
  getTenantAzureContainer,
  getTenantAzurePrefix,
  getTenantLocalBasePath,
  getTenantLocalPrefix,
  getTenantFirebasePrefix,
};
