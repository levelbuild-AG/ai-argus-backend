const { isEnabled } = require('@librechat/api');
let EndpointURLs;
try {
  ({ EndpointURLs } = require('librechat-data-provider'));
} catch (err) {
  EndpointURLs = undefined;
}

/**
 * Makes ext/v2 look like internal routing to downstream middleware.
 * IMPORTANT: Do NOT touch req.url (Express routing depends on it). Only shim req.baseUrl + req.originalUrl.
 */
function stripExtV2Segment(value = '') {
  if (typeof value !== 'string' || value.length === 0) return value;
  return value
    .replace(/(^|\/)ext\/v2(?=\/|$)/g, '$1')
    .replace(/\/+/g, '/');
}

function forceAgentsPrefix(value = '', expectedPrefix) {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (!expectedPrefix) return value;

  const stripped = stripExtV2Segment(value);

  if (stripped.startsWith(expectedPrefix)) {
    return stripped;
  }

  // If the stripped path contains /agents, rewrite everything up to /agents with expectedPrefix
  const agentsIdx = stripped.indexOf('/agents');
  if (agentsIdx !== -1) {
    const tail = stripped.slice(agentsIdx + '/agents'.length);
    return `${expectedPrefix}${tail}`.replace(/\/+/g, '/');
  }

  // Otherwise, just prepend expectedPrefix
  return `${expectedPrefix}${stripped.startsWith('/') ? '' : '/'}${stripped}`.replace(/\/+/g, '/');
}

function defineShimmedGetter(req, key, storeKey) {
  const original = req[key];
  req[storeKey] = original;

  Object.defineProperty(req, key, {
    configurable: true,
    enumerable: true,
    get() {
      // Only adjust baseUrl/originalUrl to expected agents prefix when applicable
      if (key === 'baseUrl' || key === 'originalUrl') {
        const expected = EndpointURLs?.agents || '/agents';
        return forceAgentsPrefix(original, expected);
      }
      return original;
    },
    set(v) {
      req[storeKey] = v;
    },
  });
}

function internalPathShimV2(req, _res, next) {
  if (typeof req?.originalUrl !== 'string' || !req.originalUrl.includes('/ext/v2/agents/chat')) {
    return next();
  }

  // Do NOT shim req.url
  defineShimmedGetter(req, 'originalUrl', '_extV2OriginalUrl');
  defineShimmedGetter(req, 'baseUrl', '_extV2BaseUrl');

  if (isEnabled(process.env.EXT_V2_DEBUG)) {
    // eslint-disable-next-line no-console
    console.info('[ext/v2][path-shim]', {
      before: { originalUrl: req._extV2OriginalUrl, baseUrl: req._extV2BaseUrl },
      after: { originalUrl: req.originalUrl, baseUrl: req.baseUrl },
      url_unchanged: req.url,
      expectedPrefix: EndpointURLs?.agents || '/agents',
    });
  }

  next();
}

module.exports = internalPathShimV2;