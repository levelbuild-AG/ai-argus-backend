const CANONICAL_MARKER = '\uE202';

const ESCAPED_PUA_REGEX = /\\u(?:E20[0-6]|e20[0-6])/g;
const ESCAPED_FRAGMENT_REGEX = /\\u(?:e)?/g;
const REAL_PUA_MARKER_REGEX = /[\uE200-\uE206]/g;
const NORMALIZABLE_PUA_REGEX = /(?![\uE200-\uE206])[\uE000-\uF8FF](?=turn\d+file\d+)/g;
const JUNK_PREFIX_REGEX = /[\p{N}\p{So}\p{Sk}\s]+(?=turn\d+file\d+)/gu;
const LOOSE_MARKER_REGEX = /(^|[^\uE200-\uE206])turn(\d+)file(\d+)/g;

/**
 * Normalize file citation markers to the canonical delimiter.
 *
 * @param {string} text
 * @param {{ enableLoose?: boolean }} [options]
 * @returns {string}
 */
function canonicalizeCitationMarkers(text) {
  if (!text || typeof text !== 'string') {
    return text;
  }

  let canonicalized = text.replace(ESCAPED_PUA_REGEX, (match) => {
    const hex = match.slice(2);
    return String.fromCharCode(parseInt(hex, 16));
  });

  const hasRealPua = /[\uE200-\uE206]/.test(canonicalized);
  const hasEscapedFragment = /\\u(?:e)?/.test(canonicalized);
  if (hasRealPua && hasEscapedFragment) {
    canonicalized = canonicalized.replace(ESCAPED_FRAGMENT_REGEX, '');
  }

  return canonicalized;
}

function normalizeCitationMarkers(text, options = {}) {
  if (!text || typeof text !== 'string') {
    return text;
  }

  const { enableLoose = false } = options;
  let normalized = canonicalizeCitationMarkers(text);
  normalized = normalized.replace(NORMALIZABLE_PUA_REGEX, CANONICAL_MARKER);
  normalized = normalized.replace(JUNK_PREFIX_REGEX, CANONICAL_MARKER);
  normalized = normalized.replace(/\uE202\s*(turn\d+file\d+)/g, `${CANONICAL_MARKER}$1`);

  if (enableLoose) {
    normalized = normalized.replace(LOOSE_MARKER_REGEX, (match, prefix, turn, file) => {
      return `${prefix}${CANONICAL_MARKER}turn${turn}file${file}`;
    });
  }

  return normalized;
}

/**
 * Normalize citations in message text and text content parts.
 *
 * @param {object} message
 * @param {{ enableLoose?: boolean }} [options]
 */
function normalizeMessageCitations(message, options = {}) {
  if (!message || typeof message !== 'object') {
    return;
  }

  if (typeof message.text === 'string') {
    message.text = normalizeCitationMarkers(message.text, options);
  }

  if (Array.isArray(message.content)) {
    message.content = message.content.map((part) => {
      if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
        return { ...part, text: normalizeCitationMarkers(part.text, options) };
      }
      return part;
    });
  }
}

/**
 * Normalize a streaming delta with a tail buffer to handle split markers.
 *
 * @param {object} params
 * @param {string} params.deltaText
 * @param {string} params.buffer
 * @param {boolean} params.enableLoose
 * @param {number} [params.tailSize=64]
 * @returns {{ emitText: string, buffer: string }}
 */
function normalizeCitationStreamDelta({ deltaText, buffer, enableLoose, tailSize = 64 }) {
  if (typeof deltaText !== 'string') {
    return { emitText: deltaText, buffer: buffer || '' };
  }

  if (!enableLoose) {
    const combined = `${buffer || ''}${deltaText}`;
    const nextBuffer = tailSize > 0 ? combined.slice(-tailSize) : '';
    return { emitText: deltaText, buffer: nextBuffer };
  }

  const combined = `${buffer || ''}${deltaText}`;
  const normalized = normalizeCitationMarkers(combined, { enableLoose: true });
  if (tailSize <= 0) {
    return { emitText: normalized, buffer: '' };
  }
  if (normalized.length <= tailSize) {
    return { emitText: '', buffer: normalized };
  }
  const emitText = normalized.slice(0, normalized.length - tailSize);
  const nextBuffer = normalized.slice(-tailSize);
  return { emitText, buffer: nextBuffer };
}

/**
 * Determine if loose file citation normalization should be enabled.
 *
 * @param {object} params
 * @param {Array<object>} [params.attachments]
 * @returns {boolean}
 */
function shouldEnableLooseFileCitations({ attachments } = {}) {
  if (!Array.isArray(attachments)) {
    return false;
  }
  return attachments.some((attachment) => {
    const sources = attachment?.file_search?.sources;
    return Array.isArray(sources) && sources.length > 0;
  });
}

module.exports = {
  canonicalizeCitationMarkers,
  normalizeCitationMarkers,
  normalizeMessageCitations,
  shouldEnableLooseFileCitations,
  normalizeCitationStreamDelta,
  CANONICAL_MARKER,
};