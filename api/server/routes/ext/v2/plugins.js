const express = require('express');
const requireExtUserAuth = require('~/server/middleware/requireExtUserAuth');
const { extV2Log } = require('~/server/middleware/extV2Log');
const internalRouter = require('~/server/routes/plugins');

const router = express.Router();

router.use(extV2Log({ label: 'ext_v2', internal: '/api/plugins' }));
router.use(requireExtUserAuth);
router.use('/', internalRouter);

module.exports = router;
