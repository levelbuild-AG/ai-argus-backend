const axios = require('axios');
const { Providers } = require('@librechat/agents');
const { logger } = require('@librechat/data-schemas');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { logAxiosError, inputSchema, processModelData } = require('@librechat/api');
const { EModelEndpoint, defaultModels, CacheKeys } = require('librechat-data-provider');
const { OllamaClient } = require('~/app/clients/OllamaClient');
const { isUserProvided } = require('~/server/utils');
const { loadTenantAnthropicCredentials } = require('~/server/services/Endpoints/anthropic/tenantClient');
const getLogStores = require('~/cache/getLogStores');
const { extractBaseURL } = require('~/utils');

/**
 * Splits a string by commas and trims each resulting value.
 * @param {string} input - The input string to split.
 * @returns {string[]} An array of trimmed values.
 */
const splitAndTrim = (input) => {
  if (!input || typeof input !== 'string') {
    return [];
  }
  return input
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const { openAIApiKey, userProvidedOpenAI } = require('./Config/EndpointService').config;

const toUserId = (user) => {
  if (!user) {
    return undefined;
  }
  if (typeof user === 'string') {
    return user;
  }
  return user.id || user.user || user.userId;
};

const DEFAULT_ENDPOINT_TAGS = {
  [EModelEndpoint.openAI]: ['chat'],
  [EModelEndpoint.azureOpenAI]: ['chat'],
  [EModelEndpoint.assistants]: ['chat', 'tools'],
  [EModelEndpoint.azureAssistants]: ['chat', 'tools'],
  [EModelEndpoint.anthropic]: ['chat'],
  [EModelEndpoint.google]: ['chat'],
  [EModelEndpoint.bedrock]: ['chat'],
};

const normalizeModelDescriptor = (model, endpoint) => {
  if (!model) {
    return null;
  }

  if (typeof model === 'string') {
    return {
      id: model,
      name: model,
      endpoint,
      contextWindow: null,
      inputPrice: null,
      outputPrice: null,
      tags: [],
    };
  }

  const id = model.id || model.name || model.model || model.slug;
  if (!id) {
    return null;
  }

  const fallbackTags = DEFAULT_ENDPOINT_TAGS[endpoint] || [];
  const derivedTags = Array.isArray(model.tags)
    ? model.tags
    : Array.isArray(model.capabilities)
      ? model.capabilities
      : null;

  return {
    id,
    name: model.label || model.name || id,
    endpoint,
    contextWindow: model.contextWindow ?? model.context ?? null,
    inputPrice: model.inputPrice ?? null,
    outputPrice: model.outputPrice ?? null,
    tags: derivedTags ?? fallbackTags,
  };
};

/**
 * Fetches OpenAI models from the specified base API path or Azure, based on the provided configuration.
 *
 * @param {Object} params - The parameters for fetching the models.
 * @param {Object} params.user - The user ID to send to the API.
 * @param {string} params.apiKey - The API key for authentication with the API.
 * @param {string} params.baseURL - The base path URL for the API.
 * @param {string} [params.name='OpenAI'] - The name of the API; defaults to 'OpenAI'.
 * @param {boolean} [params.direct=false] - Whether `directEndpoint` was configured
 * @param {boolean} [params.azure=false] - Whether to fetch models from Azure.
 * @param {boolean} [params.userIdQuery=false] - Whether to send the user ID as a query parameter.
 * @param {boolean} [params.createTokenConfig=true] - Whether to create a token configuration from the API response.
 * @param {string} [params.tokenKey] - The cache key to save the token configuration. Uses `name` if omitted.
 * @param {Record<string, string>} [params.headers] - Optional headers for the request.
 * @param {Partial<IUser>} [params.userObject] - Optional user object for header resolution.
 * @returns {Promise<string[]>} A promise that resolves to an array of model identifiers.
 * @async
 */
const fetchModels = async ({
  user,
  apiKey,
  baseURL: _baseURL,
  name = EModelEndpoint.openAI,
  direct,
  azure = false,
  userIdQuery = false,
  createTokenConfig = true,
  tokenKey,
  headers,
  userObject,
}) => {
  let models = [];
  const baseURL = direct ? extractBaseURL(_baseURL) : _baseURL;

  if (!baseURL && !azure) {
    return models;
  }

  if (!apiKey) {
    return models;
  }

  if (name && name.toLowerCase().startsWith(Providers.OLLAMA)) {
    try {
      return await OllamaClient.fetchModels(baseURL, { headers, user: userObject });
    } catch (ollamaError) {
      const logMessage =
        'Failed to fetch models from Ollama API. Attempting to fetch via OpenAI-compatible endpoint.';
      logAxiosError({ message: logMessage, error: ollamaError });
    }
  }

  try {
    const options = {
      headers: {
        ...(headers ?? {}),
      },
      timeout: 5000,
    };

    if (name === EModelEndpoint.anthropic) {
      options.headers = {
        'x-api-key': apiKey,
        'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
      };
    } else {
      options.headers.Authorization = `Bearer ${apiKey}`;
    }

    if (process.env.PROXY) {
      options.httpsAgent = new HttpsProxyAgent(process.env.PROXY);
    }

    if (process.env.OPENAI_ORGANIZATION && baseURL.includes('openai')) {
      options.headers['OpenAI-Organization'] = process.env.OPENAI_ORGANIZATION;
    }

    const url = new URL(`${baseURL}${azure ? '' : '/models'}`);
    if (user && userIdQuery) {
      url.searchParams.append('user', user);
    }
    const res = await axios.get(url.toString(), options);

    /** @type {z.infer<typeof inputSchema>} */
    const input = res.data;

    const validationResult = inputSchema.safeParse(input);
    if (validationResult.success && createTokenConfig) {
      const endpointTokenConfig = processModelData(input);
      const cache = getLogStores(CacheKeys.TOKEN_CONFIG);
      await cache.set(tokenKey ?? name, endpointTokenConfig);
    }
    models = input.data.map((item) => item.id);
  } catch (error) {
    const logMessage = `Failed to fetch models from ${azure ? 'Azure ' : ''}${name} API`;
    logAxiosError({ message: logMessage, error });
  }

  return models;
};

/**
 * Fetches models from the specified API path or Azure, based on the provided options.
 * @async
 * @function
 * @param {object} opts - The options for fetching the models.
 * @param {string} opts.user - The user ID to send to the API.
 * @param {boolean} [opts.azure=false] - Whether to fetch models from Azure.
 * @param {boolean} [opts.assistants=false] - Whether to fetch models from Azure.
 * @param {boolean} [opts.plugins=false] - Whether to fetch models from the plugins.
 * @param {string[]} [_models=[]] - The models to use as a fallback.
 */
const fetchOpenAIModels = async (opts, _models = []) => {
  let models = _models.slice() ?? [];
  let apiKey = openAIApiKey;
  const openaiBaseURL = 'https://api.openai.com/v1';
  let baseURL = openaiBaseURL;
  let reverseProxyUrl = process.env.OPENAI_REVERSE_PROXY;

  if (opts.assistants && process.env.ASSISTANTS_BASE_URL) {
    reverseProxyUrl = process.env.ASSISTANTS_BASE_URL;
  } else if (opts.azure) {
    return models;
    // const azure = getAzureCredentials();
    // baseURL = (genAzureChatCompletion(azure))
    //   .split('/deployments')[0]
    //   .concat(`/models?api-version=${azure.azureOpenAIApiVersion}`);
    // apiKey = azureOpenAIApiKey;
  }

  if (reverseProxyUrl) {
    baseURL = extractBaseURL(reverseProxyUrl);
  }

  const modelsCache = getLogStores(CacheKeys.MODEL_QUERIES);

  const cachedModels = await modelsCache.get(baseURL);
  if (cachedModels) {
    return cachedModels;
  }

  if (baseURL || opts.azure) {
    models = await fetchModels({
      apiKey,
      baseURL,
      azure: opts.azure,
      user: opts.user,
      name: EModelEndpoint.openAI,
    });
  }

  if (models.length === 0) {
    return _models;
  }

  if (baseURL === openaiBaseURL) {
    const regex = /(text-davinci-003|gpt-|o\d+)/;
    const excludeRegex = /audio|realtime/;
    models = models.filter((model) => regex.test(model) && !excludeRegex.test(model));
    const instructModels = models.filter((model) => model.includes('instruct'));
    const otherModels = models.filter((model) => !model.includes('instruct'));
    models = otherModels.concat(instructModels);
  }

  await modelsCache.set(baseURL, models);
  return models;
};

/**
 * Loads the default models for the application.
 * @async
 * @function
 * @param {object} opts - The options for fetching the models.
 * @param {string} opts.user - The user ID to send to the API.
 * @param {boolean} [opts.azure=false] - Whether to fetch models from Azure.
 * @param {boolean} [opts.plugins=false] - Whether to fetch models for the plugins endpoint.
 * @param {boolean} [opts.assistants=false] - Whether to fetch models for the Assistants endpoint.
 */
const getOpenAIModels = async (opts) => {
  let models = defaultModels[EModelEndpoint.openAI];

  if (opts.assistants) {
    models = defaultModels[EModelEndpoint.assistants];
  } else if (opts.azure) {
    models = defaultModels[EModelEndpoint.azureAssistants];
  }

  if (opts.plugins) {
    models = models.filter(
      (model) =>
        !model.includes('text-davinci') &&
        !model.includes('instruct') &&
        !model.includes('0613') &&
        !model.includes('0314') &&
        !model.includes('0301'),
    );
  }

  let key;
  if (opts.assistants) {
    key = 'ASSISTANTS_MODELS';
  } else if (opts.azure) {
    key = 'AZURE_OPENAI_MODELS';
  } else if (opts.plugins) {
    key = 'PLUGIN_MODELS';
  } else {
    key = 'OPENAI_MODELS';
  }

  if (process.env[key]) {
    models = splitAndTrim(process.env[key]);
    return models;
  }

  if (userProvidedOpenAI) {
    return models;
  }

  return await fetchOpenAIModels(opts, models);
};

const getChatGPTBrowserModels = () => {
  let models = ['text-davinci-002-render-sha', 'gpt-4'];
  if (process.env.CHATGPT_MODELS) {
    models = splitAndTrim(process.env.CHATGPT_MODELS);
  }

  return models;
};

/**
 * Fetches models from the Anthropic API.
 * API key must be passed in opts.apiKey when multi-tenancy is enabled (no process.env fallback).
 *
 * @async
 * @function
 * @param {object} opts - The options for fetching the models.
 * @param {string} opts.user - The user ID to send to the API.
 * @param {string} [opts.apiKey] - API key (required in tenant mode; in single-tenant mode falls back to process.env).
 * @param {string[]} [_models=[]] - The models to use as a fallback.
 */
const fetchAnthropicModels = async (opts, _models = []) => {
  let models = _models.slice() ?? [];
  const anthropicBaseURL = 'https://api.anthropic.com/v1';
  let baseURL = anthropicBaseURL;
  let reverseProxyUrl = process.env.ANTHROPIC_REVERSE_PROXY;

  if (reverseProxyUrl) {
    baseURL = extractBaseURL(reverseProxyUrl);
  }

  let apiKey = opts.apiKey;
  if (apiKey == null || apiKey === '') {
    return models;
  }

  if (!apiKey) {
    return models;
  }

  const modelsCache = getLogStores(CacheKeys.MODEL_QUERIES);

  const cachedModels = await modelsCache.get(baseURL);
  if (cachedModels) {
    return cachedModels;
  }

  if (baseURL) {
    models = await fetchModels({
      apiKey,
      baseURL,
      user: opts.user,
      name: EModelEndpoint.anthropic,
      tokenKey: EModelEndpoint.anthropic,
    });
  }

  if (models.length === 0) {
    return _models;
  }

  await modelsCache.set(baseURL, models);
  return models;
};

/**
 * Get Anthropic models. In multi-tenant mode requires explicit opts.tenantId and uses tenant config only (no process.env fallback).
 *
 * @param {Object} opts - Options.
 * @param {string} [opts.user] - User ID for the API.
 * @param {string} [opts.tenantId] - Tenant ID (required when MULTI_TENANCY_ENABLED=true).
 * @returns {Promise<string[]>}
 * @throws {Error} When multi-tenancy enabled and tenantId missing or tenant secret missing.
 */
const getAnthropicModels = async (opts = {}) => {
  let models = defaultModels[EModelEndpoint.anthropic];
  if (process.env.ANTHROPIC_MODELS) {
    models = splitAndTrim(process.env.ANTHROPIC_MODELS);
    return models;
  }

  if (isMultiTenancyEnabled()) {
    if (!opts.tenantId) {
      throw new Error(
        'Tenant ID required for Anthropic models in multi-tenant mode. ' +
          'Pass tenantId explicitly (e.g. from req.tenantContext.tenantId).',
      );
    }
    try {
      const { anthropicApiKey } = await loadTenantAnthropicCredentials(opts.tenantId);
      return await fetchAnthropicModels({ ...opts, apiKey: anthropicApiKey }, models);
    } catch (error) {
      logger.error('Error fetching Anthropic models (tenant):', error);
      return models;
    }
  }

  if (isUserProvided(process.env.ANTHROPIC_API_KEY)) {
    return models;
  }

  try {
    return await fetchAnthropicModels(
      { ...opts, apiKey: process.env.ANTHROPIC_API_KEY },
      models,
    );
  } catch (error) {
    logger.error('Error fetching Anthropic models:', error);
    return models;
  }
};

const getGoogleModels = () => {
  let models = defaultModels[EModelEndpoint.google];
  if (process.env.GOOGLE_MODELS) {
    models = splitAndTrim(process.env.GOOGLE_MODELS);
  }

  return models;
};

const getBedrockModels = () => {
  let models = defaultModels[EModelEndpoint.bedrock];
  if (process.env.BEDROCK_AWS_MODELS) {
    models = splitAndTrim(process.env.BEDROCK_AWS_MODELS);
  }

  return models;
};

const MODEL_ENDPOINT_FETCHERS = {
  [EModelEndpoint.openAI]: ({ user }) => getOpenAIModels({ user: toUserId(user) }),
  [EModelEndpoint.azureOpenAI]: ({ user }) =>
    getOpenAIModels({ user: toUserId(user), azure: true }),
  [EModelEndpoint.assistants]: () => getOpenAIModels({ assistants: true }),
  [EModelEndpoint.azureAssistants]: () => getOpenAIModels({ azureAssistants: true }),
  [EModelEndpoint.anthropic]: ({ user }) => getAnthropicModels({ user: toUserId(user) }),
  [EModelEndpoint.google]: () => Promise.resolve(getGoogleModels()),
  [EModelEndpoint.bedrock]: () => Promise.resolve(getBedrockModels()),
};

const isSupportedModelEndpoint = (endpoint) => Boolean(MODEL_ENDPOINT_FETCHERS[endpoint]);

const getModelsForEndpoint = async ({ endpoint, user, signal } = {}) => {
  if (!isSupportedModelEndpoint(endpoint)) {
    const unsupportedError = new Error(`Unsupported endpoint: ${endpoint}`);
    unsupportedError.code = 'UNSUPPORTED_MODEL_ENDPOINT';
    throw unsupportedError;
  }

  const fetcher = MODEL_ENDPOINT_FETCHERS[endpoint];
  const result = await fetcher({ endpoint, user, signal });
  const list = Array.isArray(result) ? result : [];

  return list
    .map((model) => normalizeModelDescriptor(model, endpoint))
    .filter(Boolean);
};

module.exports = {
  fetchModels,
  splitAndTrim,
  getOpenAIModels,
  getBedrockModels,
  getChatGPTBrowserModels,
  getAnthropicModels,
  getGoogleModels,
  getModelsForEndpoint,
  isSupportedModelEndpoint,
};
