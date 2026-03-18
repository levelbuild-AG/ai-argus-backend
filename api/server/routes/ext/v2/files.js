const express = require('express');
const { extV2Log } = require('~/server/middleware/extV2Log');
const requireExtUserAuth = require('~/server/middleware/requireExtUserAuth');
const extV2RequireTenantContext = require('~/server/middleware/extV2TenantContext');
const { initialize } = require('~/server/routes/files');

const router = express.Router();
const internalRouterPromise = initialize();

router.use(extV2Log({ label: 'ext_v2', internal: '/api/files' }));
router.use(requireExtUserAuth); // 1. Auth first (sets req.user)
router.use(extV2RequireTenantContext); // 2. Tenant context second (uses req.user.tenantId)

router.use(async (req, res, next) => {
  try {
    const internalRouter = await internalRouterPromise;
    return internalRouter(req, res, next);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
