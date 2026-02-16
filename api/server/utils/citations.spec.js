const {
  normalizeCitationMarkers,
  normalizeMessageCitations,
  shouldEnableLooseFileCitations,
  normalizeCitationStreamDelta,
  CANONICAL_MARKER,
  canonicalizeCitationMarkers,
} = require('./citations');

describe('normalizeCitationMarkers', () => {
  it('normalizes PUA marker variants to canonical', () => {
    const input = `Example \uEE02turn0file0`;
    const output = normalizeCitationMarkers(input, { enableLoose: true });
    expect(output).toBe(`Example ${CANONICAL_MARKER}turn0file0`);
  });

  it('normalizes escaped canonical markers without hybrid prefix', () => {
    const input = 'Example \\ue202turn0file0';
    const output = normalizeCitationMarkers(input, { enableLoose: true });
    expect(output).toBe(`Example ${CANONICAL_MARKER}turn0file0`);
    expect(output).not.toContain('\\ue');
  });

  it('canonicalizes escaped PUA markers', () => {
    const input = 'Example \\ue203text\\ue204';
    const output = canonicalizeCitationMarkers(input);
    expect(output).toBe('Example \uE203text\uE204');
  });

  it('collapses hybrid escaped fragments with real markers', () => {
    const input = `Example \\ue${CANONICAL_MARKER}turn0file0`;
    const output = canonicalizeCitationMarkers(input);
    expect(output).toBe(`Example ${CANONICAL_MARKER}turn0file0`);
  });

  it('preserves canonical markers as-is', () => {
    const input = `Example ${CANONICAL_MARKER}turn0file0`;
    const output = normalizeCitationMarkers(input, { enableLoose: true });
    expect(output).toBe(`Example ${CANONICAL_MARKER}turn0file0`);
  });

  it('preserves composite markers', () => {
    const composite = `Example \uE200turn0file0\uE201`;
    const output = normalizeCitationMarkers(composite, { enableLoose: true });
    expect(output).toBe(composite);
  });

  it('never outputs both escaped and real markers', () => {
    const input = `Example \\ue${CANONICAL_MARKER}turn0file0`;
    const output = normalizeCitationMarkers(input, { enableLoose: true });
    expect(output).not.toMatch(/\\ue/);
    expect(output).toMatch(/[\uE200-\uE206]/);
  });

  it('normalizes junk prefix variants to canonical', () => {
    const input = 'Example \uEE02turn0file0 and \u09E6\u09E8turn1file2';
    const output = normalizeCitationMarkers(input, { enableLoose: true });
    expect(output).toBe(`Example ${CANONICAL_MARKER}turn0file0 and${CANONICAL_MARKER}turn1file2`);
  });

  it('normalizes raw turn tokens when enabled', () => {
    const input = 'Example turn0file0';
    const output = normalizeCitationMarkers(input, { enableLoose: true });
    expect(output).toBe(`Example${CANONICAL_MARKER}turn0file0`);
  });

  it('leaves raw turn tokens when disabled', () => {
    const input = 'Example turn0file0';
    const output = normalizeCitationMarkers(input, { enableLoose: false });
    expect(output).toBe(`Example${CANONICAL_MARKER}turn0file0`);
  });

  it('preserves canonical markers across split deltas', () => {
    const combined = `Example ${CANONICAL_MARKER}turn0file` + '0';
    const output = normalizeCitationMarkers(combined, { enableLoose: true });
    expect(output).toBe(`Example ${CANONICAL_MARKER}turn0file0`);
  });

  it('enables loose normalization only when file_search sources exist', () => {
    const message = { text: 'Example turn0file0' };
    const attachments = [
      { file_search: { sources: [{ fileId: 'file-1', fileName: 'doc.txt' }] } },
    ];
    const enableLoose = shouldEnableLooseFileCitations({ attachments });
    normalizeMessageCitations(message, { enableLoose });
    expect(message.text).toBe(`Example${CANONICAL_MARKER}turn0file0`);
  });

  it('skips loose normalization when file_search sources are absent', () => {
    const message = { text: 'Example turn0file0' };
    const attachments = [{ web_search: { organic: [] } }];
    const enableLoose = shouldEnableLooseFileCitations({ attachments });
    normalizeMessageCitations(message, { enableLoose });
    expect(message.text).toBe(`Example${CANONICAL_MARKER}turn0file0`);
  });

  it('normalizes streaming deltas with split markers', () => {
    const first = normalizeCitationStreamDelta({
      deltaText: `Anchor: ${CANONICAL_MARKER}turn0fi`,
      buffer: '',
      enableLoose: true,
      tailSize: 4,
    });
    const second = normalizeCitationStreamDelta({
      deltaText: 'le0',
      buffer: first.buffer,
      enableLoose: true,
      tailSize: 4,
    });
    const combined = `${first.emitText}${second.emitText}${second.buffer}`;
    expect(combined).toContain(`${CANONICAL_MARKER}turn0file0`);
  });

  it('normalizes streaming deltas with junk prefixes', () => {
    const result = normalizeCitationStreamDelta({
      deltaText: 'Example \u09E6\u09E8turn0file0',
      buffer: '',
      enableLoose: true,
      tailSize: 0,
    });
    expect(result.emitText).toBe(`Example${CANONICAL_MARKER}turn0file0`);
  });
});