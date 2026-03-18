const { HttpsProxyAgent } = require('https-proxy-agent');
const {
  bedrockInputParser,
  bedrockOutputParser,
  removeNullishValues,
} = require('librechat-data-provider');
const { loadTenantBedrockCredentials } = require('./tenantClient');

const getOptions = async ({ req, overrideModel, endpointOption }) => {
  const { PROXY } = process.env;
  
  // ALWAYS-ON MULTI-TENANCY: Multi-tenancy is the only supported mode. Credentials come from tenant config only.
  // No process.env fallback. Fail-hard if tenantId missing.
  
  // Require tenantId from request context
  const tenantId = req?.tenantContext?.tenantId;
  if (!tenantId) {
    throw new Error(
      '[getOptions] Tenant ID is required for Bedrock operations. ' +
      'Ensure requireTenantContext middleware runs before Bedrock endpoint calls.'
    );
  }
  
  // Load credentials from tenant config (no process.env fallback)
  const tenantCreds = await loadTenantBedrockCredentials(tenantId);
  const credentials = {
    accessKeyId: tenantCreds.accessKeyId,
    secretAccessKey: tenantCreds.secretAccessKey,
    ...(tenantCreds.sessionToken && { sessionToken: tenantCreds.sessionToken }),
  };
  const region = tenantCreds.region;
  const endpointHost = tenantCreds.endpointHost;

  /*
  Callback for stream rate no longer awaits and may end the stream prematurely
  /** @type {number}
  let streamRate = Constants.DEFAULT_STREAM_RATE;

  /** @type {undefined | TBaseEndpoint}
  const bedrockConfig = appConfig.endpoints?.[EModelEndpoint.bedrock];

  if (bedrockConfig && bedrockConfig.streamRate) {
    streamRate = bedrockConfig.streamRate;
  }

  const allConfig = appConfig.endpoints?.all;
  if (allConfig && allConfig.streamRate) {
    streamRate = allConfig.streamRate;
  }
  */

  /** @type {BedrockClientOptions} */
  const requestOptions = {
    model: overrideModel ?? endpointOption?.model,
    region: region,
  };

  const configOptions = {};
  if (PROXY) {
    /** NOTE: NOT SUPPORTED BY BEDROCK */
    configOptions.httpAgent = new HttpsProxyAgent(PROXY);
  }

  const llmConfig = bedrockOutputParser(
    bedrockInputParser.parse(
      removeNullishValues(Object.assign(requestOptions, endpointOption?.model_parameters ?? {})),
    ),
  );

  if (credentials) {
    llmConfig.credentials = credentials;
  }

  if (endpointHost) {
    llmConfig.endpointHost = endpointHost;
  }

  return {
    /** @type {BedrockClientOptions} */
    llmConfig,
    configOptions,
  };
};

module.exports = getOptions;
