const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { z } = require('zod');
const { v4: uuidv4 } = require('uuid');
const { Tool } = require('@langchain/core/tools');
const { GoogleAuth } = require('google-auth-library');
const { logger } = require('@librechat/data-schemas');
const { FileContext, ContentTypes } = require('librechat-data-provider');
const { loadServiceKey, isMultiTenancyEnabled } = require('@librechat/api');
const { getTenantConfigService } = require('~/server/services/Config/TenantConfigService');
const paths = require('~/config/paths');

const displayMessage =
  "Google Imagen displayed an image. All generated images are already plainly visible, so don't repeat the descriptions in detail. Do not list download links as they are available in the UI already. The user may download the images by clicking on them, but do not mention anything about downloading to the user.";

class GoogleImagenAPI extends Tool {
  constructor(fields = {}) {
    super();
    /** @type {string} */
    this.userId = fields.userId;
    /** @type {ServerRequest | undefined} */
    this.req = fields.req; // Kept for uploadImageBuffer and other non-credential uses
    /** @type {string | undefined} */
    this.tenantId = fields.tenantId; // REQUIRED in multi-tenant mode, passed explicitly
    /** @type {boolean} */
    this.override = fields.override ?? false;
    /** @type {boolean} */
    this.returnMetadata = fields.returnMetadata ?? false;
    /** @type {boolean} */
    this.isAgent = fields.isAgent;

    if (fields.uploadImageBuffer) {
      /** bind uploadImageBuffer from ToolService */
      this.uploadImageBuffer = fields.uploadImageBuffer.bind(this);
    }

    this.name = 'google-imagen';
    this.description_for_model = `// Generate images using Google's Imagen 3 / Imagen 4 models on Vertex AI.
// Guidelines:
// - Use a concise but detailed visual description: subject, style, lighting, camera/view, mood.
// - Avoid excessively long prompts; focus on key visual features.
// - If the user wants multiple images, set "number_of_images" to 2–4.
// - Do NOT describe download mechanics; images are visible in the UI.
// - Generate images only once per user query unless the user explicitly asks for more.`;
    this.description = 'Generate images from text using Google Vertex AI Imagen models (3 / 4).';

    this.schema = z.object({
      prompt: z
        .string()
        .min(1)
        .describe('The text prompt describing the desired image content.'),
      negative_prompt: z
        .string()
        .optional()
        .describe('Optional negative prompt to suppress unwanted concepts.'),
      aspect_ratio: z
        .enum(['1:1', '16:9', '9:16', '4:3', '3:4', '2:3', '3:2'])
        .optional()
        .describe('Optional aspect ratio for the generated image. Defaults to 1:1.'),
      image_size: z
        .enum(['1K', '2K'])
        .optional()
        .describe('Optional size hint for Imagen (sampleImageSize). Defaults to 1K.'),
      safety_filter_level: z
        .enum(['block_most', 'block_some', 'block_few'])
        .optional()
        .describe('Content safety strictness. Defaults to block_some.'),
      person_generation: z
        .enum(['allow_adult', 'allow_all'])
        .optional()
        .describe('Controls depiction of people. Defaults to allow_adult.'),
      seed: z
        .number()
        .int()
        .min(0)
        .max(4294967295)
        .optional()
        .describe('Optional seed for reproducibility.'),
      number_of_images: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional()
        .describe('Number of images to generate (1–4). Defaults to 1.'),
      model_version: z
        .string()
        .optional()
        .describe(
          'Optional Imagen model version override, e.g. "imagen-3.0-generate-001" or "imagen-4.0-generate-001".',
        ),
    });
  }

  replaceNewLinesWithSpaces(input = '') {
    return input.replace(/\r\n|\r|\n/g, ' ');
  }

  returnValue(value) {
    if (this.isAgent === true && typeof value === 'string') {
      return [value, {}];
    } else if (this.isAgent === true && typeof value === 'object') {
      return [displayMessage, value];
    }
    return value;
  }

