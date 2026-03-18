const path = require('path');
const { EModelEndpoint, AuthKeys } = require('librechat-data-provider');
const { getGoogleConfig, isEnabled } = require('@librechat/api');
const { getUserKey, checkUserKeyExpiry } = require('~/server/services/UserService');
const { GoogleClient } = require('~/app');
const { loadTenantGoogleCredentials } = require('./tenantClient');

/**
 * Initialize Google client with explicit credentials
 * 
 * This function accepts credentials explicitly, allowing callers to decide where credentials come from:
 * - Tenant mode: from TenantConfigService
 * - Single mode: from process.env (existing behavior)
 * 
 * @param {Object} params - Initialization parameters
 * @param {Object} [params.credentials] - Google credentials object (optional, will be loaded if not provided)
 * @param {string} [params.tenantId] - Tenant ID (REQUIRED in multi-tenant mode, must be passed explicitly)
 * @param {Object} params.req - Express request object
 * @param {Object} params.res - Express response object
 * @param {Object} params.endpointOption - Endpoint options
 * @param {string} [params.overrideModel] - Optional model override
 * @param {boolean} [params.optionsOnly] - If true, return config only, not client
 * @returns {Promise<Object>} Client and credentials
 * @throws {Error} If multi-tenancy enabled and tenantId missing
 */
async function initializeClientWithCredentials({
  credentials: providedCredentials,
  tenantId: providedTenantId,
  req,
  res,
  endpointOption,
  overrideModel,
  optionsOnly,
}) {
  let credentials = providedCredentials;
  
  // CRITICAL: In multi-tenant mode, tenantId MUST be provided explicitly
  // Do not rely on req.user.tenantId or req.tenantContext - extract at call site
  let tenantId = providedTenantId;
  if (!tenantId && req?.tenantContext?.tenantId) {
    tenantId = req.tenantContext.tenantId;
  }

  // Handle user-provided keys first (takes precedence in both modes)
  const { GOOGLE_KEY } = process.env;
  const isUserProvided = GOOGLE_KEY === 'user_provided';
  const { key: expiresAt } = req?.body;

  if (expiresAt && isUserProvided && req?.user) {
    checkUserKeyExpiry(expiresAt, EModelEndpoint.google);
    const userKey = await getUserKey({ userId: req.user.id, name: EModelEndpoint.google });
    if (userKey) {
      // User-provided key takes precedence
      credentials = userKey;
    }
  }

  // If credentials not provided and not user-provided, load from tenant config
  if (!credentials) {
    if (!tenantId) {
      throw new Error(
        'Tenant ID required for Google client initialization. ' +
          'Pass tenantId explicitly or ensure req.tenantContext.tenantId is set.',
      );
    }
    credentials = await loadTenantGoogleCredentials(tenantId);
  }

  const { GOOGLE_REVERSE_PROXY, GOOGLE_AUTH_HEADER, PROXY } = process.env;

  let clientOptions = {};

  const appConfig = req.config;
  /** @type {undefined | TBaseEndpoint} */
  const allConfig = appConfig.endpoints?.all;
  /** @type {undefined | TBaseEndpoint} */
  const googleConfig = appConfig.endpoints?.[EModelEndpoint.google];

  if (googleConfig) {
    clientOptions.streamRate = googleConfig.streamRate;
    clientOptions.titleModel = googleConfig.titleModel;
  }

  if (allConfig) {
    clientOptions.streamRate = allConfig.streamRate;
  }

  clientOptions = {
    req,
    res,
    reverseProxyUrl: GOOGLE_REVERSE_PROXY ?? null,
    authHeader: isEnabled(GOOGLE_AUTH_HEADER) ?? null,
    proxy: PROXY ?? null,
    ...clientOptions,
    ...endpointOption,
  };

  if (optionsOnly) {
    clientOptions = Object.assign(
      {
        modelOptions: endpointOption?.model_parameters ?? {},
      },
      clientOptions,
    );
    if (overrideModel) {
      clientOptions.modelOptions.model = overrideModel;
    }
    return getGoogleConfig(credentials, clientOptions);
  }

  const client = new GoogleClient(credentials, clientOptions);

  return {
    client,
    credentials,
  };
}

/**
 * Initialize Google client (backward-compatible wrapper)
 * 
 * Automatically loads credentials based on multi-tenancy mode:
 * - Multi-tenancy enabled: from tenant config (requires req.tenantContext.tenantId)
 * - Multi-tenancy disabled: from process.env (existing behavior)
 * 
 * CRITICAL: In multi-tenant mode, req.tenantContext.tenantId MUST be set by middleware.
 * This wrapper extracts tenantId from req.tenantContext (set by tenantContext middleware).
 * 
 * @param {Object} params - Initialization parameters
 * @param {Object} params.req - Express request object (must have req.tenantContext.tenantId in multi-tenant mode)
 * @param {Object} params.res - Express response object
 * @param {Object} params.endpointOption - Endpoint options
 * @param {string} [params.overrideModel] - Optional model override
 * @param {boolean} [params.optionsOnly] - If true, return config only, not client
 * @returns {Promise<Object>} Client and credentials
 * @throws {Error} If multi-tenancy enabled and req.tenantContext.tenantId missing
 */
const initializeClient = async ({ req, res, endpointOption, overrideModel, optionsOnly }) => {
  // Extract tenantId from req.tenantContext (set by tenantContext middleware)
  // CRITICAL: Do not use req.user.tenantId - use req.tenantContext.tenantId
  const tenantId = req?.tenantContext?.tenantId;
  
  return initializeClientWithCredentials({
    credentials: undefined, // Will be loaded automatically
    tenantId, // Pass explicitly
    req,
    res,
    endpointOption,
    overrideModel,
    optionsOnly,
  });
};

module.exports = initializeClient;
module.exports.initializeClientWithCredentials = initializeClientWithCredentials;