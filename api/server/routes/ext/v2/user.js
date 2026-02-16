const express = require('express');
const { extV2Log } = require('~/server/middleware/extV2Log');
const maybeExtUserAuth = require('~/server/middleware/maybeExtUserAuth');
const internalRouter = require('~/server/routes/user');

const router = express.Router();

router.use(extV2Log({ label: 'ext_v2', internal: '/api/user' }));
router.use(maybeExtUserAuth);
router.use('/', internalRouter);

module.exports = router;
