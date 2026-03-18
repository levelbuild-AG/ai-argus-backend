/* eslint-disable no-console */
const fs = require('fs');
const axios = require('axios');
const { execFile } = require('child_process');
const { MongoClient } = require('mongodb');

const TENANT_ID = process.env.TENANT_LEVELBUILD_ID || 'tenant-levelbuild';
const RUN_MARKER_PREFIX = 'verify-google-levelbuild';
const DEFAULT_ADMIN_AUTH_SECRET = 'admin-auth-secret-min-16-chars';
const DEFAULT_GOOGLE_VERIFY_MODEL = 'gemini-2.5-pro';

function buildAdminHeaders() {
  const adminSecret = process.env.ADMIN_AUTH_SECRET || DEFAULT_ADMIN_AUTH_SECRET;
  const roleHeader = process.env.ADMIN_ROLE_HEADER || 'X-LibreChat-Role';
  const authHeader = process.env.ADMIN_AUTH_HEADER || 'X-Admin-Auth';
  const roleValue = process.env.ADMIN_ROLE_VALUE || 'ADMIN';
  return {
    [roleHeader]: roleValue,
    [authHeader]: adminSecret,
    'Content-Type': 'application/json',
  };
}

function buildExtHeaders({ runId }) {
  const email = `mt-levelbuild-${runId}@test.local`;
  const userId = `user-levelbuild-${runId}`;
  const origin = process.env.ARGUS_VERIFY_ORIGIN || 'http://localhost:3090';
  const referer = process.env.ARGUS_VERIFY_REFERER || 'http://localhost:3090/';

  return {
    'X-User-ID': userId,
    'X-User-Email': email,
    'X-User-Name': 'Levelbuild Verifier',
    'X-Tenant-ID': TENANT_ID,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua':
      '"Not.A/Brand";v="8", "Chromium";v="123", "Microsoft Edge";v="123"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    Origin: origin,
    Referer: referer,
  };
}

async function waitForExtV2Health(apiUrl) {
  const health = await axios.get(`${apiUrl}/ext/v2/health`, { timeout: 5000 });
  if (health.status !== 200 || health.data?.status !== 'ok') {
    throw new Error(`ext/v2/health returned ${health.status}: ${JSON.stringify(health.data)}`);
  }
}

async function getTenantConfig(apiUrl, adminHeaders) {
  const resp = await axios.get(
    `${apiUrl}/api/admin/tenants/${encodeURIComponent(TENANT_ID)}?secrets=1`,
    {
      headers: adminHeaders,
      timeout: 10000,
      validateStatus: () => true,
    },
  );
  if (resp.status !== 200) {
    throw new Error(
      `GET /api/admin/tenants/${TENANT_ID} failed ${resp.status}: ${JSON.stringify(resp.data)}`,
    );
  }
  return resp.data;
}

async function patchTenantConfig(apiUrl, adminHeaders, partialConfig, expectedVersion) {
  const payload = {
    expectedVersion,
    config: partialConfig,
  };
  const resp = await axios.patch(
    `${apiUrl}/api/admin/tenants/${encodeURIComponent(TENANT_ID)}`,
    payload,
    {
      headers: adminHeaders,
      timeout: 15000,
      validateStatus: () => true,
    },
  );
  if (resp.status >= 400) {
    throw new Error(
      `PATCH /api/admin/tenants/${TENANT_ID} failed ${resp.status}: ${JSON.stringify(resp.data)}`,
    );
  }
  return resp.data;
}

function resolveGoogleKeyJsonString() {
  const b64 = process.env.TENANT_LEVELBUILD_GOOGLE_KEY_JSON_B64;
  const raw = process.env.TENANT_LEVELBUILD_GOOGLE_KEY_JSON;
  const filePath =
    process.env.TENANT_LEVELBUILD_GOOGLE_KEY_FILE || 'config/gcp/auth.json';

  let jsonString;

  if (b64) {
    try {
      jsonString = Buffer.from(b64.trim(), 'base64').toString('utf8');
    } catch (e) {
      throw new Error(
        `Failed to decode TENANT_LEVELBUILD_GOOGLE_KEY_JSON_B64: ${e.message}`,
      );
    }
  } else if (raw) {
    jsonString = raw;
  } else if (filePath) {
    try {
      jsonString = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      throw new Error(
        `Failed to read TENANT_LEVELBUILD_GOOGLE_KEY_FILE at ${filePath}: ${e.message}`,
      );
    }
  } else {
    throw new Error(
      'One of TENANT_LEVELBUILD_GOOGLE_KEY_JSON_B64, TENANT_LEVELBUILD_GOOGLE_KEY_JSON, or TENANT_LEVELBUILD_GOOGLE_KEY_FILE is required',
    );
  }

  try {
    JSON.parse(jsonString);
  } catch (e) {
    throw new Error(
      `Provided tenant-levelbuild Google key is not valid JSON: ${e.message}`,
    );
  }

  return jsonString;
}

