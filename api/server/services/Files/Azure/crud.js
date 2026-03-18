const fs = require('fs');
const path = require('path');
const mime = require('mime');
const axios = require('axios');
const fetch = require('node-fetch');
const { logger } = require('@librechat/data-schemas');
const { getAzureContainerClient } = require('@librechat/api');
const {
  getTenantAzureContainerAndBlobName,
  requireTenantId,
} = require('./tenantRouting');

const defaultBasePath = 'images';
const { AZURE_STORAGE_PUBLIC_ACCESS = 'true', AZURE_CONTAINER_NAME = 'files' } = process.env;

/**
 * Uploads a buffer to Azure Blob Storage.
 * 
 * CLEAN-SLATE: Requires explicit tenantId. Uses tenant-routed container and blob name.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - The user's id.
 * @param {Buffer} params.buffer - The buffer to upload.
 * @param {string} params.fileName - The name of the file.
 * @param {string} [params.basePath='images'] - The base folder within the container.
 * @returns {Promise<string>} The URL of the uploaded blob (with tenant prefix).
 */
async function saveBufferToAzure({
  tenantId,
  userId,
  buffer,
  fileName,
  basePath = defaultBasePath,
}) {
  requireTenantId(tenantId, 'saveBufferToAzure');
  
  try {
    // Get tenant-routed container and blob name (always uses tenant prefix)
    const { container, blobName } = await getTenantAzureContainerAndBlobName({
      tenantId,
      basePath,
      userId,
      fileName,
    });
    
    const containerClient = await getAzureContainerClient(container);
    const access = AZURE_STORAGE_PUBLIC_ACCESS?.toLowerCase() === 'true' ? 'blob' : undefined;
    // Create the container if it doesn't exist. This is done per operation.
    await containerClient.createIfNotExists({ access });
    
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.uploadData(buffer);
    return blockBlobClient.url;
  } catch (error) {
    logger.error('[saveBufferToAzure] Error uploading buffer:', error);
    throw error;
  }
}

/**
 * Saves a file from a URL to Azure Blob Storage.
 * 
 * CLEAN-SLATE: Requires explicit tenantId. Uses tenant-routed container and blob name.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - The user's id.
 * @param {string} params.URL - The URL of the file.
 * @param {string} params.fileName - The name of the file.
 * @param {string} [params.basePath='images'] - The base folder within the container.
 * @returns {Promise<string>} The URL of the uploaded blob (with tenant prefix).
 */
async function saveURLToAzure({
  tenantId,
  userId,
  URL,
  fileName,
  basePath = defaultBasePath,
}) {
  requireTenantId(tenantId, 'saveURLToAzure');
  
  try {
    const response = await fetch(URL);
    const buffer = await response.buffer();
    return await saveBufferToAzure({ tenantId, userId, buffer, fileName, basePath });
  } catch (error) {
    logger.error('[saveURLToAzure] Error uploading file from URL:', error);
    throw error;
  }
}

/**
 * Retrieves a blob URL from Azure Blob Storage.
 * 
 * CLEAN-SLATE: Requires explicit tenantId, userId. Uses tenant-routed container and blob name.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - User ID
 * @param {string} params.fileName - The file name.
 * @param {string} [params.basePath='images'] - The base folder used during upload.
 * @returns {Promise<string>} The blob's URL (with tenant prefix).
 */
async function getAzureURL({ tenantId, userId, fileName, basePath = defaultBasePath }) {
  requireTenantId(tenantId, 'getAzureURL');
  
  try {
    // Get tenant-routed container and blob name (always uses tenant prefix)
    const { container, blobName } = await getTenantAzureContainerAndBlobName({
      tenantId,
      basePath,
      userId,
      fileName,
    });
    
    const containerClient = await getAzureContainerClient(container);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    return blockBlobClient.url;
  } catch (error) {
    logger.error('[getAzureURL] Error retrieving blob URL:', error);
    throw error;
  }
}

/**
 * Deletes a blob from Azure Blob Storage.
 * 
 * CLEAN-SLATE: Requires explicit tenantId, userId, basePath, fileName. No legacy path parsing.
 * No `req` dependency - all parameters must be explicit.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - User ID
 * @param {string} params.basePath - Base path (e.g., 'images', 'documents', 'uploads')
 * @param {string} params.fileName - File name
 * @returns {Promise<void>}
 */
async function deleteFileFromAzure({ tenantId, userId, basePath, fileName }) {
  requireTenantId(tenantId, 'deleteFileFromAzure');
  
  try {
    // Get tenant-routed container and blob name (always uses tenant prefix)
    const { container, blobName } = await getTenantAzureContainerAndBlobName({
      tenantId,
      basePath,
      userId,
      fileName,
    });
    
    const containerClient = await getAzureContainerClient(container);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.delete();
    logger.debug('[deleteFileFromAzure] Blob deleted successfully from Azure Blob Storage');
  } catch (error) {
    logger.error('[deleteFileFromAzure] Error deleting blob:', error);
    if (error.statusCode === 404) {
      return;
    }
    throw error;
  }
}

