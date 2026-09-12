import { chunkText } from './chunking.util';

describe('chunkText', () => {
  it('returns empty for blank input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('returns a single chunk for short text', () => {
    const chunks = chunkText('hello world');
    expect(chunks).toEqual([{ text: 'hello world', start: 0, length: 11 }]);
  });

  it('packs paragraphs up to maxChars', () => {
    const text = ['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60)].join('\n\n');
    const chunks = chunkText(text, { maxChars: 140 });
    // 60+2+60=122 fits; adding c (2+60) would exceed 140
    expect(chunks.length).toBe(2);
    expect(chunks[0].text).toContain('a'.repeat(60));
    expect(chunks[0].text).toContain('b'.repeat(60));
    expect(chunks[1].text).toBe('c'.repeat(60));
  });

  it('hard-splits an oversized block with overlap', () => {
    const text = 'x'.repeat(300);
    const chunks = chunkText(text, { maxChars: 100, overlapChars: 20 });
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    // consecutive chunks overlap by ~20 chars
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = chunks[i - 1].text.slice(-20);
      expect(chunks[i].text.startsWith(prevTail.slice(0, 10))).toBe(true);
    }
    // full coverage: offsets tile the source
    expect(chunks[0].start).toBe(0);
    expect(chunks[chunks.length - 1].start + chunks[chunks.length - 1].length).toBe(300);
  });

  it('normalizes CRLF', () => {
    // CRLF line endings are normalized, then small blocks pack into one chunk
    const chunks = chunkText('a\r\n\r\nb');
    expect(chunks.map((c) => c.text)).toEqual(['a\n\nb']);
  });

  it('tracks offsets into the original text', () => {
    const text = 'first paragraph\n\nsecond paragraph';
    const chunks = chunkText(text, { maxChars: 20 });
    for (const c of chunks) {
      expect(text.slice(c.start, c.start + c.length)).toBe(c.text);
    }
  });
});
