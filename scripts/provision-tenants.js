/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const axios = require('axios');

// Simple admin client for /api/admin/tenants

const DEFAULT_ADMIN_AUTH_SECRET = 'admin-auth-secret-min-16-chars';

function parseBoolEnv(name, defaultValue) {
  const raw = process.env[name];
  if (typeof raw === 'string') {
    const value = raw.toLowerCase();
    if (value === '1' || value === 'true' || value === 'yes') {
      return true;
    }
    if (value === '0' || value === 'false' || value === 'no') {
      return false;
    }
  }
  return defaultValue;
}

async function loadBootstrapConfig() {
  const filePath = path.resolve(__dirname, '..', 'tenants', 'bootstrap.tenants.yaml');
  const content = fs.readFileSync(filePath, 'utf8');
  const doc = yaml.load(content);
  return doc.tenants || [];
}

function getAdminHeaders() {
  const adminSecret = process.env.ADMIN_AUTH_SECRET || DEFAULT_ADMIN_AUTH_SECRET;
  const roleHeader = process.env.ADMIN_ROLE_HEADER || 'X-LibreChat-Role';
  const authHeader = process.env.ADMIN_AUTH_HEADER || 'X-Admin-Auth';
  const roleValue = process.env.ADMIN_ROLE_VALUE || 'ADMIN';
  return {
    [roleHeader]: roleValue,
    [authHeader]: adminSecret,
  };
}

async function getTenant(baseUrl, tenantId, headers) {
  try {
    const res = await axios.get(`${baseUrl}/api/admin/tenants/${tenantId}`, { headers });
    return res.data;
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return null;
    }
    throw err;
  }
}

function buildPayload(entry, googleKeyJson) {
  const payload = {
    tenantId: entry.tenantId,
    name: entry.name,
    dbUri: entry.dbUri,
    status: 'active',
    config: {
      ...(entry.config || {}),
    },
  };

  if (googleKeyJson) {
    payload.config.googleServiceKeyFile = googleKeyJson;
  }

  return payload;
}

async function createOrUpdateTenant(baseUrl, entry, headers, options, counters) {
  const { dryRun } = options || {};
  const existing = await getTenant(baseUrl, entry.tenantId, headers);

  const googleEnv = entry.config && entry.config.googleServiceKeyEnv;
  const googleKeyJson = googleEnv ? process.env[googleEnv] : null;

  const payload = buildPayload(entry, googleKeyJson);

  if (!existing) {
    console.log(
      `[bootstrap] ${dryRun ? 'Would create' : 'Creating'} tenant ${entry.tenantId}`,
    );
    if (!dryRun) {
      await axios.post(`${baseUrl}/api/admin/tenants`, payload, { headers });
    }
    if (counters) counters.created += 1;
    return;
  }

  const currentVersion = existing.configVersion || 0;
  console.log(
    `[bootstrap] ${dryRun ? 'Would update' : 'Updating'} tenant ${entry.tenantId} (version ${currentVersion})`,
  );

  // Use expectedVersion in body, matching admin PATCH contract
  const updatePayload = {
    ...payload,
    expectedVersion: currentVersion,
  };

  if (!dryRun) {
    await axios.patch(`${baseUrl}/api/admin/tenants/${entry.tenantId}`, updatePayload, {
      headers,
    });
  }
  if (counters) counters.updated += 1;
}

