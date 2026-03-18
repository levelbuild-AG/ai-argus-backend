const axios = require('axios');
const { isEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { ErrorTypes } = require('librechat-data-provider');
const denyRequest = require('./denyRequest');
const { getTenantConfigService } = require('~/server/services/Config/TenantConfigService');

/**
 * Resolve moderation API key and base URL.
 * Always uses tenant config (no process.env). Requires req.tenantContext.tenantId.
 */
async function getModerationCredentials(req) {
  const tenantId = req.tenantContext && req.tenantContext.tenantId;
  if (!tenantId) {
    throw new Error(
      'Tenant ID required for moderation. Ensure requireTenantContext runs before moderateText.',
    );
  }

  const service = getTenantConfigService();
  const config = await service.getTenantConfig(tenantId);
  const apiKey = config.secrets?.openAiApiKey;
  if (!apiKey) {
    throw new Error(
      `Tenant '${tenantId}' has moderation enabled but no openAiApiKey configured. Configure the key or disable OPENAI_MODERATION.`,
    );
  }

  const baseURL =
    config.settings?.OPENAI_MODERATION_REVERSE_PROXY || 'https://api.openai.com/v1/moderations';

  return { apiKey, baseURL };
}

async function moderateText(req, res, next) {
  if (!isEnabled(process.env.OPENAI_MODERATION)) {
    return next();
  }
  try {
    const credentials = await getModerationCredentials(req);
    const { text } = req.body;
    const response = await axios.post(
      credentials.baseURL,
      {
        input: text,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credentials.apiKey}`,
        },
      },
    );

    const results = response.data.results;
    const flagged = results.some((result) => result.flagged);

    if (flagged) {
      const type = ErrorTypes.MODERATION;
      const errorMessage = { type };
      return await denyRequest(req, res, errorMessage);
    }
  } catch (error) {
    logger.error('Error in moderateText:', error);
    const errorMessage = 'error in moderation check';
    return await denyRequest(req, res, errorMessage);
  }
  next();
}

module.exports = moderateText;
