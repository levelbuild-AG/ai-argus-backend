const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { Tenant } = require('~/db/models');
const { validateTenantConfigSchema } = require('~/server/services/Config/validateTenantConfigSchema');
const { validateTenantConfigConnectivity } = require('~/server/services/Config/validateTenantConfigConnectivity');
const { getTenantConfigService } = require('~/server/services/Config/TenantConfigService');
const {
  onTenantCreated,
  onTenantConfigChanged,
  onTenantDeleted,
  buildConfigDiff,
} = require('~/server/services/Config/TenantRuntimeInvalidationService');
const { auditLog } = require('~/server/services/Config/adminTenantAuditLog');

const router = express.Router({ mergeParams: true });
const { initializeClientWithCredentials } = require('~/server/services/Endpoints/google/initialize');

function getRequestId(req) {
  return req.get('x-request-id') || req.id || undefined;
}

const SECRET_KEYS = new Set([
  'openAiApiKey',
  'anthropicApiKey',
  'googleApiKey',
  'googleServiceKeyFile',
  'fluxApiKey',
  'bedrock',
  'customEndpoints',
]);

function redactSecrets(obj, depth = 0) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (depth > 10) return '[REDACTED]';
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEYS.has(k)) {
      out[k] = v != null ? '[REDACTED]' : v;
    } else if (k === 'apiKey' || k === 'secretAccessKey' || k === 'accessKeyId' || k === 'sessionToken') {
      out[k] = v != null ? '[REDACTED]' : v;
    } else {
      out[k] = typeof v === 'object' && v !== null ? redactSecrets(v, depth + 1) : v;
    }
  }
  return out;
}

function getExpectedVersion(req) {
  const ifMatch = req.get('If-Match');
  if (ifMatch != null) {
    const n = parseInt(ifMatch, 10);
    if (!Number.isNaN(n)) return n;
  }
  const body = req.body || {};
  if (typeof body.expectedVersion === 'number') return body.expectedVersion;
  return null;
}

/** GET /api/admin/tenants — list tenants (paginated) */
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const includeDeleted = req.query.status === 'all';

    const filter = includeDeleted ? {} : { status: 'active' };
    const [docs, total] = await Promise.all([
      Tenant.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
      Tenant.countDocuments(filter),
    ]);

    const redact = req.query.secrets !== '1';
    const items = docs.map((d) => {
      const out = { ...d };
      if (redact && out.config) out.config = redactSecrets(out.config);
      return out;
    });

    res.json({
      tenants: items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (e) {
    logger.error('[admin/tenants] list error', e);
    res.status(500).json({ error: e.message || 'List failed' });
  }
});

/** POST /api/admin/tenants/validate — validate create payload (no :tenantId) */
router.post('/validate', async (req, res) => {
  try {
    const payload = req.body || {};
    const schemaResult = validateTenantConfigSchema(payload, true);
    if (!schemaResult.valid) {
      return res.status(400).json({ valid: false, schema: schemaResult.errors });
    }
    const tenantId = (payload.tenantId || '').trim().toLowerCase();
    const fullPayload = {
      tenantId,
      dbUri: payload.dbUri ?? '',
      config: payload.config ?? {},
    };
    const connectivity = await validateTenantConfigConnectivity(tenantId, fullPayload);
    if (!connectivity.valid) {
      return res.status(400).json({
        valid: false,
        connectivity: connectivity.errors,
      });
    }
    res.json({ valid: true });
  } catch (e) {
    logger.error('[admin/tenants] validate (create) error', e);
    res.status(500).json({ error: e.message || 'Validation failed' });
  }
});

/** POST /api/admin/tenants — create tenant */
router.post('/', async (req, res) => {
  try {
    const payload = req.body || {};
    const schemaResult = validateTenantConfigSchema(payload, true);
    if (!schemaResult.valid) {
      return res.status(400).json({ error: 'Validation failed', details: schemaResult.errors });
    }

    const connectivity = await validateTenantConfigConnectivity(payload.tenantId, payload);
    if (!connectivity.valid) {
      return res.status(400).json({
        error: 'Connectivity validation failed',
        details: connectivity.errors,
      });
    }

    const existing = await Tenant.findOne({ tenantId: payload.tenantId.trim().toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: 'Tenant already exists' });
    }

    const doc = await Tenant.create({
      tenantId: payload.tenantId.trim().toLowerCase(),
      name: payload.name || payload.tenantId,
      dbUri: payload.dbUri,
      status: payload.status || 'active',
      configVersion: 0,
      config: payload.config || {},
    });

    onTenantCreated(doc.tenantId);
    auditLog({
      tenantId: doc.tenantId,
      action: 'create',
      configVersionAfter: 0,
      requestId: getRequestId(req),
    });
    const redact = req.query.secrets !== '1';
    const out = doc.toObject ? doc.toObject() : doc;
    if (redact && out.config) out.config = redactSecrets(out.config);
    res.status(201).json(out);
  } catch (e) {
    logger.error('[admin/tenants] create error', e);
    res.status(500).json({ error: e.message || 'Create failed' });
  }
});

