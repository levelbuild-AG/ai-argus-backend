const fs = require('fs');
const path = require('path');
const axios = require('axios');
const fetch = require('node-fetch');
const { logger } = require('@librechat/data-schemas');
const { getFirebaseStorage } = require('@librechat/api');
const { ref, uploadBytes, getDownloadURL, deleteObject } = require('firebase/storage');
const { getBufferMetadata } = require('~/server/utils');
const { getRagApiHeaders } = require('~/server/utils/ragApiClient');
const {
  getTenantFirebasePath,
  requireTenantId,
} = require('./tenantRouting');

/**
 * Deletes a file from Firebase Storage.
 * 
 * CLEAN-SLATE: Requires explicit tenantId. Uses tenant-routed path.
 * 
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.basePath - Base path (e.g., 'images', 'documents', 'uploads')
 * @param {string} params.userId - User ID
 * @param {string} params.fileName - File name
 * @returns {Promise<void>} A promise that resolves when the file is deleted.
 */
async function deleteFile({ tenantId, basePath, userId, fileName }) {
  requireTenantId(tenantId, 'deleteFile');
  
  const storage = getFirebaseStorage();
  if (!storage) {
    logger.error('Firebase is not initialized. Cannot delete file from Firebase Storage.');
    throw new Error('Firebase is not initialized');
  }

  // Get tenant-routed path (always uses tenant prefix)
  const storagePath = await getTenantFirebasePath({ tenantId, basePath, userId, fileName });
  const storageRef = ref(storage, storagePath);

  try {
    await deleteObject(storageRef);
    logger.debug('File deleted successfully from Firebase Storage');
  } catch (error) {
    logger.error('Error deleting file from Firebase Storage:', error.message);
    throw error;
  }
}

/**
 * Saves a file from a given URL to Firebase Storage.
 * 
 * CLEAN-SLATE: Requires explicit tenantId. Uses tenant-routed path.
 *
 * @param {Object} params - The parameters object.
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - The user's unique identifier.
 * @param {string} params.URL - The URL of the file to be uploaded.
 * @param {string} params.fileName - The name that will be used to save the file in Firebase Storage.
 * @param {string} [params.basePath='images'] - Optional. The base path in Firebase Storage where the file will be stored.
 *
 * @returns {Promise<{ bytes: number, type: string, dimensions: Record<string, number>} | null>}
 *          A promise that resolves to the file metadata if the file is successfully saved, or null if there is an error.
 */
async function saveURLToFirebase({ tenantId, userId, URL, fileName, basePath = 'images' }) {
  requireTenantId(tenantId, 'saveURLToFirebase');
  
  const storage = getFirebaseStorage();
  if (!storage) {
    logger.error('Firebase is not initialized. Cannot save file to Firebase Storage.');
    return null;
  }

  // Get tenant-routed path (always uses tenant prefix)
  const storagePath = await getTenantFirebasePath({ tenantId, basePath, userId, fileName });
  const storageRef = ref(storage, storagePath);
  
  const response = await fetch(URL);
  const buffer = await response.buffer();

  try {
    await uploadBytes(storageRef, buffer);
    return await getBufferMetadata(buffer);
  } catch (error) {
    logger.error('Error uploading file to Firebase Storage:', error.message);
    return null;
  }
}

/**
 * Retrieves the download URL for a specified file from Firebase Storage.
 * 
 * CLEAN-SLATE: Requires explicit tenantId, userId. Uses tenant-routed path.
 *
 * @param {Object} params - The parameters object.
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - User ID
 * @param {string} params.fileName - The name of the file for which the URL is to be retrieved.
 * @param {string} [params.basePath='images'] - Optional. The base path in Firebase Storage where the file is stored.
 *
 * @returns {Promise<string|null>}
 *          A promise that resolves to the download URL of the file if successful, or null if there is an error.
 */
