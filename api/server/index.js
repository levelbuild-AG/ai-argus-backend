require('dotenv').config();
const fs = require('fs');
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..') });
const cors = require('cors');
const axios = require('axios');
const express = require('express');
const passport = require('passport');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const { logger } = require('@librechat/data-schemas');
const mongoSanitize = require('express-mongo-sanitize');
const {
  isEnabled,
  isMultiTenancyEnabled,
  ErrorController,
  performStartupChecks,
  initializeFileStorage,
} = require('@librechat/api');
const middleware = require('~/server/middleware');
const { optionalTenantContext, requireTenantContext } = middleware;
const { connectDb, indexSync } = require('~/db');
const initializeOAuthReconnectManager = require('./services/initializeOAuthReconnectManager');
const createValidateImageRequest = require('./middleware/validateImageRequest');
const { jwtLogin, ldapLogin, passportLogin } = require('~/strategies');
const { updateInterfacePermissions } = require('~/models/interface');
const { checkMigrations } = require('./services/start/migration');
const initializeMCPs = require('./services/initializeMCPs');
const configureSocialLogins = require('./socialLogins');
const { getAppConfig } = require('./services/Config');
const staticCache = require('./utils/staticCache');
const noIndex = require('./middleware/noIndex');
const externalUserIdMiddleware = require('./middleware/externalUserId');
const { seedDatabase } = require('~/models');
const routes = require('./routes');

const {
  PORT,
  HOST,
  ALLOW_SOCIAL_LOGIN,
  DISABLE_COMPRESSION,
  TRUST_PROXY,
  EXTERNAL_API_ENABLED,
} = process.env ?? {};

// MT E2E: log crashes and keep process alive for diagnostics
if (process.env.MT_E2E_INTERNAL_ROUTES === '1') {
  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[MT-E2E] unhandledRejection', reason);
  });
  process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error('[MT-E2E] uncaughtException', err);
  });
}

const boolTrue = new Set(['1', 'true', 'yes', 'on']);
const parseCsv = (value = '') =>
  value
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

