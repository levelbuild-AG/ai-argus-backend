const fs = require('fs');
const fetch = require('node-fetch');
const { initializeS3 } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { FileSources } = require('librechat-data-provider');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const {
  getTenantS3BucketAndKey,
  requireTenantId,
} = require('./tenantRouting');

const bucketName = process.env.AWS_BUCKET_NAME;
const defaultBasePath = 'images';

let s3UrlExpirySeconds = 2 * 60; // 2 minutes
let s3RefreshExpiryMs = null;

if (process.env.S3_URL_EXPIRY_SECONDS !== undefined) {
  const parsed = parseInt(process.env.S3_URL_EXPIRY_SECONDS, 10);

  if (!isNaN(parsed) && parsed > 0) {
    s3UrlExpirySeconds = Math.min(parsed, 7 * 24 * 60 * 60);
  } else {
    logger.warn(
      `[S3] Invalid S3_URL_EXPIRY_SECONDS value: "${process.env.S3_URL_EXPIRY_SECONDS}". Using 2-minute expiry.`,
    );
  }
}

if (process.env.S3_REFRESH_EXPIRY_MS !== null && process.env.S3_REFRESH_EXPIRY_MS) {
  const parsed = parseInt(process.env.S3_REFRESH_EXPIRY_MS, 10);

  if (!isNaN(parsed) && parsed > 0) {
    s3RefreshExpiryMs = parsed;
    logger.info(`[S3] Using custom refresh expiry time: ${s3RefreshExpiryMs}ms`);
  } else {
    logger.warn(
      `[S3] Invalid S3_REFRESH_EXPIRY_MS value: "${process.env.S3_REFRESH_EXPIRY_MS}". Using default refresh logic.`,
    );
  }
}

/**
 * Uploads a buffer to S3 and returns a signed URL.
 *
 * @param {Object} params
 * @param {string} params.userId - The user's unique identifier.
 * @param {Buffer} params.buffer - The buffer containing file data.
 * @param {string} params.fileName - The file name to use in S3.
 * @param {string} [params.basePath='images'] - The base path in the bucket.
 * @param {string} [params.tenantId] - Tenant ID (required for tenant-scoped paths)
 * @returns {Promise<string>} Signed URL of the uploaded file.
 */
async function saveBufferToS3({ userId, buffer, fileName, basePath = defaultBasePath, tenantId }) {
  // Require tenantId for tenant-scoped operations
  requireTenantId(tenantId, 'saveBufferToS3');
  
  // Get tenant-routed bucket and key
  const { bucket, key } = await getTenantS3BucketAndKey({
    tenantId,
    basePath,
    userId,
    fileName,
    requireTenantPrefix: true,
  });
  
  const params = { Bucket: bucket, Key: key, Body: buffer };

  try {
    const s3 = initializeS3();
    await s3.send(new PutObjectCommand(params));
    return await getS3URL({ userId, fileName, basePath, tenantId });
  } catch (error) {
    logger.error('[saveBufferToS3] Error uploading buffer to S3:', error.message);
    throw error;
  }
}

/**
 * Retrieves a URL for a file stored in S3.
 * Returns a signed URL with expiration time or a proxy URL based on config
 *
 * @param {Object} params
 * @param {string} params.userId - The user's unique identifier.
 * @param {string} params.fileName - The file name in S3.
 * @param {string} [params.basePath='images'] - The base path in the bucket.
 * @param {string} [params.tenantId] - Tenant ID (required for tenant-scoped paths)
 * @param {string} [params.customFilename] - Custom filename for Content-Disposition header (overrides extracted filename).
 * @param {string} [params.contentType] - Custom content type for the response.
 * @returns {Promise<string>} A URL to access the S3 object
 */
async function getS3URL({
  userId,
  fileName,
  basePath = defaultBasePath,
  tenantId,
  customFilename = null,
  contentType = null,
}) {
  // Require tenantId for tenant-scoped operations
  requireTenantId(tenantId, 'getS3URL');
  
  // Get tenant-routed bucket and key
  const { bucket, key } = await getTenantS3BucketAndKey({
    tenantId,
    basePath,
    userId,
    fileName,
    requireTenantPrefix: true,
  });
  
  const params = { Bucket: bucket, Key: key };

  // Add response headers if specified
  if (customFilename) {
    params.ResponseContentDisposition = `attachment; filename="${customFilename}"`;
  }

  if (contentType) {
    params.ResponseContentType = contentType;
  }

  try {
    const s3 = initializeS3();
    return await getSignedUrl(s3, new GetObjectCommand(params), { expiresIn: s3UrlExpirySeconds });
  } catch (error) {
    logger.error('[getS3URL] Error getting signed URL from S3:', error.message);
    throw error;
  }
}