async function verifyTenants(apiUrl, tenants, headers, options) {
  const { verifyStorage, verifyRag, verifyGoogle } = options || {};
  const verifyCounters = {
    readbackPassed: 0,
    readbackFailed: 0,
    extv2Passed: 0,
    extv2Failed: 0,
    storageVerified: 0,
    storageSkipped: 0,
    ragVerified: 0,
    ragSkipped: 0,
    googleVerified: 0,
    googleSkipped: 0,
  };

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  for (const entry of tenants) {
    const tenantId = entry.tenantId;
    console.log(`\n[verify] Tenant ${tenantId}`);

    // 1) Read-back verification
    try {
      const res = await axios.get(`${apiUrl}/api/admin/tenants/${tenantId}`, { headers });
      const t = res.data;
      const mismatches = [];
      if (t.tenantId !== tenantId) mismatches.push(`tenantId mismatch (${t.tenantId})`);
      if (t.name !== entry.name) mismatches.push(`name mismatch (${t.name})`);
      if (t.dbUri !== entry.dbUri) mismatches.push(`dbUri mismatch (${t.dbUri})`);
      if (entry.config?.storage) {
        const s = t.config?.storage || {};
        if (s.provider !== entry.config.storage.provider) mismatches.push('storage.provider mismatch');
        if (s.bucket !== entry.config.storage.bucket) mismatches.push('storage.bucket mismatch');
        if (s.prefix !== entry.config.storage.prefix) mismatches.push('storage.prefix mismatch');
      }
      if (entry.config?.rag) {
        const r = t.config?.rag || {};
        if (r.postgresUri !== entry.config.rag.postgresUri) mismatches.push('rag.postgresUri mismatch');
        if (r.vectorDbType !== entry.config.rag.vectorDbType) mismatches.push('rag.vectorDbType mismatch');
      }
      if (mismatches.length === 0) {
        console.log('[verify] Read-back OK');
        verifyCounters.readbackPassed += 1;
      } else {
        console.warn('[verify] Read-back mismatches:', mismatches.join(', '));
        verifyCounters.readbackFailed += 1;
      }
    } catch (err) {
      const detail = err.response
        ? err.response.data || err.response.status
        : { message: err.message, code: err.code };
      console.error('[verify] Read-back failed:', detail);
      verifyCounters.readbackFailed += 1;
    }

    // 2) Per-tenant ext/v2 smoke verification (minimal write path)
    try {
      const smokeHeaders = {
        ...headers,
        'X-Tenant-ID': tenantId,
        'X-User-Email': `bootstrap-smoke+${tenantId}@example.com`,
        'X-User-ID': `bootstrap-smoke-${tenantId}`,
      };
      const marker = `bootstrap-extv2-${tenantId}-${Date.now()}`;
      const body = {
        arg: {
          conversationId: marker,
          title: `bootstrap-${tenantId}`,
          endpoint: 'agents',
          model: 'bootstrap',
        },
      };
      const resp = await axios.post(`${apiUrl}/ext/v2/convos/update`, body, {
        headers: smokeHeaders,
        timeout: 5000,
      });
      if (resp.status >= 200 && resp.status < 300 && resp.data?.conversationId) {
        console.log(
          '[verify] ext/v2 smoke OK (POST /ext/v2/convos/update, conversationId=',
          resp.data.conversationId,
          ')',
        );
        verifyCounters.extv2Passed += 1;
      } else {
        console.warn(
          '[verify] ext/v2 smoke returned non-2xx or missing conversationId:',
          resp.status,
          resp.data,
        );
        verifyCounters.extv2Failed += 1;
      }
    } catch (err) {
      const detail = err.response
        ? err.response.data || err.response.status
        : { message: err.message, code: err.code };
      console.error('[verify] ext/v2 smoke failed:', detail);
      verifyCounters.extv2Failed += 1;
    }

    // 3) Optional storage verification: upload tiny text file via /ext/v2/files
    if (verifyStorage) {
      try {
        const os = require('os');
        const fs = require('fs');
        const path = require('path');
        const { randomUUID } = require('crypto');
        const FormData = require('form-data');

        const tmpDir = os.tmpdir();
        const storageFileId = randomUUID();
        const storageFilePath = path.join(
          tmpDir,
          `bootstrap-extv2-storage-${tenantId}-${Date.now()}.txt`,
        );
        fs.writeFileSync(storageFilePath, `bootstrap storage verify for ${tenantId}`);

        let resp;
        try {
          const form = new FormData();
          form.append('file', fs.createReadStream(storageFilePath));
          form.append('file_id', storageFileId);
          form.append('message_file', 'true');
          form.append('endpoint', 'chat');

          const storageHeaders = {
            ...headers,
            'X-Tenant-ID': tenantId,
            'X-User-Email': `bootstrap-smoke+${tenantId}@example.com`,
            'X-User-ID': `bootstrap-smoke-${tenantId}`,
            'X-User-Role': 'USER',
            Accept: 'application/json',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ...form.getHeaders(),
          };

          resp = await axios.post(`${apiUrl}/ext/v2/files`, form, {
            headers: storageHeaders,
            maxBodyLength: Infinity,
            timeout: 15000,
            validateStatus: () => true,
          });
        } finally {
          try {
            fs.unlinkSync(storageFilePath);
          } catch (_) {}
        }

        if (resp.status !== 200 || !resp.data?.filepath) {
          console.warn(
            '[verify] Storage upload failed or missing filepath:',
            resp.status,
            typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data),
          );
          verifyCounters.storageFailed = (verifyCounters.storageFailed || 0) + 1;
        } else {
          console.log(
            '[verify] Storage upload OK (POST /ext/v2/files, filepath=',
            resp.data.filepath,
            ')',
          );
          verifyCounters.storageVerified += 1;
        }
      } catch (err) {
        const detail =
          err.response && err.response.data
            ? typeof err.response.data === 'string'
              ? err.response.data
              : JSON.stringify(err.response.data)
            : err.response
            ? err.response.status
            : { message: err.message, code: err.code };
        console.error('[verify] Storage upload failed:', detail);
        verifyCounters.storageFailed = (verifyCounters.storageFailed || 0) + 1;
      }
    } else {
      verifyCounters.storageSkipped += 1;
    }

    // 4) Optional RAG verification: tiny file_search upload via /ext/v2/files
    if (verifyRag) {
      try {
        const os = require('os');
        const fs = require('fs');
        const path = require('path');
        const { randomUUID } = require('crypto');
        const FormData = require('form-data');

        const tmpDir = os.tmpdir();
        const ragFilePath = path.join(
          tmpDir,
          `bootstrap-extv2-rag-${tenantId}-${Date.now()}.txt`,
        );
        fs.writeFileSync(ragFilePath, `bootstrap RAG verify for ${tenantId}`);

        let resp;
        let embeddedFileId;
        try {
          const maxAttempts = 3;
          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const form = new FormData();
            form.append('file', fs.createReadStream(ragFilePath));
            form.append('file_id', randomUUID());
            form.append('message_file', 'true');
            form.append('endpoint', 'chat');
            form.append('tool_resource', 'file_search');

            const ragHeaders = {
              ...headers,
              'X-Tenant-ID': tenantId,
              'X-User-Email': `bootstrap-smoke+${tenantId}@example.com`,
              'X-User-ID': `bootstrap-smoke-${tenantId}`,
              'X-User-Role': 'USER',
              Accept: 'application/json',
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              ...form.getHeaders(),
            };

            try {
              resp = await axios.post(`${apiUrl}/ext/v2/files`, form, {
                headers: ragHeaders,
                maxBodyLength: Infinity,
                timeout: 20000,
                validateStatus: () => true,
              });

              if (
                resp.status === 200 &&
                resp.data?.file_id &&
                typeof resp.data.file_id === 'string'
              ) {
                embeddedFileId = resp.data.file_id;
              }
              break;
            } catch (err) {
              const isConnRefused =
                err.code === 'ECONNREFUSED' ||
                (typeof err.message === 'string' && err.message.includes('ECONNREFUSED'));
              if (!isConnRefused || attempt === maxAttempts) {
                throw err;
              }
              console.warn(
                `[verify] RAG upload attempt ${attempt} for tenant ${tenantId} failed with ECONNREFUSED; retrying shortly...`,
              );
              // Small bounded backoff to allow rag_api to finish startup
              // eslint-disable-next-line no-await-in-loop
              await delay(5000);
            }
          }
        } finally {
          try {
            fs.unlinkSync(ragFilePath);
          } catch (_) {}
        }

        if (resp.status !== 200 || !embeddedFileId) {
          console.warn(
            '[verify] RAG upload failed or missing file_id:',
            resp.status,
            typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data),
          );
          verifyCounters.ragFailed = (verifyCounters.ragFailed || 0) + 1;
        } else {
          console.log(
            '[verify] RAG upload OK (POST /ext/v2/files tool_resource=file_search, file_id=',
            embeddedFileId,
            ')',
          );
          verifyCounters.ragVerified += 1;
        }
      } catch (err) {
        const detail =
          err.response && err.response.data
            ? typeof err.response.data === 'string'
              ? err.response.data
              : JSON.stringify(err.response.data)
            : err.response
            ? err.response.status
            : { message: err.message, code: err.code };
        console.error('[verify] RAG upload failed:', detail);
        verifyCounters.ragFailed = (verifyCounters.ragFailed || 0) + 1;
      }
    } else {
      verifyCounters.ragSkipped += 1;
    }

    // 5) Optional Google verification (tenant-levelbuild only) via ext/v2 agents/chat/google
    if (verifyGoogle && tenantId === 'tenant-levelbuild') {
      try {
        const { runGoogleVerification } = require('./verify-google-helper');
        console.log('[verify] Starting Google/Gemini ext/v2 verification for tenant-levelbuild');
        const result = await runGoogleVerification({ apiUrl });
        console.log(
          '[verify] Google/Gemini ext/v2 verification OK (conversationId=',
          result.conversationId,
          ')',
        );
        verifyCounters.googleVerified += 1;
      } catch (err) {
        console.error(
          '[verify] Google/Gemini ext/v2 verification FAILED:',
          err.message || err,
        );
        verifyCounters.googleFailed = (verifyCounters.googleFailed || 0) + 1;
      }
    } else if (tenantId === 'tenant-levelbuild') {
      verifyCounters.googleSkipped += 1;
    }
  }

  console.log('\n[verify] Summary:');
  console.log(
    `  readback: passed=${verifyCounters.readbackPassed}, failed=${verifyCounters.readbackFailed}`,
  );
  console.log(
    `  ext/v2 smoke: passed=${verifyCounters.extv2Passed}, failed=${verifyCounters.extv2Failed}`,
  );
  console.log(
    `  storage: verified=${verifyCounters.storageVerified}, failed=${verifyCounters.storageFailed || 0}, skipped=${verifyCounters.storageSkipped}`,
  );
  console.log(
    `  rag: verified=${verifyCounters.ragVerified}, failed=${verifyCounters.ragFailed || 0}, skipped=${verifyCounters.ragSkipped}`,
  );
  console.log(
    `  google(levelbuild): verified=${verifyCounters.googleVerified}, failed=${verifyCounters.googleFailed || 0}, skipped=${verifyCounters.googleSkipped}`,
  );

  if (
    verifyCounters.readbackFailed > 0 ||
    verifyCounters.extv2Failed > 0 ||
    (verifyStorage && (verifyCounters.storageFailed || 0) > 0) ||
    (verifyRag && (verifyCounters.ragFailed || 0) > 0) ||
    (verifyGoogle && (verifyCounters.googleFailed || 0) > 0)
  ) {
    process.exit(1);
  }
}

