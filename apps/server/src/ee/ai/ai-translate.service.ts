import { Injectable, Logger } from '@nestjs/common';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { AiProviderService } from './ai-provider.service';
import { streamCompletionDeltas } from './ai-stream.util';

export interface TranslateBlock {
  id: number;
  html: string;
}

/** Hard caps so a giant page can't run up provider cost in one click. */
const MAX_BLOCKS = 150;
const MAX_BLOCK_CHARS = 8000;
const MAX_BATCH_CHARS = 5000;
const MAX_TOTAL_CHARS = 200_000;

/**
 * PAT-2723: view-only AI translation of a page into Korean.
 *
 * The client sends the top-level HTML blocks of the page it is viewing; we
 * translate them in batches and stream each finished block back as an SSE
 * frame so the reader sees the translation cascade into place.
 *
 * Contract (client: use-page-translate.ts):
 *   data: {"block":{"id":3,"html":"<p>…</p>"}} — one translated block
 *   data: {"done":true}                        — end of stream
 *   data: {"error":"…"}                        — failure
 */
@Injectable()
export class AiTranslateService {
  private readonly logger = new Logger(AiTranslateService.name);

  constructor(
    private readonly aiProvider: AiProviderService,
    private readonly pagePermissionRepo: PagePermissionRepo,
  ) {}

  async streamPageTranslation(opts: {
    pageId: string;
    blocks: TranslateBlock[];
    userId: string;
    write: (obj: any) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    const { pageId, blocks, userId, write, signal } = opts;

    // The SSE response is already initialized by the controller, so report
    // access denial as an error frame (throwing here would lose the message
    // behind an already-sent 200).
    const accessible = await this.pagePermissionRepo.filterAccessiblePageIds({
      pageIds: [pageId],
      userId,
    });
    if (accessible.length === 0) {
      write({ error: 'You cannot access this page' });
      return;
    }

    // DTO validation covers the envelope only; items are plain objects, so
    // guard them here (a null item or NaN id must not crash the loop).
    if (!Array.isArray(blocks)) {
      write({ error: 'Invalid block payload' });
      return;
    }
    if (blocks.length === 0) {
      write({ done: true });
      return;
    }
    if (blocks.length > MAX_BLOCKS) {
      write({ error: `Too many blocks (max ${MAX_BLOCKS})` });
      return;
    }
    for (const b of blocks) {
      if (
        !b ||
        !Number.isInteger(b.id) ||
        typeof b.html !== 'string' ||
        !b.html.trim()
      ) {
        write({ error: 'Invalid block payload' });
        return;
      }
    }

    // batch blocks by cumulative size for a fast first frame + steady cadence
    const batches: TranslateBlock[][] = [];
    let current: TranslateBlock[] = [];
    let currentChars = 0;
    let totalChars = 0;
    for (const b of blocks) {
      // skipped blocks are simply never emitted — the client keeps showing
      // the original for them (oversized single block / whole-page cap)
      if (b.html.length > MAX_BLOCK_CHARS) continue;
      if (totalChars + b.html.length > MAX_TOTAL_CHARS) continue;
      totalChars += b.html.length;
      if (current.length > 0 && currentChars + b.html.length > MAX_BATCH_CHARS) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(b);
      currentChars += b.html.length;
    }
    if (current.length > 0) batches.push(current);

    for (const batch of batches) {
      if (signal?.aborted) return;
      const ok = await this.translateBatch(batch, write, signal);
      if (!ok) return; // failure already reported as an error frame — stop
    }

    if (!signal?.aborted) {
      write({ done: true });
    }
  }

  /** Returns false when the batch failed (error frame already sent) or the
   *  stream was aborted — the caller must not continue afterwards. */
  private async translateBatch(
    batch: TranslateBlock[],
    write: (obj: any) => void,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const systemPrompt = [
      'You are a professional translator for a company knowledge base.',
      'Translate the text content of each HTML block into Korean (한국어).',
      'Rules:',
      '- Preserve every HTML tag, attribute, class and structure exactly; translate only human-readable text.',
      '- Keep <code>, <pre> and inline code content, URLs, emails, file paths, command examples and product names unchanged.',
      '- Keep numbers, HTML entities and placeholders intact.',
      '- Natural, concise professional Korean; keep the register of the source (docs stay docs, casual stays casual).',
      '- Output ONLY the blocks, each wrapped exactly as <t id="N">translated html</t> with the same id as the input. No commentary, no markdown fences.',
    ].join('\n');

    const userContent = batch
      .map((b) => `<t id="${b.id}">${b.html}</t>`)
      .join('\n');

    let response: Response;
    try {
      response = await this.aiProvider.streamChatCompletion({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        model: 'completion',
        temperature: 0.2,
        // translation needs low latency, not reasoning: 'none' skips the
        // thinking phase so the first block streams out in ~2s
        reasoningEffort: 'none',
        signal,
      });
    } catch (err) {
      if (signal?.aborted) return false;
      this.logger.error(`translate provider call failed: ${err?.['message'] ?? err}`);
      write({ error: 'Failed to reach the AI provider' });
      return false;
    }

    // Stream-parse completed <t id="N">…</t> segments out of the partial
    // text and emit each block as soon as its closing tag arrives — the
    // client swaps it into the live view, giving visible streaming.
    let accumulated = '';
    const emitted = new Set<number>();
    const batchIds = new Set(batch.map((b) => b.id));
    // Completed segments can never change, so rescan only from the start of
    // the most recent complete match — a full rescan per delta would be
    // O(n²) over the stream. Starting at the match START (not its end)
    // preserves leftmost-first matching semantics exactly.
    let scanFrom = 0;
    const emitComplete = () => {
      const re = /<t id="(\d+)">([\s\S]*?)<\/t>/g;
      re.lastIndex = scanFrom;
      let m: RegExpExecArray | null;
      let lastStart = -1;
      while ((m = re.exec(accumulated)) !== null) {
        const id = Number(m[1]);
        if (batchIds.has(id) && !emitted.has(id)) {
          emitted.add(id);
          write({ block: { id, html: m[2] } });
        }
        lastStart = m.index;
      }
      if (lastStart >= 0) scanFrom = lastStart;
    };

    try {
      await streamCompletionDeltas(response, (delta) => {
        if (signal?.aborted) return;
        accumulated += delta;
        emitComplete();
      });
    } catch (err) {
      if (signal?.aborted) return false;
      this.logger.error(`translate stream failed: ${err?.['message'] ?? err}`);
    }

    // final pass in case the tail arrived without a trailing delta callback
    emitComplete();

    if (signal?.aborted) return false;

    // zero emitted blocks for the whole batch = provider produced nothing
    // usable; report instead of silently leaving the batch untranslated
    if (emitted.size === 0) {
      write({ error: 'The AI provider returned an empty translation' });
      return false;
    }
    return true;
  }
}
