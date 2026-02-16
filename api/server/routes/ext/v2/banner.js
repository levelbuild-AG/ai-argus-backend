const express = require('express');
const maybeExtUserAuth = require('~/server/middleware/maybeExtUserAuth');
const { extV2Log } = require('~/server/middleware/extV2Log');
const internalRouter = require('~/server/routes/banner');

const router = express.Router();

router.use(extV2Log({ label: 'ext_v2', internal: '/api/banner' }));
router.use(maybeExtUserAuth);
router.use('/', internalRouter);

module.exports = router;
