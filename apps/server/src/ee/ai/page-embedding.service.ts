import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { sql } from 'kysely';
import { Json } from '@docmost/db/types/db';
import { createHash } from 'crypto';
import { validate as isValidUUID } from 'uuid';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { chunkText } from './chunking.util';
import { EmbeddingService } from './embedding.service';

/**
 * PAT-2330: persists page embeddings.
 *
 * Splits page textContent into chunks, embeds them, and replaces the page's
 * rows in page_embeddings. Vector writes go through `::vector` casts (the
 * pg driver cannot serialize number[] into a vector column directly).
 */
@Injectable()
export class PageEmbeddingService {
  private readonly logger = new Logger(PageEmbeddingService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly embeddingService: EmbeddingService,
    private readonly workspaceRepo: WorkspaceRepo,
  ) {}

  /**
   * Page events can carry slugIds instead of UUIDs (e.g. move-page flows);
   * resolve them before hitting uuid columns.
   */
  private async resolvePageIds(pageIds: string[]): Promise<string[]> {
    const uuids = pageIds.filter((id) => isValidUUID(id));
    const slugs = pageIds.filter((id) => !isValidUUID(id));
    if (slugs.length === 0) return uuids;
    const rows = await this.db
      .selectFrom('pages')
      .select(['id'])
      .where('slugId', 'in', slugs)
      .execute();
    return [...new Set([...uuids, ...rows.map((r) => r.id)])];
  }

  async embedPages(rawPageIds: string[]): Promise<void> {
    if (!this.embeddingService.isAvailable()) {
      this.logger.warn('Embedding provider not configured; skipping');
      return;
    }
    if (!rawPageIds?.length) return;
    const pageIds = await this.resolvePageIds(rawPageIds);
    if (pageIds.length === 0) return;

    const pages = await this.db
      .selectFrom('pages')
      .select([
        'id',
        'workspaceId',
        'spaceId',
        'title',
        'textContent',
        'deletedAt',
      ])
      .where('id', 'in', pageIds)
      .execute();

    // settings check is per-workspace, not per-page
    const enabledByWorkspace = new Map<string, boolean>();

    for (const page of pages) {
      try {
        await this.embedPage(page, enabledByWorkspace);
      } catch (err) {
        // one poison page must not starve the rest of the batch
        this.logger.error(
          `Failed to embed page ${page.id}: ${err?.['message'] ?? err}`,
        );
      }
    }
  }

  private async embedPage(
    page: {
      id: string;
      workspaceId: string;
      spaceId: string;
      title: string;
      textContent: string;
      deletedAt: Date | null;
    },
    enabledByWorkspace: Map<string, boolean>,
  ): Promise<void> {
    {
      if (page.deletedAt) {
        await this.deleteByPageIds([page.id]);
        return;

      }
      let enabled = enabledByWorkspace.get(page.workspaceId);
      if (enabled === undefined) {
        enabled = await this.workspaceRepo.isAiSearchEnabled(page.workspaceId);
        enabledByWorkspace.set(page.workspaceId, enabled);
      }
      if (!enabled) return;

      const text = [page.title, page.textContent ?? ''].join('\n\n').trim();

      // skip the (expensive) re-embed when the content is unchanged —
      // PAGE_UPDATED also fires on non-content mutations (icon, position,
      // label changes)
      const contentHash = createHash('sha256').update(text).digest('hex');
      const existing = await this.db
        .selectFrom('pageEmbeddings')
        .select('metadata')
        .where('pageId', '=', page.id)
        .where('chunkIndex', '=', 0)
        .executeTakeFirst();
      const existingHash = (
        existing?.metadata as { contentHash?: string } | undefined
      )?.contentHash;
      if (existingHash === contentHash) return;

      const chunks = chunkText(text);
      if (chunks.length === 0) {
        await this.deleteByPageIds([page.id]);
        return;
      }

      const vectors = await this.embeddingService.embedBatch(
        chunks.map((c) => c.text),
      );

      // atomic replace: concurrent searches never observe a partial chunk set
      await this.db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom('pageEmbeddings')
          .where('pageId', '=', page.id)
          .execute();

        await trx
          .insertInto('pageEmbeddings')
          .values(
            chunks.map((chunk, i) => ({
              pageId: page.id,
              spaceId: page.spaceId,
              attachmentId: null,
              workspaceId: page.workspaceId,
              modelName: this.embeddingService.getModelName(),
              modelDimensions: this.embeddingService.getDimension(),
              chunkIndex: i,
              chunkStart: chunk.start,
              chunkLength: chunk.length,
              content: chunk.text,
              metadata: sql<Json>`${JSON.stringify({ contentHash })}::text::jsonb` as never,
              embedding: sql`cast(${JSON.stringify(vectors[i])} as vector)` as never,
            })),
          )
          .execute();
      });
      this.logger.debug(`Embedded page ${page.id} (${chunks.length} chunks)`);
    }
  }

  async deleteByPageIds(rawPageIds: string[]): Promise<void> {
    if (!rawPageIds?.length) return;
    const pageIds = await this.resolvePageIds(rawPageIds);
    if (pageIds.length === 0) return;
    await this.db
      .deleteFrom('pageEmbeddings')
      .where('pageId', 'in', pageIds)
      .execute();
  }

  async deleteByWorkspaceId(workspaceId: string): Promise<void> {
    // disable-time deletes are scheduled with a 24h delay; if AI search was
    // re-enabled in the meantime, the job must not wipe live embeddings
    if (await this.workspaceRepo.isAiSearchEnabled(workspaceId)) {
      this.logger.log(
        `Skipping embedding delete for workspace ${workspaceId}: AI search is enabled`,
      );
      return;
    }
    await this.db
      .deleteFrom('pageEmbeddings')
      .where('workspaceId', '=', workspaceId)
      .execute();
  }

  /** Backfill: embed every non-deleted page in the workspace (idempotent). */
  async backfillWorkspace(workspaceId: string): Promise<void> {
    if (!this.embeddingService.isAvailable()) {
      this.logger.warn('Embedding provider not configured; backfill skipped');
      return;
    }
    const batchSize = 50;
    let lastId = '00000000-0000-0000-0000-000000000000';
    // keyset pagination — stable under concurrent inserts
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const pages = await this.db
        .selectFrom('pages')
        .select(['id'])
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .where('id', '>', lastId)
        .orderBy('id')
        .limit(batchSize)
        .execute();
      if (pages.length === 0) break;
      await this.embedPages(pages.map((p) => p.id));
      lastId = pages[pages.length - 1].id;
    }
    this.logger.log(`Backfilled embeddings for workspace ${workspaceId}`);
  }
}
