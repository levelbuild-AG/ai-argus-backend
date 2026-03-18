const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { EModelEndpoint } = require('librechat-data-provider');
const { resizeImageBuffer } = require('~/server/services/Files/images/resize');
const { getBufferMetadata } = require('~/server/utils');
const { getRagApiHeaders } = require('~/server/utils/ragApiClient');
const paths = require('~/config/paths');
const {
  getTenantLocalPath,
  requireTenantId,
} = require('./tenantRouting');

/**
 * Saves a file to a specified output path with a new filename.
 *
 * @param {Express.Multer.File} file - The file object to be saved. Should contain properties like 'originalname' and 'path'.
 * @param {string} outputPath - The path where the file should be saved.
 * @param {string} outputFilename - The new filename for the saved file (without extension).
 * @returns {Promise<string>} The full path of the saved file.
 * @throws Will throw an error if the file saving process fails.
 */
async function saveLocalFile(file, outputPath, outputFilename) {
  try {
    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true });
    }

    const fileExtension = path.extname(file.originalname);
    const filenameWithExt = outputFilename + fileExtension;
    const outputFilePath = path.join(outputPath, filenameWithExt);
    fs.copyFileSync(file.path, outputFilePath);
    fs.unlinkSync(file.path);

    return outputFilePath;
  } catch (error) {
    logger.error('[saveFile] Error while saving the file:', error);
    throw error;
  }
}

/**
 * Saves an uploaded image file to a specified directory based on the user's ID and a filename.
 * 
 * CLEAN-SLATE: Requires explicit tenantId, userId. No legacy path support.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - User ID
 * @param {Express.Multer.File} params.file - The uploaded file object.
 * @param {string} params.filename - The new filename to assign to the saved image (without extension).
 * @param {Object} params.appConfig - App config (for system defaults)
 * @returns {Promise<string>} The relative path of the saved file (with tenant prefix).
 * @throws Will throw an error if the image saving process fails.
 */
const saveLocalImage = async ({ tenantId, userId, file, filename, appConfig }) => {
  requireTenantId(tenantId, 'saveLocalImage');
  
  // Get tenant-routed path for images
  const basePath = 'images';
  const fileName = filename + path.extname(file.originalname);
  
  const { fullPath, relativePath, baseDirectory } = await getTenantLocalPath({
    tenantId,
    basePath,
    userId,
    fileName,
    appConfig,
  });
  
  // Ensure directory exists
  if (!fs.existsSync(baseDirectory)) {
    fs.mkdirSync(baseDirectory, { recursive: true });
  }
  
  await saveLocalFile(file, baseDirectory, filename);
  
  return relativePath;
};

/**
 * Saves a buffer to a specified directory on the local file system.
 * 
 * CLEAN-SLATE: No legacy path support. File must be stored with tenant prefix.
 *
 * @param {Object} params - The parameters object.
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - The user's unique identifier.
 * @param {Buffer} params.buffer - The buffer to be saved.
 * @param {string} params.fileName - The name of the file to be saved.
 * @param {string} [params.basePath='images'] - Optional. The base path where the file will be stored.
 * @param {Object} params.appConfig - App config (for system defaults)
 * @returns {Promise<string>} - A promise that resolves to the relative path of the saved file.
 */
async function saveLocalBuffer({ tenantId, userId, buffer, fileName, basePath = 'images', appConfig }) {
  try {
    requireTenantId(tenantId, 'saveLocalBuffer');
    
    // Get tenant-routed path (always uses tenant prefix)
    const { fullPath, relativePath, baseDirectory } = await getTenantLocalPath({
      tenantId,
      basePath,
      userId,
      fileName,
      appConfig,
    });

    // Ensure directory exists
    if (!fs.existsSync(baseDirectory)) {
      fs.mkdirSync(baseDirectory, { recursive: true });
    }

    // Write file
    fs.writeFileSync(fullPath, buffer);

    return relativePath;
  } catch (error) {
    logger.error('[saveLocalBuffer] Error while saving the buffer:', error);
    throw error;
  }
}

