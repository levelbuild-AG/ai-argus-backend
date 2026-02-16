const { sanitizeToolSchema } = require('~/server/services/start/tools');

describe('sanitizeToolSchema', () => {
  it('removes disallowed keywords and replaces exclusiveMinimum/Maximum', () => {
    const schema = {
      type: 'object',
      properties: {
        max_chars: {
          type: 'number',
          exclusiveMinimum: 0,
        },
        size: {
          type: 'number',
          exclusiveMaximum: 10,
        },
        choice: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
        },
      },
      definitions: {
        SomeType: { type: 'string' },
      },
      $ref: '#/definitions/SomeType',
    };

    const sanitized = sanitizeToolSchema(schema);

    expect(sanitized.properties.max_chars.exclusiveMinimum).toBeUndefined();
    expect(sanitized.properties.max_chars.minimum).toBe(1);

    expect(sanitized.properties.size.exclusiveMaximum).toBeUndefined();
    expect(sanitized.properties.size.maximum).toBe(9);

    expect(sanitized.properties.choice.oneOf).toBeUndefined();
    expect(sanitized.definitions).toBeUndefined();
    expect(sanitized.$ref).toBeUndefined();
  });
});