const buildCorsOptions = () => {
  const allowCredentials = boolTrue.has((process.env.CORS_ALLOW_CREDENTIALS || 'false').toLowerCase());
  const rawOrigins = process.env.CORS_ALLOWED_ORIGINS ?? '*';
  const parsedOrigins = rawOrigins === '*' ? ['*'] : parseCsv(rawOrigins);
  const wildcard = parsedOrigins.includes('*');
  let normalizedOrigins = wildcard ? parsedOrigins.filter((origin) => origin !== '*') : parsedOrigins;

  if (allowCredentials && wildcard) {
    logger.warn('[cors] Removing wildcard origin because credentials are enabled; set CORS_ALLOWED_ORIGINS to explicit domains.');
  }

  const allowAllOrigins = (!allowCredentials && wildcard) || normalizedOrigins.length === 0;

  const originHandler = allowAllOrigins
    ? (_origin, callback) => callback(null, true)
    : (origin, callback) => {
        if (!origin || normalizedOrigins.includes(origin)) {
          return callback(null, true);
        }
        logger.warn(`[cors] Blocked origin ${origin}`);
        return callback(null, false);
      };

  const allowedHeaders = parseCsv(process.env.CORS_ALLOWED_HEADERS || '');
  if (allowedHeaders.length === 0) {
    allowedHeaders.push('Authorization', 'Content-Type', 'Accept', 'X-Requested-With');
  }

  const methods = parseCsv(process.env.CORS_ALLOWED_METHODS || 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  const exposedHeaders = parseCsv(process.env.CORS_EXPOSED_HEADERS || '');

  const options = {
    origin: originHandler,
    credentials: allowCredentials,
    methods,
    allowedHeaders,
    optionsSuccessStatus: 204,
    maxAge: Number(process.env.CORS_MAX_AGE || 600),
  };

  if (exposedHeaders.length > 0) {
    options.exposedHeaders = exposedHeaders;
  }

  return options;
};

const corsOptions = buildCorsOptions();

// Allow PORT=0 to be used for automatic free port assignment
const port = isNaN(Number(PORT)) ? 3080 : Number(PORT);
const host = HOST || 'localhost';
const trusted_proxy = Number(TRUST_PROXY) || 1; /* trust first proxy by default */

const app = express();

const startServer = async () => {
  if (typeof Bun !== 'undefined') {
    axios.defaults.headers.common['Accept-Encoding'] = 'gzip';
  }
  await connectDb();

  logger.info('Connected to MongoDB');
  
  // Multi-tenancy feature flag check
  const multiTenancyEnabled = isMultiTenancyEnabled();
  logger.info(
    `MULTI_TENANCY_ENABLED=${multiTenancyEnabled} (${multiTenancyEnabled ? 'multi-tenant' : 'single-tenant'} mode)`,
  );
  
  indexSync().catch((err) => {
    logger.error('[indexSync] Background sync failed:', err);
  });

  app.disable('x-powered-by');
  app.set('trust proxy', trusted_proxy);

  await seedDatabase();
  
  // Initialize tenant configs (if multi-tenancy enabled)
  const { initializeTenantConfigs } = require('./services/start/tenantConfigInit');
  await initializeTenantConfigs();

  // Always-on MT: single authoritative assertion (DB + TenantConfigService; fails startup if broken)
  const { assertAlwaysOnMTWiring } = require('./services/start/assertAlwaysOnMTWiring');
  assertAlwaysOnMTWiring();

  const appConfig = await getAppConfig();
  initializeFileStorage(appConfig);
  await performStartupChecks(appConfig);
  await updateInterfacePermissions(appConfig);

  const indexPath = path.join(appConfig.paths.dist, 'index.html');
  let indexHTML = fs.readFileSync(indexPath, 'utf8');

  // In order to provide support to serving the application in a sub-directory
  // We need to update the base href if the DOMAIN_CLIENT is specified and not the root path
  if (process.env.DOMAIN_CLIENT) {
    const clientUrl = new URL(process.env.DOMAIN_CLIENT);
    const baseHref = clientUrl.pathname.endsWith('/')
      ? clientUrl.pathname
      : `${clientUrl.pathname}/`;
    if (baseHref !== '/') {
      logger.info(`Setting base href to ${baseHref}`);
      indexHTML = indexHTML.replace(/base href="\/"/, `base href="${baseHref}"`);
    }
  }

  app.get('/health', (_req, res) => res.status(200).send('OK'));

  /* Middleware */
  app.use(noIndex);
  app.use(express.json({ limit: '512mb' }));
  app.use(express.urlencoded({ extended: true, limit: '512mb' }));
  app.use(mongoSanitize());
  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));
  app.use(cookieParser());
  app.use(externalUserIdMiddleware);

  if (!isEnabled(DISABLE_COMPRESSION)) {
    app.use(compression());
  } else {
    console.warn('Response compression has been disabled via DISABLE_COMPRESSION.');
  }

  app.use(staticCache(appConfig.paths.dist));
  app.use(staticCache(appConfig.paths.fonts));
  app.use(staticCache(appConfig.paths.assets));
  if (fs.existsSync(appConfig.paths.customAssets)) {
    app.use(
      '/librechat-custom',
      staticCache(appConfig.paths.customAssets, { skipGzipScan: true, noCache: true }),
    );
  }

  if (!ALLOW_SOCIAL_LOGIN) {
    console.warn('Social logins are disabled. Set ALLOW_SOCIAL_LOGIN=true to enable them.');
  }

  /* OAUTH */
  app.use(passport.initialize());
  passport.use(jwtLogin());
  passport.use(passportLogin());

  /* LDAP Auth */
  if (process.env.LDAP_URL && process.env.LDAP_USER_SEARCH_BASE) {
    passport.use(ldapLogin);
  }

  if (isEnabled(ALLOW_SOCIAL_LOGIN)) {
    await configureSocialLogins(app);
  }

  // Tenant context middleware (optional, non-blocking)
  // Mounted after auth setup but before routes
  // Extracts tenantId from req.user.tenantId when available
  app.use(optionalTenantContext);

  app.use('/oauth', routes.oauth);
  /* API Endpoints */
  app.use('/api/auth', routes.auth);
  app.use('/api/actions', routes.actions);
  app.use('/api/keys', routes.keys);
  app.use('/api/user', routes.user);
  app.use('/api/search', requireTenantContext, routes.search);
  app.use('/api/edit', requireTenantContext, routes.edit);
  app.use('/api/messages', requireTenantContext, routes.messages);
  app.use('/api/convos', middleware.requireJwtAuth, requireTenantContext, routes.convos);
  app.use('/api/presets', requireTenantContext, routes.presets);
  app.use('/api/prompts', requireTenantContext, routes.prompts);
  app.use('/api/categories', requireTenantContext, routes.categories);
  app.use('/api/tokenizer', requireTenantContext, routes.tokenizer);
  app.use('/api/endpoints', requireTenantContext, routes.endpoints);
  app.use('/api/balance', requireTenantContext, routes.balance);
  app.use('/api/models', requireTenantContext, routes.models);
  app.use('/api/plugins', requireTenantContext, routes.plugins);
  app.use('/api/config', routes.config);
  app.use('/api/assistants', requireTenantContext, routes.assistants);
  app.use('/api/files', middleware.requireJwtAuth, requireTenantContext, await routes.files.initialize());
  app.use('/images/', createValidateImageRequest(appConfig.secureImageLinks), routes.staticRoute);
  app.use('/api/share', requireTenantContext, routes.share);
  app.use('/api/roles', routes.roles);
  app.use('/api/agents', requireTenantContext, routes.agents);
  app.use('/api/banner', requireTenantContext, routes.banner);
  app.use('/api/memories', requireTenantContext, routes.memories);
  app.use('/api/permissions', routes.accessPermissions);

  app.use('/api/tags', requireTenantContext, routes.tags);
  app.use('/api/mcp', requireTenantContext, routes.mcp);

  const requireAdminHeader = require('./middleware/requireAdminHeader');
  const adminRateLimiter = require('./middleware/adminRateLimiter');
  app.use('/api/admin', requireAdminHeader, adminRateLimiter, routes.admin);

  const externalApiEnabled = isEnabled(EXTERNAL_API_ENABLED);
  if (externalApiEnabled) {
    if (routes.ext?.v2) {
      // ext/v2 routes: requireExtUserAuth runs INSIDE each route file (sets req.user)
      // requireTenantContext is added AFTER requireExtUserAuth in each route file
      // Public routes (/health, /meta) bypass both auth and tenant context
      app.use('/ext/v2', routes.ext.v2);
      logger.info('External API mounted at /ext/v2');
    } else {
      logger.warn('EXTERNAL_API_ENABLED is true but /ext/v2 router is missing');
    }
  }

  app.use(ErrorController);

  app.use((req, res) => {
    res.set({
      'Cache-Control': process.env.INDEX_CACHE_CONTROL || 'no-cache, no-store, must-revalidate',
      Pragma: process.env.INDEX_PRAGMA || 'no-cache',
      Expires: process.env.INDEX_EXPIRES || '0',
    });

    const lang = req.cookies.lang || req.headers['accept-language']?.split(',')[0] || 'en-US';
    const saneLang = lang.replace(/"/g, '&quot;');
    let updatedIndexHtml = indexHTML.replace(/lang="en-US"/g, `lang="${saneLang}"`);

    res.type('html');
    res.send(updatedIndexHtml);
  });

  app.listen(port, host, async () => {
    if (host === '0.0.0.0') {
      logger.info(
        `Server listening on all interfaces at port ${port}. Use http://localhost:${port} to access it`,
      );
    } else {
      logger.info(`Server listening at http://${host == '0.0.0.0' ? 'localhost' : host}:${port}`);
    }

    await initializeMCPs();
    await initializeOAuthReconnectManager();
    await checkMigrations();
  });
};