/**
 * Saves a file from a given URL to a local directory.
 * 
 * CLEAN-SLATE: No legacy path support. File must be stored with tenant prefix.
 *
 * @param {Object} params - The parameters object.
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - The user's unique identifier.
 * @param {string} params.URL - The URL of the file to be downloaded and saved.
 * @param {string} params.fileName - The desired file name for the saved file.
 * @param {string} [params.basePath='images'] - Optional. The base directory where the file will be saved.
 * @param {Object} params.appConfig - App config (for system defaults)
 * @returns {Promise<{ bytes: number, type: string, dimensions: Record<string, number>} | null>}
 *          A promise that resolves to the file metadata if the file is successfully saved, or null if there is an error.
 */
async function saveFileFromURL({ tenantId, userId, URL, fileName, basePath = 'images', appConfig }) {
  try {
    requireTenantId(tenantId, 'saveFileFromURL');
    
    const response = await axios({
      url: URL,
      responseType: 'arraybuffer',
    });

    const buffer = Buffer.from(response.data, 'binary');
    const { bytes, type, dimensions, extension } = await getBufferMetadata(buffer);

    // Replace or append the correct extension
    const extRegExp = new RegExp(path.extname(fileName) + '$');
    const fileNameWithExt = fileName.replace(extRegExp, `.${extension}`);
    const finalFileName = path.extname(fileNameWithExt) ? fileNameWithExt : `${fileNameWithExt}.${extension}`;

    // Get tenant-routed path (always uses tenant prefix)
    const { fullPath, baseDirectory } = await getTenantLocalPath({
      tenantId,
      basePath,
      userId,
      fileName: finalFileName,
      appConfig,
    });

    // Ensure directory exists
    if (!fs.existsSync(baseDirectory)) {
      fs.mkdirSync(baseDirectory, { recursive: true });
    }

    // Save the file
    fs.writeFileSync(fullPath, buffer);

    return {
      bytes,
      type,
      dimensions,
    };
  } catch (error) {
    logger.error('[saveFileFromURL] Error while saving the file:', error);
    return null;
  }
}

/**
 * Constructs a local file URL for a given file name and base path.
 * 
 * CLEAN-SLATE: Requires explicit tenantId, userId. No legacy path support.
 *
 * @param {Object} params - The parameters object.
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - User ID
 * @param {string} params.fileName - The name of the file for which the path is to be constructed.
 * @param {string} [params.basePath='images'] - Optional. The base directory to be used for constructing the file path.
 * @param {Object} params.appConfig - App config (for system defaults)
 * @returns {Promise<string>} The constructed local file path (relative path with tenant prefix).
 */
async function getLocalFileURL({ tenantId, userId, fileName, basePath = 'images', appConfig }) {
  requireTenantId(tenantId, 'getLocalFileURL');
  
  const { relativePath } = await getTenantLocalPath({
    tenantId,
    basePath,
    userId,
    fileName,
    appConfig,
  });
  
  return relativePath;
}

/**
 * Validates if a given filepath is within a specified subdirectory under a base path. This function constructs
 * the expected base path using the base, subfolder, and user id from the request, and then checks if the
 * provided filepath starts with this constructed base path.
 *
 * @param {ServerRequest} req - The request object from Express. It should contain a `user` property with an `id`.
 * @param {string} base - The base directory path.
 * @param {string} subfolder - The subdirectory under the base path.
 * @param {string} filepath - The complete file path to be validated.
 *
 * @returns {boolean}
 *          Returns true if the filepath is within the specified base and subfolder, false otherwise.
 */
const isValidPath = (req, base, subfolder, filepath) => {
  const normalizedBase = path.resolve(base, subfolder, req.user.id);
  const normalizedFilepath = path.resolve(filepath);
  return normalizedFilepath.startsWith(normalizedBase);
};

/**
 * @param {string} filepath
 */
const unlinkFile = async (filepath) => {
  try {
    await fs.promises.unlink(filepath);
  } catch (error) {
    logger.error('Error deleting file:', error);
  }
};

/**
 * Deletes a file from the filesystem.
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
 * @param {Object} params.appConfig - App config (for system defaults)
 * @param {boolean} [params.embedded] - Whether file is embedded (for RAG API cleanup)
 * @param {string} [params.ragFileId] - File ID for RAG API cleanup (if embedded)
 * @param {string} [params.ragJwtToken] - JWT token for RAG API authentication (if embedded)
 * @param {string} [params.ragApiUrl] - RAG API URL (defaults to process.env.RAG_API_URL)
 * @returns {Promise<void>}
 */
