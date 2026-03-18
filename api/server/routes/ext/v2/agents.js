const express = require('express');
const { isEnabled } = require('@librechat/api');
const {
  uaParser,
  checkBan,
  configMiddleware,
  concurrentLimiter,
  messageIpLimiter,
  messageUserLimiter,
} = require('~/server/middleware');
const chatRouter = require('~/server/routes/agents/chat');
const requireExtUserAuth = require('~/server/middleware/requireExtUserAuth');
const extV2RequireTenantContext = require('~/server/middleware/extV2TenantContext');
const internalPathShimV2 = require('~/server/middleware/internalPathShimV2');
let EndpointURLs;
try {
  ({ EndpointURLs } = require('librechat-data-provider'));
} catch (err) {
  EndpointURLs = undefined;
}

const v2AgentsDebug = (req, _res, next) => {
  if (!isEnabled(process.env.EXT_V2_DEBUG)) {
    return next();
  }

  const seen = {
    method: req.method,
    originalUrl: req.originalUrl,
    baseUrl: req.baseUrl,
    url: req.url,
    path: req.path,
    params: req.params,
    body: {
      endpoint: req.body?.endpoint,
      endpointType: req.body?.endpointType,
      agent_id: req.body?.agent_id,
      agentId: req.body?.agentId,
    },
    endpointUrlsAgents: EndpointURLs?.agents,
    baseUrlStartsWithAgents: EndpointURLs?.agents
      ? String(req.baseUrl || '').startsWith(EndpointURLs.agents)
      : null,
  };

  // eslint-disable-next-line no-console
  console.info('[ext/v2][agents][debug] pre-chatRouter', seen);

  return next();
};

const { LIMIT_CONCURRENT_MESSAGES, LIMIT_MESSAGE_IP, LIMIT_MESSAGE_USER } = process.env ?? {};

const router = express.Router();

router.use(requireExtUserAuth); // 1. Auth first (sets req.user)
router.use(extV2RequireTenantContext); // 2. Tenant context second (uses req.user.tenantId)
router.use(checkBan);
router.use(uaParser);

const chatWrapper = express.Router();
chatWrapper.use(configMiddleware);

if (isEnabled(LIMIT_CONCURRENT_MESSAGES)) {
  chatWrapper.use(concurrentLimiter);
}

if (isEnabled(LIMIT_MESSAGE_IP)) {
  chatWrapper.use(messageIpLimiter);
}

if (isEnabled(LIMIT_MESSAGE_USER)) {
  chatWrapper.use(messageUserLimiter);
}

chatWrapper.use('/chat', internalPathShimV2, v2AgentsDebug, chatRouter);

router.use('/', chatWrapper);

module.exports = router;