/**
 * Saves a file from a given URL to S3.
 *
 * @param {Object} params
 * @param {string} params.userId - The user's unique identifier.
 * @param {string} params.URL - The source URL of the file.
 * @param {string} params.fileName - The file name to use in S3.
 * @param {string} [params.basePath='images'] - The base path in the bucket.
 * @param {string} [params.tenantId] - Tenant ID (required for tenant-scoped paths)
 * @returns {Promise<string>} Signed URL of the uploaded file.
 */
async function saveURLToS3({ userId, URL, fileName, basePath = defaultBasePath, tenantId }) {
  try {
    const response = await fetch(URL);
    const buffer = await response.buffer();
    // Optionally you can call getBufferMetadata(buffer) if needed.
    return await saveBufferToS3({ userId, buffer, fileName, basePath, tenantId });
  } catch (error) {
    logger.error('[saveURLToS3] Error uploading file from URL to S3:', error.message);
    throw error;
  }
}

/**
 * Deletes a file from S3.
 * 
 * CLEAN-SLATE: No legacy key format support. File must be stored with tenant prefix.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - User ID
 * @param {string} params.basePath - Base path (e.g., 'images', 'documents')
 * @param {string} params.fileName - File name
 * @returns {Promise<void>}
 */
async function deleteFileFromS3({ tenantId, userId, basePath, fileName }) {
  requireTenantId(tenantId, 'deleteFileFromS3');
  
  // Get tenant-routed bucket and key (always uses tenant prefix)
  const { bucket, key } = await getTenantS3BucketAndKey({
    tenantId,
    basePath,
    userId,
    fileName,
  });
  
  const params = { Bucket: bucket, Key: key };

  try {
    const s3 = initializeS3();

    try {
      const headCommand = new HeadObjectCommand(params);
      await s3.send(headCommand);
      logger.debug('[deleteFileFromS3] File exists, proceeding with deletion');
    } catch (headErr) {
      if (headErr.name === 'NotFound') {
        logger.warn(`[deleteFileFromS3] File does not exist: ${key}`);
        return;
      }
    }

    const deleteResult = await s3.send(new DeleteObjectCommand(params));
    logger.debug('[deleteFileFromS3] Delete command response:', JSON.stringify(deleteResult));
    try {
      await s3.send(new HeadObjectCommand(params));
      logger.error('[deleteFileFromS3] File still exists after deletion!');
    } catch (verifyErr) {
      if (verifyErr.name === 'NotFound') {
        logger.debug(`[deleteFileFromS3] Verified file is deleted: ${key}`);
      } else {
        logger.error('[deleteFileFromS3] Error verifying deletion:', verifyErr);
      }
    }

    logger.debug('[deleteFileFromS3] S3 File deletion completed');
  } catch (error) {
    logger.error(`[deleteFileFromS3] Error deleting file from S3: ${error.message}`);
    logger.error(error.stack);

    // If the file is not found, we can safely return.
    if (error.code === 'NoSuchKey') {
      return;
    }
    throw error;
  }
}

/**
 * Uploads a local file to S3 by streaming it directly without loading into memory.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - User ID
 * @param {Express.Multer.File} params.file - The file object from Multer.
 * @param {string} params.file_id - Unique file identifier.
 * @param {string} [params.basePath='images'] - The base path in the bucket.
 * @returns {Promise<{ filepath: string, bytes: number }>}
 */
async function uploadFileToS3({ tenantId, userId, file, file_id, basePath = defaultBasePath }) {
  try {
    requireTenantId(tenantId, 'uploadFileToS3');
    
    const inputFilePath = file.path;
    const fileName = `${file_id}__${file.originalname}`;
    
    // Get tenant-routed bucket and key
    const { bucket, key } = await getTenantS3BucketAndKey({
      tenantId,
      basePath,
      userId,
      fileName,
    });

    const stats = await fs.promises.stat(inputFilePath);
    const bytes = stats.size;
    const fileStream = fs.createReadStream(inputFilePath);

    const s3 = initializeS3();
    const uploadParams = {
      Bucket: bucket,
      Key: key,
      Body: fileStream,
    };

    await s3.send(new PutObjectCommand(uploadParams));
    const fileURL = await getS3URL({ userId, fileName, basePath, tenantId });
    return { filepath: fileURL, bytes };
  } catch (error) {
    logger.error('[uploadFileToS3] Error streaming file to S3:', error);
    try {
      if (file && file.path) {
        await fs.promises.unlink(file.path);
      }
    } catch (unlinkError) {
      logger.error(
        '[uploadFileToS3] Error deleting temporary file, likely already deleted:',
        unlinkError.message,
      );
    }
    throw error;
  }
}