function createMessageId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function callExtAgentsChatGoogle(apiUrl, { runId, marker, model }) {
  const url = `${apiUrl}/ext/v2/agents/chat/google`;
  const headers = {
    ...buildExtHeaders({ runId }),
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
  };

  const NO_PARENT = '00000000-0000-0000-0000-000000000000';
  const messageId = createMessageId();
  const clientTimestamp = new Date().toISOString();

  const body = {
    text: `Gemini verification marker: ${marker}`,
    endpoint: 'google',
    model,
    parentMessageId: NO_PARENT,
    messageId,
    sender: 'user',
    clientTimestamp,
    isCreatedByUser: true,
    error: null,
    key: 'never',
    isTemporary: false,
    isRegenerate: false,
    isContinued: false,
    ephemeralAgent: null,
  };

  const resp = await axios.post(url, body, {
    headers,
    timeout: 45000,
    responseType: 'stream',
    validateStatus: () => true,
  });

  const rawFrames = [];

  if (resp.status !== 200) {
    return {
      ok: false,
      status: resp.status,
      errorCategory: classifyHttpFailure(resp.status, resp.data),
      finalEvent: null,
      rawFrames,
    };
  }

  return new Promise((resolve) => {
    let buffer = '';
    let finalEvent = null;
    let firstErrorEvent = null;

    resp.data.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const frame of parts) {
        rawFrames.push(frame);
        const lines = frame.split('\n');
        const eventLine = lines.find((l) => l.startsWith('event:'));
        const dataLine = lines.find((l) => l.startsWith('data:'));
        if (!dataLine) {
          continue;
        }
        const jsonStr = dataLine.slice(5).trim();
        if (!jsonStr) {
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          continue;
        }

        const eventType = eventLine ? eventLine.slice(6).trim() : 'message';

        if (eventType === 'error' && !firstErrorEvent) {
          firstErrorEvent = parsed.data || parsed;
        }

        if (parsed?.final === true || parsed?.data?.final === true) {
          finalEvent = parsed.data || parsed;
        }
      }
    });

    resp.data.on('end', () => {
      if (!finalEvent) {
        if (firstErrorEvent) {
          resolve({
            ok: false,
            status: 200,
            errorCategory: 'stream_error_event',
            finalEvent: firstErrorEvent,
            rawFrames,
          });
          return;
        }
        resolve({
          ok: false,
          status: 200,
          errorCategory: 'stream_final_missing',
          finalEvent: null,
          rawFrames,
        });
        return;
      }

      if (finalEvent.error || finalEvent.responseMessage?.error) {
        resolve({
          ok: false,
          status: 200,
          errorCategory: 'model_or_runtime_error',
          finalEvent,
          rawFrames,
        });
        return;
      }

      resolve({
        ok: true,
        status: 200,
        errorCategory: null,
        finalEvent,
        rawFrames,
      });
    });

    resp.data.on('error', (err) => {
      resolve({
        ok: false,
        status: 200,
        errorCategory: 'stream_transport_error',
        finalEvent: null,
        rawFrames,
        error: err,
      });
    });
  });
}

function classifyHttpFailure(status, data) {
  if (status === 401 || status === 403) {
    return 'auth_or_tenant';
  }
  if (status === 400) {
    return 'illegal_request';
  }
  if (status === 429) {
    return 'rate_limit';
  }
  if (status >= 500) {
    if (data && typeof data === 'object' && /google/i.test(JSON.stringify(data))) {
      return 'google_credentials_or_runtime';
    }
    return 'server_or_middleware_error';
  }
  return 'unknown_http_error';
}

