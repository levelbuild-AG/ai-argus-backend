const express = require('express');
const { extV2Log } = require('~/server/middleware/extV2Log');
const maybeExtUserAuth = require('~/server/middleware/maybeExtUserAuth');
const internalRouter = require('~/server/routes/share');

const router = express.Router();

router.use(extV2Log({ label: 'ext_v2', internal: '/api/share' }));
router.use(maybeExtUserAuth);
router.use('/', internalRouter);

module.exports = router;
