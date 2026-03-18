const express = require('express');
const { extV2Log } = require('~/server/middleware/extV2Log');
const requireExtUserAuth = require('~/server/middleware/requireExtUserAuth');
const extV2RequireTenantContext = require('~/server/middleware/extV2TenantContext');
const internalRouter = require('~/server/routes/tags');

const router = express.Router();

router.use(extV2Log({ label: 'ext_v2', internal: '/api/tags' }));
router.use(requireExtUserAuth); // 1. Auth first (sets req.user)
router.use(extV2RequireTenantContext); // 2. Tenant context second (uses req.user.tenantId)
router.use('/', internalRouter);

module.exports = router;