async function verifyPersistenceWithFinalEvent(apiUrl, { runId, marker, finalEvent }) {
  const headers = buildExtHeaders({ runId });

  if (!finalEvent || typeof finalEvent !== 'object') {
    throw new Error('Persistence verification failed: finalEvent payload is missing or invalid');
  }

  const convoId =
    finalEvent.conversation?.conversationId ||
    finalEvent.conversationId ||
    finalEvent.responseMessage?.conversationId ||
    finalEvent.requestMessage?.conversationId ||
    null;

  console.log('[verify-google] SSE final payload keys:', Object.keys(finalEvent || {}));
  console.log('[verify-google] SSE final conversationId:', convoId || '<none>');

  const checkMessagesForMarker = async (conversationId) => {
    const url = `${apiUrl}/ext/v2/messages?conversationId=${encodeURIComponent(
      conversationId,
    )}&pageSize=50`;
    const res = await axios.get(url, {
      headers,
      timeout: 15000,
      validateStatus: () => true,
    });

    if (res.status !== 200) {
      throw new Error(
        `GET /ext/v2/messages (conversationId=${conversationId}) failed ${res.status}: ${JSON.stringify(
          res.data,
        )}`,
      );
    }

    const messages = res.data?.messages || [];
    const hasMarker = messages.some((m) => {
      if (!m) return false;
      if (typeof m.text === 'string' && m.text.includes(marker)) return true;
      if (Array.isArray(m.content)) {
        return m.content.some(
          (part) => typeof part?.text === 'string' && part.text.includes(marker),
        );
      }
      return false;
    });

    if (hasMarker) {
      return conversationId;
    }

    throw new Error(
      `Persistence verification failed for conversationId=${conversationId}; inspected messages payload: ${JSON.stringify(
        { conversationId, sample: messages.slice(0, 5) },
      )}`,
    );
  };

  if (convoId) {
    return await checkMessagesForMarker(convoId);
  }

  const searchRes = await axios.get(
    `${apiUrl}/ext/v2/convos?search=${encodeURIComponent(marker)}&limit=10`,
    {
      headers,
      timeout: 15000,
      validateStatus: () => true,
    },
  );
  if (searchRes.status !== 200) {
    throw new Error(
      `GET /ext/v2/convos search failed ${searchRes.status}: ${JSON.stringify(searchRes.data)}`,
    );
  }

  const convos = searchRes.data?.conversations || [];

  for (const convo of convos) {
    if (!convo?.conversationId) continue;
    try {
      const foundId = await checkMessagesForMarker(convo.conversationId);
      if (foundId) {
        return foundId;
      }
    } catch (err) {
      console.warn(
        '[verify-google] Conversation candidate failed persistence check:',
        err.message,
      );
    }
  }

  throw new Error(
    `Persistence verification failed: scanned ${convos.length} conversation candidates but did not find marker '${marker}' in any messages. Last payload: ${JSON.stringify(
      { convosSample: convos.slice(0, 5) },
    )}`,
  );
}

async function verifyTenantMongoStorage({ conversationId, tenantDbUri, systemMongoUri }) {
  if (!systemMongoUri || !tenantDbUri) {
    throw new Error(
      'Tenant Mongo verification requires both tenantDbUri and systemMongoUri to be set',
    );
  }

  const redactMongoUri = (uri) =>
    typeof uri === 'string'
      ? uri.replace(/\/\/([^@]+)@/, '//***:***@')
      : uri;

  console.log(
    '[verify-google] Tenant DB URI (redacted):',
    redactMongoUri(tenantDbUri),
  );
  console.log(
    '[verify-google] System DB URI (redacted):',
    redactMongoUri(systemMongoUri),
  );

  const script = [
    "const { MongoClient } = require('mongodb');",
    '(async () => {',
    '  const tenantUri = process.env.TENANT_DB_URI;',
    '  const systemUri = process.env.SYSTEM_DB_URI;',
    '  const conversationId = process.env.CONVERSATION_ID;',
    '  const marker = process.env.MARKER;',
    '  const missing = [];',
    '  if (!tenantUri) missing.push("TENANT_DB_URI");',
    '  if (!systemUri) missing.push("SYSTEM_DB_URI");',
    '  if (!conversationId) missing.push("CONVERSATION_ID");',
    '  if (!marker) missing.push("MARKER");',
    '  if (missing.length) {',
    '    console.error("MISSING_ENV", missing.join(","));',
    '    process.exit(10);',
    '  }',
    '  const tenantClient = new MongoClient(tenantUri);',
    '  const systemClient = new MongoClient(systemUri);',
    '  try {',
    '    await tenantClient.connect();',
    '    await systemClient.connect();',
    '    const tenantDb = tenantClient.db();',
    '    const systemDb = systemClient.db();',
    '    const tenantDoc = await tenantDb',
    "      .collection('conversations')",
    '      .findOne({ conversationId });',
    '    const systemDoc = await systemDb',
    "      .collection('conversations')",
    '      .findOne({ conversationId });',
    '    if (!tenantDoc) {',
    '      console.error("NO_TENANT_CONVO", conversationId);',
    '      process.exit(1);',
    '    }',
    '    if (systemDoc) {',
    '      console.error("LEAK_SYSTEM_CONVO", conversationId);',
    '      process.exit(2);',
    '    }',
    '    const tenantMessages = await tenantDb',
    "      .collection('messages')",
    '      .find({ conversationId })',
    '      .toArray();',
    '    const hasMarker = tenantMessages.some((m) => {',
    '      if (!m) return false;',
    '      if (typeof m.text === "string" && m.text.includes(marker)) return true;',
    '      if (Array.isArray(m.content)) {',
    '        return m.content.some(',
    '          (part) => part && typeof part.text === "string" && part.text.includes(marker),',
    '        );',
    '      }',
    '      return false;',
    '    });',
    '    if (!hasMarker) {',
    '      console.error("NO_MARKER_IN_MESSAGES", conversationId);',
    '      process.exit(4);',
    '    }',
    '    console.log("OK");',
    '    process.exit(0);',
    '  } catch (err) {',
    '    console.error("ERROR", err && err.message);',
    '    process.exit(3);',
    '  } finally {',
    '    await tenantClient.close().catch(() => {});',
    '    await systemClient.close().catch(() => {});',
    '  }',
    '})();',
  ].join('\n');

  await new Promise((resolve, reject) => {
    const child = execFile(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        '-e',
        `TENANT_DB_URI=${tenantDbUri}`,
        '-e',
        `SYSTEM_DB_URI=${systemMongoUri}`,
        '-e',
        `CONVERSATION_ID=${conversationId}`,
        '-e',
        `MARKER=${RUN_MARKER_PREFIX}`,
        'api',
        'node',
        '-e',
        script,
      ],
      { env: process.env },
      (error, stdout, stderr) => {
        const out = (stdout || '').trim();
        const errOut = (stderr || '').trim();
        if (error) {
          return reject(
            new Error(
              `Tenant Mongo verification inside container failed (exitCode=${error.code}): stdout="${out}" stderr="${errOut}"`,
            ),
          );
        }
        if (!out.includes('OK')) {
          return reject(
            new Error(
              `Tenant Mongo verification inside container did not report OK. stdout="${out}" stderr="${errOut}"`,
            ),
          );
        }
        return resolve();
      },
    );
    child.stdin && child.stdin.end();
  });
}

