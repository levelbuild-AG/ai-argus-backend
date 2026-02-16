const express = require('express');
const { sendMeta, sendHealth } = require('./meta');

const router = express.Router();

router.use('/agents', require('./agents'));
router.get('/meta', sendMeta);
router.get('/health', sendHealth);
router.use('/convos', require('./convos'));
router.use('/messages', require('./messages'));
router.use('/endpoints', require('./endpoints'));
router.use('/models', require('./models'));
router.use('/balance', require('./balance'));
router.use('/plugins', require('./plugins'));
router.use('/categories', require('./categories'));
router.use('/tokenizer', require('./tokenizer'));
router.use('/config', require('./config'));
router.use('/banner', require('./banner'));
router.use('/share', require('./share'));
router.use('/presets', require('./presets'));
router.use('/prompts', require('./prompts'));
router.use('/tags', require('./tags'));
router.use('/search', require('./search'));
router.use('/memories', require('./memories'));
router.use('/permissions', require('./permissions'));
router.use('/roles', require('./roles'));
router.use('/user', require('./user'));
router.use('/keys', require('./keys'));
router.use('/files', require('./files'));

module.exports = router;
