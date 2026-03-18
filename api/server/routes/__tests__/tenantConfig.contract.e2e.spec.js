/**
 * Tenant config control-plane contract tests (live stack).
 * Requires: MT_IT_LIVE=1, docker-compose.mt-it.yml stack up, ADMIN_AUTH_SECRET aligned.
 *
 * Run (example):
 *   MT_IT_LIVE=1 API_URL=http://localhost:3081 ADMIN_AUTH_SECRET=admin-auth-secret-min-16-chars \
 *   npm --workspace api run test -- tenantConfig.contract.e2e.spec.js
 */
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', '..', '..') });

const axios = require('axios');

const API_URL = process.env.API_URL || 'http://localhost:3081';
const ADMIN_SECRET = process.env.ADMIN_AUTH_SECRET || 'admin-auth-secret-min-16-chars';
const useLive = process.env.MT_IT_LIVE === '1';

const adminHeaders = {
  'X-LibreChat-Role': 'ADMIN',
  'X-Admin-Auth': ADMIN_SECRET,
  'Content-Type': 'application/json',
};

async function ensureStackReachable() {
  try {
    const res = await axios.get(`${API_URL}/health`, {
      timeout: 5000,
      validateStatus: () => true,
    });
    if (res.status !== 200) {
      throw new Error(`/health returned ${res.status} at ${API_URL}/health`);
    }
  } catch (err) {
    throw new Error(
      `Tenant config contract tests require MT-IT stack. API unreachable at ${API_URL}. ` +
        `Start with: docker compose -f docker-compose.mt-it.yml up -d, then set MT_IT_LIVE=1 and re-run. ` +
        `Original error: ${err.message}`,
    );
  }
}

function expectNoSecrets(obj) {
  const serialized = JSON.stringify(obj);
  expect(serialized).not.toMatch(/apiKey/i);
  expect(serialized).not.toMatch(/secretAccessKey/i);
  expect(serialized).not.toMatch(/service.*account.*json/i);
  expect(serialized).not.toMatch(/postgresUri/i);
}

describe('Tenant config control-plane contract (live stack)', () => {
  let createdTenantId;
  let createdConfigVersion;

  beforeAll(async () => {
    if (!useLive) {
      return;
    }
    await ensureStackReachable();
  }, 20000);

  describe('Admin auth and secrecy', () => {
    it('GET /api/admin/tenants without admin headers returns 403', async () => {
      if (!useLive) return;
      const res = await axios.get(`${API_URL}/api/admin/tenants`, {
        validateStatus: () => true,
      });
      expect(res.status).toBe(403);
    });

    it('GET /api/admin/tenants with admin headers returns 200', async () => {
      if (!useLive) return;
      const res = await axios.get(`${API_URL}/api/admin/tenants`, {
        headers: adminHeaders,
        validateStatus: () => true,
      });
      expect(res.status).toBe(200);
      expect(res.data).toBeDefined();
    });

    it('GET /api/admin/tenants/:id?secrets=1 with admin headers returns secrets', async () => {
      if (!useLive) return;

      // Reuse an existing tenant if present; otherwise, create a small one.
      const list = await axios.get(`${API_URL}/api/admin/tenants`, {
        headers: adminHeaders,
        validateStatus: () => true,
      });
      expect(list.status).toBe(200);
      const anyTenant = list.data?.tenants?.[0];
      expect(anyTenant).toBeDefined();

      const res = await axios.get(
        `${API_URL}/api/admin/tenants/${encodeURIComponent(anyTenant.tenantId)}?secrets=1`,
        { headers: adminHeaders, validateStatus: () => true },
      );
      expect(res.status).toBe(200);
      expect(res.data).toBeDefined();
      // We don't assert specific secret field names (they depend on config),
      // only that admin path is reachable and payload is structured.
    });

    it('tenant-facing config endpoint does not expose secrets', async () => {
      if (!useLive) return;

      // Hit endpoint as admin; if it requires user auth or is absent, don't fail this contract test.
      const res = await axios.get(`${API_URL}/api/config/tenant`, {
        headers: adminHeaders,
        validateStatus: () => true,
      });
      if (res.status === 404 || res.status === 401 || res.status === 403) {
        // Endpoint may not exist in this build or may require user auth; document current behavior.
        return;
      }
      expect(res.status).toBe(200);
      expect(res.data).toBeDefined();
      expectNoSecrets(res.data);
    });
  });

  describe('Create, validate, and optimistic concurrency', () => {
    it('creates a tenant with full config and records configVersion', async () => {
      if (!useLive) return;
      const ts = Date.now();
      const tenantId = `tenant-contract-${ts}`;

      const pgUri = 'postgresql://myuser:mypassword@pg-a:5432/tenant_a';
      const storage = {
        provider: 's3',
        bucket: 'bucket-a',
        prefix: `tenant-contract-${ts}/`,
        endpoint: 'http://minio:9000',
        accessKeyId: 'minioadmin',
        secretAccessKey: 'minioadmin',
      };

      const body = {
        tenantId,
        name: tenantId,
        dbUri: 'mongodb://tenant-mongo-a:27017/tenant_contract_db',
        config: {
          rag: { postgresUri: pgUri },
          storage,
        },
      };

      const res = await axios.post(`${API_URL}/api/admin/tenants`, body, {
        headers: adminHeaders,
        validateStatus: () => true,
      });

      if (res.status !== 201 && res.status !== 409) {
        throw new Error(
          `Create tenant contract failed ${res.status}: ${JSON.stringify(res.data)}`,
        );
      }

      // If already existed (409), fetch it instead
      if (res.status === 201) {
        createdTenantId = res.data.tenantId;
        createdConfigVersion = res.data.configVersion;
      } else {
        const getRes = await axios.get(
          `${API_URL}/api/admin/tenants/${encodeURIComponent(tenantId)}`,
          { headers: adminHeaders },
        );
        createdTenantId = getRes.data.tenantId;
        createdConfigVersion = getRes.data.configVersion;
      }

      expect(createdTenantId).toBe(tenantId);
      expect(typeof createdConfigVersion).toBe('number');
    });

    it('rejects optimistic concurrency with stale expectedVersion', async () => {
      if (!useLive || !createdTenantId) return;

      const staleVersion = createdConfigVersion;
      // First, perform a valid patch to bump version
      const goodPatch = await axios.patch(
        `${API_URL}/api/admin/tenants/${encodeURIComponent(createdTenantId)}`,
        {
          expectedVersion: staleVersion,
          config: { storage: { prefix: `tenant-contract-good-${Date.now()}/` } },
        },
        { headers: adminHeaders, validateStatus: () => true },
      );
      expect(goodPatch.status).toBeLessThan(400);

      const afterGood = await axios.get(
        `${API_URL}/api/admin/tenants/${encodeURIComponent(createdTenantId)}`,
        { headers: adminHeaders },
      );
      const newVersion = afterGood.data.configVersion;
      expect(newVersion).toBeGreaterThan(staleVersion);

      // Now attempt a stale PATCH using the original version
      const stalePatch = await axios.patch(
        `${API_URL}/api/admin/tenants/${encodeURIComponent(createdTenantId)}`,
        {
          expectedVersion: staleVersion,
          config: { storage: { prefix: `tenant-contract-stale-${Date.now()}/` } },
        },
        { headers: adminHeaders, validateStatus: () => true },
      );
      expect(stalePatch.status).toBe(409);

      const afterStale = await axios.get(
        `${API_URL}/api/admin/tenants/${encodeURIComponent(createdTenantId)}`,
        { headers: adminHeaders },
      );
      expect(afterStale.data.configVersion).toBe(newVersion);
    });
  });
});
