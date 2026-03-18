/**
 * Tier 1: Schema validation for tenant config (create/update).
 * Validates shape and required fields. Does not check connectivity.
 * @param {Object} payload - Raw body for tenant create/update
 * @param {boolean} isCreate - If true, tenantId and dbUri are required
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateTenantConfigSchema(payload, isCreate = false) {
  const errors = [];

  if (!payload || typeof payload !== 'object') {
    return { valid: false, errors: ['Payload must be an object'] };
  }

  if (isCreate) {
    if (!payload.tenantId || typeof payload.tenantId !== 'string') {
      errors.push('tenantId is required and must be a string');
    } else {
      const normalized = payload.tenantId.trim().toLowerCase();
      if (normalized !== payload.tenantId.trim()) {
        errors.push('tenantId must be lowercase');
      }
      if (!/^[a-z0-9_-]+$/.test(payload.tenantId.trim())) {
        errors.push('tenantId may only contain lowercase letters, numbers, underscore, hyphen');
      }
    }
    if (!payload.dbUri || typeof payload.dbUri !== 'string') {
      errors.push('dbUri is required and must be a string');
    }
  }

  if (payload.status !== undefined) {
    const allowed = ['active', 'suspended', 'deleted'];
    if (!allowed.includes(payload.status)) {
      errors.push(`status must be one of: ${allowed.join(', ')}`);
    }
  }

  if (payload.config !== undefined) {
    if (typeof payload.config !== 'object' || payload.config === null || Array.isArray(payload.config)) {
      errors.push('config must be an object');
    } else {
      const c = payload.config;
      if (c.rag !== undefined && (typeof c.rag !== 'object' || c.rag === null)) {
        errors.push('config.rag must be an object');
      }
      if (c.rag?.postgresUri !== undefined && typeof c.rag.postgresUri !== 'string') {
        errors.push('config.rag.postgresUri must be a string');
      }
      if (c.storage !== undefined && (typeof c.storage !== 'object' || c.storage === null)) {
        errors.push('config.storage must be an object');
      } else if (c.storage && typeof c.storage === 'object') {
        const allowedProviders = ['s3', 'local', 'firebase', 'azure_blob'];
        if (c.storage.provider !== undefined && !allowedProviders.includes(c.storage.provider)) {
          errors.push(`config.storage.provider must be one of: ${allowedProviders.join(', ')}`);
        }
        if (c.storage.provider === 's3' && c.storage.bucket !== undefined && typeof c.storage.bucket !== 'string') {
          errors.push('config.storage.bucket must be a string when provider is s3');
        }
        if (c.storage.provider === 'azure_blob' && c.storage.container !== undefined && typeof c.storage.container !== 'string') {
          errors.push('config.storage.container must be a string when provider is azure_blob');
        }
        if (c.storage.provider === 'local' && c.storage.basePath !== undefined && typeof c.storage.basePath !== 'string') {
          errors.push('config.storage.basePath must be a string when provider is local');
        }
      }
      if (c.bedrock !== undefined && c.bedrock !== null) {
        if (typeof c.bedrock !== 'object' || Array.isArray(c.bedrock)) {
          errors.push('config.bedrock must be an object');
        } else {
          const b = c.bedrock;
          if (b.accessKeyId !== undefined && typeof b.accessKeyId !== 'string') errors.push('config.bedrock.accessKeyId must be a string');
          if (b.secretAccessKey !== undefined && typeof b.secretAccessKey !== 'string') errors.push('config.bedrock.secretAccessKey must be a string');
          if (b.region !== undefined && typeof b.region !== 'string') errors.push('config.bedrock.region must be a string');
        }
      }
      if (c.customEndpoints !== undefined && c.customEndpoints !== null) {
        if (typeof c.customEndpoints !== 'object' || Array.isArray(c.customEndpoints)) {
          errors.push('config.customEndpoints must be an object');
        } else {
          for (const [endpointId, cfg] of Object.entries(c.customEndpoints)) {
            if (cfg == null || typeof cfg !== 'object') continue;
            if (cfg.baseURL !== undefined) {
              const u = String(cfg.baseURL);
              if (!u.startsWith('http://') && !u.startsWith('https://')) {
                errors.push(`config.customEndpoints.${endpointId}.baseURL must be http or https URL`);
              }
            }
            if (cfg.apiKey !== undefined && typeof cfg.apiKey !== 'string') {
              errors.push(`config.customEndpoints.${endpointId}.apiKey must be a string`);
            }
            if (cfg.headers !== undefined && (typeof cfg.headers !== 'object' || cfg.headers === null || Array.isArray(cfg.headers))) {
              errors.push(`config.customEndpoints.${endpointId}.headers must be an object`);
            } else if (cfg.headers && typeof cfg.headers === 'object') {
              for (const [k, v] of Object.entries(cfg.headers)) {
                if (typeof v !== 'string') errors.push(`config.customEndpoints.${endpointId}.headers.${k} must be a string`);
              }
            }
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = { validateTenantConfigSchema };
