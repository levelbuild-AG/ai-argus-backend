const { schemaToGeminiParameters } = require('@langchain/google-common');
const { ingestFilesSchema } = require('../../../../app/clients/tools/util/ingestFiles');

const hasDisallowedKeys = (value) => {
  if (Array.isArray(value)) {
    return value.some(hasDisallowedKeys);
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  const keys = Object.keys(value);
  if (
    keys.includes('exclusiveMinimum') ||
    keys.includes('exclusiveMaximum') ||
    keys.includes('oneOf') ||
    keys.includes('anyOf') ||
    keys.includes('allOf') ||
    keys.includes('$ref') ||
    keys.includes('definitions')
  ) {
    return true;
  }
  return Object.values(value).some(hasDisallowedKeys);
};

describe('schemaToGeminiParameters', () => {
  it('removes unsupported keywords from Gemini tool schemas', () => {
    const params = schemaToGeminiParameters(ingestFilesSchema);

    expect(hasDisallowedKeys(params)).toBe(false);
    expect(params.properties.max_chars.minimum).toBe(1);
  });
});
