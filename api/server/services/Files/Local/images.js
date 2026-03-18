const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { resizeImageBuffer } = require('../images/resize');
const { updateUser, updateFile } = require('~/models');
const { getTenantLocalPath, requireTenantId } = require('./tenantRouting');
const { saveLocalBuffer } = require('./crud');

/**
 * Converts an image file to the target format. The function first resizes the image based on the specified
 * resolution.
 * 
 * CLEAN-SLATE: Requires explicit tenantId, userId. No legacy path support.
 *
 * @param {Object} params - The params object.
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {string} params.userId - User ID
 * @param {Express.Multer.File} params.file - The file object.
 * @param {string} params.file_id - The file ID.
 * @param {EModelEndpoint} params.endpoint - The endpoint.
 * @param {string} [params.resolution='high'] - Optional. The desired resolution for the image resizing. Default is 'high'.
 * @param {Object} params.appConfig - App config (for system defaults)
 * @returns {Promise<{ filepath: string, bytes: number, width: number, height: number}>}
 *          A promise that resolves to an object containing:
 *            - filepath: The relative path where the converted image is saved (with tenant prefix).
 *            - bytes: The size of the converted image in bytes.
 *            - width: The width of the converted image.
 *            - height: The height of the converted image.
 */
async function uploadLocalImage({ tenantId, userId, file, file_id, endpoint, resolution = 'high', appConfig }) {
  requireTenantId(tenantId, 'uploadLocalImage');
  
  const inputFilePath = file.path;
  const inputBuffer = await fs.promises.readFile(inputFilePath);
  const {
    buffer: resizedBuffer,
    width,
    height,
  } = await resizeImageBuffer(inputBuffer, resolution, endpoint);
  const extension = path.extname(inputFilePath);

  const basePath = 'images';
  const baseFileName = `${file_id}__${path.basename(inputFilePath)}`;
  const targetExtension = `.${appConfig.imageOutputType}`;
  
  let fileName, processedBuffer;
  if (extension.toLowerCase() === targetExtension) {
    fileName = baseFileName;
    processedBuffer = resizedBuffer;
  } else {
    fileName = baseFileName.replace(extension, targetExtension);
    processedBuffer = await sharp(resizedBuffer).toFormat(appConfig.imageOutputType).toBuffer();
  }

  // Use saveLocalBuffer for tenant-aware path routing
  const filepath = await saveLocalBuffer({
    tenantId,
    userId,
    buffer: processedBuffer,
    fileName,
    basePath,
    appConfig,
  });

  await fs.promises.unlink(inputFilePath);
  const bytes = Buffer.byteLength(processedBuffer);
  return { filepath, bytes, width, height };
}

/**
 * Encodes an image file to base64.
 * @param {string} imagePath - The path to the image file.
 * @returns {Promise<string>} A promise that resolves with the base64 encoded image data.
 */
function encodeImage(imagePath) {
  return new Promise((resolve, reject) => {
    fs.readFile(imagePath, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data.toString('base64'));
      }
    });
  });
}

/**
 * Local: Updates the file and encodes the image to base64,
 * for image payload handling: tuple order of [filepath, base64].
 * 
 * CLEAN-SLATE: Requires explicit tenantId, userId. Uses tenant-routed path.
 * 
 * @param {Object} req - The request object (must have tenantContext).
 * @param {MongoFile} file - The file object (must have user, filename, context).
 * @returns {Promise<[MongoFile, string]>} - A promise that resolves to an array of results from updateFile and encodeImage.
 */
async function prepareImagesLocal(req, file) {
  const tenantId = req?.tenantContext?.tenantId;
  if (!tenantId) {
    throw new Error('Tenant ID required for prepareImagesLocal. Ensure requireTenantContext middleware runs.');
  }
  
  const appConfig = req.config;
  
  // Extract basePath from file context
  const basePath = file.context === 'documents' ? 'documents' : 'images';
  
  // Get tenant-routed full path
  const { fullPath } = await getTenantLocalPath({
    tenantId,
    basePath,
    userId: file.user || req.user.id,
    fileName: file.filename || file.filepath?.split('/').pop() || '',
    appConfig,
  });

  const promises = [];
  promises.push(updateFile({ file_id: file.file_id }));
  promises.push(encodeImage(fullPath));
  return await Promise.all(promises);
}

/**
 * Uploads a user's avatar to local server storage and returns the URL.
 * 
 * CLEAN-SLATE: Requires explicit tenantId. No legacy path support.
 *
 * @param {object} params - The parameters object.
 * @param {string} params.tenantId - Tenant ID (REQUIRED)
 * @param {Buffer} params.buffer - The Buffer containing the avatar image.
 * @param {string} params.userId - The user ID.
 * @param {string} params.manual - A string flag indicating whether the update is manual ('true' or 'false').
 * @param {string} [params.agentId] - Optional agent ID if this is an agent avatar.
 * @param {Object} params.appConfig - App config (for system defaults)
 * @returns {Promise<string>} - A promise that resolves with the URL of the uploaded avatar (with tenant prefix).
 * @throws {Error} - Throws an error if tenantId is missing or if there is an error in uploading.
 */
async function processLocalAvatar({ tenantId, buffer, userId, manual, agentId, appConfig }) {
  requireTenantId(tenantId, 'processLocalAvatar');

  const metadata = await sharp(buffer).metadata();
  const extension = metadata.format === 'gif' ? 'gif' : 'png';

  const timestamp = new Date().getTime();
  /** Unique filename with timestamp and optional agent ID */
  const fileName = agentId
    ? `agent-${agentId}-avatar-${timestamp}.${extension}`
    : `avatar-${timestamp}.${extension}`;

  const basePath = 'images';

  // Use saveLocalBuffer for tenant-aware path routing
  const filepath = await saveLocalBuffer({
    tenantId,
    userId,
    buffer,
    fileName,
    basePath,
    appConfig,
  });

  const isManual = manual === 'true';
  let url = `${filepath}?manual=${isManual}`;

  // Only update user record if this is a user avatar (manual === 'true')
  if (isManual && !agentId) {
    await updateUser(userId, { avatar: url });
  }

  return url;
}

module.exports = { uploadLocalImage, encodeImage, prepareImagesLocal, processLocalAvatar };