  ensureUserDirectory() {
    const { imageOutput } = paths;
    if (!this.userId) {
      throw new Error('User ID required to save generated images.');
    }
    const dir = path.join(imageOutput, this.userId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  getMarkdownImageUrl(imageName) {
    const { imageOutput, clientPath } = paths;
    const relativePath = path.relative(clientPath, imageOutput).replace(/\\/g, '/');
    const imageUrl = path.join(relativePath, this.userId, imageName).replace(/\\/g, '/');
    return `![generated image](/${imageUrl})`;
  }

  /**
   * Get Google service account credentials from tenant config or env.
   *
   * Uses this.tenantId (passed explicitly), NOT req.user.tenantId.
   * This ensures tools work in background jobs, SSE, and other non-request contexts.
   *
   * The underlying helper `loadServiceKey` supports:
   * - base64-encoded JSON
   * - raw JSON string
   * - URL returning JSON
   * - filesystem path to JSON
   *
   * @returns {Promise<object|null>} Parsed service account JSON, or null if not configured
   */
  async getServiceAccount() {
    let keySource;

    if (isMultiTenancyEnabled() && this.tenantId) {
      const service = getTenantConfigService();
      const tenantConfig = await service.getTenantConfig(this.tenantId);
      keySource = tenantConfig.secrets?.googleServiceKeyFile;

      if (!keySource && !this.override) {
        throw new Error(
          `Tenant '${this.tenantId}' has Google Imagen enabled but missing required secret: googleServiceKeyFile`,
        );
      }
    } else {
      keySource = process.env.GOOGLE_SERVICE_KEY_FILE;
    }

    if (!keySource) {
      return null;
    }

    const serviceKey = await loadServiceKey(keySource);
    if (!serviceKey && !this.override) {
      throw new Error('Google service account could not be loaded for Google Imagen.');
    }

    return serviceKey;
  }

  /**
   * Get Google Cloud project ID from tenant config or env
   * 
   * CRITICAL: Uses this.tenantId (passed explicitly), NOT req.user.tenantId
   * 
   * @returns {Promise<string|undefined>} Project ID
   */
  async getProjectId() {
    if (isMultiTenancyEnabled() && this.tenantId) {
      // Multi-tenancy enabled: check tenant config first, then fall back to env
      const service = getTenantConfigService();
      const tenantConfig = await service.getTenantConfig(this.tenantId);
      
      // Check merged settings (could be in librechatSettings override)
      // These settings might be in the merged config structure
      const projectId = tenantConfig.settings?.GOOGLE_CLOUD_PROJECT || 
                       tenantConfig.settings?.googleCloudProject ||
                       process.env.GOOGLE_CLOUD_PROJECT;
      
      if (!projectId && !this.override) {
        throw new Error(
          `Tenant '${this.tenantId}' has Google Imagen enabled but missing required setting: GOOGLE_CLOUD_PROJECT or googleCloudProject`,
        );
      }
      return projectId;
    }
    
    // Single-tenant mode OR multi-tenant mode without tenantId: use env var
    const projectId = process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId && !this.override) {
      throw new Error('Missing GOOGLE_CLOUD_PROJECT environment variable for Google Imagen.');
    }
    return projectId;
  }

  /**
   * Get Google Vertex location from tenant config or env
   * 
   * CRITICAL: Uses this.tenantId (passed explicitly), NOT req.user.tenantId
   * 
   * @returns {Promise<string|undefined>} Location
   */
  async getLocation() {
    if (isMultiTenancyEnabled() && this.tenantId) {
      // Multi-tenancy enabled: check tenant config first, then fall back to env
      const service = getTenantConfigService();
      const tenantConfig = await service.getTenantConfig(this.tenantId);
      
      // Check merged settings (could be in librechatSettings override)
      const location = tenantConfig.settings?.GOOGLE_VERTEX_LOCATION ||
                       tenantConfig.settings?.GOOGLE_LOC ||
                       tenantConfig.settings?.googleVertexLocation ||
                       tenantConfig.settings?.googleLoc ||
                       process.env.GOOGLE_VERTEX_LOCATION ||
                       process.env.GOOGLE_LOC;
      
      if (!location && !this.override) {
        throw new Error(
          `Tenant '${this.tenantId}' has Google Imagen enabled but missing required setting: GOOGLE_VERTEX_LOCATION or GOOGLE_LOC`,
        );
      }
      return location;
    }
    
    // Single-tenant mode OR multi-tenant mode without tenantId: use env var
    const location = process.env.GOOGLE_VERTEX_LOCATION || process.env.GOOGLE_LOC;
    if (!location && !this.override) {
      throw new Error('Missing GOOGLE_VERTEX_LOCATION or GOOGLE_LOC for Google Imagen.');
    }
    return location;
  }

  async getAccessToken() {
    const serviceKey = await this.getServiceAccount();
    if (!serviceKey && !this.override) {
      throw new Error('Missing Google service account credentials for Google Imagen.');
    }

    const authOptions = {
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    };

    if (serviceKey) {
      authOptions.credentials = serviceKey;
    }

    const auth = new GoogleAuth(authOptions);
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    return accessToken?.token || accessToken;
  }

  getModelVersion(modelOverride) {
    return (
      modelOverride ||
      process.env.GOOGLE_IMAGEN_MODEL ||
      'imagen-4.0-generate-001'
    );
  }

  buildRequestBody(data) {
    const {
      prompt,
      negative_prompt,
      aspect_ratio,
      image_size,
      number_of_images,
      safety_filter_level,
      person_generation,
      seed,
    } = data;

    const instance = {
      prompt: this.replaceNewLinesWithSpaces(prompt),
    };

    const parameters = {
      sampleCount: Math.min(Math.max(number_of_images ?? 1, 1), 4),
      aspectRatio: aspect_ratio || '1:1',
      safetyFilterLevel: safety_filter_level || 'block_some',
      personGeneration: person_generation || 'allow_adult',
    };

    if (image_size) {
      parameters.sampleImageSize = image_size;
    }

    if (typeof seed === 'number') {
      parameters.seed = seed;
    }

    if (negative_prompt && negative_prompt.trim().length > 0) {
      parameters.negativePrompt = this.replaceNewLinesWithSpaces(negative_prompt);
    }

    return {
      instances: [instance],
      parameters,
    };
  }

  async callImagenAPI(data) {
    const projectId = await this.getProjectId();
    const location = await this.getLocation();
    const modelVersion = this.getModelVersion(data.model_version);
    const accessToken = await this.getAccessToken();

    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${modelVersion}:predict`;
    const body = this.buildRequestBody(data);

    try {
      const response = await axios.post(url, body, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        timeout: 60000,
      });

      const predictions = Array.isArray(response.data?.predictions)
        ? response.data.predictions
        : [];

      const images = predictions
        .map((prediction) => {
          return (
            prediction?.bytesBase64Encoded ||
            prediction?.structValue?.fields?.bytesBase64Encoded?.stringValue ||
            null
          );
        })
        .filter(Boolean);

      if (!images.length) {
        throw new Error('Google Imagen response did not include image data.');
      }

      return {
        images,
        rawPredictions: predictions,
        modelVersion,
      };
    } catch (error) {
      const details = error?.response?.data || error.message;
      logger.error('[GoogleImagen] Error calling Vertex AI Imagen', details);
      throw new Error('Error calling Google Imagen API.');
    }
  }

  async handleAgentResponse(images) {
    const content = images.map((base64) => ({
      type: ContentTypes.IMAGE_URL,
      image_url: {
        url: `data:image/png;base64,${base64}`,
      },
    }));

    const response = [
      {
        type: ContentTypes.TEXT,
        text: displayMessage,
      },
    ];

    return [response, { content }];
  }

  async storeImage(buffer, prompt, metadata) {
    const file_id = uuidv4();
    const imageName = `${file_id}.png`;
    const userDir = this.ensureUserDirectory();
    const filepath = path.join(userDir, imageName);

    let dimensions = {};
    try {
      dimensions = await sharp(buffer).metadata();
    } catch (error) {
      logger.warn('[GoogleImagen] Unable to read image metadata', error?.message || error);
    }

    if (!this.isAgent && this.returnMetadata && this.uploadImageBuffer && this.req) {
      const file = await this.uploadImageBuffer({
        req: this.req,
        context: FileContext.image_generation,
        resize: false,
        metadata: {
          buffer,
          height: dimensions.height,
          width: dimensions.width,
          bytes: Buffer.byteLength(buffer),
          filename: imageName,
          type: 'image/png',
          file_id,
        },
      });

      return {
        ...file,
        prompt,
        metadata,
      };
    }

    try {
      await sharp(buffer).toFile(filepath);
    } catch (error) {
      logger.error('[GoogleImagen] Error while saving the image', error);
      throw new Error('Failed to save Google Imagen output to disk.');
    }

    return this.getMarkdownImageUrl(imageName);
  }

  async _call(data) {
    let result;
    try {
      result = await this.callImagenAPI(data);
    } catch (error) {
      return this.returnValue('Error generating image with Google Imagen.');
    }

    const { images, rawPredictions, modelVersion } = result;

    if (this.isAgent) {
      return this.handleAgentResponse(images);
    }

    const primaryImage = images[0];
    const buffer = Buffer.from(primaryImage, 'base64');
    const metadata = {
      modelVersion,
      rawPredictions,
    };

    try {
      const stored = await this.storeImage(buffer, data.prompt, metadata);
      return this.returnValue(stored);
    } catch (error) {
      logger.error('[GoogleImagen] Error handling generated image', error);
      return this.returnValue('Error saving image generated by Google Imagen.');
    }
  }
}

module.exports = GoogleImagenAPI;
