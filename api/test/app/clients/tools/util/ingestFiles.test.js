const axios = require('axios');

jest.mock('axios');
jest.mock('@librechat/api', () => ({
  generateShortLivedToken: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { createIngestFilesTool, ingestFilesSchema } = require('~/app/clients/tools/util/ingestFiles');
const { generateShortLivedToken } = require('@librechat/api');

describe('ingestFiles.js - filename resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RAG_API_URL = 'http://localhost:8000';
  });

  it('resolves single filename to file_id', async () => {
    generateShortLivedToken.mockReturnValue('mock-jwt-token');
    axios.get.mockResolvedValue({ data: 'File content' });

    const ingestTool = await createIngestFilesTool({
      userId: 'user1',
      files: [{ file_id: 'file-1', filename: 'ingest.txt' }],
    });

    const result = await ingestTool.func({ filename: 'ingest.txt', max_chars: 200 });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);

    const [formattedString, artifact] = result;
    expect(formattedString).toContain('File: ingest.txt (file-1)');
    expect(artifact).toBeDefined();
    const ingestArtifact = Object.values(artifact)[0];
    expect(ingestArtifact).toHaveProperty('files');
    expect(ingestArtifact.files[0]).toMatchObject({
      file_id: 'file-1',
      filename: 'ingest.txt',
    });

    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenCalledWith(
      'http://localhost:8000/documents/file-1/context',
      expect.any(Object),
    );
  });

  it('accepts filenames in schema validation', () => {
    const result = ingestFilesSchema.safeParse({ filenames: ['TriggerGuidlines.docx'] });
    expect(result.success).toBe(true);
  });

  it('returns suggestions when filename is not found', async () => {
    generateShortLivedToken.mockReturnValue('mock-jwt-token');

    const ingestTool = await createIngestFilesTool({
      userId: 'user1',
      files: [{ file_id: 'file-1', filename: 'ingest.txt' }],
    });

    const result = await ingestTool.func({ filename: 'ingstt.txt' });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('Did you mean');
    expect(result[0]).toContain('ingest.txt');
    expect(result[1]).toBeUndefined();
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('suggests closest filename for misspelling and lists available files', async () => {
    generateShortLivedToken.mockReturnValue('mock-jwt-token');

    const ingestTool = await createIngestFilesTool({
      userId: 'user1',
      files: [
        { file_id: 'file-1', filename: 'Trigger Guidelines.docx' },
        { file_id: 'file-2', filename: 'Other.docx' },
      ],
    });

    const result = await ingestTool.func({ filenames: ['TriggerGuidlines.docx'] });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('Did you mean "Trigger Guidelines.docx"');
    expect(result[0]).toContain('Available files: "Trigger Guidelines.docx", "Other.docx"');
    expect(result[1]).toBeUndefined();
  });

  it('returns not found with available list when no suggestions', async () => {
    generateShortLivedToken.mockReturnValue('mock-jwt-token');

    const ingestTool = await createIngestFilesTool({
      userId: 'user1',
      files: [
        { file_id: 'file-1', filename: 'Trigger Guidelines.docx' },
        { file_id: 'file-2', filename: 'Other.docx' },
      ],
    });

    const result = await ingestTool.func({ filenames: ['Nonexistent.docx'] });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('File "Nonexistent.docx" not found.');
    expect(result[0]).toContain('Available files: "Trigger Guidelines.docx", "Other.docx"');
    expect(result[1]).toBeUndefined();
  });
});
