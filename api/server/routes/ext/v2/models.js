const express = require('express');
const requireExtUserAuth = require('~/server/middleware/requireExtUserAuth');
const { extV2Log } = require('~/server/middleware/extV2Log');
const internalRouter = require('~/server/routes/models');

const router = express.Router();

router.use(extV2Log({ label: 'ext_v2', internal: '/api/models' }));
router.use(requireExtUserAuth);
router.use('/', internalRouter);

module.exports = router;
