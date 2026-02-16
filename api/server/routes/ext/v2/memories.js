const express = require('express');
const { extV2Log } = require('~/server/middleware/extV2Log');
const requireExtUserAuth = require('~/server/middleware/requireExtUserAuth');
const internalRouter = require('~/server/routes/memories');

const router = express.Router();

router.use(extV2Log({ label: 'ext_v2', internal: '/api/memories' }));
router.use(requireExtUserAuth);
router.use('/', internalRouter);

module.exports = router;
