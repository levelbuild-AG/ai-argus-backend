const multer = require('multer');
const express = require('express');
const { sleep } = require('@librechat/agents');
const { isEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { CacheKeys, EModelEndpoint } = require('librechat-data-provider');
const {
  createImportLimiters,
  createForkLimiters,
  configMiddleware,
} = require('~/server/middleware');
const { getConvosByCursor, deleteConvos, getConvo, saveConvo } = require('~/models/Conversation');
const { forkConversation, duplicateConversation } = require('~/server/utils/import/fork');
const { storage, importFileFilter } = require('~/server/routes/files/multer');
const { deleteAllSharedLinks, deleteConvoSharedLink } = require('~/models');
const { importConversations } = require('~/server/utils/import');
const { deleteToolCalls } = require('~/models/ToolCall');
const getLogStores = require('~/cache/getLogStores');
const getModelsFromReq = require('~/server/utils/getTenantModelsFromReq');
const mongoose = require('mongoose');

const assistantClients = {
  [EModelEndpoint.azureAssistants]: require('~/server/services/Endpoints/azureAssistants'),
  [EModelEndpoint.assistants]: require('~/server/services/Endpoints/assistants'),
};

const middleware = require('~/server/middleware');

const router = express.Router();
router.use(middleware.requireJwtAuth, middleware.requireTenantContext);

router.get('/', async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 25;
  const cursor = req.query.cursor;
  const isArchived = isEnabled(req.query.isArchived);
  const search = req.query.search ? decodeURIComponent(req.query.search) : undefined;
  const order = req.query.order || 'desc';

  let tags;
  if (req.query.tags) {
    tags = Array.isArray(req.query.tags) ? req.query.tags : [req.query.tags];
  }

  try {
    const models = await getModelsFromReq(req);
    
    // Guard: fail fast if models missing (tenant routes always require tenant models)
    if (!models) {
      throw new Error('Tenant models required for this route.');
    }

    // Assertion: verify tenant models. Reference-only (no side effects, no extra DB).
    if (models) {
      const systemModels = require('~/db/models');
      if (models.Conversation === systemModels.Conversation) {
        const error = new Error('[DEV ASSERTION FAILED] THIS IS A BUG: Conversation model is from system connection, expected tenant connection');
        logger.error(error.message);
        throw error;
      }
      // Verify model is bound to tenant connection (not system)
      if (models.Conversation.db === mongoose.connection) {
        const error = new Error('[DEV ASSERTION FAILED] THIS IS A BUG: Conversation model.db is system connection, expected tenant connection');
        logger.error(error.message);
        throw error;
      }
    }
    
    const result = await getConvosByCursor(
      req.user.id,
      {
        cursor,
        limit,
        isArchived,
        tags,
        search,
        order,
        tenantId: req.tenantContext?.tenantId,
      },
      models,
    );
    res.status(200).json(result);
  } catch (error) {
    logger.error('Error fetching conversations', error);
    res.status(500).json({ error: 'Error fetching conversations' });
  }
});

router.get('/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  try {
    const models = await getModelsFromReq(req);
    // Guard: fail fast if models missing (tenant routes always require tenant models)
    if (!models) {
      throw new Error('Tenant models required for this route.');
    }
    const convo = await getConvo(req.user.id, conversationId, models);

    if (convo) {
      res.status(200).json(convo);
    } else {
      res.status(404).end();
    }
  } catch (error) {
    logger.error('Error fetching conversation', error);
    res.status(500).json({ error: 'Error fetching conversation' });
  }
});

router.post('/gen_title', async (req, res) => {
  const { conversationId } = req.body;
  const titleCache = getLogStores(CacheKeys.GEN_TITLE);
  const key = `${req.user.id}-${conversationId}`;
  let title = await titleCache.get(key);

  if (!title) {
    // Retry every 1s for up to 20s
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      title = await titleCache.get(key);
      if (title) {
        break;
      }
    }
  }

  if (title) {
    await titleCache.delete(key);
    res.status(200).json({ title });
  } else {
    res.status(404).json({
      message: "Title not found or method not implemented for the conversation's endpoint",
    });
  }
});

router.delete('/', async (req, res) => {
  let filter = {};
  const { conversationId, source, thread_id, endpoint } = req.body.arg;

  // Prevent deletion of all conversations
  if (!conversationId && !source && !thread_id && !endpoint) {
    return res.status(400).json({
      error: 'no parameters provided',
    });
  }

  if (conversationId) {
    filter = { conversationId };
  } else if (source === 'button') {
    return res.status(200).send('No conversationId provided');
  }

  if (
    typeof endpoint !== 'undefined' &&
    Object.prototype.propertyIsEnumerable.call(assistantClients, endpoint)
  ) {
    /** @type {{ openai: OpenAI }} */
    const { openai } = await assistantClients[endpoint].initializeClient({ req, res });
    try {
      const response = await openai.beta.threads.delete(thread_id);
      logger.debug('Deleted OpenAI thread:', response);
    } catch (error) {
      logger.error('Error deleting OpenAI thread:', error);
    }
  }

  try {
    const models = await getModelsFromReq(req);
    // Guard: fail fast if models missing (tenant routes always require tenant models)
    if (!models) {
      throw new Error('Tenant models required for this route.');
    }
    const dbResponse = await deleteConvos(req.user.id, filter, models);
    if (filter.conversationId) {
      await deleteToolCalls(req.user.id, filter.conversationId, models);
      await deleteConvoSharedLink(req.user.id, filter.conversationId);
    }
    res.status(201).json(dbResponse);
  } catch (error) {
    logger.error('Error clearing conversations', error);
    res.status(500).send('Error clearing conversations');
  }
});

