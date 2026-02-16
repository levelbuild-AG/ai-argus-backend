const express = require('express');
const { extV2Log } = require('~/server/middleware/extV2Log');
const internalRouter = require('~/server/routes/endpoints');

const router = express.Router();

router.use(extV2Log({ label: 'ext_v2', internal: '/api/endpoints' }));
router.use('/', internalRouter);

module.exports = router;
