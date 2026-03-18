const express = require('express');
const tenants = require('./tenants');

const router = express.Router();

router.use('/tenants', tenants);

// E2E-only internal routes: mounted only when MT_E2E_INTERNAL_ROUTES=1 (e.g. docker-compose.mt-it.yml)
if (process.env.MT_E2E_INTERNAL_ROUTES === '1') {
  const internal = require('./internal');
  router.use('/internal/mt-e2e', internal);
}

module.exports = router;
