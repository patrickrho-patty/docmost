import { Injectable, Logger } from '@nestjs/common';
import {
  VectorSearchService,
  VectorChunkHit,
  EmbeddingUnavailableError,
} from './vector-search.service';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { containsCjk } from '../../common/helpers';
import { streamCompletionDeltas } from './ai-stream.util';
import { AiProviderService, AiProviderError } from './ai-provider.service';

const NO_CONTEXT_EN =
  "I couldn't find relevant information in this workspace for your question.";
const NO_CONTEXT_KO = '이 질문과 관련된 정보를 워크스페이스 문서에서 찾지 못했습니다.';

export interface AiSourceDto {
  pageId: string;
  title: string;
  slugId: string;
  spaceSlug: string;
  similarity: number;
  distance: number;
  chunkIndex: number;
  excerpt: string;
  /** the [n] citation number of the chunk in the prompt context */
  citation?: number;
}

/**
 * PAT-2332: retrieval-augmented answers over page_embeddings, streamed via
 * the configured OpenAI-compatible provider (MiniMax-M3 in this fork).
 *
 * M3 is a reasoning model: reasoning arrives either as a separate
 * `reasoning_content` delta field (ignored) or inline as `<think>…</think>`
 * tags inside content — the ThinkTagFilter strips the latter across chunk
 * boundaries.
 */
@Injectable()
export class AiAnswersService {
  private readonly logger = new Logger(AiAnswersService.name);

  constructor(
    private readonly vectorSearchService: VectorSearchService,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly aiProvider: AiProviderService,
  ) {}

  async retrieveChunks(opts: {
    query: string;
    workspaceId: string;
    userId: string;
    spaceId?: string;
    limit?: number;
    userSpaceIds?: string[];
  }): Promise<VectorChunkHit[]> {
    const { query, workspaceId, userId, spaceId, limit = 8 } = opts;

    const userSpaceIds =
      opts.userSpaceIds ?? (await this.spaceMemberRepo.getUserSpaceIds(userId));
    if (userSpaceIds.length === 0) return [];
    if (spaceId && !userSpaceIds.includes(spaceId)) return [];

    const chunks = await this.vectorSearchService.searchChunks({
      query,
      workspaceId,
      userSpaceIds,
      spaceId,
      limit: limit * 2, // fetch extra; some may be filtered out
    });
    if (chunks.length === 0) return [];

    const pageIds = [...new Set(chunks.map((c) => c.pageId))];
    const accessibleIds = new Set(
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds,
        userId,
        spaceId,
      }),
    );

    return chunks.filter((c) => accessibleIds.has(c.pageId)).slice(0, limit);
  }

  buildSources(
    entries: { chunk: VectorChunkHit; citation?: number }[],
  ): AiSourceDto[] {
    const byPage = new Map<string, AiSourceDto>();
    for (const { chunk: c, citation } of entries) {
      const existing = byPage.get(c.pageId);
      if (!existing || c.similarity > existing.similarity) {
        byPage.set(c.pageId, {
          pageId: c.pageId,
          title: c.title,
          slugId: c.slugId,
          spaceSlug: c.spaceSlug,
          similarity: c.similarity,
          distance: c.distance,
          chunkIndex: c.chunkIndex,
          excerpt: c.content.slice(0, 300),
          citation,
        });
      }
    }
    return [...byPage.values()];
  }

  /**
   * Streams the answer. `write` receives objects to be serialized as SSE
   * data frames ({content}, {sources}, {error}). Returns when done.
   */
  async streamAnswer(opts: {
    query: string;
    workspaceId: string;
    userId: string;
    spaceId?: string;
    write: (obj: Record<string, unknown>) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    const { query, workspaceId, userId, spaceId, write, signal } = opts;

    let chunks: VectorChunkHit[];
    try {
      chunks = await this.retrieveChunks({
        query,
        workspaceId,
        userId,
        spaceId,
      });
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) {
        write({ error: 'AI search is temporarily unavailable' });
        return;
      }
      throw err;
    }

    if (chunks.length === 0) {
      write({ content: containsCjk(query) ? NO_CONTEXT_KO : NO_CONTEXT_EN });
      write({ sources: [] });
      return;
    }

    // Sources go out before the provider call so the UI can render citations
    // while the answer streams (and even if the provider call fails).
    // Citation numbers match the [n] markers the model sees in the context.
    write({
      sources: this.buildSources(
        chunks.map((chunk, i) => ({ chunk, citation: i + 1 })),
      ),
    });

    const context = chunks
      .map((c, i) => `[${i + 1}] (page: "${c.title}")\n${c.content}`)
      .join('\n\n');

    const systemPrompt = [
      'You are the AI assistant of this knowledge base.',
      'Answer the question using ONLY the context chunks below.',
      'Give a thorough, well-structured answer: cover all relevant details from the context (steps, numbers, conditions, exceptions), using short sections or bullet lists when that helps readability.',
      'Always answer in the same language as the question (Korean question -> Korean answer).',
      'If the context does not contain the answer, say that you could not find it in the workspace documents — do not invent information.',
      'When you use information from a chunk, cite it inline as [1], [2], etc.',
      '',
      'Context:',
      context,
    ].join('\n');

    let response: Response;
    try {
      response = await this.aiProvider.streamChatCompletion({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query },
        ],
        model: 'completion',
        signal,
      });
    } catch (err) {
      if (signal?.aborted) return;
      if (err instanceof AiProviderError) {
        write({ error: err.message });
        return;
      }
      throw err;
    }

    const fullText = await streamCompletionDeltas(response, (text) => {
      if (!signal?.aborted) write({ content: text });
    });

    if (signal?.aborted) return;

    // a 200 with zero parseable deltas (provider error page, reasoning-only
    // frames) must not be reported as an empty success
    if (!fullText.trim()) {
      this.logger.error('AI provider returned an empty stream');
      write({ error: 'The AI provider returned an empty response' });
      return;
    }

    // narrow sources to the chunks the answer actually cites ([1], [2]…) —
    // retrieval may return pages the answer never used
    write({ sources: this.buildSources(citedChunksWithNumbers(chunks, fullText)) });
  }
}

/**
 * Chunks the answer actually cites, paired with their 1-based [n] citation
 * number (the chunk's position in the prompt context).
 */
export function citedChunksWithNumbers(
  chunks: VectorChunkHit[],
  answerText: string,
): { chunk: VectorChunkHit; citation: number }[] {
  const cited = new Set<number>();
  for (const m of answerText.matchAll(/\[(\d+)\]/g)) cited.add(+m[1]);
  return chunks
    .map((chunk, i) => ({ chunk, citation: i + 1 }))
    .filter(({ citation }) => cited.has(citation));
}
