/**
 * PAT-2330: text chunking for page embeddings.
 *
 * Paragraph/heading-aware packing: split on blank lines, greedily pack blocks
 * into chunks up to `maxChars`. Oversized single blocks are hard-split with a
 * character overlap so sentences spanning a split survive in both chunks.
 * Returns the chunk text plus its offset in the source (for citation/excerpt
 * bookkeeping alongside the stored `content`).
 */

export interface TextChunk {
  text: string;
  start: number;
  length: number;
}

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
}

const DEFAULT_MAX_CHARS = 2000; // ~500 tokens EN, comfortably within bge-m3 context
const DEFAULT_OVERLAP_CHARS = 200;

export function chunkText(input: string, opts?: ChunkOptions): TextChunk[] {
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = opts?.overlapChars ?? DEFAULT_OVERLAP_CHARS;

  const text = (input ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  if (text.length <= maxChars) {
    return [{ text, start: 0, length: text.length }];
  }

  // split into blocks, tracking offsets in the original text
  const blocks: { text: string; start: number }[] = [];
  const re = /\n{2,}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const block = text.slice(last, m.index).trim();
    if (block) blocks.push({ text: block, start: last });
    last = m.index + m[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail) blocks.push({ text: tail, start: last });

  const chunks: TextChunk[] = [];
  let current = '';
  let currentStart = 0;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) {
      chunks.push({
        text: trimmed,
        start: currentStart,
        length: trimmed.length,
      });
    }
    current = '';
  };

  for (const block of blocks) {
    if (block.text.length > maxChars) {
      // hard-split oversized block with overlap
      flush();
      let start = 0;
      while (start < block.text.length) {
        const end = Math.min(start + maxChars, block.text.length);
        const piece = block.text.slice(start, end).trim();
        if (piece) {
          chunks.push({
            text: piece,
            start: block.start + start,
            length: piece.length,
          });
        }
        if (end === block.text.length) break;
        start = end - overlapChars;
      }
      continue;
    }

    const candidate = current ? `${current}\n\n${block.text}` : block.text;
    if (candidate.length > maxChars) {
      flush();
      current = block.text;
      currentStart = block.start;
    } else {
      if (!current) currentStart = block.start;
      current = candidate;
    }
  }
  flush();

  return chunks;
}
