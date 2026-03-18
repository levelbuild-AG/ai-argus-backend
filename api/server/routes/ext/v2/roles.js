const express = require('express');
const { extV2Log } = require('~/server/middleware/extV2Log');
const requireExtUserAuth = require('~/server/middleware/requireExtUserAuth');
// NOTE: /ext/v2/roles is SYSTEM-SCOPED (system roles stored in system DB)
// Does NOT use extV2RequireTenantContext - roles are system-wide, not tenant-scoped
const internalRouter = require('~/server/routes/roles');

const router = express.Router();

router.use(extV2Log({ label: 'ext_v2', internal: '/api/roles' }));
router.use(requireExtUserAuth);
router.use('/', internalRouter);

module.exports = router;
