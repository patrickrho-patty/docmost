import { FastifyReply } from 'fastify';

/**
 * Shared streaming helpers for the AI endpoints (answers + chat).
 *
 * The upstream provider streams SSE `data:` frames with OpenAI-style
 * `choices[0].delta.content`; MiniMax-M3 additionally emits reasoning as
 * inline `<think>…</think>` tags, which ThinkTagFilter strips.
 */

export interface SseStream {
  emit: (obj: Record<string, unknown>) => void;
  readonly closed: boolean;
  /** Wire client-disconnect detection to an AbortController. */
  bindAbort: (controller: AbortController) => void;
  close: () => void;
}

/** Initialize a Fastify reply as an SSE stream. */
export function initSseResponse(res: FastifyReply): SseStream {
  const raw = res.raw;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  raw.on('close', () => {
    closed = true;
  });

  return {
    emit(obj) {
      if (closed || raw.destroyed) return;
      raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    },
    get closed() {
      return closed || raw.destroyed;
    },
    bindAbort(controller: AbortController) {
      raw.on('close', () => {
        if (!controller.signal.aborted) controller.abort();
      });
    },
    close() {
      if (closed || raw.destroyed) return;
      closed = true;
      raw.write('data: [DONE]\n\n');
      raw.end();
    },
  };
}

/**
 * Consume an upstream SSE completion stream, forwarding visible
 * (think-filtered) text deltas to `onDelta`. Returns the full visible text.
 */
export async function streamCompletionDeltas(
  response: Response,
  onDelta: (text: string) => void,
): Promise<string> {
  const filter = new ThinkTagFilter();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        // reasoning_content (separate channel) is intentionally ignored
        const content: string | undefined =
          parsed?.choices?.[0]?.delta?.content;
        if (!content) continue;
        const visible = filter.push(content);
        if (visible) {
          fullText += visible;
          onDelta(visible);
        }
      } catch {
        // skip malformed frame
      }
    }
  }

  const tail = filter.flush();
  if (tail) {
    fullText += tail;
    onDelta(tail);
  }
  return fullText;
}

/**
 * Strips `<think>…</think>` regions from a streamed token sequence,
 * handling tags split across chunk boundaries. Text inside think blocks
 * (the model's chain-of-thought) is never forwarded.
 */
export class ThinkTagFilter {
  private insideThink = false;
  private buffer = '';
  private static readonly OPEN = '<think>';
  private static readonly CLOSE = '</think>';

  push(text: string): string {
    this.buffer += text;
    let out = '';

    for (;;) {
      if (this.insideThink) {
        const idx = this.buffer.indexOf(ThinkTagFilter.CLOSE);
        if (idx === -1) {
          // keep a holdback in case the close tag is split across chunks
          const hold = this.longestTagSuffix(this.buffer, ThinkTagFilter.CLOSE);
          this.buffer = this.buffer.slice(this.buffer.length - hold);
          break;
        }
        this.buffer = this.buffer.slice(idx + ThinkTagFilter.CLOSE.length);
        this.insideThink = false;
      } else {
        const idx = this.buffer.indexOf(ThinkTagFilter.OPEN);
        if (idx === -1) {
          const hold = this.longestTagSuffix(this.buffer, ThinkTagFilter.OPEN);
          out += this.buffer.slice(0, this.buffer.length - hold);
          this.buffer = this.buffer.slice(this.buffer.length - hold);
          break;
        }
        out += this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + ThinkTagFilter.OPEN.length);
        this.insideThink = true;
      }
    }

    return out;
  }

  flush(): string {
    const out = this.insideThink ? '' : this.buffer;
    this.buffer = '';
    return out;
  }

  /** Length of the longest suffix of `s` that is a prefix of `tag`. */
  private longestTagSuffix(s: string, tag: string): number {
    const max = Math.min(s.length, tag.length - 1);
    for (let len = max; len > 0; len--) {
      if (s.endsWith(tag.slice(0, len))) return len;
    }
    return 0;
  }
}
