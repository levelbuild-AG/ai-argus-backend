const EXT_API_VERSION = '2.0.0';

const sendMeta = (_req, res) =>
  res.status(200).json({
    version: EXT_API_VERSION,
    status: 'ok',
  });

const sendHealth = (_req, res) =>
  res.status(200).json({
    status: 'ok',
  });

module.exports = {
  sendMeta,
  sendHealth,
  EXT_API_VERSION,
};