const deleteLocalFile = async ({ tenantId, userId, basePath, fileName, appConfig, embedded, ragFileId, ragJwtToken, ragApiUrl }) => {
  requireTenantId(tenantId, 'deleteLocalFile');

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
        'Local/crud.deleteLocalFile'
      );
      
      axios.delete(`${apiUrl}/documents`, {
        headers,
        data: [ragFileId],
      }).catch((error) => {
        logger.error(`[deleteLocalFile] Error cleaning up RAG document ${ragFileId}:`, error.message);
      });
    }
  }

  // Get tenant-routed path (always uses tenant prefix)
  const { fullPath } = await getTenantLocalPath({
    tenantId,
    basePath,
    userId,
    fileName,
    appConfig,
  });

  await unlinkFile(fullPath);
};

/**
 * Uploads a file to the specified upload directory.
 * 
 * CLEAN-SLATE: Requires explicit tenantId, userId. No legacy path support.
 *
 * @param {Object} params - The params object.
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - User ID
 * @param {Express.Multer.File} params.file - The file object.
 * @param {string} params.file_id - The file ID.
 * @param {Object} params.appConfig - App config (for system defaults)
 * @returns {Promise<{ filepath: string, bytes: number, height?: number, width?: number }>}
 *          A promise that resolves to an object containing:
 *            - filepath: The relative path where the file is saved (with tenant prefix).
 *            - bytes: The size of the file in bytes.
 *            - height, width: Image dimensions (if image file).
 */
async function uploadLocalFile({ tenantId, userId, file, file_id, appConfig }) {
  requireTenantId(tenantId, 'uploadLocalFile');
  
  const inputFilePath = file.path;
  const inputBuffer = await fs.promises.readFile(inputFilePath);
  const bytes = Buffer.byteLength(inputBuffer);

  const fileName = `${file_id}__${path.basename(inputFilePath)}`;
  const basePath = 'uploads'; // Uploads use 'uploads' basePath

  // Get tenant-routed path (always uses tenant prefix)
  const { fullPath, relativePath, baseDirectory } = await getTenantLocalPath({
    tenantId,
    basePath,
    userId,
    fileName,
    appConfig,
  });

  // Ensure directory exists
  if (!fs.existsSync(baseDirectory)) {
    fs.mkdirSync(baseDirectory, { recursive: true });
  }

  // Write file
  await fs.promises.writeFile(fullPath, inputBuffer);

  let height, width;
  if (file.mimetype && file.mimetype.startsWith('image/')) {
    try {
      const { width: imgWidth, height: imgHeight } = await resizeImageBuffer(inputBuffer, 'high');
      height = imgHeight;
      width = imgWidth;
    } catch (error) {
      logger.warn('[uploadLocalFile] Could not get image dimensions:', error.message);
    }
  }

  return { filepath: relativePath, bytes, height, width };
}

/**
 * Retrieves a readable stream for a file from local storage.
 * 
 * CLEAN-SLATE: Requires explicit tenantId, userId, basePath, fileName. No legacy path parsing.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - User ID
 * @param {string} params.basePath - Base path (e.g., 'images', 'documents', 'uploads')
 * @param {string} params.fileName - File name
 * @param {Object} params.appConfig - App config (for system defaults)
 * @returns {Promise<ReadableStream>} A readable stream of the file.
 */
async function getLocalFileStream({ tenantId, userId, basePath, fileName, appConfig }) {
  try {
    requireTenantId(tenantId, 'getLocalFileStream');
    
    // Get tenant-routed path (always uses tenant prefix)
    const { fullPath } = await getTenantLocalPath({
      tenantId,
      basePath,
      userId,
      fileName,
      appConfig,
    });
    
    return fs.createReadStream(fullPath);
  } catch (error) {
    logger.error('[getLocalFileStream] Error getting local file stream:', error);
    throw error;
  }
}

module.exports = {
  saveLocalFile,
  saveLocalImage,
  saveLocalBuffer,
  saveFileFromURL,
  getLocalFileURL,
  deleteLocalFile,
  uploadLocalFile,
  getLocalFileStream,
  // Note: uploadLocalImage, prepareImagesLocal, processLocalAvatar are exported from ./images.js
};
