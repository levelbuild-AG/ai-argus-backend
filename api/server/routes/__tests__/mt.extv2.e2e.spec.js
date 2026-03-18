/**
 * MT ext/v2 E2E integration tests (primary production gate).
 * Uses header-auth ext/v2 endpoints only for data-plane actions.
 *
 * Requires: MT_IT_LIVE=1, docker-compose.mt-it.yml stack up.
 *
 * Run:
 *   MT_IT_LIVE=1 API_URL=http://localhost:3081 ADMIN_AUTH_SECRET=admin-auth-secret-min-16-chars \
 *   npm --workspace api run test -- mt.extv2.e2e.spec.js
 */
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', '..', '..') });

const axios = require('axios');
const { MongoClient } = require('mongodb');
const { ListObjectsV2Command, S3Client } = require('@aws-sdk/client-s3');
const { Client: PgClient } = require('pg');

const API_URL = process.env.API_URL || 'http://localhost:3081';
const ADMIN_SECRET = process.env.ADMIN_AUTH_SECRET || 'admin-auth-secret-min-16-chars';
const useLive = process.env.MT_IT_LIVE === '1';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const DB_A = 'tenantA_db';
const DB_B = 'tenantB_db';
const MONGO_A_URI = 'mongodb://localhost:27018';
const MONGO_B_URI = 'mongodb://localhost:27019';
// Host-side assertion DSNs: use localhost + published ports from docker-compose.mt-it.yml
const PG_A_URI =
  process.env.MT_IT_PG_A_URI || 'postgresql://myuser:mypassword@localhost:5432/tenant_a';
const PG_B_URI =
  process.env.MT_IT_PG_B_URI || 'postgresql://myuser:mypassword@localhost:5433/tenant_b';
// Runtime tenant-config DSNs: container-network hostnames for use inside Docker
const PG_A_RUNTIME_URI = 'postgresql://myuser:mypassword@pg-a:5432/tenant_a';
const PG_B_RUNTIME_URI = 'postgresql://myuser:mypassword@pg-b:5432/tenant_b';

const MINIO_ENDPOINT = process.env.MT_IT_MINIO_ENDPOINT || 'http://localhost:9000';
const MINIO_ACCESS = process.env.MT_IT_MINIO_ACCESS || 'minioadmin';
const MINIO_SECRET = process.env.MT_IT_MINIO_SECRET || 'minioadmin';

const adminHeaders = {
  'X-LibreChat-Role': 'ADMIN',
  'X-Admin-Auth': ADMIN_SECRET,
  'Content-Type': 'application/json',
};

const runId = Date.now().toString();
const extUserA = {
  userId: `user-a-${runId}`,
  tenantId: TENANT_A,
  email: `mt-extv2-a-${runId}@test.local`,
  role: 'USER',
};
const extUserB = {
  userId: `user-b-${runId}`,
  tenantId: TENANT_B,
  email: `mt-extv2-b-${runId}@test.local`,
  role: 'USER',
};

function extHeaders({ userId, tenantId, email, role = 'USER' }) {
  return {
    'X-User-ID': userId,
    'X-Tenant-ID': tenantId,
    'X-User-Email': email,
    'X-User-Role': role,
    Accept: 'application/json',
  };
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

  // Try create first
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
      `extv2 ensureBaselineTenant: create ${tenantId} failed ${createRes?.status}: ${JSON.stringify(
        createRes?.data,
      )}`,
    );
  }

  // Tenant exists: patch back to baseline
  const listRes = await axios.get(`${API_URL}/api/admin/tenants`, {
    headers: adminHeaders,
    params: { limit: 100 },
  });
  if (listRes.status !== 200) {
    throw new Error(
      `extv2 ensureBaselineTenant: list failed ${listRes.status}: ${JSON.stringify(
        listRes.data,
      )}`,
    );
  }
  const current = (listRes.data?.tenants || []).find((t) => t.tenantId === tenantId);
  if (!current) {
    throw new Error(`extv2 ensureBaselineTenant: tenant ${tenantId} not found in list`);
  }

  const expectedVersion = current.configVersion;
  const patchBody = {
    expectedVersion,
    dbUri,
    config: {
      rag: { postgresUri: ragPgUri },
      storage: storageConfig,
    },
  };

  const patchRes = await axios.patch(
    `${API_URL}/api/admin/tenants/${encodeURIComponent(tenantId)}`,
    patchBody,
    { headers: adminHeaders, validateStatus: () => true },
  );
  if (patchRes.status >= 400) {
    throw new Error(
      `extv2 ensureBaselineTenant: patch ${tenantId} failed ${patchRes.status}: ${JSON.stringify(
        patchRes.data,
      )}`,
    );
  }
}

async function ensureStackReachable() {
  const health = await axios.get(`${API_URL}/ext/v2/health`, {
    validateStatus: () => true,
    timeout: 5000,
  });
  if (health.status !== 200) {
    throw new Error(`/ext/v2/health returned ${health.status}: ${JSON.stringify(health.data)}`);
  }

  const admin = await axios.get(`${API_URL}/api/admin/tenants`, {
    headers: adminHeaders,
    validateStatus: () => true,
    timeout: 5000,
  });
  if (admin.status !== 200) {
    throw new Error(`/api/admin/tenants returned ${admin.status}: ${JSON.stringify(admin.data)}`);
  }
}