async function getFirebaseURL({ tenantId, userId, fileName, basePath = 'images' }) {
  requireTenantId(tenantId, 'getFirebaseURL');
  
  const storage = getFirebaseStorage();
  if (!storage) {
    logger.error('Firebase is not initialized. Cannot get image URL from Firebase Storage.');
    return null;
  }

  // Get tenant-routed path (always uses tenant prefix)
  const storagePath = await getTenantFirebasePath({ tenantId, basePath, userId, fileName });
  const storageRef = ref(storage, storagePath);

  try {
    return await getDownloadURL(storageRef);
  } catch (error) {
    logger.error('Error fetching file URL from Firebase Storage:', error.message);
    return null;
  }
}

/**
 * Uploads a buffer to Firebase Storage.
 * 
 * CLEAN-SLATE: Requires explicit tenantId. Uses tenant-routed path.
 *
 * @param {Object} params - The parameters object.
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - The user's unique identifier.
 * @param {string} params.fileName - The name of the file to be saved in Firebase Storage.
 * @param {Buffer} params.buffer - The buffer to be uploaded.
 * @param {string} [params.basePath='images'] - Optional. The base path in Firebase Storage where the file will be stored.
 *
 * @returns {Promise<string>} - A promise that resolves to the download URL of the uploaded file.
 */
async function saveBufferToFirebase({ tenantId, userId, buffer, fileName, basePath = 'images' }) {
  requireTenantId(tenantId, 'saveBufferToFirebase');
  
  const storage = getFirebaseStorage();
  if (!storage) {
    throw new Error('Firebase is not initialized');
  }

  // Get tenant-routed path (always uses tenant prefix)
  const storagePath = await getTenantFirebasePath({ tenantId, basePath, userId, fileName });
  const storageRef = ref(storage, storagePath);
  
  await uploadBytes(storageRef, buffer);

  // Get download URL using tenant-routed path
  return await getFirebaseURL({ tenantId, userId, fileName, basePath });
}

/**
 * Extracts and decodes the file path from a Firebase Storage URL.
 *
 * @param {string} urlString - The Firebase Storage URL.
 * @returns {string} The decoded file path.
 */
function extractFirebaseFilePath(urlString) {
  try {
    const url = new URL(urlString);
    const pathRegex = /\/o\/(.+?)(\?|$)/;
    const match = url.pathname.match(pathRegex);

    if (match && match[1]) {
      return decodeURIComponent(match[1]);
    }

    return '';
  } catch {
    logger.debug(
      '[extractFirebaseFilePath] Failed to extract Firebase file path from URL, returning empty string',
    );
    // If URL parsing fails, return an empty string
    return '';
  }
}

/**
 * Deletes a file from Firebase storage.
 * 
 * CLEAN-SLATE: Requires explicit tenantId, userId, basePath, fileName. No legacy path parsing.
 * No `req` dependency - all parameters must be explicit.
 * Uses centralized getRagApiHeaders for RAG cleanup (single-source-of-truth for headers).
 *
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - User ID
 * @param {string} params.basePath - Base path (e.g., 'images', 'documents', 'uploads')
 * @param {string} params.fileName - File name
 * @param {boolean} [params.embedded] - Whether file is embedded (for RAG API cleanup)
 * @param {string} [params.ragFileId] - File ID for RAG API cleanup (if embedded)
 * @param {string} [params.ragJwtToken] - JWT token for RAG API authentication (if embedded)
 * @param {string} [params.ragApiUrl] - RAG API URL (defaults to process.env.RAG_API_URL)
 * @returns {Promise<void>}
 */