/** GET /api/admin/tenants/:tenantId */
router.get('/:tenantId', async (req, res) => {
  try {
    const tenantId = req.params.tenantId?.toLowerCase();
    const doc = await Tenant.findOne({ tenantId }).lean();
    if (!doc) return res.status(404).json({ error: 'Tenant not found' });

    const redact = req.query.secrets !== '1';
    const out = { ...doc };
    if (redact && out.config) out.config = redactSecrets(out.config);
    res.json(out);
  } catch (e) {
    logger.error('[admin/tenants] get error', e);
    res.status(500).json({ error: e.message || 'Get failed' });
  }
});

/** PUT /api/admin/tenants/:tenantId — full replace */
router.put('/:tenantId', async (req, res) => {
  try {
    const tenantId = req.params.tenantId?.toLowerCase();
    const payload = req.body || {};
    const schemaResult = validateTenantConfigSchema({ ...payload, tenantId }, false);
    if (!schemaResult.valid) {
      return res.status(400).json({ error: 'Validation failed', details: schemaResult.errors });
    }

    const connectivity = await validateTenantConfigConnectivity(tenantId, {
      ...payload,
      tenantId,
      dbUri: payload.dbUri,
      config: payload.config,
    });
    if (!connectivity.valid) {
      return res.status(400).json({
        error: 'Connectivity validation failed',
        details: connectivity.errors,
      });
    }

    const expectedVersion = getExpectedVersion(req);
    const current = await Tenant.findOne({ tenantId });
    if (!current) return res.status(404).json({ error: 'Tenant not found' });
    if (expectedVersion != null && (current.configVersion || 0) !== expectedVersion) {
      return res.status(409).json({
        error: 'Conflict: config was modified',
        currentVersion: current.configVersion,
      });
    }

    const updated = await Tenant.findOneAndUpdate(
      { tenantId },
      {
        $set: {
          name: payload.name ?? current.name,
          dbUri: payload.dbUri ?? current.dbUri,
          status: payload.status ?? current.status,
          config: payload.config ?? current.config ?? {},
          updatedAt: new Date(),
        },
        $inc: { configVersion: 1 },
      },
      { new: true, runValidators: true },
    ).lean();

    const nextDoc = { ...current, ...updated, config: updated.config ?? current.config ?? {} };
    const diff = buildConfigDiff(current, nextDoc);
    const appliedInvalidations = await onTenantConfigChanged(tenantId, diff);
    auditLog({
      tenantId,
      action: 'put',
      configVersionBefore: current.configVersion ?? 0,
      configVersionAfter: updated.configVersion,
      requestId: getRequestId(req),
    });

    const redact = req.query.secrets !== '1';
    const out = { ...updated, appliedInvalidations };
    if (redact && out.config) out.config = redactSecrets(out.config);
    res.json(out);
  } catch (e) {
    logger.error('[admin/tenants] put error', e);
    res.status(500).json({ error: e.message || 'Update failed' });
  }
});

/** PATCH /api/admin/tenants/:tenantId */
router.patch('/:tenantId', async (req, res) => {
  try {
    const tenantId = req.params.tenantId?.toLowerCase();
    const payload = req.body || {};
    const schemaResult = validateTenantConfigSchema(payload, false);
    if (!schemaResult.valid) {
      return res.status(400).json({ error: 'Validation failed', details: schemaResult.errors });
    }

    const current = await Tenant.findOne({ tenantId }).lean();
    if (!current) return res.status(404).json({ error: 'Tenant not found' });

    const expectedVersion = getExpectedVersion(req);
    if (expectedVersion != null && (current.configVersion || 0) !== expectedVersion) {
      return res.status(409).json({
        error: 'Conflict: config was modified',
        currentVersion: current.configVersion,
      });
    }

    const merged = {
      name: payload.name !== undefined ? payload.name : current.name,
      dbUri: payload.dbUri !== undefined ? payload.dbUri : current.dbUri,
      status: payload.status !== undefined ? payload.status : current.status,
      config: { ...(current.config || {}), ...(payload.config || {}) },
    };

    const connectivity = await validateTenantConfigConnectivity(tenantId, {
      tenantId,
      dbUri: merged.dbUri,
      config: merged.config,
    });
    if (!connectivity.valid) {
      return res.status(400).json({
        error: 'Connectivity validation failed',
        details: connectivity.errors,
      });
    }

    const updated = await Tenant.findOneAndUpdate(
      { tenantId },
      {
        $set: {
          name: merged.name,
          dbUri: merged.dbUri,
          status: merged.status,
          config: merged.config,
          updatedAt: new Date(),
        },
        $inc: { configVersion: 1 },
      },
      { new: true, runValidators: true },
    ).lean();

    const nextDoc = { ...current, ...merged };
    const diff = buildConfigDiff(current, nextDoc);
    const appliedInvalidations = await onTenantConfigChanged(tenantId, diff);
    auditLog({
      tenantId,
      action: 'patch',
      configVersionBefore: current.configVersion ?? 0,
      configVersionAfter: updated.configVersion,
      requestId: getRequestId(req),
    });

    const redact = req.query.secrets !== '1';
    const out = { ...updated, appliedInvalidations };
    if (redact && out.config) out.config = redactSecrets(out.config);
    res.json(out);
  } catch (e) {
    logger.error('[admin/tenants] patch error', e);
    res.status(500).json({ error: e.message || 'Update failed' });
  }
});

