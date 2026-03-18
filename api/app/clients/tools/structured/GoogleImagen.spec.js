const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', '..', '..', '..') });

jest.mock('@librechat/api', () => ({
  loadServiceKey: jest.fn(),
  isMultiTenancyEnabled: jest.fn().mockReturnValue(true),
}));

jest.mock('~/server/services/Config/TenantConfigService', () => ({
  getTenantConfigService: () => ({
    getTenantConfig: jest.fn().mockResolvedValue({
      secrets: {
        googleServiceKeyFile: '{"type":"service_account","project_id":"tenant-project"}',
      },
      settings: {},
    }),
  }),
}));

jest.mock('google-auth-library', () => {
  const mockGoogleAuth = jest.fn().mockImplementation((options) => {
    mockGoogleAuth.lastOptions = options;
    return {
      getClient: async () => ({
        getAccessToken: async () => ({ token: 'test-token' }),
      }),
    };
  });
  return { GoogleAuth: mockGoogleAuth };
});

const { loadServiceKey } = require('@librechat/api');
const { GoogleAuth } = require('google-auth-library');
const GoogleImagenAPI = require('./GoogleImagen');

describe('GoogleImagenAPI service account handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete GoogleAuth.lastOptions;
    process.env.GOOGLE_SERVICE_KEY_FILE = '';
  });

  it('uses tenant-config raw JSON via loadServiceKey and passes credentials to GoogleAuth', async () => {
    loadServiceKey.mockResolvedValue({
      type: 'service_account',
      project_id: 'tenant-project',
      client_email: 'test@example.com',
      private_key: '-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----\\n',
    });

    const tool = new GoogleImagenAPI({ userId: 'user-1', tenantId: 'tenant-1' });
    const token = await tool.getAccessToken();

    expect(loadServiceKey).toHaveBeenCalledWith(
      '{"type":"service_account","project_id":"tenant-project"}',
    );
    expect(GoogleAuth).toHaveBeenCalledTimes(1);
    expect(GoogleAuth.lastOptions).toBeDefined();
    expect(GoogleAuth.lastOptions.scopes).toContain(
      'https://www.googleapis.com/auth/cloud-platform',
    );
    expect(GoogleAuth.lastOptions.credentials).toBeDefined();
    expect(GoogleAuth.lastOptions.credentials.project_id).toBe('tenant-project');
    expect(token).toBe('test-token');
  });

  it('falls back to env GOOGLE_SERVICE_KEY_FILE in non-MT mode', async () => {
    const apiModule = require('@librechat/api');
    apiModule.isMultiTenancyEnabled.mockReturnValue(false);
    process.env.GOOGLE_SERVICE_KEY_FILE = '{"type":"service_account","project_id":"env-project"}';
    loadServiceKey.mockResolvedValue({
      type: 'service_account',
      project_id: 'env-project',
    });

    const tool = new GoogleImagenAPI({ userId: 'user-1' });
    await tool.getAccessToken();

    expect(loadServiceKey).toHaveBeenCalledWith(
      '{"type":"service_account","project_id":"env-project"}',
    );
    expect(GoogleAuth.lastOptions.credentials.project_id).toBe('env-project');
  });
});

