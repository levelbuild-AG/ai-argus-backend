const express = require('express');
const { extV2Log } = require('~/server/middleware/extV2Log');
const requireExtUserAuth = require('~/server/middleware/requireExtUserAuth');
const { initialize } = require('~/server/routes/files');

const router = express.Router();
const internalRouterPromise = initialize();

router.use(extV2Log({ label: 'ext_v2', internal: '/api/files' }));
router.use(requireExtUserAuth);

router.use(async (req, res, next) => {
  try {
    const internalRouter = await internalRouterPromise;
    return internalRouter(req, res, next);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