async function runGoogleVerification({ apiUrl }) {
  const runId = `${Date.now()}`;
  const markerBase = `${RUN_MARKER_PREFIX}-${runId}`;
  const originalKeyJson = resolveGoogleKeyJsonString();
  const adminHeaders = buildAdminHeaders();

  await waitForExtV2Health(apiUrl);

  const currentConfig = await getTenantConfig(apiUrl, adminHeaders);
  const currentVersion = currentConfig.configVersion || 0;
  const tenantDbUri = currentConfig.dbUri;
  const systemMongoUri =
    process.env.SYSTEM_MONGO_URI ||
    process.env.MT_IT_SYSTEM_MONGO_URI ||
    'mongodb://system-mongo:27017/LibreChat';

  await patchTenantConfig(
    apiUrl,
    adminHeaders,
    {
      googleServiceKeyFile: originalKeyJson,
    },
    currentVersion,
  );

  const model = process.env.GOOGLE_VERIFY_MODEL || DEFAULT_GOOGLE_VERIFY_MODEL;

  const markerValid = `${markerBase}-valid`;
  const validResult = await callExtAgentsChatGoogle(apiUrl, {
    runId,
    marker: markerValid,
    model,
  });

  if (!validResult.ok) {
    throw new Error(
      `[verify-google] Valid ext/v2 agents chat failed. Category=${validResult.errorCategory}; finalEvent=${JSON.stringify(
        validResult.finalEvent,
      )}`,
    );
  }

  const conversationId = await verifyPersistenceWithFinalEvent(apiUrl, {
    runId,
    marker: markerValid,
    finalEvent: validResult.finalEvent,
  });

  await verifyTenantMongoStorage({
    conversationId,
    tenantDbUri,
    systemMongoUri,
  });

  const invalidKeyJson = '{"this_is_not":"a_valid_service_account"}';
  await patchTenantConfig(
    apiUrl,
    adminHeaders,
    {
      googleServiceKeyFile: invalidKeyJson,
    },
    currentVersion + 1,
  );

  const markerInvalid = `${markerBase}-invalid`;
  const invalidResult = await callExtAgentsChatGoogle(apiUrl, {
    runId,
    marker: markerInvalid,
    model,
  });

  if (invalidResult.ok) {
    throw new Error(
      '[verify-google] Expected Google credential failure, but ext/v2 agents chat succeeded.',
    );
  }

  const markerRestored = `${markerBase}-restored`;
  await patchTenantConfig(
    apiUrl,
    adminHeaders,
    {
      googleServiceKeyFile: originalKeyJson,
    },
    currentVersion + 2,
  );

  const restoredResult = await callExtAgentsChatGoogle(apiUrl, {
    runId,
    marker: markerRestored,
    model,
  });

  if (!restoredResult.ok) {
    throw new Error(
      `[verify-google] Restored credentials did not succeed. Category=${restoredResult.errorCategory}; finalEvent=${JSON.stringify(
        restoredResult.finalEvent,
      )}`,
    );
  }

  await verifyPersistenceWithFinalEvent(apiUrl, {
    runId,
    marker: markerRestored,
    finalEvent: restoredResult.finalEvent,
  });

  return {
    conversationId,
  };
}

module.exports = {
  runGoogleVerification,
};

