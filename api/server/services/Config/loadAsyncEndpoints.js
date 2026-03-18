const path = require('path');
const { logger } = require('@librechat/data-schemas');
const { EModelEndpoint } = require('librechat-data-provider');
const { loadServiceKey, isUserProvided, isMultiTenancyEnabled } = require('@librechat/api');
const { config } = require('./EndpointService');
const { getTenantConfigService } = require('./TenantConfigService');

const { openAIApiKey, azureOpenAIApiKey, useAzurePlugins, userProvidedOpenAI, googleKey } = config;

/**
 * Load async endpoints and return a configuration object
 * 
 * NOTE: In multi-tenant mode, this function returns base config only.
 * Tenant-specific endpoint availability is determined per-request via tenant config.
 * 
 * @param {AppConfig} [appConfig] - The app configuration object
 */
async function loadAsyncEndpoints(appConfig) {
  let serviceKey, googleUserProvides;

  // In multi-tenant mode, don't load global Google credentials here
  // Each tenant will have its own credentials checked per-request
  if (isMultiTenancyEnabled()) {
    // Return base config indicating Google endpoint exists (tenant-specific creds checked per-request)
    const google = googleKey && googleKey.trim() !== '' 
      ? { userProvide: isUserProvided(googleKey) }
      : { userProvide: false }; // Service key availability checked per-tenant
    return { google, gptPlugins: getGptPluginsConfig(appConfig) };
  }

  /** Check if GOOGLE_KEY is provided at all(including 'user_provided') */
  const isGoogleKeyProvided = googleKey && googleKey.trim() !== '';

  if (isGoogleKeyProvided) {
    /** If GOOGLE_KEY is provided, check if it's user_provided */
    googleUserProvides = isUserProvided(googleKey);
  } else {
    /** Only attempt to load service key if GOOGLE_KEY is not provided */
    const serviceKeyPath =
      process.env.GOOGLE_SERVICE_KEY_FILE || path.join(__dirname, '../../..', 'data', 'auth.json');

    try {
      serviceKey = await loadServiceKey(serviceKeyPath);
    } catch (error) {
      logger.error('Error loading service key', error);
      serviceKey = null;
    }
  }

  const google = serviceKey || isGoogleKeyProvided ? { userProvide: googleUserProvides } : false;

  return { google, gptPlugins: getGptPluginsConfig(appConfig) };
}

/**
 * Get GPT plugins configuration
 * @param {AppConfig} [appConfig] - The app configuration object
 * @returns {Object|false} GPT plugins config or false
 */
function getGptPluginsConfig(appConfig) {
  const useAzure = !!appConfig?.endpoints?.[EModelEndpoint.azureOpenAI]?.plugins;
  return useAzure || openAIApiKey || azureOpenAIApiKey
    ? {
        availableAgents: ['classic', 'functions'],
        userProvide: useAzure ? false : userProvidedOpenAI,
        userProvideURL: useAzure
          ? false
          : config[EModelEndpoint.openAI]?.userProvideURL ||
            config[EModelEndpoint.azureOpenAI]?.userProvideURL,
        azure: useAzurePlugins || useAzure,
      }
    : false;
}

module.exports = loadAsyncEndpoints;
