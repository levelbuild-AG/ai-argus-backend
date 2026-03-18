const checkBan = require('../checkBan');

describe('checkBan DEV_DISABLE_BAN_CHECK bypass', () => {
  const origEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  function buildReqResNext() {
    const req = {
      headers: {},
      body: {},
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();
    return { req, res, next };
  }

  test('defaults to normal behavior when DEV_DISABLE_BAN_CHECK is not "true"', async () => {
    process.env.DEV_DISABLE_BAN_CHECK = 'false';
    process.env.BAN_VIOLATIONS = '0'; // disable via feature flag

    const { req, res, next } = buildReqResNext();

    await checkBan(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('bypasses ban enforcement when DEV_DISABLE_BAN_CHECK === "true"', async () => {
    process.env.DEV_DISABLE_BAN_CHECK = 'true';
    process.env.BAN_VIOLATIONS = '1';

    const { req, res, next } = buildReqResNext();

    await checkBan(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
}