/**
 * POST /api/admin/tenants/:tenantId/google-verify
 *
 * Admin-only **diagnostic** helper to hit Google/Gemini directly for a tenant.
 *
 * IMPORTANT:
 * - This route is **not** the canonical proof path for multi-tenant Google isolation.
 * - The release-gate proof is:
 *     1) PATCH /api/admin/tenants/:tenantId with raw JSON creds
 *     2) POST /ext/v2/agents/chat/google
 *     3) ext/v2 readback
 *     4) deep Mongo verification (tenant vs system DB)
 * - Treat this endpoint as a low-level runtime smoke test only; do not rely on it for production sign-off.
 */
router.post('/:tenantId/google-verify', async (req, res) => {
  const tenantId = req.params.tenantId?.toLowerCase();
  try {
    const service = getTenantConfigService();
    const tenantConfig = await service.getTenantConfig(tenantId);
    if (!tenantConfig) {
      return res.status(404).json({ error: `Tenant '${tenantId}' not found` });
    }

    const model = req.body?.model || null;
    const prompt =
      req.body?.prompt || 'Say hello from admin Google verify for this tenant.';

    const fakeReq = {
      config: req.config,
      tenantContext: { tenantId },
      body: {},
    };

    const endpointOption = {
      endpoint: 'google',
      model_parameters: {
        model,
      },
    };

    const { client } = await initializeClientWithCredentials({
      credentials: undefined,
      tenantId,
      req: fakeReq,
      res,
      endpointOption,
      overrideModel: model || undefined,
      optionsOnly: false,
    });

    const result = await client.getCompletion(
      [
        {
          role: 'user',
          content: prompt,
        },
      ],
      {},
    );

    const text = typeof result === 'string' ? result : result?.text ?? null;

    return res.status(200).json({
      ok: true,
      tenantId,
      model: model || endpointOption.model_parameters.model,
      text,
    });
  } catch (e) {
    logger.error(
      `[admin/tenants] google-verify error for tenant '${tenantId}':`,
      e?.message || e,
    );
    return res.status(500).json({
      ok: false,
      error: 'Google verification failed',
      detail: e?.message || String(e),
    });
  }
});

/** DELETE /api/admin/tenants/:tenantId — soft delete */
router.delete('/:tenantId', async (req, res) => {
  try {
    const tenantId = req.params.tenantId?.toLowerCase();
    const updated = await Tenant.findOneAndUpdate(
      { tenantId },
      { $set: { status: 'deleted', updatedAt: new Date() } },
      { new: true },
    );
    if (!updated) return res.status(404).json({ error: 'Tenant not found' });

    const appliedInvalidations = await onTenantDeleted(tenantId);
    auditLog({
      tenantId,
      action: 'delete',
      configVersionBefore: updated.configVersion ?? undefined,
      requestId: getRequestId(req),
    });
    res.json({ ok: true, tenantId, status: 'deleted', appliedInvalidations });
  } catch (e) {
    logger.error('[admin/tenants] delete error', e);
    res.status(500).json({ error: e.message || 'Delete failed' });
  }
});

/** POST /api/admin/tenants/:tenantId/validate — validate update without persisting */
router.post('/:tenantId/validate', async (req, res) => {
  try {
    const tenantId = req.params.tenantId?.toLowerCase();
    const payload = req.body || {};
    const schemaResult = validateTenantConfigSchema(payload, false);
    if (!schemaResult.valid) {
      return res.status(400).json({ valid: false, schema: schemaResult.errors });
    }
    const current = await Tenant.findOne({ tenantId }).lean();
    if (!current) return res.status(404).json({ error: 'Tenant not found' });
    const merged = {
      dbUri: payload.dbUri !== undefined ? payload.dbUri : current.dbUri,
      config: { ...(current.config || {}), ...(payload.config || {}) },
    };
    const fullPayload = { tenantId, dbUri: merged.dbUri, config: merged.config };
    const connectivity = await validateTenantConfigConnectivity(tenantId, fullPayload);
    if (!connectivity.valid) {
      return res.status(400).json({
        valid: false,
        connectivity: connectivity.errors,
      });
    }
    res.json({ valid: true });
  } catch (e) {
    logger.error('[admin/tenants] validate (update) error', e);
    res.status(500).json({ error: e.message || 'Validation failed' });
  }
});

module.exports = router;