/**
 * Extracts the S3 key from a URL or returns the key if already properly formatted
 *
 * @param {string} fileUrlOrKey - The file URL or key
 * @returns {string} The S3 key
 */
function extractKeyFromS3Url(fileUrlOrKey) {
  if (!fileUrlOrKey) {
    throw new Error('Invalid input: URL or key is empty');
  }

  try {
    const url = new URL(fileUrlOrKey);
    return url.pathname.substring(1);
  } catch (error) {
    const parts = fileUrlOrKey.split('/');

    if (parts.length >= 3 && !fileUrlOrKey.startsWith('http') && !fileUrlOrKey.startsWith('/')) {
      return fileUrlOrKey;
    }

    return fileUrlOrKey.startsWith('/') ? fileUrlOrKey.substring(1) : fileUrlOrKey;
  }
}

/**
 * Retrieves a readable stream for a file stored in S3.
 * 
 * CLEAN-SLATE: No legacy key format support. File must be stored with tenant prefix.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - User ID
 * @param {string} params.basePath - Base path (e.g., 'images', 'documents')
 * @param {string} params.fileName - File name
 * @returns {Promise<NodeJS.ReadableStream>}
 */
async function getS3FileStream({ tenantId, userId, basePath, fileName }) {
  try {
    requireTenantId(tenantId, 'getS3FileStream');
    
    // Get tenant-routed bucket and key (always uses tenant prefix)
    const { bucket, key } = await getTenantS3BucketAndKey({
      tenantId,
      basePath,
      userId,
      fileName,
    });
    
    const params = { Bucket: bucket, Key: key };
    const s3 = initializeS3();
    const data = await s3.send(new GetObjectCommand(params));
    return data.Body; // Returns a Node.js ReadableStream.
  } catch (error) {
    logger.error('[getS3FileStream] Error retrieving S3 file stream:', error);
    throw error;
  }
}

/**
 * Determines if a signed S3 URL is close to expiration
 *
 * @param {string} signedUrl - The signed S3 URL
 * @param {number} bufferSeconds - Buffer time in seconds
 * @returns {boolean} True if the URL needs refreshing
 */
function needsRefresh(signedUrl, bufferSeconds) {
  try {
    // Parse the URL
    const url = new URL(signedUrl);

    // Check if it has the signature parameters that indicate it's a signed URL
    // X-Amz-Signature is the most reliable indicator for AWS signed URLs
    if (!url.searchParams.has('X-Amz-Signature')) {
      // Not a signed URL, so no expiration to check (or it's already a proxy URL)
      return false;
    }

    // Extract the expiration time from the URL
    const expiresParam = url.searchParams.get('X-Amz-Expires');
    const dateParam = url.searchParams.get('X-Amz-Date');

    if (!expiresParam || !dateParam) {
      // Missing expiration information, assume it needs refresh to be safe
      return true;
    }

    // Parse the AWS date format (YYYYMMDDTHHMMSSZ)
    const year = dateParam.substring(0, 4);
    const month = dateParam.substring(4, 6);
    const day = dateParam.substring(6, 8);
    const hour = dateParam.substring(9, 11);
    const minute = dateParam.substring(11, 13);
    const second = dateParam.substring(13, 15);

    const dateObj = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
    const expiresAtDate = new Date(dateObj.getTime() + parseInt(expiresParam) * 1000);

    // Check if it's close to expiration
    const now = new Date();

    // If S3_REFRESH_EXPIRY_MS is set, use it to determine if URL is expired
    if (s3RefreshExpiryMs !== null) {
      const urlCreationTime = dateObj.getTime();
      const urlAge = now.getTime() - urlCreationTime;
      return urlAge >= s3RefreshExpiryMs;
    }

    // Otherwise use the default buffer-based logic
    const bufferTime = new Date(now.getTime() + bufferSeconds * 1000);
    return expiresAtDate <= bufferTime;
  } catch (error) {
    logger.error('Error checking URL expiration:', error);
    // If we can't determine, assume it needs refresh to be safe
    return true;
  }
}

