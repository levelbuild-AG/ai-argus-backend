const { getLLMConfig, isMultiTenancyEnabled } = require('@librechat/api');
const { EModelEndpoint } = require('librechat-data-provider');
const { getUserKey, checkUserKeyExpiry } = require('~/server/services/UserService');
const AnthropicClient = require('~/app/clients/AnthropicClient');
const { loadTenantAnthropicCredentials } = require('./tenantClient');

/**
 * Initialize Anthropic client. In multi-tenant mode, tenantId is required and must be passed
 * explicitly. Request-scoped callers may use the convenience fallback from req.tenantContext.tenantId.
 *
 * @param {Object} params
 * @param {string} [params.tenantId] - Tenant ID (explicit-first; required in multi-tenant mode)
 * @param {Object} params.req - Express request (req.tenantContext.tenantId used as convenience fallback only)
 * @param {Object} params.res - Express response
 * @param {Object} [params.endpointOption] - Endpoint options
 * @param {string} [params.overrideModel] - Override model
 * @param {boolean} [params.optionsOnly] - If true, return config only
 * @returns {Promise<{ client?: import('~/app/clients/AnthropicClient'), anthropicApiKey: string }>}
 * @throws {Error} If multi-tenancy enabled and tenantId missing
 */
const initializeClient = async ({
  tenantId: providedTenantId,
  req,
  res,
  endpointOption,
  overrideModel,
  optionsOnly,
}) => {
  const appConfig = req.config;
  const { ANTHROPIC_API_KEY, ANTHROPIC_REVERSE_PROXY, PROXY } = process.env;
  const expiresAt = req.body?.key;
  const isUserProvided = ANTHROPIC_API_KEY === 'user_provided';

  const tenantId = providedTenantId ?? req?.tenantContext?.tenantId;

  if (!tenantId) {
    throw new Error(
      'Tenant ID required for Anthropic client initialization. ' +
        'Pass tenantId explicitly or ensure req.tenantContext.tenantId is set.',
    );
  }

  let anthropicApiKey = isUserProvided
    ? await getUserKey({ userId: req.user.id, name: EModelEndpoint.anthropic })
    : null;

  if (!isUserProvided) {
    const tenantCreds = await loadTenantAnthropicCredentials(tenantId);
    anthropicApiKey = tenantCreds.anthropicApiKey;
  }

  if (!anthropicApiKey) {
    throw new Error('Anthropic API key not provided. Please provide it again.');
  }

  if (expiresAt && isUserProvided) {
    checkUserKeyExpiry(expiresAt, EModelEndpoint.anthropic);
  }

  let clientOptions = {};

  /** @type {undefined | TBaseEndpoint} */
  const anthropicConfig = appConfig.endpoints?.[EModelEndpoint.anthropic];

  if (anthropicConfig) {
    clientOptions._lc_stream_delay = anthropicConfig.streamRate;
    clientOptions.titleModel = anthropicConfig.titleModel;
  }

  const allConfig = appConfig.endpoints?.all;
  if (allConfig) {
    clientOptions._lc_stream_delay = allConfig.streamRate;
  }

  if (optionsOnly) {
    clientOptions = Object.assign(
      {
        proxy: PROXY ?? null,
        reverseProxyUrl: ANTHROPIC_REVERSE_PROXY ?? null,
        modelOptions: endpointOption?.model_parameters ?? {},
      },
      clientOptions,
    );
    if (overrideModel) {
      clientOptions.modelOptions.model = overrideModel;
    }
    clientOptions.modelOptions.user = req.user.id;
    return getLLMConfig(anthropicApiKey, clientOptions);
  }

  const client = new AnthropicClient(anthropicApiKey, {
    req,
    res,
    reverseProxyUrl: ANTHROPIC_REVERSE_PROXY ?? null,
    proxy: PROXY ?? null,
    ...clientOptions,
    ...endpointOption,
  });

  return {
    client,
    anthropicApiKey,
  };
};

module.exports = initializeClient;