describe('MT ext/v2 E2E (live stack)', () => {
  beforeAll(async () => {
    if (!useLive) return;
    await ensureStackReachable();

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
  }, 60000);

  it('ext/v2 health is reachable', async () => {
    if (!useLive) return;
    const res = await axios.get(`${API_URL}/ext/v2/health`, { validateStatus: () => true });
    expect(res.status).toBe(200);
    expect(res.data?.status).toBe('ok');
  });

  describe('Mongo routing via ext/v2', () => {
    it('tenant-scoped write lands in correct Mongo host only', async () => {
      if (!useLive) return;

      const convoA = `extv2-mongo-a-${Date.now()}`;
      const convoB = `extv2-mongo-b-${Date.now()}`;

      const resA = await axios.post(
        `${API_URL}/ext/v2/convos/update`,
        { arg: { conversationId: convoA, title: 'ExtV2 Mongo A' } },
        {
          headers: extHeaders({
            userId: extUserA.userId,
            tenantId: extUserA.tenantId,
            email: extUserA.email,
          }),
          validateStatus: () => true,
        },
      );
      if (resA.status >= 400) {
        throw new Error(
          `/ext/v2/convos (tenant A) failed ${resA.status}: ${JSON.stringify(resA.data)}`,
        );
      }

      const resB = await axios.post(
        `${API_URL}/ext/v2/convos/update`,
        { arg: { conversationId: convoB, title: 'ExtV2 Mongo B' } },
        {
          headers: extHeaders({
            userId: extUserB.userId,
            tenantId: extUserB.tenantId,
            email: extUserB.email,
          }),
          validateStatus: () => true,
        },
      );
      if (resB.status >= 400) {
        throw new Error(
          `/ext/v2/convos (tenant B) failed ${resB.status}: ${JSON.stringify(resB.data)}`,
        );
      }

      const clientA = await MongoClient.connect(MONGO_A_URI);
      const clientB = await MongoClient.connect(MONGO_B_URI);
      try {
        const dbA = clientA.db(DB_A);
        const dbB = clientB.db(DB_B);

        const docsA = await dbA
          .collection('conversations')
          .find({ conversationId: convoA })
          .toArray();
        const docsB = await dbB
          .collection('conversations')
          .find({ conversationId: convoB })
          .toArray();
        const leakAInB = await dbB
          .collection('conversations')
          .find({ conversationId: convoA })
          .toArray();
        const leakBInA = await dbA
          .collection('conversations')
          .find({ conversationId: convoB })
          .toArray();

        expect(docsA.length).toBeGreaterThanOrEqual(1);
        expect(docsB.length).toBeGreaterThanOrEqual(1);
        expect(leakAInB.length).toBe(0);
        expect(leakBInA.length).toBe(0);
      } finally {
        await clientA.close();
        await clientB.close();
      }
    }, 30000);

    it('title persistence lands in tenant DB only, not system or other tenant', async () => {
      if (!useLive) return;

      const titleOnlyConvoId = `extv2-title-tenant-${Date.now()}`;
      const uniqueTitle = `TitleTenantA-${Date.now()}`;

      const res = await axios.post(
        `${API_URL}/ext/v2/convos/update`,
        { arg: { conversationId: titleOnlyConvoId, title: uniqueTitle } },
        {
          headers: extHeaders({
            userId: extUserA.userId,
            tenantId: extUserA.tenantId,
            email: extUserA.email,
          }),
          validateStatus: () => true,
        },
      );
      if (res.status >= 400) {
        throw new Error(
          `ext/v2 convos/update (title) failed ${res.status}: ${JSON.stringify(res.data)}`,
        );
      }

      const systemMongoUri = process.env.MT_IT_SYSTEM_MONGO_URI || 'mongodb://localhost:27017';
      const systemDbName = process.env.MT_IT_SYSTEM_DB || 'LibreChat';

      const clientA = await MongoClient.connect(MONGO_A_URI);
      const clientB = await MongoClient.connect(MONGO_B_URI);
      const clientSystem = await MongoClient.connect(systemMongoUri);
      try {
        const dbA = clientA.db(DB_A);
        const dbB = clientB.db(DB_B);
        const dbSystem = clientSystem.db(systemDbName);

        const inA = await dbA
          .collection('conversations')
          .find({ conversationId: titleOnlyConvoId, title: uniqueTitle })
          .toArray();
        const inB = await dbB
          .collection('conversations')
          .find({ conversationId: titleOnlyConvoId })
          .toArray();
        const inSystem = await dbSystem
          .collection('conversations')
          .find({ conversationId: titleOnlyConvoId })
          .toArray();

        expect(inA.length).toBe(1);
        expect(inA[0].title).toBe(uniqueTitle);
        expect(inB.length).toBe(0);
        expect(inSystem.length).toBe(0);
      } finally {
        await clientA.close();
        await clientB.close();
        await clientSystem.close();
      }
    }, 30000);
  });

  describe('Meilisearch isolation via ext/v2', () => {
    it('search returns only tenant-scoped results', async () => {
      if (!useLive) return;

      const uniqueA = `ExtV2MeiliA-${Date.now()}`;
      const uniqueB = `ExtV2MeiliB-${Date.now()}`;

      await axios.post(
        `${API_URL}/ext/v2/convos/update`,
        { arg: { conversationId: `extv2-meili-a-${Date.now()}`, title: uniqueA } },
        {
          headers: extHeaders({
            userId: extUserA.userId,
            tenantId: extUserA.tenantId,
            email: extUserA.email,
          }),
        },
      );
      await axios.post(
        `${API_URL}/ext/v2/convos/update`,
        { arg: { conversationId: `extv2-meili-b-${Date.now()}`, title: uniqueB } },
        {
          headers: extHeaders({
            userId: extUserB.userId,
            tenantId: extUserB.tenantId,
            email: extUserB.email,
          }),
        },
      );

      // Poll until tenant A sees its marker
      const start = Date.now();
      let listA;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        listA = await axios.get(
          `${API_URL}/ext/v2/convos?search=${encodeURIComponent(uniqueA)}&limit=10`,
          {
            headers: extHeaders({
              userId: extUserA.userId,
              tenantId: extUserA.tenantId,
              email: extUserA.email,
            }),
            validateStatus: () => true,
          },
        );
        if (listA.status >= 400) {
          throw new Error(
            `/ext/v2/convos search (tenant A) failed ${listA.status}: ${JSON.stringify(
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
            `/ext/v2/convos search (tenant A) did not return hit for ${uniqueA} within 45s; last=${JSON.stringify(
              listA.data,
            )}`,
          );
        }
        await new Promise((r) => setTimeout(r, 750));
      }

      // Poll until tenant B sees its marker (symmetrical with tenant A)
      const startB = Date.now();
      let listB;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        listB = await axios.get(
          `${API_URL}/ext/v2/convos?search=${encodeURIComponent(uniqueB)}&limit=10`,
          {
            headers: extHeaders({
              userId: extUserB.userId,
              tenantId: extUserB.tenantId,
              email: extUserB.email,
            }),
            validateStatus: () => true,
          },
        );
        if (listB.status >= 400) {
          throw new Error(
            `/ext/v2/convos search (tenant B) failed ${listB.status}: ${JSON.stringify(
              listB.data,
            )}`,
          );
        }
        if (listB.data && Array.isArray(listB.data.conversations)) {
          const hitB = listB.data.conversations.some(
            (c) => (c.title || '').includes(uniqueB),
          );
          if (hitB) break;
        }
        if (Date.now() - startB > 45000) {
          throw new Error(
            `/ext/v2/convos search (tenant B) did not return hit for ${uniqueB} within 45s; last=${JSON.stringify(
              listB.data,
            )}`,
          );
        }
        await new Promise((r) => setTimeout(r, 750));
      }

      const crossB = await axios.get(
        `${API_URL}/ext/v2/convos?search=${encodeURIComponent(uniqueA)}&limit=10`,
        {
          headers: extHeaders({
            userId: extUserB.userId,
            tenantId: extUserB.tenantId,
            email: extUserB.email,
          }),
          validateStatus: () => true,
        },
      );
      if (crossB.status >= 400) {
        throw new Error(
          `/ext/v2/convos search (cross tenant B) failed ${crossB.status}: ${JSON.stringify(
            crossB.data,
          )}`,
        );
      }

      expect(
        listA.data.conversations.some((c) => (c.title || '').includes(uniqueA)),
      ).toBe(true);
      expect(
        listB.data.conversations.some((c) => (c.title || '').includes(uniqueB)),
      ).toBe(true);
      expect(
        crossB.data.conversations.some((c) => (c.title || '').includes(uniqueA)),
      ).toBe(false);
    }, 60000);
  });

  describe('Storage (Minio) isolation via ext/v2', () => {
    it('upload via /ext/v2/files stores objects under correct tenant prefixes', async () => {
      if (!useLive) return;

      const os = require('os');
      const fs = require('fs');
      const { randomUUID } = require('crypto');
      const FormData = require('form-data');

      const tmpDir = os.tmpdir();
      const ts = Date.now();
      const fileIdA = randomUUID();
      const fileIdB = randomUUID();
      const filePathA = path.join(tmpDir, `extv2-storage-a-${ts}.txt`);
      const filePathB = path.join(tmpDir, `extv2-storage-b-${ts}.txt`);
      fs.writeFileSync(filePathA, 'MT extv2 storage test A');
      fs.writeFileSync(filePathB, 'MT extv2 storage test B');

      let resA;
      let resB;
      try {
        const formA = new FormData();
        formA.append('file', fs.createReadStream(filePathA));
        formA.append('file_id', fileIdA);
        formA.append('message_file', 'true');
        formA.append('endpoint', 'chat');
        resA = await axios.post(`${API_URL}/ext/v2/files`, formA, {
          headers: {
            ...extHeaders(extUserA),
            ...formA.getHeaders(),
          },
          maxBodyLength: Infinity,
          validateStatus: () => true,
        });

        const formB = new FormData();
        formB.append('file', fs.createReadStream(filePathB));
        formB.append('file_id', fileIdB);
        formB.append('message_file', 'true');
        formB.append('endpoint', 'chat');
        resB = await axios.post(`${API_URL}/ext/v2/files`, formB, {
          headers: {
            ...extHeaders(extUserB),
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
          `/ext/v2/files (tenant A) failed ${resA.status}: ${JSON.stringify(resA.data)}`,
        );
      }
      if (resB.status !== 200) {
        throw new Error(
          `/ext/v2/files (tenant B) failed ${resB.status}: ${JSON.stringify(resB.data)}`,
        );
      }

      const toKey = (urlString) => {
        const url = new URL(urlString);
        const pathname = url.pathname.replace(/^\/+/, '');
        const segments = pathname.split('/');
        if (segments.length < 2) {
          throw new Error(`Unexpected S3 URL pathname: ${pathname}`);
        }
        const [maybeBucket, ...rest] = segments;
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
    }, 60000);

    it('PATCH storage prefix moves next ext/v2 upload to new prefix', async () => {
      if (!useLive) return;

      const os = require('os');
      const fs = require('fs');
      const { randomUUID } = require('crypto');
      const FormData = require('form-data');

      const tmpDir = os.tmpdir();
      const ts = Date.now();
      const fileIdBefore = randomUUID();
      const fileIdAfter = randomUUID();
      const filePathBefore = path.join(tmpDir, `extv2-storage-reroute-before-${ts}.txt`);
      const filePathAfter = path.join(tmpDir, `extv2-storage-reroute-after-${ts}.txt`);
      fs.writeFileSync(filePathBefore, 'MT extv2 storage reroute BEFORE');
      fs.writeFileSync(filePathAfter, 'MT extv2 storage reroute AFTER');

      let resBefore;
      let resAfter;
      try {
        // Baseline upload under current prefix (tenantA/)
        const formBefore = new FormData();
        formBefore.append('file', fs.createReadStream(filePathBefore));
        formBefore.append('file_id', fileIdBefore);
        formBefore.append('message_file', 'true');
        formBefore.append('endpoint', 'chat');
        resBefore = await axios.post(`${API_URL}/ext/v2/files`, formBefore, {
          headers: {
            ...extHeaders(extUserA),
            ...formBefore.getHeaders(),
          },
          maxBodyLength: Infinity,
          validateStatus: () => true,
        });
        if (resBefore.status !== 200) {
          throw new Error(
            `/ext/v2/files (baseline tenant A) failed ${resBefore.status}: ${JSON.stringify(
              resBefore.data,
            )}`,
          );
        }

        const toKey = (urlString) => {
          const url = new URL(urlString);
          const pathname = url.pathname.replace(/^\/+/, '');
          const segments = pathname.split('/');
          if (segments.length < 2) {
            throw new Error(`Unexpected S3 URL pathname: ${pathname}`);
          }
          const [maybeBucket, ...rest] = segments;
          return rest.length ? rest.join('/') : maybeBucket;
        };

        const baselineKey = toKey(resBefore.data.filepath);

        // Reroute: patch tenant A storage prefix
        const newPrefix = `tenantA-reroute-${Date.now()}/`;
        const getRes = await axios.get(`${API_URL}/api/admin/tenants/${TENANT_A}`, {
          headers: adminHeaders,
        });
        const expectedVersion = getRes.data.configVersion;
        const patchRes = await axios.patch(
          `${API_URL}/api/admin/tenants/${TENANT_A}`,
          {
            expectedVersion,
            config: {
              storage: {
                provider: 's3',
                bucket: 'bucket-a',
                prefix: newPrefix,
                endpoint: 'http://minio:9000',
                accessKeyId: 'minioadmin',
                secretAccessKey: 'minioadmin',
              },
            },
          },
          { headers: adminHeaders, validateStatus: () => true },
        );
        if (patchRes.status >= 400) {
          throw new Error(
            `PATCH /api/admin/tenants/${TENANT_A} storage failed ${patchRes.status}: ${JSON.stringify(
              patchRes.data,
            )}`,
          );
        }

        // Upload after reroute
        const formAfter = new FormData();
        formAfter.append('file', fs.createReadStream(filePathAfter));
        formAfter.append('file_id', fileIdAfter);
        formAfter.append('message_file', 'true');
        formAfter.append('endpoint', 'chat');
        resAfter = await axios.post(`${API_URL}/ext/v2/files`, formAfter, {
          headers: {
            ...extHeaders(extUserA),
            ...formAfter.getHeaders(),
          },
          maxBodyLength: Infinity,
          validateStatus: () => true,
        });
        if (resAfter.status !== 200) {
          throw new Error(
            `/ext/v2/files (reroute tenant A) failed ${resAfter.status}: ${JSON.stringify(
              resAfter.data,
            )}`,
          );
        }

        const rerouteKey = toKey(resAfter.data.filepath);

        const s3 = new S3Client({
          region: 'us-east-1',
          endpoint: MINIO_ENDPOINT,
          credentials: { accessKeyId: MINIO_ACCESS, secretAccessKey: MINIO_SECRET },
          forcePathStyle: true,
        });

        const listA = await s3.send(
          new ListObjectsV2Command({ Bucket: 'bucket-a', MaxKeys: 500 }),
        );
        const keysA = (listA.Contents || []).map((o) => o.Key).filter(Boolean);

        // Baseline object must remain under old prefix
        expect(keysA).toContain(baselineKey);
        // New object must be present under new prefix and not under old prefix
        expect(keysA).toContain(rerouteKey);
        expect(rerouteKey.startsWith(newPrefix)).toBe(true);
      } finally {
        try {
          fs.unlinkSync(filePathBefore);
        } catch (_) {}
        try {
          fs.unlinkSync(filePathAfter);
        } catch (_) {}
      }
    }, 60000);
  });

  describe('RAG routing via ext/v2 files', () => {
    it('embed for tenant A lands in pg-a, for B in pg-b (no cross-tenant leakage)', async () => {
      if (!useLive) return;

      const os = require('os');
      const fs = require('fs');
      const { randomUUID } = require('crypto');

      const tmpDir = os.tmpdir();
      const ts = Date.now();
      const clientFileIdA = randomUUID();
      const clientFileIdB = randomUUID();
      const filePathA = path.join(tmpDir, `extv2-rag-a-${ts}.txt`);
      const filePathB = path.join(tmpDir, `extv2-rag-b-${ts}.txt`);
      fs.writeFileSync(filePathA, 'MT extv2 RAG tenant A unique content.');
      fs.writeFileSync(filePathB, 'MT extv2 RAG tenant B unique content.');

      let pgFileIdA;
      let pgFileIdB;

      try {
        const FormData = require('form-data');

        // Upload for tenant A (file_search tool to trigger vector ingest)
        const formA = new FormData();
        formA.append('file', fs.createReadStream(filePathA));
        formA.append('file_id', clientFileIdA);
        formA.append('message_file', 'true');
        formA.append('endpoint', 'chat');
        formA.append('tool_resource', 'file_search');
        const resA = await axios.post(`${API_URL}/ext/v2/files`, formA, {
          headers: {
            ...extHeaders(extUserA),
            ...formA.getHeaders(),
          },
          maxBodyLength: Infinity,
          validateStatus: () => true,
        });
        if (resA.status !== 200) {
          throw new Error(
            `/ext/v2/files (tenant A RAG) failed ${resA.status}: ${JSON.stringify(resA.data)}`,
          );
        }
        const embeddedFileIdA = resA.data?.file_id;
        if (!embeddedFileIdA || typeof embeddedFileIdA !== 'string') {
          throw new Error(
            `/ext/v2/files (tenant A RAG) did not return a valid file_id: ${JSON.stringify(
              resA.data,
            )}`,
          );
        }

        // Upload for tenant B
        const formB = new FormData();
        formB.append('file', fs.createReadStream(filePathB));
        formB.append('file_id', clientFileIdB);
        formB.append('message_file', 'true');
        formB.append('endpoint', 'chat');
        formB.append('tool_resource', 'file_search');
        const resB = await axios.post(`${API_URL}/ext/v2/files`, formB, {
          headers: {
            ...extHeaders(extUserB),
            ...formB.getHeaders(),
          },
          maxBodyLength: Infinity,
          validateStatus: () => true,
        });
        if (resB.status !== 200) {
          throw new Error(
            `/ext/v2/files (tenant B RAG) failed ${resB.status}: ${JSON.stringify(resB.data)}`,
          );
        }
        const embeddedFileIdB = resB.data?.file_id;
        if (!embeddedFileIdB || typeof embeddedFileIdB !== 'string') {
          throw new Error(
            `/ext/v2/files (tenant B RAG) did not return a valid file_id: ${JSON.stringify(
              resB.data,
            )}`,
          );
        }

        // Use server-returned file_ids for PG assertions
        pgFileIdA = embeddedFileIdA;
        pgFileIdB = embeddedFileIdB;
      } finally {
        try {
          fs.unlinkSync(filePathA);
        } catch (_) {}
        try {
          fs.unlinkSync(filePathB);
        } catch (_) {}
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

        // Poll for up to 30s to account for async commit latency in rag_api
        // eslint-disable-next-line no-constant-condition
        while (true) {
          // Tenant A vectors in pg-a
          resA = await pgA.query(
            "SELECT COUNT(*) AS cnt FROM langchain_pg_embedding WHERE (cmetadata->>'file_id') = $1",
            [pgFileIdA],
          );
          // Tenant B vectors in pg-b
          resB = await pgB.query(
            "SELECT COUNT(*) AS cnt FROM langchain_pg_embedding WHERE (cmetadata->>'file_id') = $1",
            [pgFileIdB],
          );
          // Cross-tenant leakage checks
          leakAInB = await pgB.query(
            "SELECT COUNT(*) AS cnt FROM langchain_pg_embedding WHERE (cmetadata->>'file_id') = $1",
            [pgFileIdA],
          );
          leakBInA = await pgA.query(
            "SELECT COUNT(*) AS cnt FROM langchain_pg_embedding WHERE (cmetadata->>'file_id') = $1",
            [pgFileIdB],
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

          // eslint-disable-next-line no-await-in-loop
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

    it('PATCH rag postgresUri moves next ext/v2 RAG write to new PG', async () => {
      if (!useLive) return;

      const os = require('os');
      const fs = require('fs');
      const { randomUUID } = require('crypto');
      const FormData = require('form-data');

      const tmpDir = os.tmpdir();
      const ts = Date.now();
      const clientFileIdBefore = randomUUID();
      const clientFileIdAfter = randomUUID();
      const filePathBefore = path.join(tmpDir, `extv2-rag-reroute-before-${ts}.txt`);
      const filePathAfter = path.join(tmpDir, `extv2-rag-reroute-after-${ts}.txt`);
      fs.writeFileSync(filePathBefore, 'MT extv2 RAG reroute BEFORE');
      fs.writeFileSync(filePathAfter, 'MT extv2 RAG reroute AFTER');

      try {
        // Baseline upload for tenant A (configured to pg-a in beforeAll)
        const formBefore = new FormData();
        formBefore.append('file', fs.createReadStream(filePathBefore));
        formBefore.append('file_id', clientFileIdBefore);
        formBefore.append('message_file', 'true');
        formBefore.append('endpoint', 'chat');
        formBefore.append('tool_resource', 'file_search');
        const resBefore = await axios.post(`${API_URL}/ext/v2/files`, formBefore, {
          headers: {
            ...extHeaders(extUserA),
            ...formBefore.getHeaders(),
          },
          maxBodyLength: Infinity,
          validateStatus: () => true,
        });
        if (resBefore.status !== 200) {
          throw new Error(
            `/ext/v2/files (tenant A RAG baseline) failed ${resBefore.status}: ${JSON.stringify(
              resBefore.data,
            )}`,
          );
        }
        const embeddedFileIdBefore = resBefore.data?.file_id;
        if (!embeddedFileIdBefore || typeof embeddedFileIdBefore !== 'string') {
          throw new Error(
            `/ext/v2/files (tenant A RAG baseline) did not return a valid file_id: ${JSON.stringify(
              resBefore.data,
            )}`,
          );
        }

        // Assert baseline embeddings only in pg-a
        {
          const pgA = new PgClient({ connectionString: PG_A_URI });
          const pgB = new PgClient({ connectionString: PG_B_URI });
          await pgA.connect();
          await pgB.connect();
          try {
            const start = Date.now();
            let resA;
            let leakInB;
            // eslint-disable-next-line no-constant-condition
            while (true) {
              resA = await pgA.query(
                "SELECT COUNT(*) AS cnt FROM langchain_pg_embedding WHERE (cmetadata->>'file_id') = $1",
                [embeddedFileIdBefore],
              );
              leakInB = await pgB.query(
                "SELECT COUNT(*) AS cnt FROM langchain_pg_embedding WHERE (cmetadata->>'file_id') = $1",
                [embeddedFileIdBefore],
              );
              const aCnt = parseInt(resA.rows[0].cnt, 10);
              const bCnt = parseInt(leakInB.rows[0].cnt, 10);
              if (aCnt >= 1 && bCnt === 0) {
                break;
              }
              if (Date.now() - start > 30000) {
                throw new Error(
                  `Baseline RAG routing mismatch after 30s: aCnt=${aCnt}, leakInB=${bCnt}`,
                );
              }
              // eslint-disable-next-line no-await-in-loop
              await new Promise((r) => setTimeout(r, 500));
            }
          } finally {
            await pgA.end();
            await pgB.end();
          }
        }

        // Reroute tenant A rag postgresUri to pg-b
        const getRes = await axios.get(`${API_URL}/api/admin/tenants/${TENANT_A}`, {
          headers: adminHeaders,
        });
        const expectedVersion = getRes.data.configVersion;
        // Minimal safe PATCH: only update rag.postgresUri, avoid sending back raw config/_id artifacts.
        // Use container-network DSN so runtime inside Docker can reach pg-b.
        const patchRes = await axios.patch(
          `${API_URL}/api/admin/tenants/${TENANT_A}`,
          {
            expectedVersion,
            config: {
              rag: {
                postgresUri: PG_B_RUNTIME_URI,
              },
            },
          },
          { headers: adminHeaders, validateStatus: () => true },
        );
        if (patchRes.status >= 400) {
          throw new Error(
            `PATCH /api/admin/tenants/${TENANT_A} rag postgresUri failed ${patchRes.status}: ${JSON.stringify(
              patchRes.data,
            )}`,
          );
        }

        // Upload after reroute for tenant A
        const formAfter = new FormData();
        formAfter.append('file', fs.createReadStream(filePathAfter));
        formAfter.append('file_id', clientFileIdAfter);
        formAfter.append('message_file', 'true');
        formAfter.append('endpoint', 'chat');
        formAfter.append('tool_resource', 'file_search');
        const resAfter = await axios.post(`${API_URL}/ext/v2/files`, formAfter, {
          headers: {
            ...extHeaders(extUserA),
            ...formAfter.getHeaders(),
          },
          maxBodyLength: Infinity,
          validateStatus: () => true,
        });
        if (resAfter.status !== 200) {
          throw new Error(
            `/ext/v2/files (tenant A RAG after reroute) failed ${resAfter.status}: ${JSON.stringify(
              resAfter.data,
            )}`,
          );
        }

        const embeddedFileIdAfter = resAfter.data?.file_id;
        if (!embeddedFileIdAfter || typeof embeddedFileIdAfter !== 'string') {
          throw new Error(
            `/ext/v2/files (tenant A RAG after reroute) did not return a valid file_id: ${JSON.stringify(
              resAfter.data,
            )}`,
          );
        }

        // Assert post-reroute embeddings only in pg-b
        const pgA2 = new PgClient({ connectionString: PG_A_URI });
        const pgB2 = new PgClient({ connectionString: PG_B_URI });
        await pgA2.connect();
        await pgB2.connect();
        try {
          const start = Date.now();
          let resOnA;
          let resOnB;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            resOnA = await pgA2.query(
              "SELECT COUNT(*) AS cnt FROM langchain_pg_embedding WHERE (cmetadata->>'file_id') = $1",
              [embeddedFileIdAfter],
            );
            resOnB = await pgB2.query(
              "SELECT COUNT(*) AS cnt FROM langchain_pg_embedding WHERE (cmetadata->>'file_id') = $1",
              [embeddedFileIdAfter],
            );
            const aCnt = parseInt(resOnA.rows[0].cnt, 10);
            const bCnt = parseInt(resOnB.rows[0].cnt, 10);
            if (bCnt >= 1 && aCnt === 0) {
              break;
            }
            if (Date.now() - start > 30000) {
              throw new Error(
                `RAG reroute mismatch after 30s: aCnt=${aCnt}, bCnt=${bCnt} (expected aCnt=0, bCnt>=1)`,
              );
            }
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, 500));
          }
        } finally {
          await pgA2.end();
          await pgB2.end();
        }
      } finally {
        try {
          fs.unlinkSync(filePathBefore);
        } catch (_) {}
        try {
          fs.unlinkSync(filePathAfter);
        } catch (_) {}
      }
    }, 90000);
  });

  describe('Negative security via ext/v2', () => {
    it('rejects spoofed tenant for an already-bound ext user', async () => {
      if (!useLive) return;

      const marker = `extv2-spoof-${Date.now()}`;
      const convoId = `extv2-spoof-convo-${Date.now()}`;

      // 1) First request: bind extUserA to tenant-a
      const resBind = await axios.post(
        `${API_URL}/ext/v2/convos/update`,
        { arg: { conversationId: convoId, title: 'ExtV2 Spoof Baseline' } },
        {
          headers: extHeaders(extUserA),
          validateStatus: () => true,
        },
      );
      if (resBind.status >= 400) {
        throw new Error(
          `/ext/v2/convos/update (bind A) failed ${resBind.status}: ${JSON.stringify(
            resBind.data,
          )}`,
        );
      }

      // 2) Spoof attempt: same user id/email but tenant-b header
      const spoofHeaders = extHeaders({
        userId: extUserA.userId,
        tenantId: TENANT_B,
        email: extUserA.email,
      });
      const resSpoof = await axios.post(
        `${API_URL}/ext/v2/convos/update`,
        { arg: { conversationId: `extv2-spoof-${Date.now()}`, title: marker } },
        {
          headers: spoofHeaders,
          validateStatus: () => true,
        },
      );
      expect(resSpoof.status).toBeGreaterThanOrEqual(400);

      // 3) Assert no side-effects in either tenant DB
      const clientA = await MongoClient.connect(MONGO_A_URI);
      const clientB = await MongoClient.connect(MONGO_B_URI);
      try {
        const dbA = clientA.db(DB_A);
        const dbB = clientB.db(DB_B);
        const leakA = await dbA
          .collection('conversations')
          .find({ title: marker })
          .toArray();
        const leakB = await dbB
          .collection('conversations')
          .find({ title: marker })
          .toArray();
        expect(leakA.length).toBe(0);
        expect(leakB.length).toBe(0);
      } finally {
        await clientA.close();
        await clientB.close();
      }
    }, 30000);

    it('rejects ext/v2 write when X-Tenant-ID is missing', async () => {
      if (!useLive) return;

      const marker = `extv2-tenantless-${Date.now()}`;
      const convoId = `extv2-tenantless-convo-${Date.now()}`;

      // Deliberately omit X-Tenant-ID
      const headersWithoutTenant = {
        'X-User-ID': `${extUserA.userId}-tenantless`,
        'X-User-Email': `tenantless-${extUserA.email}`,
        Accept: 'application/json',
      };

      const res = await axios.post(
        `${API_URL}/ext/v2/convos/update`,
        { arg: { conversationId: convoId, title: marker } },
        { headers: headersWithoutTenant, validateStatus: () => true },
      );
      expect(res.status).toBeGreaterThanOrEqual(400);

      // Assert no writes occurred
      const clientA = await MongoClient.connect(MONGO_A_URI);
      const clientB = await MongoClient.connect(MONGO_B_URI);
      try {
        const dbA = clientA.db(DB_A);
        const dbB = clientB.db(DB_B);
        const leakA = await dbA
          .collection('conversations')
          .find({ title: marker })
          .toArray();
        const leakB = await dbB
          .collection('conversations')
          .find({ title: marker })
          .toArray();
        expect(leakA.length).toBe(0);
        expect(leakB.length).toBe(0);
      } finally {
        await clientA.close();
        await clientB.close();
      }
    }, 30000);

    it('rejects ext/v2 write when X-User-Email is missing or malformed', async () => {
      if (!useLive) return;

      const marker = `extv2-bad-email-${Date.now()}`;
      const convoId = `extv2-bad-email-convo-${Date.now()}`;

      // Case 1: missing X-User-Email
      const headersMissingEmail = {
        'X-User-ID': `user-missing-email-${runId}`,
        'X-Tenant-ID': TENANT_A,
        Accept: 'application/json',
      };
      const resMissing = await axios.post(
        `${API_URL}/ext/v2/convos/update`,
        { arg: { conversationId: convoId, title: marker } },
        { headers: headersMissingEmail, validateStatus: () => true },
      );
      expect(resMissing.status).toBeGreaterThanOrEqual(400);

      // Case 2: malformed email
      const headersBadEmail = {
        'X-User-ID': `user-bad-email-${runId}`,
        'X-Tenant-ID': TENANT_A,
        'X-User-Email': 'not-an-email',
        Accept: 'application/json',
      };
      const resBadEmail = await axios.post(
        `${API_URL}/ext/v2/convos/update`,
        { arg: { conversationId: `${convoId}-2`, title: marker } },
        { headers: headersBadEmail, validateStatus: () => true },
      );
      expect(resBadEmail.status).toBeGreaterThanOrEqual(400);

      // Assert no writes occurred for either case
      const clientA = await MongoClient.connect(MONGO_A_URI);
      const clientB = await MongoClient.connect(MONGO_B_URI);
      try {
        const dbA = clientA.db(DB_A);
        const dbB = clientB.db(DB_B);
        const leakA = await dbA
          .collection('conversations')
          .find({ title: marker })
          .toArray();
        const leakB = await dbB
          .collection('conversations')
          .find({ title: marker })
          .toArray();
        expect(leakA.length).toBe(0);
        expect(leakB.length).toBe(0);
      } finally {
        await clientA.close();
        await clientB.close();
      }
    }, 30000);
  });

  describe('Runtime config edit reroute via ext/v2', () => {
    it('PATCH dbUri moves next ext/v2 write to new Mongo host', async () => {
      if (!useLive) return;

      // Baseline: write for tenant A should go to tenant-mongo-a / DB_A
      const convoBefore = `extv2-runtime-before-${Date.now()}`;
      const resBefore = await axios.post(
        `${API_URL}/ext/v2/convos/update`,
        { arg: { conversationId: convoBefore, title: 'ExtV2 Before PATCH' } },
        { headers: extHeaders(extUserA), validateStatus: () => true },
      );
      if (resBefore.status >= 400) {
        throw new Error(
          `/ext/v2/convos/update before PATCH failed ${resBefore.status}: ${JSON.stringify(
            resBefore.data,
          )}`,
        );
      }

      const clientA0 = await MongoClient.connect(MONGO_A_URI);
      const clientB0 = await MongoClient.connect(MONGO_B_URI);
      try {
        const onABefore = await clientA0
          .db(DB_A)
          .collection('conversations')
          .find({ conversationId: convoBefore })
          .toArray();
        const onBBefore = await clientB0
          .db(DB_B)
          .collection('conversations')
          .find({ conversationId: convoBefore })
          .toArray();
        expect(onABefore.length).toBeGreaterThanOrEqual(1);
        expect(onBBefore.length).toBe(0);
      } finally {
        await clientA0.close();
        await clientB0.close();
      }

      // Patch tenant A dbUri to point to a new DB on tenant-mongo-b
      const secondaryDb = 'tenantA_secondary_extv2';
      const getRes = await axios.get(`${API_URL}/api/admin/tenants/${TENANT_A}`, {
        headers: adminHeaders,
      });
      const expectedVersion = getRes.data.configVersion;
      const patchRes = await axios.patch(
        `${API_URL}/api/admin/tenants/${TENANT_A}`,
        {
          expectedVersion,
          dbUri: `mongodb://tenant-mongo-b:27017/${secondaryDb}`,
        },
        { headers: adminHeaders, validateStatus: () => true },
      );
      if (patchRes.status >= 400) {
        throw new Error(
          `PATCH /api/admin/tenants/${TENANT_A} failed ${patchRes.status}: ${JSON.stringify(
            patchRes.data,
          )}`,
        );
      }

      // After patch: next ext/v2 write for tenant A must land only in secondaryDb on tenant-mongo-b
      const convoAfter = `extv2-runtime-after-${Date.now()}`;
      const resAfter = await axios.post(
        `${API_URL}/ext/v2/convos/update`,
        { arg: { conversationId: convoAfter, title: 'ExtV2 After PATCH' } },
        { headers: extHeaders(extUserA), validateStatus: () => true },
      );
      if (resAfter.status >= 400) {
        throw new Error(
          `/ext/v2/convos/update after PATCH failed ${resAfter.status}: ${JSON.stringify(
            resAfter.data,
          )}`,
        );
      }

      const clientA = await MongoClient.connect(MONGO_A_URI);
      const clientB = await MongoClient.connect(MONGO_B_URI);
      try {
        const onA = await clientA
          .db(DB_A)
          .collection('conversations')
          .find({ conversationId: convoAfter })
          .toArray();
        const onB = await clientB
          .db(secondaryDb)
          .collection('conversations')
          .find({ conversationId: convoAfter })
          .toArray();
        expect(onA.length).toBe(0);
        expect(onB.length).toBe(1);
      } finally {
        await clientA.close();
        await clientB.close();
      }
    }, 40000);

    it('after api restart, ext/v2 routing still correct (MT_IT_RESTART=1)', async () => {
      if (!useLive || process.env.MT_IT_RESTART !== '1') return;

      const { execSync } = require('child_process');
      const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
      const composeFile =
        process.env.MT_IT_COMPOSE_FILE || path.join(repoRoot, 'docker-compose.mt-it.yml');

      // Restart only the api service in the MT-IT stack
      execSync(`docker compose -f "${composeFile}" restart api`, {
        stdio: 'inherit',
        cwd: repoRoot,
      });

      // Wait for api to come back healthy
      for (let i = 0; i < 30; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const res = await axios.get(`${API_URL}/api/admin/tenants`, {
            headers: adminHeaders,
            timeout: 5000,
          });
          if (res.status === 200) break;
        } catch (_) {
          // ignore and retry
        }
        if (i === 29) throw new Error('API did not come back after restart');
      }

      // After restart, tenant B config must still be present
      const expectedDbUriB = `mongodb://tenant-mongo-b:27017/${DB_B}`;
      const expectedRagPgB = 'postgresql://myuser:mypassword@pg-b:5432/tenant_b';
      const tenantBRes = await axios.get(
        `${API_URL}/api/admin/tenants/${TENANT_B}?secrets=1`,
        { headers: adminHeaders },
      );
      expect(tenantBRes.data.dbUri).toBe(expectedDbUriB);
      expect(tenantBRes.data.config?.rag?.postgresUri).toBe(expectedRagPgB);
      expect(tenantBRes.data.config?.storage?.provider).toBe('s3');
      expect(tenantBRes.data.config?.storage?.bucket).toBe('bucket-b');
      expect(tenantBRes.data.config?.storage?.prefix).toBe('tenantB/');

      // ext/v2 write after restart must still land in tenant-mongo-b / DB_B for tenant B
      const convoAfterRestart = `extv2-after-restart-${Date.now()}`;
      const resAfterRestart = await axios.post(
        `${API_URL}/ext/v2/convos/update`,
        { arg: { conversationId: convoAfterRestart, title: 'ExtV2 After restart' } },
        { headers: extHeaders(extUserB) },
      );
      if (resAfterRestart.status >= 400) {
        throw new Error(
          `/ext/v2/convos/update after restart failed ${resAfterRestart.status}: ${JSON.stringify(
            resAfterRestart.data,
          )}`,
        );
      }

      const clientB = await MongoClient.connect(MONGO_B_URI);
      try {
        const found = await clientB
          .db(DB_B)
          .collection('conversations')
          .find({ conversationId: convoAfterRestart })
          .toArray();
        expect(found.length).toBe(1);
      } finally {
        await clientB.close();
      }
    }, 90000);
  });

  describe('Fresh tenant onboarding via ext/v2', () => {
    it('new tenant can be onboarded and used immediately across Mongo, storage, and RAG', async () => {
      if (!useLive) return;

      const os = require('os');
      const fs = require('fs');
      const { randomUUID } = require('crypto');
      const FormData = require('form-data');

      const ts = Date.now();
      const onboardTenantId = `tenant-onboard-${ts}`;
      const onboardDbName = `tenant_onboard_db_${ts}`;
      const onboardStoragePrefix = `tenantOnboard-${ts}/`;

      const onboardUser = {
        userId: `user-onboard-${ts}`,
        tenantId: onboardTenantId,
        email: `mt-extv2-onboard-${ts}@test.local`,
        role: 'USER',
      };

      // 1. Create new tenant via admin API with full config (Mongo, storage, RAG)
      const createBody = {
        tenantId: onboardTenantId,
        name: onboardTenantId,
        dbUri: `mongodb://tenant-mongo-b:27017/${onboardDbName}`,
        config: {
          rag: { postgresUri: PG_B_RUNTIME_URI },
          storage: {
            provider: 's3',
            bucket: 'bucket-a',
            prefix: onboardStoragePrefix,
            endpoint: 'http://minio:9000',
            accessKeyId: 'minioadmin',
            secretAccessKey: 'minioadmin',
          },
        },
      };

      const createRes = await axios.post(`${API_URL}/api/admin/tenants`, createBody, {
        headers: adminHeaders,
        validateStatus: () => true,
      });
      if (createRes.status !== 201 && createRes.status !== 409) {
        throw new Error(
          `Onboarding tenant create failed ${createRes.status}: ${JSON.stringify(createRes.data)}`,
        );
      }

      // 2. ext/v2 Mongo proof: write convo and assert only in new DB
      const convoId = `extv2-onboard-convo-${ts}`;
      const convoRes = await axios.post(
        `${API_URL}/ext/v2/convos/update`,
        { arg: { conversationId: convoId, title: 'ExtV2 Onboard Mongo' } },
        {
          headers: extHeaders(onboardUser),
          validateStatus: () => true,
        },
      );
      if (convoRes.status >= 400) {
        throw new Error(
          `/ext/v2/convos/update (onboard) failed ${convoRes.status}: ${JSON.stringify(
            convoRes.data,
          )}`,
        );
      }

      const onboardMongoClient = await MongoClient.connect(MONGO_B_URI);
      const mongoClientA = await MongoClient.connect(MONGO_A_URI);
      try {
        const onboardDb = onboardMongoClient.db(onboardDbName);
        const dbA = mongoClientA.db(DB_A);
        const dbB = onboardMongoClient.db(DB_B); // existing tenant B DB on same host

        const onboardDocs = await onboardDb
          .collection('conversations')
          .find({ conversationId: convoId })
          .toArray();
        const inTenantA = await dbA.collection('conversations').find({ conversationId: convoId }).toArray();
        const inTenantB = await dbB.collection('conversations').find({ conversationId: convoId }).toArray();

        expect(onboardDocs.length).toBeGreaterThanOrEqual(1);
        expect(inTenantA.length).toBe(0);
        expect(inTenantB.length).toBe(0);
      } finally {
        await onboardMongoClient.close();
        await mongoClientA.close();
      }

      // 3. ext/v2 storage proof: upload file and assert only under onboard prefix
      const tmpDir = os.tmpdir();
      const storageFileId = randomUUID();
      const storageFilePath = path.join(tmpDir, `extv2-onboard-storage-${ts}.txt`);
      fs.writeFileSync(storageFilePath, 'MT extv2 onboarding storage test');

      let storageRes;
      try {
        const storageForm = new FormData();
        storageForm.append('file', fs.createReadStream(storageFilePath));
        storageForm.append('file_id', storageFileId);
        storageForm.append('message_file', 'true');
        storageForm.append('endpoint', 'chat');
        storageRes = await axios.post(`${API_URL}/ext/v2/files`, storageForm, {
          headers: {
            ...extHeaders(onboardUser),
            ...storageForm.getHeaders(),
          },
          maxBodyLength: Infinity,
          validateStatus: () => true,
        });
      } finally {
        try {
          fs.unlinkSync(storageFilePath);
        } catch (_) {}
      }

      if (storageRes.status !== 200) {
        throw new Error(
          `/ext/v2/files (onboard storage) failed ${storageRes.status}: ${JSON.stringify(
            storageRes.data,
          )}`,
        );
      }

      const toKey = (urlString) => {
        const url = new URL(urlString);
        const pathname = url.pathname.replace(/^\/+/, '');
        const segments = pathname.split('/');
        if (segments.length < 2) {
          throw new Error(`Unexpected S3 URL pathname: ${pathname}`);
        }
        const [maybeBucket, ...rest] = segments;
        return rest.length ? rest.join('/') : maybeBucket;
      };
      const onboardKey = toKey(storageRes.data.filepath);

      const s3 = new S3Client({
        region: 'us-east-1',
        endpoint: MINIO_ENDPOINT,
        credentials: { accessKeyId: MINIO_ACCESS, secretAccessKey: MINIO_SECRET },
        forcePathStyle: true,
      });

      const listBucketA = await s3.send(
        new ListObjectsV2Command({ Bucket: 'bucket-a', MaxKeys: 500 }),
      );
      const keysBucketA = (listBucketA.Contents || []).map((o) => o.Key).filter(Boolean);

      expect(keysBucketA).toContain(onboardKey);
      expect(onboardKey.startsWith(onboardStoragePrefix)).toBe(true);

      // 4. ext/v2 RAG proof: upload with file_search and assert embeddings only in pg-b
      const ragTmpPath = path.join(tmpDir, `extv2-onboard-rag-${ts}.txt`);
      fs.writeFileSync(ragTmpPath, 'MT extv2 onboarding RAG test');

      let embeddedFileId;
      try {
        const ragForm = new FormData();
        ragForm.append('file', fs.createReadStream(ragTmpPath));
        ragForm.append('file_id', randomUUID());
        ragForm.append('message_file', 'true');
        ragForm.append('endpoint', 'chat');
        ragForm.append('tool_resource', 'file_search');
        const ragRes = await axios.post(`${API_URL}/ext/v2/files`, ragForm, {
          headers: {
            ...extHeaders(onboardUser),
            ...ragForm.getHeaders(),
          },
          maxBodyLength: Infinity,
          validateStatus: () => true,
        });
        if (ragRes.status !== 200) {
          throw new Error(
            `/ext/v2/files (onboard RAG) failed ${ragRes.status}: ${JSON.stringify(ragRes.data)}`,
          );
        }
        embeddedFileId = ragRes.data?.file_id;
        if (!embeddedFileId || typeof embeddedFileId !== 'string') {
          throw new Error(
            `/ext/v2/files (onboard RAG) did not return a valid file_id: ${JSON.stringify(
              ragRes.data,
            )}`,
          );
        }
      } finally {
        try {
          fs.unlinkSync(ragTmpPath);
        } catch (_) {}
      }

      const pgA = new PgClient({ connectionString: PG_A_URI });
      const pgB = new PgClient({ connectionString: PG_B_URI });
      await pgA.connect();
      await pgB.connect();
      try {
        const start = Date.now();
        let resOnA;
        let resOnB;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          resOnA = await pgA.query(
            "SELECT COUNT(*) AS cnt FROM langchain_pg_embedding WHERE (cmetadata->>'file_id') = $1",
            [embeddedFileId],
          );
          resOnB = await pgB.query(
            "SELECT COUNT(*) AS cnt FROM langchain_pg_embedding WHERE (cmetadata->>'file_id') = $1",
            [embeddedFileId],
          );
          const aCnt = parseInt(resOnA.rows[0].cnt, 10);
          const bCnt = parseInt(resOnB.rows[0].cnt, 10);
          if (bCnt >= 1 && aCnt === 0) {
            break;
          }
          if (Date.now() - start > 30000) {
            throw new Error(
              `Onboard RAG mismatch after 30s: aCnt=${aCnt}, bCnt=${bCnt} (expected aCnt=0, bCnt>=1)`,
            );
          }
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 500));
        }
      } finally {
        await pgA.end();
        await pgB.end();
      }
    }, 90000);
  });
});