/**
 * Generates a new URL for an expired S3 URL
 * 
 * CLEAN-SLATE: Requires explicit tenantId, userId, basePath, fileName.
 * No URL parsing or legacy format support.
 * 
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - User ID
 * @param {string} params.basePath - Base path (e.g., 'images', 'documents')
 * @param {string} params.fileName - File name
 * @returns {Promise<string | undefined>}
 */
async function getNewS3URL({ tenantId, userId, basePath, fileName }) {
  try {
    requireTenantId(tenantId, 'getNewS3URL');

    return await getS3URL({
      userId,
      fileName,
      basePath,
      tenantId,
    });
  } catch (error) {
    logger.error('[getNewS3URL] Error getting new S3 URL:', error);
    return undefined;
  }
}

/**
 * Refreshes S3 URLs for an array of files if they're expired or close to expiring
 * 
 * CLEAN-SLATE: Files must have tenant-prefixed keys. Requires explicit file metadata.
 *
 * @param {MongoFile[]} files - Array of file documents (must include userId, basePath, fileName metadata)
 * @param {(files: MongoFile[]) => Promise<void>} batchUpdateFiles - Function to update files in the database
 * @param {string} tenantId - Tenant ID (required for tenant-scoped operations)
 * @param {number} [bufferSeconds=3600] - Buffer time in seconds to check for expiration
 * @returns {Promise<MongoFile[]>} The files with refreshed URLs if needed
 */
async function refreshS3FileUrls(files, batchUpdateFiles, tenantId, bufferSeconds = 3600) {
  if (!files || !Array.isArray(files) || files.length === 0) {
    return files;
  }
  
  requireTenantId(tenantId, 'refreshS3FileUrls');

  const filesToUpdate = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file?.file_id) {
      continue;
    }
    if (file.source !== FileSources.s3) {
      continue;
    }
    if (!file.filepath) {
      continue;
    }
    if (!needsRefresh(file.filepath, bufferSeconds)) {
      continue;
    }
    
    // CLEAN-SLATE: Require explicit file metadata (no URL parsing)
    if (!file.user || !file.filename) {
      logger.warn(`[refreshS3FileUrls] File ${file.file_id} missing required metadata (user, filename). Skipping refresh.`);
      continue;
    }
    
    // Extract basePath from file context or default to 'images'
    const basePath = file.context === 'documents' ? 'documents' : 'images';
    
    try {
      const newURL = await getNewS3URL({
        tenantId,
        userId: file.user,
        basePath,
        fileName: file.filename,
      });
      if (!newURL) {
        continue;
      }
      filesToUpdate.push({
        file_id: file.file_id,
        filepath: newURL,
      });
      files[i].filepath = newURL;
    } catch (error) {
      logger.error(`[refreshS3FileUrls] Error refreshing S3 URL for file ${file.file_id}:`, error);
    }
  }

  if (filesToUpdate.length > 0) {
    await batchUpdateFiles(filesToUpdate);
  }

  return files;
}

/**
 * Refreshes a single S3 URL if it's expired or close to expiring
 * 
 * CLEAN-SLATE: Requires explicit file metadata. No URL parsing or legacy format support.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - User ID
 * @param {string} params.basePath - Base path (e.g., 'images', 'documents')
 * @param {string} params.fileName - File name
 * @param {string} params.currentUrl - Current S3 URL (for expiration check only)
 * @param {number} [bufferSeconds=3600] - Buffer time in seconds to check for expiration
 * @returns {Promise<string>} The refreshed URL or the original URL if no refresh needed
 */
async function refreshS3Url({ tenantId, userId, basePath, fileName, currentUrl, bufferSeconds = 3600 }) {
  if (!currentUrl) {
    return '';
  }
  
  requireTenantId(tenantId, 'refreshS3Url');

  if (!needsRefresh(currentUrl, bufferSeconds)) {
    return currentUrl;
  }

  try {
    const newUrl = await getS3URL({
      userId,
      fileName,
      basePath,
      tenantId,
    });

    logger.debug(`[refreshS3Url] Refreshed S3 URL for tenant=${tenantId}, userId=${userId}, fileName=${fileName}`);
    return newUrl;
  } catch (error) {
    logger.error(`[refreshS3Url] Error refreshing S3 URL: ${error.message}`);
    return currentUrl;
  }
}

module.exports = {
  saveBufferToS3,
  saveURLToS3,
  getS3URL,
  deleteFileFromS3,
  uploadFileToS3,
  getS3FileStream,
  refreshS3FileUrls,
  refreshS3Url,
  needsRefresh,
  getNewS3URL,
};
