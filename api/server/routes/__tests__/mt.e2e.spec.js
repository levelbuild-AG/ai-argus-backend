/**
 * Multi-tenant E2E integration tests.
 * Requires: MT_IT_LIVE=1, stack up (docker compose -f docker-compose.mt-it.yml up -d).
 * If MT_IT_LIVE=1 and API is unreachable, the suite FAILS (no silent skip).
 *
 * Run: MT_IT_LIVE=1 API_URL=http://localhost:3081 ADMIN_AUTH_SECRET=admin-auth-secret-min-16-chars npm run test -- mt.e2e.spec.js
 */
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', '..', '..') });

console.log('[MT-E2E] USING MODIFIED TEST FILE v2 - tenant patch + rag health diagnostics enabled');

const axios = require('axios');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { MongoClient } = require('mongodb');
const Redis = require('ioredis');
const { Client: PgClient } = require('pg');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

const API_URL = process.env.API_URL || 'http://localhost:3081';
const ADMIN_SECRET = process.env.ADMIN_AUTH_SECRET || 'admin-auth-secret-min-16-chars';
const RAG_API_URL = process.env.RAG_API_URL || 'http://localhost:8001';
const useLive = process.env.MT_IT_LIVE === '1';

const adminHeaders = {
  'X-LibreChat-Role': 'ADMIN',
  'X-Admin-Auth': ADMIN_SECRET,
  'Content-Type': 'application/json',
};

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const DB_A = 'tenantA_db';
const DB_B = 'tenantB_db';
const MONGO_A_URI = 'mongodb://localhost:27018';
const MONGO_B_URI = 'mongodb://localhost:27019';
const SYSTEM_MONGO_URI = process.env.MT_IT_SYSTEM_MONGO_URI || 'mongodb://localhost:27017/LibreChat';
const REDIS_URI = process.env.MT_IT_REDIS_URI || 'redis://localhost:6379';
const PG_A_URI = process.env.MT_IT_PG_A_URI || 'postgresql://myuser:mypassword@localhost:5432/tenant_a';
const PG_B_URI = process.env.MT_IT_PG_B_URI || 'postgresql://myuser:mypassword@localhost:5433/tenant_b';
const MEILI_HOST = process.env.MT_IT_MEILI_HOST || 'http://localhost:7700';
const MEILI_KEY = process.env.MEILI_MASTER_KEY || 'masterKeyMin16Chars';
const MINIO_ENDPOINT = process.env.MT_IT_MINIO_ENDPOINT || 'http://localhost:9000';
const MINIO_ACCESS = process.env.MT_IT_MINIO_ACCESS || 'minioadmin';
const MINIO_SECRET = process.env.MT_IT_MINIO_SECRET || 'minioadmin';
const JWT_SECRET = process.env.JWT_SECRET || 'jwt-secret';

function shortLivedToken(userId) {
  return jwt.sign(
    { id: userId, exp: Math.floor(Date.now() / 1000) + 300 },
    JWT_SECRET,
    { algorithm: 'HS256' },
  );
}

let tokenA;
let tokenB;
let userAId;
let userBId;
let tenantlessToken; // shared token for tenantless negative tests

async function ensureStackReachable() {
  try {
    const res = await axios.get(`${API_URL}/api/admin/tenants`, {
      headers: adminHeaders,
      timeout: 5000,
      validateStatus: () => true,
    });
    if (res.status !== 200) {
      throw new Error(`Admin API returned ${res.status}; stack may be down or auth wrong`);
    }
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
      throw new Error(
        `E2E requires stack. API unreachable at ${API_URL}. Start with: docker compose -f docker-compose.mt-it.yml up -d. Then set MT_IT_LIVE=1 and re-run.`,
      );
    }
    throw err;
  }
}

async function ensureBaselineTenant(tenantId, dbUri, ragPgUri, storageConfig) {
  const body = {
    tenantId,
    name: tenantId,
    dbUri,
    config: {
      rag: { postgresUri: ragPgUri },
      storage: storageConfig,
    },
  };

  // Try to create the tenant first
  const createRes = await axios
    .post(`${API_URL}/api/admin/tenants`, body, {
      headers: adminHeaders,
      validateStatus: () => true,
    })
    .catch((e) => e.response);

  if (createRes?.status === 201) {
    return;
  }

  if (createRes?.status !== 409) {
    throw new Error(
      `Create tenant ${tenantId} failed: ${createRes?.status} ${JSON.stringify(createRes?.data)}`,
    );
  }

  // Tenant exists; list tenants and find by tenantId (avoid relying on GET :id semantics)
  const listRes = await axios.get(`${API_URL}/api/admin/tenants`, {
    headers: adminHeaders,
    params: { limit: 100 },
  });
  if (listRes.status !== 200) {
    throw new Error(
      `GET /api/admin/tenants failed ${listRes.status}: ${JSON.stringify(listRes.data)}`,
    );
  }
  const current = (listRes.data?.tenants || []).find((t) => t.tenantId === tenantId);
  if (!current) {
    throw new Error(`Tenant ${tenantId} not found in list after 409`);
  }
  if (current._id == null) {
    throw new Error(`Tenant ${tenantId} list entry missing _id`);
  }

  const expectedVersion = current.configVersion;
  // Send only baseline fields; server merges with existing config. Do not spread current.config
  // into the body (it can contain _id/Buffer-like values that trigger Cast to ObjectId errors).
  const patchBody = {
    expectedVersion,
    dbUri,
    config: {
      rag: { postgresUri: ragPgUri },
      storage: storageConfig,
    },
  };
  // eslint-disable-next-line no-console
  console.log('[MT-E2E] baseline patch target', {
    tenantId,
    patchId: current._id,
    configVersion: current.configVersion,
  });

  const patchRes = await axios.patch(
    `${API_URL}/api/admin/tenants/${encodeURIComponent(tenantId)}`,
    patchBody,
    { headers: adminHeaders, validateStatus: () => true },
  );

  if (patchRes.status >= 400) {
    throw new Error(
      `PATCH tenant ${tenantId} failed ${patchRes.status}: ${JSON.stringify(patchRes.data)}`,
    );
  }
}

