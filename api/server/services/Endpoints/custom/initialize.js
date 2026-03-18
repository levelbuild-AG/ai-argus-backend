const { isUserProvided, getOpenAIConfig, getCustomEndpointConfig } = require('@librechat/api');
const {
  CacheKeys,
  ErrorTypes,
  FetchTokenConfig,
} = require('librechat-data-provider');
const { getUserKeyValues, checkUserKeyExpiry } = require('~/server/services/UserService');
const { fetchModels } = require('~/server/services/ModelService');
const OpenAIClient = require('~/app/clients/OpenAIClient');
const getLogStores = require('~/cache/getLogStores');
const { getTenantCustomEndpointConfig } = require('./tenantConfig');

const { PROXY } = process.env;

const initializeClient = async ({ req, res, endpointOption, optionsOnly, overrideEndpoint }) => {
  const appConfig = req.config;
  const { key: expiresAt } = req.body;
  const endpoint = overrideEndpoint ?? req.body.endpoint;

  // ALWAYS-ON MULTI-TENANCY: Multi-tenancy is the only supported mode. Custom endpoint configs
  // must come from tenant config when available, fallback to global config for non-secret fields.
  // No process.env fallback for credentials in tenant mode.

  // Require tenantId from request context
  const tenantId = req?.tenantContext?.tenantId;
  if (!tenantId) {
    throw new Error(
      '[initializeClient] Tenant ID is required for custom endpoint operations. ' +
      'Ensure requireTenantContext middleware runs before custom endpoint calls.'
    );
  }

  // ALWAYS-ON MULTI-TENANCY: Require tenant-specific custom endpoint config.
  // No fallback to global config for credentials (apiKey, baseURL).
  // Fail hard if tenant has no mapping for this endpoint.

  // Get global endpoint config first (for non-secret fields like headers, params, etc.)
  const endpointConfig = getCustomEndpointConfig({
    endpoint,
    appConfig,
  });
  if (!endpointConfig) {
    throw new Error(`Config not found for the ${endpoint} custom endpoint.`);
  }

  // Try to get tenant-specific custom endpoint config
  let tenantEndpointConfig = null;
  try {
    tenantEndpointConfig = await getTenantCustomEndpointConfig(tenantId, endpoint);
  } catch (error) {
    // LOGGING SAFETY: Do not log tenantEndpointConfig or any merged object (may contain apiKey/headers).
    // Only rethrow with error.message (already safe, no secrets).
    throw new Error(
      `[initializeClient] Failed to load tenant custom endpoint config: ${error.message}`
    );
  }

  // ALWAYS-ON: Require tenant config for credentials - no fallback to global/env
  if (!tenantEndpointConfig) {
    throw new Error(
      `Tenant '${tenantId}' has no configuration for custom endpoint '${endpoint}'. ` +
      `Tenant config must include customEndpoints['${endpoint}'] with apiKey and baseURL. ` +
      `No fallback to global config in always-on multi-tenancy mode.`
    );
  }

  // Use tenant config for credentials (no env variable extraction needed)
  // Tenant config values are actual values, not env var references
  let CUSTOM_API_KEY = tenantEndpointConfig.apiKey;
  let CUSTOM_BASE_URL = tenantEndpointConfig.baseURL;

  // Validate tenant-provided values are not empty
  if (!CUSTOM_API_KEY || CUSTOM_API_KEY.trim() === '') {
    throw new Error(`Tenant '${tenantId}' custom endpoint '${endpoint}' has empty apiKey.`);
  }

  if (!CUSTOM_BASE_URL || CUSTOM_BASE_URL.trim() === '') {
    throw new Error(`Tenant '${tenantId}' custom endpoint '${endpoint}' has empty baseURL.`);
  }

  CUSTOM_API_KEY = CUSTOM_API_KEY.trim();
  CUSTOM_BASE_URL = CUSTOM_BASE_URL.trim();

  // Check if tenant config indicates user-provided keys (for user key override support)
  const userProvidesKey = isUserProvided(CUSTOM_API_KEY);
  const userProvidesURL = isUserProvided(CUSTOM_BASE_URL);

  let userValues = null;
  if (expiresAt && (userProvidesKey || userProvidesURL)) {
    checkUserKeyExpiry(expiresAt, endpoint);
    userValues = await getUserKeyValues({ userId: req.user.id, name: endpoint });
  }

  let apiKey = userProvidesKey ? userValues?.apiKey : CUSTOM_API_KEY;
  let baseURL = userProvidesURL ? userValues?.baseURL : CUSTOM_BASE_URL;

  if (userProvidesKey & !apiKey) {
    throw new Error(
      JSON.stringify({
        type: ErrorTypes.NO_USER_KEY,
      }),
    );
  }

  if (userProvidesURL && !baseURL) {
    throw new Error(
      JSON.stringify({
        type: ErrorTypes.NO_BASE_URL,
      }),
    );
  }

  if (!apiKey) {
    throw new Error(`${endpoint} API key not provided.`);
  }

  if (!baseURL) {
    throw new Error(`${endpoint} Base URL not provided.`);
  }

  const cache = getLogStores(CacheKeys.TOKEN_CONFIG);
  const tokenKey =
    !endpointConfig.tokenConfig && (userProvidesKey || userProvidesURL)
      ? `${endpoint}:${req.user.id}`
      : endpoint;

  let endpointTokenConfig =
    !endpointConfig.tokenConfig &&
    FetchTokenConfig[endpoint.toLowerCase()] &&
    (await cache.get(tokenKey));

  if (
    FetchTokenConfig[endpoint.toLowerCase()] &&
    endpointConfig &&
    endpointConfig.models.fetch &&
    !endpointTokenConfig
  ) {
    await fetchModels({ apiKey, baseURL, name: endpoint, user: req.user.id, tokenKey });
    endpointTokenConfig = await cache.get(tokenKey);
  }

  // Merge tenant-specific headers if provided
  const mergedHeaders = tenantEndpointConfig?.headers
    ? { ...endpointConfig.headers, ...tenantEndpointConfig.headers }
    : endpointConfig.headers;

  const customOptions = {
    headers: mergedHeaders,
    addParams: endpointConfig.addParams,
    dropParams: endpointConfig.dropParams,
    customParams: endpointConfig.customParams,
    titleConvo: endpointConfig.titleConvo,
    titleModel: endpointConfig.titleModel,
    forcePrompt: endpointConfig.forcePrompt,
    summaryModel: endpointConfig.summaryModel,
    modelDisplayLabel: endpointConfig.modelDisplayLabel,
    titleMethod: endpointConfig.titleMethod ?? 'completion',
    contextStrategy: endpointConfig.summarize ? 'summarize' : null,
    directEndpoint: endpointConfig.directEndpoint,
    titleMessageRole: endpointConfig.titleMessageRole,
    streamRate: endpointConfig.streamRate,
    endpointTokenConfig,
  };

  const allConfig = appConfig.endpoints?.all;
  if (allConfig) {
    customOptions.streamRate = allConfig.streamRate;
  }

  let clientOptions = {
    reverseProxyUrl: baseURL ?? null,
    proxy: PROXY ?? null,
    req,
    res,
    ...customOptions,
    ...endpointOption,
  };

  if (optionsOnly) {
    const modelOptions = endpointOption?.model_parameters ?? {};
    clientOptions = Object.assign(
      {
        modelOptions,
      },
      clientOptions,
    );
    clientOptions.modelOptions.user = req.user.id;
    const options = getOpenAIConfig(apiKey, clientOptions, endpoint);
    if (options != null) {
      options.useLegacyContent = true;
      options.endpointTokenConfig = endpointTokenConfig;
    }
    if (!clientOptions.streamRate) {
      return options;
    }
    options.llmConfig._lc_stream_delay = clientOptions.streamRate;
    return options;
  }

  const client = new OpenAIClient(apiKey, clientOptions);
  return {
    client,
    openAIApiKey: apiKey,
  };
};

module.exports = initializeClient;
