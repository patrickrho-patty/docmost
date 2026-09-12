import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PageTranslationRepo } from '@docmost/db/repos/page/page-translation.repo';
import {
  PageTranslation,
  TranslatedBlock,
} from '@docmost/db/types/translation.types';
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
 * A row left in_progress by a dead process (crash/restart) is reapable after
 * this long; until then a recent row with no live job is still treated as
 * 'none' so a new translation can start.
 */
const STALE_JOB_MS = 15 * 60 * 1000;

/** In-flight translation job, shared by every viewer of the page. */
interface TranslateJob {
  key: string;
  pageId: string;
  sourceHash: string;
  total: number;
  /** validated translated blocks so far, keyed by client block id */
  blocks: Map<number, string>;
  subscribers: Set<(obj: any) => void>;
  done: boolean;
}

/**
 * PAT-2723: view-only AI translation of a page into Korean, cached per page
 * version and shared between concurrent viewers.
 *
 * "Page version" is `sourceHash`, derived BY THE SERVER as sha256 of the
 * received blocks' normalized text (see hashBlocks): HTML serialization is
 * browser/renderer-dependent and would fragment the cache per client, while
 * text extraction is stable. The client's status poller derives the
 * identical key from the live DOM (use-page-translate.ts) — the derivation
 * must match or jobs/cache fragment per viewer. Deriving here (never
 * trusting a client-sent key) keeps a crafted request from writing another
 * page version's cache row. A text edit changes the key and therefore
 * misses the cache; a formatting-only edit keeps it.
 *
 * One POST /ai/translate call per viewer, three server behaviors:
 *   - a live job for this version exists  -> join: replay done blocks, then
 *     stream the rest live (subscribers are fanned out per block)
 *   - a complete row exists (and !force)  -> replay the cache instantly
 *   - otherwise                           -> start the job: translate in
 *     batches, validate each block (cheerio normalize + sanity checks) before
 *     it is broadcast OR persisted, write through to the row as blocks land,
 *     mark complete at the end. The job is NOT aborted when the initiator's
 *     SSE connection closes — it finishes and warms the cache.
 *
 * Live jobs are in-memory, so the job registry is per API process. An
 * in_progress row with no live job behind it means the owning process is
 * gone (crash/restart): status reports it as 'none' so any viewer can
 * restart the translation right away (the next job's upsert resets the
 * row), and rows untouched beyond STALE_JOB_MS are reaped on sight.
 *
 * Clients that only need visibility poll POST /ai/translate/status.
 *
 * Contract (client: use-page-translate.ts):
 *   data: {"cached":true}                      — replaying a finished cache
 *   data: {"block":{"id":3,"html":"<p>…</p>"}} — one translated block
 *   data: {"done":true}                        — end of stream
 *   data: {"error":"…"}                        — failure
 */
@Injectable()
export class AiTranslateService {
  private readonly logger = new Logger(AiTranslateService.name);
  private readonly jobs = new Map<string, TranslateJob>();

  constructor(
    private readonly aiProvider: AiProviderService,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly translationRepo: PageTranslationRepo,
  ) {}