async function createTenants() {
  const pgA = 'postgresql://myuser:mypassword@pg-a:5432/tenant_a';
  const pgB = 'postgresql://myuser:mypassword@pg-b:5432/tenant_b';
  const storageA = {
    provider: 's3',
    bucket: 'bucket-a',
    prefix: 'tenantA/',
    endpoint: 'http://minio:9000',
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
  };
  const storageB = {
    provider: 's3',
    bucket: 'bucket-b',
    prefix: 'tenantB/',
    endpoint: 'http://minio:9000',
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
  };

  await ensureBaselineTenant(TENANT_A, `mongodb://tenant-mongo-a:27017/${DB_A}`, pgA, storageA);
  await ensureBaselineTenant(TENANT_B, `mongodb://tenant-mongo-b:27017/${DB_B}`, pgB, storageB);
}

async function seedUsersAndLogin() {
  const { createModels } = require('@librechat/data-schemas');
  await mongoose.connect(SYSTEM_MONGO_URI);
  const models = createModels(mongoose);
  const User = models.User;
  const password = 'TestPassword123!';
  const hash = bcrypt.hashSync(password, bcrypt.genSaltSync(10));

  // Hard reset MT E2E users to ensure deterministic tenant assignment
  await User.deleteMany({
    email: { $in: ['mt-e2e-a@test.local', 'mt-e2e-b@test.local'] },
  });

  const uA = await User.create({
    email: 'mt-e2e-a@test.local',
    username: 'mt-e2e-a',
    name: 'MT E2E User A',
    provider: 'local',
    password: hash,
    emailVerified: true,
    tenantId: TENANT_A,
  });

  const uB = await User.create({
    email: 'mt-e2e-b@test.local',
    username: 'mt-e2e-b',
    name: 'MT E2E User B',
    provider: 'local',
    password: hash,
    emailVerified: true,
    tenantId: TENANT_B,
  });
  userAId = uA._id.toString();
  userBId = uB._id.toString();
  await mongoose.disconnect();

  const loginA = await axios.post(
    `${API_URL}/api/auth/login`,
    { email: 'mt-e2e-a@test.local', password },
    { validateStatus: () => true, timeout: 15000 },
  );
  const loginB = await axios.post(
    `${API_URL}/api/auth/login`,
    { email: 'mt-e2e-b@test.local', password },
    { validateStatus: () => true, timeout: 15000 },
  );
  if (loginA.status !== 200 || !loginA.data?.token) {
    throw new Error(`Login A failed ${loginA.status}: ${JSON.stringify(loginA.data)}`);
  }
  if (loginB.status !== 200 || !loginB.data?.token) {
    throw new Error(`Login B failed ${loginB.status}: ${JSON.stringify(loginB.data)}`);
  }
  tokenA = loginA.data.token;
  tokenB = loginB.data.token;

  // Sanity: tokens must be non-empty strings
  if (!tokenA || typeof tokenA !== 'string') {
    throw new Error(`TokenA invalid after login: ${String(tokenA)}`);
  }
  if (!tokenB || typeof tokenB !== 'string') {
    throw new Error(`TokenB invalid after login: ${String(tokenB)}`);
  }
}

