/**
 * Proves addTitle passes tenant-scoped models to saveConvo so title persistence
 * lands in the tenant DB, not the system DB.
 */
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', '..', '..', '..', '..') });

jest.mock('~/db/tenantHelpers', () => ({
  getTenantModels: jest.fn(),
}));

const mockSaveConvo = jest.fn().mockResolvedValue({ conversationId: 'c1', title: 'Title' });
jest.mock('~/models', () => ({
  saveConvo: (...args) => mockSaveConvo(...args),
}));

const { getTenantModels } = require('~/db/tenantHelpers');

jest.mock('~/cache/getLogStores', () => () => ({
  set: jest.fn().mockResolvedValue(undefined),
}));

const addTitle = require('./title');

describe('addTitle tenant-safety', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes tenant-scoped models to saveConvo when getTenantModels resolves', async () => {
    const tenantModels = { Conversation: {}, Message: {} };
    getTenantModels.mockResolvedValue(tenantModels);

    const req = { user: { id: 'user-1' } };
    const client = {
      options: { titleConvo: true },
      titleConvo: jest.fn().mockResolvedValue('My Title'),
    };

    await addTitle(req, {
      text: 'Hello',
      response: { conversationId: 'convo-1' },
      client,
    });

    expect(mockSaveConvo).toHaveBeenCalledTimes(1);
    const call = mockSaveConvo.mock.calls[0];
    expect(call[0]).toBe(req);
    expect(call[1]).toMatchObject({ conversationId: 'convo-1', title: 'My Title' });
    expect(call[2]).toMatchObject({ context: 'api/server/services/Endpoints/agents/title.js' });
    expect(call[3]).toBe(tenantModels);
  });

  it('passes undefined models to saveConvo when getTenantModels throws', async () => {
    getTenantModels.mockRejectedValue(new Error('No tenant context'));

    const req = { user: { id: 'user-1' } };
    const client = {
      options: { titleConvo: true },
      titleConvo: jest.fn().mockResolvedValue('Fallback Title'),
    };

    await addTitle(req, {
      text: 'Hi',
      response: { conversationId: 'convo-2' },
      client,
    });

    expect(mockSaveConvo).toHaveBeenCalledTimes(1);
    const call = mockSaveConvo.mock.calls[0];
    expect(call[3]).toBeUndefined();
  });
});
