import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { sql } from 'kysely';
import { EmbeddingService } from './embedding.service';

export interface VectorHit {
  pageId: string;
  similarity: number;
  excerpt: string;
}

export interface VectorChunkHit {
  pageId: string;
  chunkIndex: number;
  title: string;
  slugId: string;
  spaceSlug: string;
  content: string;
  similarity: number;
  distance: number;
}

/**
 * PAT-2331: semantic (vector) search over page_embeddings.
 *
 * Caller is responsible for page-level permission filtering of the returned
 * ids (same pattern as SearchService). Space membership is enforced here via
 * the provided space-id set so the ANN query never leaves the caller's
 * visible spaces.
 */
@Injectable()
export class EmbeddingUnavailableError extends Error {
  declare cause?: unknown;

  constructor(cause?: unknown) {
    super('Embedding provider unavailable');
    this.name = 'EmbeddingUnavailableError';
    this.cause = cause;
  }
}

export class VectorSearchService {
  private readonly logger = new Logger(VectorSearchService.name);

  /**
   * Cosine-distance ceiling for RAG chunk retrieval. Calibrated on bge-m3
   * against a mixed Korean corpus: on-topic chunks land ~0.42, off-topic
   * pages ~0.63+. Only applied to the RAG path — the hybrid-search merge
   * relies on RRF ranking instead.
   */
  private static readonly RAG_MAX_DISTANCE = 0.55;

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly embeddingService: EmbeddingService,
  ) {}

  isEnabled(): boolean {
    return this.embeddingService.isAvailable();
  }

  async search(opts: {
    query: string;
    workspaceId: string;
    userSpaceIds: string[];
    spaceId?: string;
    limit?: number;
  }): Promise<VectorHit[]> {
    const { query, workspaceId, userSpaceIds, spaceId, limit = 25 } = opts;
    if (!query.trim()) return [];

    const scopeSpaceIds = spaceId ? [spaceId] : userSpaceIds;
    if (scopeSpaceIds.length === 0) return [];

    let queryVector: number[];
    try {
      queryVector = await this.embeddingService.embedQuery(query);
    } catch (err) {
      this.logger.warn(`Query embedding failed: ${err?.['message'] ?? err}`);
      return [];
    }

    const vec = JSON.stringify(queryVector);

    // Index-assisted ANN: fetch the top-K chunks (HNSW can satisfy this
    // ordering), then collapse to the best chunk per page in JS. A
    // DISTINCT ON (page_id) … ORDER BY page_id variant would defeat the
    // index and compute exact distances over the whole corpus.
    const rows = await sql<{
      pageId: string;
      distance: number;
      excerpt: string;
    }>`
      SELECT
        pe.page_id       AS "pageId",
        pe.embedding <=> ${vec}::vector AS distance,
        pe.content       AS excerpt
      FROM page_embeddings pe
      INNER JOIN pages p ON p.id = pe.page_id
      WHERE pe.workspace_id = ${workspaceId}
        AND pe.deleted_at IS NULL
        AND pe.page_id IS NOT NULL
        AND p.deleted_at IS NULL
        AND p.space_id IN (${sql.join(scopeSpaceIds.map((id) => sql`${id}::uuid`))})
      ORDER BY pe.embedding <=> ${vec}::vector
      LIMIT ${limit * 5}
    `.execute(this.db);

    // rows arrive ordered by distance; first occurrence per page is its best
    const bestByPage = new Map<string, VectorHit>();
    for (const r of rows.rows) {
      if (bestByPage.has(r.pageId)) continue;
      bestByPage.set(r.pageId, {
        pageId: r.pageId,
        similarity: 1 - r.distance, // cosine similarity from cosine distance
        excerpt: r.excerpt,
      });
      if (bestByPage.size >= limit) break;
    }

    return [...bestByPage.values()];
  }

  /**
   * PAT-2332: top-K raw chunks across pages for RAG answer context.
   * Unlike search() this does not collapse to one chunk per page.
   * Page-level permission filtering is left to the caller.
   */
  async searchChunks(opts: {
    query: string;
    workspaceId: string;
    userSpaceIds: string[];
    spaceId?: string;
    limit?: number;
  }): Promise<VectorChunkHit[]> {
    const { query, workspaceId, userSpaceIds, spaceId, limit = 8 } = opts;
    if (!query.trim()) return [];

    const scopeSpaceIds = spaceId ? [spaceId] : userSpaceIds;
    if (scopeSpaceIds.length === 0) return [];

    let queryVector: number[];
    try {
      queryVector = await this.embeddingService.embedQuery(query);
    } catch (err) {
      // RAG has no fallback — "embedder down" must not masquerade as
      // "no relevant documents"
      this.logger.warn(`Query embedding failed: ${err?.['message'] ?? err}`);
      throw new EmbeddingUnavailableError(err);
    }

    const vec = JSON.stringify(queryVector);

    const rows = await sql<{
      pageId: string;
      chunkIndex: number;
      title: string;
      slugId: string;
      spaceSlug: string;
      content: string;
      distance: number;
    }>`
      SELECT
        pe.page_id     AS "pageId",
        pe.chunk_index AS "chunkIndex",
        p.title        AS "title",
        p.slug_id      AS "slugId",
        s.slug         AS "spaceSlug",
        pe.content     AS "content",
        pe.embedding <=> ${vec}::vector AS distance
      FROM page_embeddings pe
      INNER JOIN pages p ON p.id = pe.page_id
      INNER JOIN spaces s ON s.id = p.space_id
      WHERE pe.workspace_id = ${workspaceId}
        AND pe.deleted_at IS NULL
        AND pe.page_id IS NOT NULL
        AND p.deleted_at IS NULL
        AND p.space_id IN (${sql.join(scopeSpaceIds.map((id) => sql`${id}::uuid`))})
        AND pe.embedding <=> ${vec}::vector <= ${VectorSearchService.RAG_MAX_DISTANCE}
      ORDER BY distance
      LIMIT ${limit}
    `.execute(this.db);

    return rows.rows.map((r) => ({
      pageId: r.pageId,
      chunkIndex: r.chunkIndex,
      title: r.title,
      slugId: r.slugId,
      spaceSlug: r.spaceSlug,
      content: r.content,
      similarity: 1 - r.distance,
      distance: r.distance,
    }));
  }
}