function authHeaders(token) {
  if (!token || typeof token !== 'string') {
    throw new Error(`authHeaders called with invalid token: ${String(token)}`);
  }
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

describe('MT E2E (live stack)', () => {
  beforeAll(async () => {
    if (!useLive) {
      return;
    }
    await ensureStackReachable();
    await createTenants();
    await seedUsersAndLogin();
  }, 30000);

  it('when MT_IT_LIVE=1 stack is required and reachable', async () => {
    if (!useLive) return;
    const res = await axios.get(`${API_URL}/api/admin/tenants`, { headers: adminHeaders });
    expect(res.status).toBe(200);
    expect(res.data.tenants).toBeDefined();
  });

  describe('Mongo routing', () => {
    it('tenant-scoped write lands in correct Mongo host only', async () => {
      if (!useLive) return;
      const convoIdA = `mt-e2e-mongo-a-${Date.now()}`;
      const convoIdB = `mt-e2e-mongo-b-${Date.now()}`;

      const resA = await axios.post(
        `${API_URL}/api/convos/update`,
        { arg: { conversationId: convoIdA, title: 'E2E Mongo A' } },
        { headers: authHeaders(tokenA), validateStatus: () => true },
      );
      if (resA.status >= 400) {
        throw new Error(
          `/api/convos/update (tenant A) failed ${resA.status}: ${JSON.stringify(resA.data)}`,
        );
      }

      const resB = await axios.post(
        `${API_URL}/api/convos/update`,
        { arg: { conversationId: convoIdB, title: 'E2E Mongo B' } },
        { headers: authHeaders(tokenB), validateStatus: () => true },
      );
      if (resB.status >= 400) {
        throw new Error(
          `/api/convos/update (tenant B) failed ${resB.status}: ${JSON.stringify(resB.data)}`,
        );
      }

      const clientA = await MongoClient.connect(MONGO_A_URI);
      const clientB = await MongoClient.connect(MONGO_B_URI);
      try {
        const dbA = clientA.db(DB_A);
        const dbB = clientB.db(DB_B);
        // Use title-based lookup to tolerate ID shape differences
        const convosA = await dbA
          .collection('conversations')
          .find({ title: 'E2E Mongo A' })
          .toArray();
        const convosB = await dbB
          .collection('conversations')
          .find({ title: 'E2E Mongo B' })
          .toArray();
        const leakAInB = await dbB
          .collection('conversations')
          .find({ title: 'E2E Mongo A' })
          .toArray();
        const leakBInA = await dbA
          .collection('conversations')
          .find({ title: 'E2E Mongo B' })
          .toArray();

        if (
          convosA.length < 1 ||
          convosB.length < 1 ||
          leakAInB.length !== 0 ||
          leakBInA.length !== 0
        ) {
          throw new Error(
            `Mongo routing mismatch: tenantA=${convosA.length}, tenantB=${convosB.length}, leakAInB=${leakAInB.length}, leakBInA=${leakBInA.length}`,
          );
        }
      } finally {
        await clientA.close();
        await clientB.close();
      }
    }, 15000);
  });

  describe('RAG routing', () => {
    it('embed for tenant A lands in pg-a, for B in pg-b', async () => {
      if (!useLive) return;
      const fileIdA = `mt-e2e-rag-a-${Date.now()}`;
      const fileIdB = `mt-e2e-rag-b-${Date.now()}`;
      const tmpDir = os.tmpdir();
      const filePathA = path.join(tmpDir, `rag-a-${Date.now()}.txt`);
      const filePathB = path.join(tmpDir, `rag-b-${Date.now()}.txt`);
      fs.writeFileSync(filePathA, 'E2E RAG tenant A unique content for vector.');
      fs.writeFileSync(filePathB, 'E2E RAG tenant B unique content for vector.');

      // Wait for rag_api health before first embed to avoid race conditions
      const start = Date.now();
      let last = null;
      // Best-effort: up to ~30s
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          const health = await axios.get(`${RAG_API_URL}/health`, {
            validateStatus: () => true,
            timeout: 5000,
          });
          last = { type: 'http', status: health.status, data: health.data };
          if (health.status === 200) {
            break;
          }
        } catch (err) {
          last = {
            type: 'error',
            code: err.code,
            message: err.message,
            status: err.response?.status,
            data: err.response?.data,
          };
        }
        if (Date.now() - start > 30000) {
          throw new Error(
            `rag_api /health did not return 200 within 30s at ${RAG_API_URL}/health; last=${JSON.stringify(
              last,
            )}`,
          );
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      try {
        const formA = new FormData();
        formA.append('file_id', fileIdA);
        formA.append('file', fs.createReadStream(filePathA));
        const embedA = await axios.post(`${RAG_API_URL}/embed`, formA, {
          headers: {
            'X-Tenant-ID': TENANT_A,
            Authorization: `Bearer ${tokenA}`,
            ...formA.getHeaders(),
          },
          maxBodyLength: Infinity,
          timeout: 60000,
          validateStatus: () => true,
        });
        if (embedA.status >= 400) {
          throw new Error(
            `${RAG_API_URL}/embed (tenant A) failed ${embedA.status}: ${JSON.stringify(
              embedA.data,
            )}`,
          );
        }
        const formB = new FormData();
        formB.append('file_id', fileIdB);
        formB.append('file', fs.createReadStream(filePathB));
        const embedB = await axios.post(`${RAG_API_URL}/embed`, formB, {
          headers: {
            'X-Tenant-ID': TENANT_B,
            Authorization: `Bearer ${tokenB}`,
            ...formB.getHeaders(),
          },
          maxBodyLength: Infinity,
          timeout: 60000,
          validateStatus: () => true,
        });
        if (embedB.status >= 400) {
          throw new Error(
            `${RAG_API_URL}/embed (tenant B) failed ${embedB.status}: ${JSON.stringify(
              embedB.data,
            )}`,
          );
        }
      } finally {
        try { fs.unlinkSync(filePathA); } catch (_) {}
        try { fs.unlinkSync(filePathB); } catch (_) {}
      }

      const pgA = new PgClient({ connectionString: PG_A_URI });
      const pgB = new PgClient({ connectionString: PG_B_URI });
      await pgA.connect();
      await pgB.connect();
      try {
        const start = Date.now();
        let resA;
        let resB;
        let leakAInB;
        let leakBInA;
        // Poll for up to 30s to account for any async commit latency
        // eslint-disable-next-line no-constant-condition
        while (true) {
          resA = await pgA.query(
            "SELECT COUNT(*) AS cnt FROM langchain_pg_embedding WHERE (cmetadata->>'file_id') = $1",
            [fileIdA],
          );
          resB = await pgB.query(
            "SELECT COUNT(*) AS cnt FROM langchain_pg_embedding WHERE (cmetadata->>'file_id') = $1",
            [fileIdB],
          );
          leakAInB = await pgB.query(
            "SELECT COUNT(*) AS cnt FROM langchain_pg_embedding WHERE (cmetadata->>'file_id') = $1",
            [fileIdA],
          );
          leakBInA = await pgA.query(
            "SELECT COUNT(*) AS cnt FROM langchain_pg_embedding WHERE (cmetadata->>'file_id') = $1",
            [fileIdB],
          );

          const aCnt = parseInt(resA.rows[0].cnt, 10);
          const bCnt = parseInt(resB.rows[0].cnt, 10);
          const aInB = parseInt(leakAInB.rows[0].cnt, 10);
          const bInA = parseInt(leakBInA.rows[0].cnt, 10);

          if (aCnt >= 1 && bCnt >= 1 && aInB === 0 && bInA === 0) {
            break;
          }

          if (Date.now() - start > 30000) {
            throw new Error(
              `RAG routing mismatch after 30s: tenantA=${aCnt}, tenantB=${bCnt}, leakAInB=${aInB}, leakBInA=${bInA}`,
            );
          }

          await new Promise((r) => setTimeout(r, 500));
        }

        expect(parseInt(resA.rows[0].cnt, 10)).toBeGreaterThanOrEqual(1);
        expect(parseInt(resB.rows[0].cnt, 10)).toBeGreaterThanOrEqual(1);
        expect(parseInt(leakAInB.rows[0].cnt, 10)).toBe(0);
        expect(parseInt(leakBInA.rows[0].cnt, 10)).toBe(0);
      } finally {
        await pgA.end();
        await pgB.end();
      }
    }, 60000);
  });

  describe('Meilisearch isolation', () => {
    it('search returns only tenant-scoped results', async () => {
      if (!useLive) return;
      const uniqueA = `UniqueMeiliTermA-${Date.now()}`;
      const uniqueB = `UniqueMeiliTermB-${Date.now()}`;
      await axios.post(
        `${API_URL}/api/convos/update`,
        { arg: { conversationId: `meili-a-${Date.now()}`, title: uniqueA } },
        { headers: authHeaders(tokenA) },
      );
      await axios.post(
        `${API_URL}/api/convos/update`,
        { arg: { conversationId: `meili-b-${Date.now()}`, title: uniqueB } },
        { headers: authHeaders(tokenB) },
      );
      // Poll for Meilisearch indexing to become consistent
      const start = Date.now();
      let listA;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        listA = await axios.get(
          `${API_URL}/api/convos?search=${encodeURIComponent(uniqueA)}&limit=10`,
          { headers: authHeaders(tokenA), validateStatus: () => true },
        );
        if (listA.status >= 400) {
          throw new Error(
            `/api/convos search (tenant A) failed ${listA.status}: ${JSON.stringify(
              listA.data,
            )}`,
          );
        }
        if (listA.data && Array.isArray(listA.data.conversations)) {
          const hit = listA.data.conversations.some(
            (c) => (c.title || '').includes(uniqueA),
          );
          if (hit) break;
        }
        if (Date.now() - start > 45000) {
          throw new Error(
            `/api/convos search (tenant A) did not return hit for ${uniqueA} within 45s; last=${JSON.stringify(
              listA.data,
            )}`,
          );
        }
        await new Promise((r) => setTimeout(r, 750));
      }

      const listB = await axios.get(
        `${API_URL}/api/convos?search=${encodeURIComponent(uniqueB)}&limit=10`,
        { headers: authHeaders(tokenB), validateStatus: () => true },
      );
      if (listB.status >= 400) {
        throw new Error(
          `/api/convos search (tenant B) failed ${listB.status}: ${JSON.stringify(listB.data)}`,
        );
      }
      if (!listB.data || !Array.isArray(listB.data.conversations)) {
        throw new Error(
          `/api/convos search (tenant B) unexpected payload: ${JSON.stringify(listB.data)}`,
        );
      }

      const crossB = await axios.get(
        `${API_URL}/api/convos?search=${encodeURIComponent(uniqueA)}&limit=10`,
        { headers: authHeaders(tokenB), validateStatus: () => true },
      );
      if (crossB.status >= 400) {
        throw new Error(
          `/api/convos search (cross tenant B) failed ${crossB.status}: ${JSON.stringify(
            crossB.data,
          )}`,
        );
      }
      if (!crossB.data || !Array.isArray(crossB.data.conversations)) {
        throw new Error(
          `/api/convos search (cross tenant B) unexpected payload: ${JSON.stringify(
            crossB.data,
          )}`,
        );
      }

      expect(listA.data.conversations.some((c) => (c.title || '').includes(uniqueA))).toBe(true);
      expect(listB.data.conversations.some((c) => (c.title || '').includes(uniqueB))).toBe(true);
      expect(crossB.data.conversations.some((c) => (c.title || '').includes(uniqueA))).toBe(false);
    }, 60000);
  });

  describe('Storage (Minio) isolation', () => {
    it('upload via /api/files stores objects under correct tenant prefixes; exact key from response', async () => {
      if (!useLive) return;

      const tmpDir = os.tmpdir();
      const ts = Date.now();
      const fileIdA = randomUUID();
      const fileIdB = randomUUID();
      const originalNameA = `storage-a-${ts}.txt`;
      const originalNameB = `storage-b-${ts}.txt`;
      const filePathA = path.join(tmpDir, originalNameA);
      const filePathB = path.join(tmpDir, originalNameB);
      fs.writeFileSync(filePathA, 'MT E2E storage test A');
      fs.writeFileSync(filePathB, 'MT E2E storage test B');

      let resA;
      let resB;
      try {
        const formA = new FormData();
        formA.append('file', fs.createReadStream(filePathA), { filename: originalNameA });
        formA.append('file_id', fileIdA);
        formA.append('message_file', 'true');
        formA.append('endpoint', 'chat');
        resA = await axios.post(`${API_URL}/api/files`, formA, {
          headers: {
            Authorization: `Bearer ${tokenA}`,
            'X-Tenant-ID': TENANT_A,
            Accept: 'application/json',
            ...formA.getHeaders(),
          },
          maxBodyLength: Infinity,
          validateStatus: () => true,
        });

        const formB = new FormData();
        formB.append('file', fs.createReadStream(filePathB), { filename: originalNameB });
        formB.append('file_id', fileIdB);
        formB.append('message_file', 'true');
        formB.append('endpoint', 'chat');
        resB = await axios.post(`${API_URL}/api/files`, formB, {
          headers: {
            Authorization: `Bearer ${tokenB}`,
            'X-Tenant-ID': TENANT_B,
            Accept: 'application/json',
            ...formB.getHeaders(),
          },
          maxBodyLength: Infinity,
          validateStatus: () => true,
        });
      } finally {
        try { fs.unlinkSync(filePathA); } catch (_) {}
        try { fs.unlinkSync(filePathB); } catch (_) {}
      }

      if (resA.status !== 200) {
        throw new Error(
          `/api/files (tenant A) failed ${resA.status}: ${JSON.stringify(resA.data)}`,
        );
      }
      if (resB.status !== 200) {
        throw new Error(
          `/api/files (tenant B) failed ${resB.status}: ${JSON.stringify(resB.data)}`,
        );
      }
      if (!resA.data || !resA.data.file_id || !resA.data.filepath) {
        throw new Error(
          `/api/files (tenant A) unexpected payload: ${JSON.stringify(resA.data)}`,
        );
      }
      if (!resB.data || !resB.data.file_id || !resB.data.filepath) {
        throw new Error(
          `/api/files (tenant B) unexpected payload: ${JSON.stringify(resB.data)}`,
        );
      }

      // Derive exact S3 key from response filepath by URL parsing (no provider internals)
      const toKey = (urlString) => {
        const url = new URL(urlString);
        const pathname = url.pathname.replace(/^\/+/, '');
        const segments = pathname.split('/');
        if (segments.length < 2) {
          throw new Error(`Unexpected S3 URL pathname: ${pathname}`);
        }
        // Path-style (http://host/bucket/key...) → [bucket, ...key]
        // Virtual-host-style (https://bucket.host/key...) → pathname already key-only
        const [maybeBucket, ...rest] = segments;
        // In our Minio E2E (path-style), bucket is first segment; ListObjectsV2 returns key-only.
        return rest.length ? rest.join('/') : maybeBucket;
      };

      const expectedKeyA = toKey(resA.data.filepath);
      const expectedKeyB = toKey(resB.data.filepath);

      const s3 = new S3Client({
        region: 'us-east-1',
        endpoint: MINIO_ENDPOINT,
        credentials: { accessKeyId: MINIO_ACCESS, secretAccessKey: MINIO_SECRET },
        forcePathStyle: true,
      });

      const listA = await s3.send(new ListObjectsV2Command({ Bucket: 'bucket-a', MaxKeys: 200 }));
      const listB = await s3.send(new ListObjectsV2Command({ Bucket: 'bucket-b', MaxKeys: 200 }));
      const keysA = (listA.Contents || []).map((o) => o.Key).filter(Boolean);
      const keysB = (listB.Contents || []).map((o) => o.Key).filter(Boolean);

      expect(keysA).toContain(expectedKeyA);
      expect(keysB).toContain(expectedKeyB);
      expect(keysA.every((k) => !k.startsWith('tenantB/'))).toBe(true);
      expect(keysB.every((k) => !k.startsWith('tenantA/'))).toBe(true);
    }, 30000);
  });

  describe('Redis namespacing', () => {
    it('exact tenant and system key format (USE_REDIS) after internal trigger', async () => {
      if (!useLive) return;

      const convoAllowed = `mt-e2e-redis-${Date.now()}`;
      const triggerRes = await axios.post(
        `${API_URL}/api/admin/internal/mt-e2e/trigger-redis-keys`,
        { tenantId: TENANT_A, userId: userAId, conversationId: convoAllowed },
        { headers: adminHeaders, validateStatus: () => true },
      );
      if (triggerRes.status >= 400) {
        throw new Error(
          `/api/admin/internal/mt-e2e/trigger-redis-keys failed ${triggerRes.status}: ${JSON.stringify(
            triggerRes.data,
          )}`,
        );
      }
      expect(triggerRes.status).toBe(200);

      // Exact key format from convoAccess.js (USE_REDIS=true): prefix + namespace + ':' + userId + ':' + conversationId
      const CONVO_ACCESS = 'convo_access';
      const expectedTenantKey = `tenant:${TENANT_A}:${CONVO_ACCESS}:${userAId}:${convoAllowed}`;
      const expectedSystemKey = `system:${CONVO_ACCESS}:${userAId}`;

      const written = triggerRes.data?.written;
      if (!Array.isArray(written) || written.length < 2) {
        throw new Error(
          `/api/admin/internal/mt-e2e/trigger-redis-keys unexpected payload: ${JSON.stringify(
            triggerRes.data,
          )}`,
        );
      }
      const tenantEntry = written.find((w) => w.value === 'authorized') || written[0];
      const systemEntry = written.find((w) => w.key !== tenantEntry.key) || written[1];

      // Assert keys and values exactly as expected; rely on internal endpoint
      expect(tenantEntry.key).toBe(expectedTenantKey);
      expect(tenantEntry.value).toBe('authorized');
      expect(systemEntry.key).toBe(expectedSystemKey);
      expect(parseInt(systemEntry.value, 10)).toBeGreaterThanOrEqual(0);
    }, 15000);
  });

  describe('Negative security', () => {
    it('non-admin cannot spoof tenant via X-Tenant-ID', async () => {
      if (!useLive) return;
      const marker = `NEG-SPOOF-${Date.now()}`;

      // User A (tenant-a) attempts to write to tenant-b by overriding X-Tenant-ID
      const spoofHeaders = {
        Authorization: `Bearer ${tokenA}`,
        'X-Tenant-ID': TENANT_B,
        'Content-Type': 'application/json',
      };

      const res = await axios.post(
        `${API_URL}/api/convos/update`,
        { arg: { conversationId: `neg-spoof-${Date.now()}`, title: marker } },
        { headers: spoofHeaders, validateStatus: () => true },
      );

      expect(res.status).toBeGreaterThanOrEqual(400);

      // Assert no side-effects in tenant-b Mongo or Meilisearch
      const clientB = await MongoClient.connect(MONGO_B_URI);
      try {
        const dbB = clientB.db(DB_B);
        const leakConvos = await dbB.collection('conversations').find({ title: marker }).toArray();
        expect(leakConvos.length).toBe(0);
      } finally {
        await clientB.close();
      }

      // Also assert that no write was accidentally routed to tenant A
      const clientA = await MongoClient.connect(MONGO_A_URI);
      try {
        const dbA = clientA.db(DB_A);
        const leakConvosA = await dbA.collection('conversations').find({ title: marker }).toArray();
        expect(leakConvosA.length).toBe(0);
      } finally {
        await clientA.close();
      }

      // Meili: ensure tenant-b search does not see the marker (with polling window)
      const start = Date.now();
      let last;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const search = await axios.get(
          `${API_URL}/api/convos?search=${encodeURIComponent(marker)}&limit=10`,
          { headers: authHeaders(tokenB), validateStatus: () => true },
        );
        last = search;
        if (search.status >= 400) {
          break;
        }
        const list = search.data?.conversations || [];
        const hit = list.some((c) => (c.title || '').includes(marker));
        if (hit) {
          throw new Error(
            `Tenant spoof attempt polluted tenant B Meili index: ${JSON.stringify(
              list.map((c) => c.title),
            )}`,
          );
        }
        if (Date.now() - start > 15000) {
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }, 30000);

    it('tenant-scoped route rejects user without tenantId and without X-Tenant-ID', async () => {
      if (!useLive) return;

      // Ensure we have a tenantless user and shared token (created once across tests)
      if (!tenantlessToken) {
        const { createModels } = require('@librechat/data-schemas');
        await mongoose.connect(SYSTEM_MONGO_URI);
        const models = createModels(mongoose);
        const User = models.User;
        const password = 'TestPassword123!';
        const hash = bcrypt.hashSync(password, bcrypt.genSaltSync(10));

        await User.deleteMany({ email: 'mt-e2e-tenantless@test.local' });
        await User.create({
          email: 'mt-e2e-tenantless@test.local',
          username: 'mt-e2e-tenantless',
          name: 'MT E2E Tenantless',
          provider: 'local',
          password: hash,
          emailVerified: true,
          // intentionally no tenantId
        });
        await mongoose.disconnect();

        const login = await axios.post(
          `${API_URL}/api/auth/login`,
          { email: 'mt-e2e-tenantless@test.local', password },
          { validateStatus: () => true, timeout: 15000 },
        );
        expect(login.status).toBe(200);
        tenantlessToken = login.data.token;
      }

      const marker = `NEG-TENANTLESS-${Date.now()}`;
      const res = await axios.post(
        `${API_URL}/api/convos/update`,
        { arg: { conversationId: `neg-tenantless-${Date.now()}`, title: marker } },
        { headers: authHeaders(tenantlessToken), validateStatus: () => true },
      );

      expect(res.status).toBeGreaterThanOrEqual(400);

      // Assert nothing written in either tenant DB
      const clientA = await MongoClient.connect(MONGO_A_URI);
      const clientB = await MongoClient.connect(MONGO_B_URI);
      try {
        const dbA = clientA.db(DB_A);
        const dbB = clientB.db(DB_B);
        const leakA = await dbA.collection('conversations').find({ title: marker }).toArray();
        const leakB = await dbB.collection('conversations').find({ title: marker }).toArray();
        expect(leakA.length).toBe(0);
        expect(leakB.length).toBe(0);
      } finally {
        await clientA.close();
        await clientB.close();
      }
    }, 30000);

    it('ext/v2 write endpoints enforce same tenant rules', async () => {
      if (!useLive) return;
      const marker = `NEG-EXTV2-${Date.now()}`;

      // Spoof attempt: user A tries to write as tenant-b via ext/v2
      const spoofHeaders = {
        Authorization: `Bearer ${tokenA}`,
        'X-Tenant-ID': TENANT_B,
        'Content-Type': 'application/json',
      };

      const resSpoof = await axios.post(
        `${API_URL}/ext/v2/convos`,
        { title: marker },
        { headers: spoofHeaders, validateStatus: () => true },
      );
      expect(resSpoof.status).toBeGreaterThanOrEqual(400);

      const clientB = await MongoClient.connect(MONGO_B_URI);
      try {
        const dbB = clientB.db(DB_B);
        const leakConvos = await dbB.collection('conversations').find({ title: marker }).toArray();
        expect(leakConvos.length).toBe(0);
      } finally {
        await clientB.close();
      }

      // Tenantless ext/v2: user without tenantId, no header
      // Reuse the shared tenantless token to avoid hitting rate limits
      if (!tenantlessToken) {
        const { createModels } = require('@librechat/data-schemas');
        await mongoose.connect(SYSTEM_MONGO_URI);
        const models = createModels(mongoose);
        const User = models.User;
        const password = 'TestPassword123!';
        const hash = bcrypt.hashSync(password, bcrypt.genSaltSync(10));

        await User.deleteMany({ email: 'mt-e2e-tenantless@test.local' });
        await User.create({
          email: 'mt-e2e-tenantless@test.local',
          username: 'mt-e2e-tenantless',
          name: 'MT E2E Tenantless',
          provider: 'local',
          password: hash,
          emailVerified: true,
          // intentionally no tenantId
        });
        await mongoose.disconnect();

        const login = await axios.post(
          `${API_URL}/api/auth/login`,
          { email: 'mt-e2e-tenantless@test.local', password },
          { validateStatus: () => true, timeout: 15000 },
        );
        expect(login.status).toBe(200);
        tenantlessToken = login.data.token;
      }

      const marker2 = `NEG-EXTV2-TENANTLESS-${Date.now()}`;
      const resTenantless = await axios.post(
        `${API_URL}/ext/v2/convos`,
        { title: marker2 },
        { headers: authHeaders(tenantlessToken), validateStatus: () => true },
      );
      expect(resTenantless.status).toBeGreaterThanOrEqual(400);

      const clientA2 = await MongoClient.connect(MONGO_A_URI);
      const clientB2 = await MongoClient.connect(MONGO_B_URI);
      try {
        const dbA = clientA2.db(DB_A);
        const dbB = clientB2.db(DB_B);
        const leakA = await dbA.collection('conversations').find({ title: marker2 }).toArray();
        const leakB = await dbB.collection('conversations').find({ title: marker2 }).toArray();
        expect(leakA.length).toBe(0);
        expect(leakB.length).toBe(0);
      } finally {
        await clientA2.close();
        await clientB2.close();
      }
    }, 45000);
  });

  describe('Runtime config edit reroute', () => {
    it('PATCH dbUri moves next write to new Mongo host', async () => {
      if (!useLive) return;
      const convoBefore = `mt-e2e-runtime-before-${Date.now()}`;
      const beforeRes = await axios.post(
        `${API_URL}/api/convos/update`,
        { arg: { conversationId: convoBefore, title: 'Before PATCH' } },
        { headers: authHeaders(tokenA), validateStatus: () => true },
      );
      if (beforeRes.status >= 400) {
        throw new Error(
          `/api/convos/update before PATCH failed ${beforeRes.status}: ${JSON.stringify(
            beforeRes.data,
          )}`,
        );
      }

      const secondaryDb = 'tenantA_secondary';
      const patchRes = await axios.patch(
        `${API_URL}/api/admin/tenants/${TENANT_A}`,
        { dbUri: `mongodb://tenant-mongo-b:27017/${secondaryDb}` },
        { headers: adminHeaders, validateStatus: () => true },
      );
      if (patchRes.status >= 400) {
        throw new Error(
          `PATCH /api/admin/tenants/${TENANT_A} failed ${patchRes.status}: ${JSON.stringify(
            patchRes.data,
          )}`,
        );
      }

      const convoAfter = `mt-e2e-runtime-after-${Date.now()}`;
      const afterRes = await axios.post(
        `${API_URL}/api/convos/update`,
        { arg: { conversationId: convoAfter, title: 'After PATCH' } },
        { headers: authHeaders(tokenA), validateStatus: () => true },
      );
      if (afterRes.status >= 400) {
        throw new Error(
          `/api/convos/update after PATCH failed ${afterRes.status}: ${JSON.stringify(
            afterRes.data,
          )}`,
        );
      }

      const clientA = await MongoClient.connect(MONGO_A_URI);
      const clientB = await MongoClient.connect(MONGO_B_URI);
      try {
        const onA = await clientA.db(DB_A).collection('conversations').find({ conversationId: convoAfter }).toArray();
        const onB = await clientB.db(secondaryDb).collection('conversations').find({ conversationId: convoAfter }).toArray();
        expect(onA.length).toBe(0);
        expect(onB.length).toBe(1);
      } finally {
        await clientA.close();
        await clientB.close();
      }
    }, 20000);

    it('PATCH rag postgresUri moves new embeddings from pg-a to pg-b', async () => {
      if (!useLive) return;

      // Before: embed for tenant A uses original pg-a config
      const fileIdBefore = `mt-e2e-rag-rt-before-${Date.now()}`;
      const tmpDir = os.tmpdir();
      const filePathBefore = path.join(tmpDir, `rag-rt-before-${Date.now()}.txt`);
      fs.writeFileSync(filePathBefore, 'E2E RAG runtime before PATCH');

      try {
        const formBefore = new FormData();
        formBefore.append('file_id', fileIdBefore);
        formBefore.append('file', fs.createReadStream(filePathBefore));
        await axios.post(`${RAG_API_URL}/embed`, formBefore, {
          headers: {
            'X-Tenant-ID': TENANT_A,
            Authorization: `Bearer ${tokenA}`,
            ...formBefore.getHeaders(),
          },
          maxBodyLength: Infinity,
          timeout: 60000,
        });
      } finally {
        try {
          fs.unlinkSync(filePathBefore);
        } catch (_) {}
      }

      // Patch tenant A RAG config to point at pg-b; assert invalidation applied
      const newPgUri = 'postgresql://myuser:mypassword@pg-b:5432/tenant_b';
      const patchRes = await axios.patch(
        `${API_URL}/api/admin/tenants/${TENANT_A}`,
        { config: { rag: { postgresUri: newPgUri } } },
        { headers: adminHeaders },
      );
      expect(Array.isArray(patchRes.data.appliedInvalidations)).toBe(true);
      const ragEntry = patchRes.data.appliedInvalidations.find((e) => e && e.target === 'rag_api');
      expect(ragEntry).toBeDefined();
      expect(ragEntry.status).toBe('ok');

      // After: new embeddings for tenant A must land only in pg-b
      const fileIdAfter = `mt-e2e-rag-rt-after-${Date.now()}`;
      const filePathAfter = path.join(tmpDir, `rag-rt-after-${Date.now()}.txt`);
      fs.writeFileSync(filePathAfter, 'E2E RAG runtime after PATCH');

      try {
        const formAfter = new FormData();
        formAfter.append('file_id', fileIdAfter);
        formAfter.append('file', fs.createReadStream(filePathAfter));
        await axios.post(`${RAG_API_URL}/embed`, formAfter, {
          headers: {
            'X-Tenant-ID': TENANT_A,
            Authorization: `Bearer ${tokenA}`,
            ...formAfter.getHeaders(),
          },
          maxBodyLength: Infinity,
          timeout: 60000,
        });
      } finally {
        try {
          fs.unlinkSync(filePathAfter);
        } catch (_) {}
      }

      const pgA = new PgClient({ connectionString: PG_A_URI });
      const pgB = new PgClient({ connectionString: PG_B_URI });
      await pgA.connect();
      await pgB.connect();
      try {
        const start = Date.now();
        let beforeOnA;
        let beforeOnB;
        let afterOnA;
        let afterOnB;

        // Poll for up to 45s to allow for async commit + reroute latency
        // eslint-disable-next-line no-constant-condition
        while (true) {
          beforeOnA = await pgA.query(
            "SELECT COUNT(*) AS cnt FROM langchain_pg_embedding WHERE (cmetadata->>'file_id') = $1",
            [fileIdBefore],
          );
          beforeOnB = await pgB.query(
            "SELECT COUNT(*) AS cnt FROM langchain_pg_embedding WHERE (cmetadata->>'file_id') = $1",
            [fileIdBefore],
          );
          afterOnA = await pgA.query(
            "SELECT COUNT(*) AS cnt FROM langchain_pg_embedding WHERE (cmetadata->>'file_id') = $1",
            [fileIdAfter],
          );
          afterOnB = await pgB.query(
            "SELECT COUNT(*) AS cnt FROM langchain_pg_embedding WHERE (cmetadata->>'file_id') = $1",
            [fileIdAfter],
          );

          const beforeA = parseInt(beforeOnA.rows[0].cnt, 10);
          const beforeB = parseInt(beforeOnB.rows[0].cnt, 10);
          const afterA = parseInt(afterOnA.rows[0].cnt, 10);
          const afterB = parseInt(afterOnB.rows[0].cnt, 10);

          const ok =
            beforeA >= 1 && // original embeddings on pg-a
            beforeB === 0 && // never on pg-b
            afterA === 0 && // new embeddings not on pg-a
            afterB >= 1; // new embeddings on pg-b

          if (ok) {
            break;
          }

          if (Date.now() - start > 45000) {
            throw new Error(
              `RAG reroute mismatch after 45s: beforeA=${beforeA}, beforeB=${beforeB}, afterA=${afterA}, afterB=${afterB}`,
            );
          }

          await new Promise((r) => setTimeout(r, 500));
        }

        // Final assertions with the last snapshot
        expect(parseInt(beforeOnA.rows[0].cnt, 10)).toBeGreaterThanOrEqual(1);
        expect(parseInt(beforeOnB.rows[0].cnt, 10)).toBe(0);
        expect(parseInt(afterOnA.rows[0].cnt, 10)).toBe(0);
        expect(parseInt(afterOnB.rows[0].cnt, 10)).toBeGreaterThanOrEqual(1);
      } finally {
        await pgA.end();
        await pgB.end();
      }
    }, 90000);
  });

  describe('Restart survival (MT_IT_RESTART=1)', () => {
    it('after api restart, routing still correct', async () => {
      if (!useLive || process.env.MT_IT_RESTART !== '1') return;
      const { execSync } = require('child_process');
      const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
      const composeFile = process.env.MT_IT_COMPOSE_FILE || path.join(repoRoot, 'docker-compose.mt-it.yml');
      execSync(`docker compose -f "${composeFile}" restart api`, { stdio: 'inherit', cwd: repoRoot });
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const res = await axios.get(`${API_URL}/api/admin/tenants`, { headers: adminHeaders, timeout: 5000 });
          if (res.status === 200) break;
        } catch (_) {}
        if (i === 29) throw new Error('API did not come back after restart');
      }

      // Config persistence: tenant B must still have stored dbUri, RAG and storage config
      const expectedDbUriB = `mongodb://tenant-mongo-b:27017/${DB_B}`;
      const expectedRagPgB = 'postgresql://myuser:mypassword@pg-b:5432/tenant_b';
      const tenantBRes = await axios.get(`${API_URL}/api/admin/tenants/${TENANT_B}?secrets=1`, { headers: adminHeaders });
      expect(tenantBRes.data.dbUri).toBe(expectedDbUriB);
      expect(tenantBRes.data.config?.rag?.postgresUri).toBe(expectedRagPgB);
      expect(tenantBRes.data.config?.storage?.provider).toBe('s3');
      expect(tenantBRes.data.config?.storage?.bucket).toBe('bucket-b');
      expect(tenantBRes.data.config?.storage?.prefix).toBe('tenantB/');

      const convoAfterRestart = `mt-e2e-after-restart-${Date.now()}`;
      await axios.post(
        `${API_URL}/api/convos/update`,
        { arg: { conversationId: convoAfterRestart, title: 'After restart' } },
        { headers: authHeaders(tokenB) },
      );
      const clientB = await MongoClient.connect(MONGO_B_URI);
      try {
        const found = await clientB.db(DB_B).collection('conversations').find({ conversationId: convoAfterRestart }).toArray();
        expect(found.length).toBe(1);

        // RAG op after restart: embeddings for tenant B must still land in pg-b
        const fileIdAfterRestart = `mt-e2e-rag-after-restart-${Date.now()}`;
        const tmpDir = os.tmpdir();
        const filePath = path.join(tmpDir, `rag-after-restart-${Date.now()}.txt`);
        fs.writeFileSync(filePath, 'E2E RAG after restart');
        try {
          const form = new FormData();
          form.append('file_id', fileIdAfterRestart);
          form.append('file', fs.createReadStream(filePath));
          await axios.post(`${RAG_API_URL}/embed`, form, {
            headers: {
              'X-Tenant-ID': TENANT_B,
              Authorization: `Bearer ${tokenB}`,
              ...form.getHeaders(),
            },
            maxBodyLength: Infinity,
            timeout: 60000,
          });
        } finally {
          try {
            fs.unlinkSync(filePath);
          } catch (_) {}
        }

        const pgB = new PgClient({ connectionString: PG_B_URI });
        await pgB.connect();
        try {
          const res = await pgB.query(
            "SELECT COUNT(*) AS cnt FROM langchain_pg_embedding WHERE (cmetadata->>'file_id') = $1",
            [fileIdAfterRestart],
          );
          expect(parseInt(res.rows[0].cnt, 10)).toBeGreaterThanOrEqual(1);
        } finally {
          await pgB.end();
        }

        // Storage op after restart: tenant B upload still routes to bucket-b with tenantB/ prefix
        const s3 = new S3Client({
          region: 'us-east-1',
          endpoint: MINIO_ENDPOINT,
          credentials: { accessKeyId: MINIO_ACCESS, secretAccessKey: MINIO_SECRET },
          forcePathStyle: true,
        });
        const storageFilePath = path.join(tmpDir, `storage-after-restart-${Date.now()}.txt`);
        fs.writeFileSync(storageFilePath, 'MT E2E storage after restart');
        try {
          const storageForm = new FormData();
          storageForm.append('file', fs.createReadStream(storageFilePath));
          storageForm.append('file_id', `mt-e2e-storage-after-restart-${Date.now()}`);
          await axios.post(`${API_URL}/api/files`, storageForm, {
            headers: {
              Authorization: `Bearer ${tokenB}`,
              ...storageForm.getHeaders(),
            },
            maxBodyLength: Infinity,
          });
        } finally {
          try {
            fs.unlinkSync(storageFilePath);
          } catch (_) {}
        }

        const listB = await s3.send(new ListObjectsV2Command({ Bucket: 'bucket-b', MaxKeys: 200 }));
        const keysB = (listB.Contents || []).map((o) => o.Key).filter(Boolean);
        expect(keysB.some((k) => k.startsWith('tenantB/'))).toBe(true);
      } finally {
        await clientB.close();
      }
    }, 120000);
  });
});