const deleteFirebaseFile = async ({ tenantId, userId, basePath, fileName, embedded, ragFileId, ragJwtToken, ragApiUrl }) => {
  requireTenantId(tenantId, 'deleteFirebaseFile');

  // Handle RAG API cleanup if embedded
  if (embedded && ragFileId && ragJwtToken) {
    const apiUrl = ragApiUrl || process.env.RAG_API_URL;
    if (apiUrl) {
      // Use centralized getRagApiHeaders with explicit tenantId (no req dependency)
      const headers = getRagApiHeaders(
        { tenantId }, // Explicit tenantId object pattern
        {
          Authorization: `Bearer ${ragJwtToken}`,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        'Firebase/crud.deleteFirebaseFile'
      );
      
      axios.delete(`${apiUrl}/documents`, {
        headers,
        data: [ragFileId],
      }).catch((error) => {
        logger.error(`[deleteFirebaseFile] Error cleaning up RAG document ${ragFileId}:`, error.message);
      });
    }
  }

  // Delete file using tenant-routed path
  try {
    await deleteFile({ tenantId, basePath, userId, fileName });
  } catch (error) {
    logger.error('Error deleting file from Firebase:', error);
    if (error.code === 'storage/object-not-found') {
      return;
    }
    throw error;
  }
};

/**
 * Uploads a file to Firebase Storage.
 * 
 * CLEAN-SLATE: Requires explicit tenantId, userId. No legacy path support.
 *
 * @param {Object} params - The params object.
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - User ID
 * @param {Express.Multer.File} params.file - The file object.
 * @param {string} params.file_id - The file ID.
 * @returns {Promise<{ filepath: string, bytes: number }>}
 *          A promise that resolves to an object containing:
 *            - filepath: The download URL of the uploaded file (with tenant prefix).
 *            - bytes: The size of the uploaded file in bytes.
 */
async function uploadFileToFirebase({ tenantId, userId, file, file_id }) {
  requireTenantId(tenantId, 'uploadFileToFirebase');
  
  const inputFilePath = file.path;
  const inputBuffer = await fs.promises.readFile(inputFilePath);
  const bytes = Buffer.byteLength(inputBuffer);
  const fileName = `${file_id}__${path.basename(inputFilePath)}`;
  const basePath = 'uploads'; // Uploads use 'uploads' basePath
  
  try {
    const downloadURL = await saveBufferToFirebase({ tenantId, userId, buffer: inputBuffer, fileName, basePath });
    return { filepath: downloadURL, bytes };
  } catch (err) {
    logger.error('[uploadFileToFirebase] Error saving file buffer to Firebase:', err);
    try {
      if (file && file.path) {
        await fs.promises.unlink(file.path);
      }
    } catch (unlinkError) {
      logger.error(
        '[uploadFileToFirebase] Error deleting temporary file, likely already deleted:',
        unlinkError.message,
      );
    }
    throw err;
  }
}

/**
 * Retrieves a readable stream for a file from Firebase storage.
 * 
 * CLEAN-SLATE: Requires explicit tenantId, userId, basePath, fileName. No legacy path parsing.
 * Note: Firebase streams use download URLs, so we need to get the URL first.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - User ID
 * @param {string} params.basePath - Base path (e.g., 'images', 'documents', 'uploads')
 * @param {string} params.fileName - File name
 * @returns {Promise<ReadableStream>} A readable stream of the file.
 */
async function getFirebaseFileStream({ tenantId, userId, basePath, fileName }) {
  try {
    requireTenantId(tenantId, 'getFirebaseFileStream');
    
    // Get download URL using tenant-routed path
    const downloadURL = await getFirebaseURL({ tenantId, userId, fileName, basePath });
    
    if (!downloadURL) {
      throw new Error('Failed to get Firebase download URL');
    }

    const response = await axios({
      method: 'get',
      url: downloadURL,
      responseType: 'stream',
    });

    return response.data;
  } catch (error) {
    logger.error('[getFirebaseFileStream] Error getting Firebase file stream:', error);
    throw error;
  }
}

module.exports = {
  deleteFile,
  getFirebaseURL,
  saveURLToFirebase,
  deleteFirebaseFile,
  uploadFileToFirebase,
  saveBufferToFirebase,
  getFirebaseFileStream,
};
