const express = require('express');
const { extV2Log } = require('~/server/middleware/extV2Log');
const requireExtUserAuth = require('~/server/middleware/requireExtUserAuth');
// NOTE: /ext/v2/permissions is SYSTEM-SCOPED (system permissions stored in system DB)
// Does NOT use extV2RequireTenantContext - permissions are system-wide, not tenant-scoped
const internalRouter = require('~/server/routes/accessPermissions');

const router = express.Router();

router.use(extV2Log({ label: 'ext_v2', internal: '/api/permissions' }));
router.use(requireExtUserAuth);
router.use('/', internalRouter);

module.exports = router;
