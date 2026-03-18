const { isEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const getLogStores = require('~/cache/getLogStores');
const { saveConvo } = require('~/models');
const { getTenantModels } = require('~/db/tenantHelpers');

/**
 * Add title to conversation in a way that avoids memory retention.
 * @returns {Promise<string|undefined>} The generated title, or undefined if none/failed.
 */
const addTitle = async (req, { text, response, client }) => {
  const { TITLE_CONVO = true } = process.env ?? {};
  if (!isEnabled(TITLE_CONVO)) {
    return undefined;
  }

  if (client.options.titleConvo === false) {
    return undefined;
  }

  const titleCache = getLogStores(CacheKeys.GEN_TITLE);
  const key = `${req.user.id}-${response.conversationId}`;
  /** @type {NodeJS.Timeout} */
  let timeoutId;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Title generation timeout')), 45000);
    }).catch((error) => {
      logger.error('Title error:', error);
    });

    let titlePromise;
    let abortController = new AbortController();
    if (client && typeof client.titleConvo === 'function') {
      titlePromise = Promise.race([
        client
          .titleConvo({
            text,
            abortController,
          })
          .catch((error) => {
            logger.error('Client title error:', error);
          }),
        timeoutPromise,
      ]);
    } else {
      return undefined;
    }

    const title = await titlePromise;
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (!title) {
      logger.debug(`[${key}] No title generated`);
      return undefined;
    }

    await titleCache.set(key, title, 120000);
    // Use tenant-scoped models when in tenant context so title persists to tenant DB, not system DB
    let models;
    try {
      models = await getTenantModels();
    } catch (_) {
      models = undefined;
    }
    await saveConvo(
      req,
      {
        conversationId: response.conversationId,
        title,
      },
      { context: 'api/server/services/Endpoints/agents/title.js' },
      models,
    );
    return title;
  } catch (error) {
    logger.error('Error generating title:', error);
    return undefined;
  }
};

module.exports = addTitle;