async function main() {
  const apiUrl = process.env.API_URL || 'http://localhost:3082';
  const headers = getAdminHeaders();
  const tenants = await loadBootstrapConfig();

  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  // Verification defaults: enabled in canonical local mode, overrideable via env
  const verifyEnv = parseBoolEnv('BOOTSTRAP_VERIFY', true);
  const verifyStorageEnv = parseBoolEnv('BOOTSTRAP_VERIFY_STORAGE', true);
  const verifyRagEnv = parseBoolEnv('BOOTSTRAP_VERIFY_RAG', true);
  const verifyGoogleEnv = parseBoolEnv('BOOTSTRAP_VERIFY_GOOGLE', true);

  // Preserve explicit --verify flag as an opt-in for non-local callers
  const verify = args.includes('--verify') ? true : verifyEnv;
  const verifyStorage = verifyStorageEnv;
  const verifyRag = verifyRagEnv;
  const verifyGoogle = verifyGoogleEnv;

  const counters = {
    created: 0,
    updated: 0,
    failed: 0,
  };

  // Quick API health check for operator ergonomics
  try {
    await axios.get(`${apiUrl}/ext/v2/health`, { headers, timeout: 5000 });
  } catch (err) {
    const detail = err.response
      ? err.response.data || err.response.status
      : { message: err.message, code: err.code };
    console.error(
      `[bootstrap] Cannot reach API_URL=${apiUrl} (ext/v2/health). ` +
        'Verify docker compose ps and that ext/v2/health is green.',
      detail,
    );
    process.exit(1);
  }

  for (const entry of tenants) {
    try {
      await createOrUpdateTenant(apiUrl, entry, headers, { dryRun }, counters);
    } catch (err) {
      const detail = err.response
        ? err.response.data || err.response.status
        : { message: err.message, code: err.code };
      console.error(
        `[bootstrap] Failed for tenant ${entry.tenantId}:`,
        detail,
      );
      counters.failed += 1;
      if (process.env.BOOTSTRAP_FAIL_FAST === '1') {
        process.exit(1);
      }
    }
  }

  console.log(
    `[bootstrap] Completed tenant bootstrap ${dryRun ? '(dry run)' : ''} — ` +
      `created=${counters.created}, updated=${counters.updated}, failed=${counters.failed}`,
  );

  if (counters.failed > 0) {
    process.exit(1);
  }

  if (!dryRun && verify) {
    console.log('[bootstrap] Starting verification phase');
    await verifyTenants(apiUrl, tenants, headers, {
      verifyStorage,
      verifyRag,
      verifyGoogle,
    });
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[bootstrap] Unhandled error', err);
    process.exit(1);
  });
}

module.exports = { main };