startServer();

let messageCount = 0;
process.on('uncaughtException', (err) => {
  if (process.env.MT_E2E_INTERNAL_ROUTES === '1') {
    // eslint-disable-next-line no-console
    console.error('[MT-E2E] uncaughtException', err);
    return;
  }
  if (!err.message.includes('fetch failed')) {
    logger.error('There was an uncaught error:', err);
  }

  if (err.message && err.message?.toLowerCase()?.includes('abort')) {
    logger.warn('There was an uncatchable abort error.');
    return;
  }

  if (err.message.includes('GoogleGenerativeAI')) {
    logger.warn(
      '\n\n`GoogleGenerativeAI` errors cannot be caught due to an upstream issue, see: https://github.com/google-gemini/generative-ai-js/issues/303',
    );
    return;
  }

  if (err.message.includes('fetch failed')) {
    if (messageCount === 0) {
      logger.warn('Meilisearch error, search will be disabled');
      messageCount++;
    }

    return;
  }

  if (err.message.includes('OpenAIError') || err.message.includes('ChatCompletionMessage')) {
    logger.error(
      '\n\nAn Uncaught `OpenAIError` error may be due to your reverse-proxy setup or stream configuration, or a bug in the `openai` node package.',
    );
    return;
  }

  if (err.stack && err.stack.includes('@librechat/agents')) {
    logger.error(
      '\n\nAn error occurred in the agents system. The error has been logged and the app will continue running.',
      {
        message: err.message,
        stack: err.stack,
      },
    );
    return;
  }

  process.exit(1);
});

/** Export app for easier testing purposes */
module.exports = app;