  async streamPageTranslation(opts: {
    pageId: string;
    blocks: TranslateBlock[];
    userId: string;
    force?: boolean;
    write: (obj: any) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    const { pageId, blocks, userId, force, write, signal } = opts;

    // The SSE response is already initialized by the controller, so report
    // access denial as an error frame (throwing here would lose the message
    // behind an already-sent 200).
    if (!(await this.pagePermissionRepo.canUserAccessPage(userId, pageId))) {
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

    const sourceHash = this.hashBlocks(blocks);
    const key = `${pageId}:${sourceHash}`;

    // Live job for this exact version -> join it (even with force: never run
    // two jobs for the same version at once).
    const live = this.jobs.get(key);
    if (live && !live.done) {
      await this.joinJob(live, write, signal);
      return;
    }

    const existing = await this.translationRepo.findByPageAndHash(
      pageId,
      sourceHash,
    );
    if (existing && existing.status === 'complete' && !force) {
      write({ cached: true });
      this.replayBlocks(
        existing.blocks as unknown as TranslatedBlock[],
        write,
        signal,
      );
      if (!signal?.aborted) write({ done: true });
      return;
    }
    if (existing && existing.status === 'in_progress') {
      // No live job behind the row (crashed process). Reap if stale; either
      // way a fresh job may start and the upsert resets the row.
      if (Date.now() - new Date(existing.updatedAt).getTime() > STALE_JOB_MS) {
        await this.translationRepo.deleteByPageAndHash(pageId, sourceHash);
      }
    }

    // Claim the job synchronously (no await between get and set — in-process
    // start races are impossible), then double-check in case a joiner raced
    // us during the awaits above.
    const racing = this.jobs.get(key);
    if (racing) {
      await this.joinJob(racing, write, signal);
      return;
    }
    const job: TranslateJob = {
      key,
      pageId,
      sourceHash,
      total: blocks.length,
      blocks: new Map(),
      subscribers: new Set(),
      done: false,
    };
    this.jobs.set(key, job);

    try {
      await this.translationRepo.startJob({
        pageId,
        sourceHash,
        totalCount: blocks.length,
        createdBy: userId,
      });
      await this.runJob(job, blocks, write, signal);
    } catch (err) {
      // a failed start must not leave a phantom registry entry — joiners
      // would wait on a broadcast that never comes and the page version
      // would be bricked until restart
      job.done = true;
      this.jobs.delete(key);
      throw err;
    }
  }

  /** Job state for the status poller. Returns null when the user cannot
   *  read the page (the controller answers 404 so page existence stays
   *  unguessable). `sourceHash` is the client-computed sha256 of the block
   *  payload — it is only ever a cache key, never executed content. */
  async getStatus(opts: {
    pageId: string;
    sourceHash: string;
    userId: string;
  }): Promise<{
    state: 'none' | 'in_progress' | 'cached';
    done?: number;
    total?: number;
  } | null> {
    const { pageId, sourceHash, userId } = opts;
    if (!(await this.pagePermissionRepo.canUserAccessPage(userId, pageId))) {
      return null;
    }
    const job = this.jobs.get(`${pageId}:${sourceHash}`);
    if (job && !job.done) {
      return { state: 'in_progress', done: job.blocks.size, total: job.total };
    }
    const row = await this.translationRepo.findStatusByPageAndHash(
      pageId,
      sourceHash,
    );
    if (row?.status === 'complete') {
      return { state: 'cached' };
    }
    if (row?.status === 'in_progress') {
      if (Date.now() - new Date(row.updatedAt).getTime() > STALE_JOB_MS) {
        await this.translationRepo.deleteByPageAndHash(pageId, sourceHash);
      }
    }
    return { state: 'none' };
  }

  // ------------------------------------------------------------------ jobs

  /**
   * Version key for a block payload: sha256 of `[{id, text}]` with text
   * extracted via cheerio and whitespace-collapsed. Must stay byte-identical
   * to the client derivation (normalizeBlockText over DOM textContent in
   * use-page-translate.ts) — both concatenate text descendants the same way,
   * so honest viewers always land on the same key.
   */
  private hashBlocks(blocks: TranslateBlock[]): string {
    const payload = blocks.map((b) => ({
      id: b.id,
      text: load(b.html, null, false)
        .root()
        .text()
        .replace(/\s+/g, ' ')
        .trim(),
    }));
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  private broadcast(job: TranslateJob, obj: any): void {
    for (const subscriber of job.subscribers) {
      subscriber(obj);
    }
  }

  private replayBlocks(
    blocks: TranslatedBlock[],
    write: (obj: any) => void,
    signal?: AbortSignal,
  ): void {
    const sorted = [...blocks].sort((a, b) => a.id - b.id);
    for (const block of sorted) {
      if (signal?.aborted) return;
      write({ block });
    }
  }

  /** Replay what is done, then stream the rest until the job terminates. */
  private async joinJob(
    job: TranslateJob,
    write: (obj: any) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    this.replayBlocks(
      [...job.blocks.entries()].map(([id, html]) => ({ id, html })),
      write,
      signal,
    );
    if (signal?.aborted) return;
    if (job.done) {
      write({ done: true });
      return;
    }
    await new Promise<void>((resolve) => {
      const cleanup = () => {
        job.subscribers.delete(subscriber);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        resolve();
      };
      const subscriber = (obj: any) => {
        write(obj);
        if (obj?.done || obj?.error) {
          cleanup();
          resolve();
        }
      };
      job.subscribers.add(subscriber);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async runJob(
    job: TranslateJob,
    blocks: TranslateBlock[],
    write: (obj: any) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    // The starter is also just a subscriber — its own `write` receives frames
    // through the same fan-out as joiners.
    const starterDone = new Promise<void>((resolve) => {
      const cleanup = () => {
        job.subscribers.delete(subscriber);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        resolve();
      };
      const subscriber = (obj: any) => {
        write(obj);
        if (obj?.done || obj?.error) {
          cleanup();
          resolve();
        }
      };
      job.subscribers.add(subscriber);
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    // Write-through to the translation row, one snapshot per finished batch,
    // chained so snapshots commit in issue order (fire-and-forget writes
    // could land out of order and leave a 'complete' row missing blocks).
    // The row only matters for crash-resume and the final cache — live
    // progress comes from the in-memory job — so per-batch cadence is enough.
    let persistFailed = false;
    let writeQueue: Promise<unknown> = Promise.resolve();
    const persist = () => {
      writeQueue = writeQueue.then(() =>
        this.translationRepo
          .updateBlocks(job.pageId, job.sourceHash, this.serialize(job))
          .catch((err) => {
            persistFailed = true;
            this.logger.warn(
              `failed to persist translation progress: ${err?.['message'] ?? err}`,
            );
          }),
      );
      return writeQueue;
    };

    try {
      // batch blocks by cumulative size for a fast first frame + steady cadence
      const batches: TranslateBlock[][] = [];
      let current: TranslateBlock[] = [];
      let currentChars = 0;
      let totalChars = 0;
      for (const b of blocks) {
        // skipped blocks are simply never emitted — viewers keep the original
        // for them (oversized single block / whole-page cap)
        if (b.html.length > MAX_BLOCK_CHARS) continue;
        if (totalChars + b.html.length > MAX_TOTAL_CHARS) continue;
        totalChars += b.html.length;
        if (
          current.length > 0 &&
          currentChars + b.html.length > MAX_BATCH_CHARS
        ) {
          batches.push(current);
          current = [];
          currentChars = 0;
        }
        current.push(b);
        currentChars += b.html.length;
      }
      if (current.length > 0) batches.push(current);

      let failed = !!signal?.aborted;
      for (const batch of batches) {
        if (signal?.aborted) {
          failed = true;
          break;
        }
        const ok = await this.translateBatch(
          batch,
          (block) => {
            job.blocks.set(block.id, block.html);
            this.broadcast(job, { block });
          },
          signal,
        );
        persist();
        if (!ok) {
          failed = true;
          break;
        }
      }

      // Terminal sequence order matters: persist row state BEFORE dropping
      // the registry entry, so a request arriving mid-sequence either sees
      // the live (not-yet-done) job and joins it, or sees the complete row
      // and takes the cache path — never a duplicate job.
      if (failed || persistFailed) {
        // don't keep a partial/failed version cached — retry must be possible
        await writeQueue;
        await this.translationRepo
          .deleteByPageAndHash(job.pageId, job.sourceHash)
          .catch((err) =>
            this.logger.warn(
              `failed to delete failed translation row: ${err?.['message'] ?? err}`,
            ),
          );
        job.done = true;
        this.broadcast(job, { error: 'Translation failed' });
        this.jobs.delete(job.key);
      } else {
        // flush the final snapshot, then flip status — a reader must never
        // see 'complete' with a stale blocks column
        persist();
        await writeQueue;
        await this.translationRepo.markComplete(job.pageId, job.sourceHash);
        job.done = true;
        this.broadcast(job, { done: true });
        this.jobs.delete(job.key);
      }
    } catch (err) {
      this.logger.error(
        `translate job failed: ${err?.['message'] ?? err}`,
      );
      job.done = true;
      this.broadcast(job, { error: 'Failed to translate the page' });
      this.jobs.delete(job.key);
      await this.translationRepo
        .deleteByPageAndHash(job.pageId, job.sourceHash)
        .catch(() => {});
    }

    // keep the request handler alive until the starter has been told the
    // terminal frame (its subscriber resolves on done/error)
    await starterDone;
  }

  private serialize(job: TranslateJob): TranslatedBlock[] {
    return [...job.blocks.entries()]
      .map(([id, html]) => ({ id, html }))
      .sort((a, b) => a.id - b.id);
  }

  /**
   * Validate a model-produced block before it is shown or persisted:
   * strip leaked <t id="N"> wrapper fragments, normalize/repair markup with
   * cheerio (truncated streams become well-formed), and reject output whose
   * text collapsed versus the source (the malformed-response guard that
   * keeps garbage out of the cache). Returns null when unusable.
   */
  private sanitizeTranslated(sourceHtml: string, raw: string): string | null {
    if (!raw || !raw.trim()) return null;

    let html = raw.replace(/<t(?:\s[^>]*)?>/g, '').replace(/<\/t>/g, '');
    html = html.trim();
    if (!html) return null;

    const $ = load(html, null, false);
    const normalized = $.root().html();
    if (!normalized || !normalized.trim()) return null;

    const srcText = load(sourceHtml, null, false).root().text().trim();
    const outText = $.root().text().trim();
    if (srcText.length >= 20 && outText.length < srcText.length * 0.2) {
      return null;
    }
    return normalized;
  }

  /** Returns false when the batch yielded nothing usable (provider failure
   *  or zero validated blocks) or the stream was aborted — the caller must
   *  not continue afterwards and reports the failure at job level. */
  private async translateBatch(
    batch: TranslateBlock[],
    publish: (block: TranslatedBlock) => void,
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
      return false;
    }

    // Stream-parse completed <t id="N">…</t> segments out of the partial
    // text and emit each block as soon as its closing tag arrives — the
    // client swaps it into the live view, giving visible streaming.
    let accumulated = '';
    let validCount = 0;
    const emitted = new Set<number>();
    const batchIds = new Set(batch.map((b) => b.id));
    const sources = new Map(batch.map((b) => [b.id, b.html]));
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
          const sanitized = this.sanitizeTranslated(sources.get(id), m[2]);
          if (sanitized !== null) {
            validCount += 1;
            publish({ id, html: sanitized });
          }
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

    // zero valid blocks for the whole batch = provider produced nothing
    // usable; report instead of silently leaving the batch untranslated
    if (validCount === 0) {
      this.logger.warn(
        `translate batch produced no valid blocks (${batch.length} source blocks)`,
      );
      return false;
    }
    return true;
  }
}