/**
 * Streams a file from disk directly to Azure Blob Storage without loading
 * the entire file into memory.
 * 
 * CLEAN-SLATE: Requires explicit tenantId. Uses tenant-routed container and blob name.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - The user's id.
 * @param {string} params.filePath - The local file path to upload.
 * @param {string} params.fileName - The name of the file in Azure.
 * @param {string} [params.basePath='images'] - The base folder within the container.
 * @returns {Promise<string>} The URL of the uploaded blob (with tenant prefix).
 */
async function streamFileToAzure({
  tenantId,
  userId,
  filePath,
  fileName,
  basePath = defaultBasePath,
}) {
  requireTenantId(tenantId, 'streamFileToAzure');
  
  try {
    // Get tenant-routed container and blob name (always uses tenant prefix)
    const { container, blobName } = await getTenantAzureContainerAndBlobName({
      tenantId,
      basePath,
      userId,
      fileName,
    });
    
    const containerClient = await getAzureContainerClient(container);
    const access = AZURE_STORAGE_PUBLIC_ACCESS?.toLowerCase() === 'true' ? 'blob' : undefined;

    // Create the container if it doesn't exist
    await containerClient.createIfNotExists({ access });

    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Get file size for proper content length
    const stats = await fs.promises.stat(filePath);

    // Create read stream from the file
    const fileStream = fs.createReadStream(filePath);

    const blobContentType = mime.getType(fileName);
    await blockBlobClient.uploadStream(
      fileStream,
      undefined, // Use default concurrency (5)
      undefined, // Use default buffer size (8MB)
      {
        blobHTTPHeaders: {
          blobContentType,
        },
        onProgress: (progress) => {
          logger.debug(
            `[streamFileToAzure] Upload progress: ${progress.loadedBytes} bytes of ${stats.size}`,
          );
        },
      },
    );

    return blockBlobClient.url;
  } catch (error) {
    logger.error('[streamFileToAzure] Error streaming file:', error);
    throw error;
  }
}

/**
 * Uploads a file from the local file system to Azure Blob Storage.
 * 
 * CLEAN-SLATE: Requires explicit tenantId, userId. No legacy path support.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - User ID
 * @param {Express.Multer.File} params.file - The file object.
 * @param {string} params.file_id - The file id.
 * @param {string} [params.basePath='images'] - The base folder within the container.
 * @returns {Promise<{ filepath: string, bytes: number }>} An object containing the blob URL (with tenant prefix) and its byte size.
 */
async function uploadFileToAzure({
  tenantId,
  userId,
  file,
  file_id,
  basePath = defaultBasePath,
}) {
  requireTenantId(tenantId, 'uploadFileToAzure');
  
  try {
    const inputFilePath = file.path;
    const stats = await fs.promises.stat(inputFilePath);
    const bytes = stats.size;
    const fileName = `${file_id}__${path.basename(inputFilePath)}`;
    const uploadBasePath = basePath || 'uploads'; // Uploads use 'uploads' basePath

    const fileURL = await streamFileToAzure({
      tenantId,
      userId,
      filePath: inputFilePath,
      fileName,
      basePath: uploadBasePath,
    });

    return { filepath: fileURL, bytes };
  } catch (error) {
    logger.error('[uploadFileToAzure] Error uploading file:', error);
    throw error;
  }
}

/**
 * Retrieves a readable stream for a blob from Azure Blob Storage.
 * 
 * CLEAN-SLATE: Requires explicit tenantId, userId, basePath, fileName. No legacy URL parsing.
 * Note: Azure streams use blob URLs, so we need to get the URL first using tenant-routed path.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - User ID
 * @param {string} params.basePath - Base path (e.g., 'images', 'documents', 'uploads')
 * @param {string} params.fileName - File name
 * @returns {Promise<ReadableStream>} A readable stream of the blob.
 */
async function getAzureFileStream({ tenantId, userId, basePath, fileName }) {
  requireTenantId(tenantId, 'getAzureFileStream');
  
  try {
    // Get download URL using tenant-routed path
    const blobURL = await getAzureURL({ tenantId, userId, fileName, basePath });
    
    if (!blobURL) {
      throw new Error('Failed to get Azure blob URL');
    }
    
    const response = await axios({
      method: 'get',
      url: blobURL,
      responseType: 'stream',
    });
    return response.data;
  } catch (error) {
    logger.error('[getAzureFileStream] Error getting blob stream:', error);
    throw error;
  }
}

module.exports = {
  saveBufferToAzure,
  saveURLToAzure,
  getAzureURL,
  deleteFileFromAzure,
  uploadFileToAzure,
  getAzureFileStream,
};