router.delete('/all', async (req, res) => {
  try {
    const models = await getModelsFromReq(req);
    // Guard: fail fast if models missing (tenant routes always require tenant models)
    if (!models) {
      throw new Error('Tenant models required for this route.');
    }
    const dbResponse = await deleteConvos(req.user.id, {}, models);
    await deleteToolCalls(req.user.id, undefined, models);
    await deleteAllSharedLinks(req.user.id);
    res.status(201).json(dbResponse);
  } catch (error) {
    logger.error('Error clearing conversations', error);
    res.status(500).send('Error clearing conversations');
  }
});

router.post('/update', async (req, res) => {
  const update = req.body.arg;

  if (!update.conversationId) {
    return res.status(400).json({ error: 'conversationId is required' });
  }

  try {
    const models = await getModelsFromReq(req);
    // Guard: fail fast if models missing (tenant routes always require tenant models)
    if (!models) {
      throw new Error('Tenant models required for this route.');
    }
    const dbResponse = await saveConvo(req, update, {
      context: `POST /api/convos/update ${update.conversationId}`,
    }, models);
    res.status(201).json(dbResponse);
  } catch (error) {
    logger.error('Error updating conversation', error);
    res.status(500).send('Error updating conversation');
  }
});

const { importIpLimiter, importUserLimiter } = createImportLimiters();
const { forkIpLimiter, forkUserLimiter } = createForkLimiters();
const upload = multer({ storage: storage, fileFilter: importFileFilter });

/**
 * Imports a conversation from a JSON file and saves it to the database.
 * @route POST /import
 * @param {Express.Multer.File} req.file - The JSON file to import.
 * @returns {object} 201 - success response - application/json
 */
router.post(
  '/import',
  importIpLimiter,
  importUserLimiter,
  configMiddleware,
  upload.single('file'),
  async (req, res) => {
    try {
      const models = await getModelsFromReq(req);
      // Guard: fail fast if models missing (tenant routes always require tenant models)
      if (!models) {
        throw new Error('Tenant models required for this route.');
      }
      /* TODO: optimize to return imported conversations and add manually */
      await importConversations({ filepath: req.file.path, requestUserId: req.user.id, models });
      res.status(201).json({ message: 'Conversation(s) imported successfully' });
    } catch (error) {
      logger.error('Error processing file', error);
      res.status(500).send('Error processing file');
    }
  },
);

/**
 * POST /fork
 * This route handles forking a conversation based on the TForkConvoRequest and responds with TForkConvoResponse.
 * @route POST /fork
 * @param {express.Request<{}, TForkConvoResponse, TForkConvoRequest>} req - Express request object.
 * @param {express.Response<TForkConvoResponse>} res - Express response object.
 * @returns {Promise<void>} - The response after forking the conversation.
 */
router.post('/fork', forkIpLimiter, forkUserLimiter, async (req, res) => {
  try {
    const models = await getModelsFromReq(req);
    // Guard: fail fast if models missing (tenant routes always require tenant models)
    if (!models) {
      throw new Error('Tenant models required for this route.');
    }
    /** @type {TForkConvoRequest} */
    const { conversationId, messageId, option, splitAtTarget, latestMessageId } = req.body;
    const result = await forkConversation({
      requestUserId: req.user.id,
      originalConvoId: conversationId,
      targetMessageId: messageId,
      latestMessageId,
      records: true,
      splitAtTarget,
      option,
      models,
    });

    res.json(result);
  } catch (error) {
    logger.error('Error forking conversation:', error);
    res.status(500).send('Error forking conversation');
  }
});

router.post('/duplicate', async (req, res) => {
  const { conversationId, title } = req.body;

  try {
    const models = await getModelsFromReq(req);
    // Guard: fail fast if models missing (tenant routes always require tenant models)
    if (!models) {
      throw new Error('Tenant models required for this route.');
    }
    const result = await duplicateConversation({
      userId: req.user.id,
      conversationId,
      title,
      models,
    });
    res.status(201).json(result);
  } catch (error) {
    logger.error('Error duplicating conversation:', error);
    res.status(500).send('Error duplicating conversation');
  }
});

module.exports = router;
