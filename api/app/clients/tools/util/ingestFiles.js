const { z } = require('zod');
const axios = require('axios');
const { tool } = require('@langchain/core/tools');
const { logger } = require('@librechat/data-schemas');
const { generateShortLivedToken } = require('@librechat/api');
const { Tools } = require('librechat-data-provider');
const { getRagApiHeaders } = require('~/server/utils/ragApiClient');

const MAX_INGEST_CHARS = 20000;
const ERROR_DETAIL_LIMIT = 200;

const buildRagUrl = (fileId) => `${process.env.RAG_API_URL}/documents/${fileId}/context`;

const redactRagUrl = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch (error) {
    return url;
  }
};

const formatDetails = (value) => {
  if (value == null) {
    return undefined;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.slice(0, ERROR_DETAIL_LIMIT);
};

const resolveRagErrorCode = (status, details) => {
  if (status === 404) {
    const normalized = (details || '').toLowerCase();
    if (normalized.includes('embed')) {
      return 'NOT_EMBEDDED';
    }
    return 'RAG_404';
  }
  if (status === 401 || status === 403) {
    return 'RAG_401_403';
  }
  if (status >= 500) {
    return 'RAG_5XX';
  }
  return 'RAG_INVALID_RESPONSE';
};

const normalizeMaxChars = (maxChars) => {
  if (maxChars == null) {
    return undefined;
  }
  const parsed = Number(maxChars);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const bounded = Math.max(1, Math.floor(parsed));
  return Math.min(bounded, MAX_INGEST_CHARS);
};

const normalizeFilename = (name) => {
  if (!name || typeof name !== 'string') {
    return '';
  }
  return name
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^\p{L}\p{N}.\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const getExtension = (name) => {
  const match = /\.([^.\s]+)$/.exec(name);
  return match ? match[1].toLowerCase() : '';
};

const levenshteinDistance = (a, b) => {
  if (a === b) {
    return 0;
  }
  if (!a.length) {
    return b.length;
  }
  if (!b.length) {
    return a.length;
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) {
    dp[i][0] = i;
  }
  for (let j = 0; j <= b.length; j += 1) {
    dp[0][j] = j;
  }
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[a.length][b.length];
};

const scoreFilenameMatch = (requested, candidate) => {
  const normalizedRequested = normalizeFilename(requested);
  const normalizedCandidate = normalizeFilename(candidate);
  if (!normalizedRequested || !normalizedCandidate) {
    return 0;
  }
  if (normalizedRequested === normalizedCandidate) {
    return 1;
  }
  const extRequested = getExtension(normalizedRequested);
  const extCandidate = getExtension(normalizedCandidate);
  const extensionBoost = extRequested && extCandidate && extRequested === extCandidate ? 0.1 : 0;
  const containsBoost =
    normalizedCandidate.includes(normalizedRequested) ||
    normalizedRequested.includes(normalizedCandidate)
      ? 0.15
      : 0;
  const distance = levenshteinDistance(normalizedRequested, normalizedCandidate);
  const maxLen = Math.max(normalizedRequested.length, normalizedCandidate.length, 1);
  const similarity = 1 - distance / maxLen;
  return Math.max(0, Math.min(1, similarity + extensionBoost + containsBoost));
};

const resolveFilenameMatches = ({ requestedNames, files }) => {
  const results = [];
  const suggestions = {};
  const fileList = Array.isArray(files) ? files : [];
  const suggestionThreshold = 0.5;

  for (const requestedName of requestedNames) {
    const normalizedRequested = normalizeFilename(requestedName);
    const exactMatch = fileList.find(
      (file) => normalizeFilename(file?.filename || '') === normalizedRequested,
    );
    if (exactMatch) {
      results.push(exactMatch);
      continue;
    }

    const scored = fileList
      .map((file) => ({
        file,
        score: scoreFilenameMatch(requestedName, file?.filename || ''),
      }))
      .filter((entry) => entry.score >= suggestionThreshold)
      .sort((a, b) => b.score - a.score);

    if (!scored.length) {
      suggestions[requestedName] = [];
      continue;
    }

    suggestions[requestedName] = scored.slice(0, 3).map((entry) => entry.file?.filename).filter(Boolean);
  }

  return { resolved: results, suggestions };
};

const formatSuggestionMessage = ({ requestedNames, suggestions, availableNames }) => {
  const lines = requestedNames.map((name) => {
    const matches = suggestions[name] || [];
    if (matches.length === 1) {
      return `File "${name}" not found. Did you mean "${matches[0]}"?`;
    }
    if (matches.length > 1) {
      return `File "${name}" not found. Did you mean one of: ${matches.map((m) => `"${m}"`).join(', ')}?`;
    }
    return `File "${name}" not found.`;
  });
  if (availableNames.length) {
    lines.push(`Available files: ${availableNames.map((name) => `"${name}"`).join(', ')}`);
  }
  return lines.join(' ');
};

/**
 * @param {Object} options
 * @param {string} options.userId
 * @param {Array<{ file_id: string; filename: string }>} options.files
 * @returns {Promise<import('@langchain/core/tools').Tool>}
 */
const ingestFilesSchema = z
  .object({
    file_ids: z
      .array(z.string())
      .min(1)
      .optional()
      .describe('List of file IDs to ingest and return context for.'),
    scope: z
      .enum(['conversation', 'message'])
      .optional()
      .describe('Scope used to resolve files when file_ids are not provided.'),
    select: z
      .enum(['all', 'indices', 'filenames'])
      .optional()
      .describe('Selection strategy for resolving files when file_ids are not provided.'),
    indices: z
      .array(z.number().int().min(0))
      .optional()
      .describe('Zero-based indices into the available file list.'),
    filenames: z
      .preprocess((value) => {
        if (typeof value === 'string') {
          return [value];
        }
        return value;
      }, z.array(z.string()))
      .optional()
      .describe('Exact filenames to match from the available file list.'),
    filename: z
      .string()
      .optional()
      .describe('Single filename to match from the available file list.'),
    max_chars: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(`Optional maximum number of characters to return per file (max ${MAX_INGEST_CHARS}).`),
  })
  .refine((value) => {
    if (value.file_ids && value.file_ids.length > 0) {
      return true;
    }
    if (value.filename && value.filename.length > 0) {
      return true;
    }
    if (value.filenames && value.filenames.length > 0) {
      return true;
    }
    if (value.select === 'all') {
      return true;
    }
    if (value.select === 'indices' && value.indices?.length) {
      return true;
    }
    if (value.select === 'filenames' && value.filenames?.length) {
      return true;
    }
    return false;
  }, 'Provide file_ids or a valid select/indices/filenames combination.');

const resolveRequestedIds = ({ file_ids, select, indices, filenames, files }) => {
  if (Array.isArray(file_ids) && file_ids.length > 0) {
    return file_ids;
  }

  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  if (select === 'all') {
    return files.map((file) => file.file_id).filter(Boolean);
  }

  if (select === 'indices' && Array.isArray(indices)) {
    return indices
      .map((index) => files[index]?.file_id)
      .filter(Boolean);
  }

  if (select === 'filenames' && Array.isArray(filenames)) {
    const desired = new Set(filenames.map((name) => name.trim()).filter(Boolean));
    return files
      .filter((file) => desired.has(file.filename))
      .map((file) => file.file_id)
      .filter(Boolean);
  }

  return [];
};

const createIngestFilesTool = async ({ userId, files, tenantId }) => {
  return tool(
    async ({ file_ids, max_chars, scope, select, indices, filenames, filename }) => {
      if (!files || files.length === 0) {
        return ['No files are available for ingestion. Request the user to upload documents.', undefined];
      }

      const jwtToken = generateShortLivedToken(userId);
      if (!jwtToken) {
        return ['There was an error authenticating the file ingestion request.', undefined];
      }

      // Build headers with tenant ID if available
      const headers = {
        Authorization: `Bearer ${jwtToken}`,
      };
      if (tenantId) {
        headers['X-Tenant-ID'] = tenantId;
      }

      const maxChars = normalizeMaxChars(max_chars);
      const availableFiles = new Map();
      for (const file of files) {
        if (file?.file_id) {
          availableFiles.set(file.file_id, file);
        }
        if (file?.temp_file_id) {
          availableFiles.set(file.temp_file_id, file);
        }
        if (file?.metadata?.fileIdentifier) {
          availableFiles.set(file.metadata.fileIdentifier, file);
        }
      }

      const nameInputs = [filename, ...(Array.isArray(filenames) ? filenames : [])]
        .map((name) => (typeof name === 'string' ? name.trim() : ''))
        .filter(Boolean);

      if (nameInputs.length > 0 && (!file_ids || file_ids.length === 0)) {
        const { resolved, suggestions } = resolveFilenameMatches({
          requestedNames: nameInputs,
          files,
        });
        if (!resolved.length) {
          const availableNames = (files || []).map((file) => file?.filename).filter(Boolean);
          return [
            formatSuggestionMessage({
              requestedNames: nameInputs,
              suggestions,
              availableNames,
            }),
            undefined,
          ];
        }
        file_ids = resolved.map((file) => file.file_id).filter(Boolean);
      }

      const requestedIds = resolveRequestedIds({
        file_ids,
        select,
        indices,
        filenames,
        files,
      });

      const filteredRequestedIds = requestedIds.filter((rawId) => {
        const fileId = typeof rawId === 'string' ? rawId.trim() : '';
        return fileId && availableFiles.has(fileId);
      });

      if (requestedIds.length === 0) {
        return ['No file IDs provided for ingestion.', undefined];
      }

      if (filteredRequestedIds.length === 0) {
        return ['No available files to ingest. Request the user to upload documents.', undefined];
      }

      const results = await Promise.all(
        filteredRequestedIds.map(async (rawId) => {
          const fileId = typeof rawId === 'string' ? rawId.trim() : '';
          if (!fileId) {
            return {
              file_id: typeof rawId === 'string' ? rawId : String(rawId ?? ''),
              error: 'Invalid file_id provided.',
              error_code: 'FILE_NOT_FOUND',
            };
          }

          const file = availableFiles.get(fileId);
          if (!file) {
            return {
              file_id: fileId,
              error: 'File not available for ingestion.',
              error_code: 'FILE_NOT_FOUND',
              resolved_file_id_used_for_rag: fileId,
            };
          }

          const ragUrl = buildRagUrl(fileId);
          const resolvedId = file?.file_id || fileId;

          try {
            const response = await axios.get(
              buildRagUrl(resolvedId),
              {
                headers,
                params: maxChars ? { max_chars: maxChars } : undefined,
              },
            );

            if (response.data == null) {
              return {
                file_id: fileId,
                filename: file.filename,
                error: 'File not available for ingestion.',
                error_code: 'RAG_INVALID_RESPONSE',
                http_status: response.status,
                rag_url: redactRagUrl(buildRagUrl(resolvedId)),
                details: 'Empty response body',
                resolved_file_id_used_for_rag: resolvedId,
                file_metadata_identifier: file?.metadata?.fileIdentifier,
                file_temp_id: file?.temp_file_id,
              };
            }

            const context = typeof response.data === 'string'
              ? response.data
              : JSON.stringify(response.data);
            const charCount = context.length;
            const truncated = maxChars != null ? charCount >= maxChars : false;

            return {
              file_id: fileId,
              filename: file.filename,
              context,
              truncated,
              char_count: charCount,
              resolved_file_id_used_for_rag: resolvedId,
              file_metadata_identifier: file?.metadata?.fileIdentifier,
              file_temp_id: file?.temp_file_id,
            };
          } catch (error) {
            const status = error?.response?.status;
            const details = formatDetails(error?.response?.data || error?.message);
            const errorCode = resolveRagErrorCode(status, details);
            logger.error('[ingest_files] Error fetching file context:', error);
            return {
              file_id: fileId,
              filename: file.filename,
              error: 'File not available for ingestion.',
              error_code: errorCode,
              http_status: status,
              rag_url: redactRagUrl(buildRagUrl(resolvedId)),
              details,
              truncated: false,
              char_count: 0,
              resolved_file_id_used_for_rag: resolvedId,
              file_metadata_identifier: file?.metadata?.fileIdentifier,
              file_temp_id: file?.temp_file_id,
            };
          }
        }),
      );

      const formattedString = results
        .map((result) => {
          const label = result.filename ? `${result.filename} (${result.file_id})` : result.file_id;
          if (result.error) {
            return `File: ${label}\nError: ${result.error}`;
          }
          return `File: ${label}\nContext:\n${result.context}`;
        })
        .join('\n---\n');

      return [
        formattedString,
        {
          [Tools.ingest_files]: {
            files: results,
            max_chars: maxChars,
          },
        },
      ];
    },
    {
      name: Tools.ingest_files,
      responseFormat: 'content_and_artifact',
      description:
        'Fetches full or truncated context for selected files. Provide file IDs to retrieve extracted content for each file. Use this when you need the raw document context for specific files instead of semantic search.',
      schema: ingestFilesSchema,
    },
  );
};

module.exports = { createIngestFilesTool, ingestFilesSchema, MAX_INGEST_CHARS };
