const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', '..') });

jest.mock('~/models', () => ({
  findUser: jest.fn(),
  createUser: jest.fn(),
  updateUser: jest.fn(),
}));

jest.mock('~/db/models', () => ({
  User: {
    find: jest.fn(),
  },
}));

const { findUser, createUser, updateUser } = require('~/models');
const { User } = require('~/db/models');
const requireExtUserAuth = require('./requireExtUserAuth');
const { ensureUser } = require('./requireExtUserAuth');

/** Chainable Mongoose-style query mock: .find().sort().limit().lean() → Promise<array> */
function chainableFindMock(result = []) {
  const chain = {
    sort() {
      return chain;
    },
    limit() {
      return chain;
    },
    lean() {
      return Promise.resolve(result);
    },
  };
  return chain;
}

describe('requireExtUserAuth tenant-scoped identity (unit)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: User.find returns chainable mock that resolves to [] (no existing user)
    User.find.mockImplementation(() => chainableFindMock([]));
  });

  it('creates tenant-a user for shared email when no scoped/legacy user exists', async () => {
    const email = 'shared@example.com';

    createUser.mockResolvedValueOnce({
      _id: 'user-a-id',
      email,
      tenantId: 'tenant-a',
      provider: 'external_v2',
    });

    const userA = await ensureUser({
      externalId: email,
      email,
      name: null,
      tenantId: 'tenant-a',
    });

    expect(createUser).toHaveBeenCalledTimes(1);
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email, tenantId: 'tenant-a' }),
      undefined,
      true,
      true,
    );
    expect(userA).toMatchObject({ email, tenantId: 'tenant-a' });
  });

  it('creates tenant-b user for same shared email when no scoped/legacy user exists', async () => {
    const email = 'shared@example.com';

    createUser.mockResolvedValueOnce({
      _id: 'user-b-id',
      email,
      tenantId: 'tenant-b',
      provider: 'external_v2',
    });

    const userB = await ensureUser({
      externalId: email,
      email,
      name: null,
      tenantId: 'tenant-b',
    });

    expect(createUser).toHaveBeenCalledTimes(1);
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email, tenantId: 'tenant-b' }),
      undefined,
      true,
      true,
    );
    expect(userB).toMatchObject({ email, tenantId: 'tenant-b' });
  });

  it('binds a legacy user to tenant on first request', async () => {
    const legacyUser = {
      _id: 'legacy-id',
      email: 'legacy@example.com',
      tenantId: 'legacy',
    };

    const req = {
      headers: {
        // Looks like a Mongo ObjectId so requireExtUserAuth will use findUser({_id})
        'x-user-id': '0123456789abcdef01234567',
        'x-user-email': 'legacy@example.com',
        'x-tenant-id': 'tenant-x',
      },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    const next = jest.fn();

    findUser.mockResolvedValueOnce(legacyUser);

    updateUser.mockResolvedValueOnce({
      _id: 'legacy-id',
      email: 'legacy@example.com',
      tenantId: 'tenant-x',
    });

    await requireExtUserAuth(req, res, next);

    expect(updateUser).toHaveBeenCalledWith('legacy-id', { tenantId: 'tenant-x' });
    expect(req.user).toMatchObject({ email: 'legacy@example.com', tenantId: 'tenant-x' });
  });
});

