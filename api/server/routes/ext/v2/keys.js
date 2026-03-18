const express = require('express');
const { extV2Log } = require('~/server/middleware/extV2Log');
const requireExtUserAuth = require('~/server/middleware/requireExtUserAuth');
// NOTE: /ext/v2/keys is SYSTEM-SCOPED (user API keys stored in system DB)
// Does NOT use extV2RequireTenantContext - keys are user-scoped, not tenant-scoped
const internalRouter = require('~/server/routes/keys');

const router = express.Router();

router.use(extV2Log({ label: 'ext_v2', internal: '/api/keys' }));
router.use(requireExtUserAuth);
router.use('/', internalRouter);

module.exports = router;
