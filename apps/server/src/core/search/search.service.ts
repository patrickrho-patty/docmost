import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { SearchDTO, SearchSuggestionDTO } from './dto/search.dto';
import { SearchResponseDto } from './dto/search-response.dto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { sql } from 'kysely';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import {
  containsCjk,
  escapeLike,
  buildSnippetHighlight,
} from '../../common/helpers';
import type { VectorHit, VectorSearchService } from '../../ee/ai/vector-search.service';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tsquery = require('pg-tsquery')();

const RRF_K = 60;

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  // patty fork: soft-loaded EE vector search (license-check pattern)
  private vectorSearchService?: VectorSearchService | null;

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private pageRepo: PageRepo,
    private shareRepo: ShareRepo,
    private spaceMemberRepo: SpaceMemberRepo,
    private pagePermissionRepo: PagePermissionRepo,
    private workspaceRepo: WorkspaceRepo,
    private moduleRef: ModuleRef,
  ) {}

  private getVectorSearchService(): VectorSearchService | null {
    if (this.vectorSearchService !== undefined) return this.vectorSearchService;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../../ee/ai/vector-search.service');
      this.vectorSearchService = this.moduleRef.get(mod.VectorSearchService, {
        strict: false,
      });
    } catch {
      this.vectorSearchService = null;
    }
    return this.vectorSearchService;
  }

  async searchPage(
    searchParams: SearchDTO,
    opts: {
      userId?: string;
      workspaceId: string;
      publicPageIds?: string[];
      /** caller-resolved settings.ai.search (avoids a repeat DB lookup) */
      aiSearchEnabled?: boolean;
    },
  ): Promise<{ items: SearchResponseDto[] }> {
    const query = searchParams.query?.trim() ?? '';
    const labelIds = [...new Set(searchParams.labelIds ?? [])];
    // selected filters (labels, creator) are browsable without a query
    const browseByFilters =
      query.length < 1 &&
      (labelIds.length > 0 || Boolean(searchParams.creatorId));

    if (query.length < 1 && !browseByFilters) {
      return { items: [] };
    }
    const searchQuery = tsquery(query + '*');
    const titleOnly = searchParams.titleOnly === true;
    const titleQuery = query;
    // escape LIKE wildcards; ranking keeps the raw query
    const titleLikeQuery = escapeLike(query);
    // patty fork (PAT-2331): the stock 'english' FTS cannot segment CJK —
    // Korean/Japanese/Chinese queries route through a trigram/ILIKE path.
    const useCjkPath = !browseByFilters && containsCjk(query);

    const limit = searchParams.limit || 25;
    const offset = searchParams.offset || 0;

    // patty fork (PAT-2331): hybrid semantic merge eligibility. When active,
    // the lexical query fetches offset+limit rows from position 0 and the
    // RRF merge slices once — slicing a pre-offset window would drop the top
    // merged results.
    const vectorService =
      !browseByFilters &&
      !titleOnly &&
      opts.userId &&
      !searchParams.shareId &&
      !opts.publicPageIds
        ? this.getVectorSearchService()
        : null;
    const aiSearchEnabled =
      vectorService != null &&
      (opts.aiSearchEnabled ??
        (await this.workspaceRepo.isAiSearchEnabled(opts.workspaceId)));
    const hybridActive = vectorService != null && aiSearchEnabled;

    // Embedding (~350ms warm) runs concurrently with the lexical query.
    // Vector failures must never take down lexical search.
    const vectorPromise: Promise<VectorHit[]> = hybridActive
      ? (async () => {
          const userSpaceIds = searchParams.spaceId
            ? [searchParams.spaceId]
            : await this.spaceMemberRepo.getUserSpaceIds(opts.userId);
          return vectorService.search({
            query,
            workspaceId: opts.workspaceId,
            userSpaceIds,
            spaceId: searchParams.spaceId,
            limit: limit + offset,
          });
        })().catch((err) => {
          this.logger.warn(
            `Vector search failed, falling back to lexical: ${err?.message ?? err}`,
          );
          return [];
        })
      : Promise.resolve([]);

    const rankColumn = browseByFilters
      ? sql<number>`0`.as('rank')
      : titleOnly
        ? sql<number>`word_similarity(lower(${titleQuery}), lower(pages.title))`.as(
            'rank',
          )
        : useCjkPath
          ? sql<number>`(word_similarity(lower(${titleQuery}), lower(pages.title)) * 3 + CASE WHEN pages.text_content ILIKE ${`%${titleLikeQuery}%`} THEN 1 ELSE 0 END)`.as(
              'rank',
            )
          : sql<number>`ts_rank(tsv, to_tsquery('english', f_unaccent(${searchQuery})))`.as(
              'rank',
            );
    // CJK highlights are built in JS from textContent (ts_headline cannot
    // match CJK against the 'english' FTS config)
    const highlightColumn =
      browseByFilters || titleOnly || useCjkPath
      ? sql<string>`''`.as('highlight')
      : sql<string>`ts_headline('english', text_content, to_tsquery('english', f_unaccent(${searchQuery})),'MinWords=9, MaxWords=10, MaxFragments=3')`.as(
          'highlight',
        );

    let queryResults = this.db
      .selectFrom('pages')
      .select([
        'id',
        'slugId',
        'title',
        'icon',
        'parentPageId',
        'creatorId',
        'createdAt',
        'updatedAt',
        rankColumn,
        highlightColumn,
      ])
      // body text is needed for JS-side CJK highlights
      .$if(useCjkPath, (qb) => qb.select('textContent'))
      .$if(!browseByFilters && !titleOnly && !useCjkPath, (qb) =>
        qb.where(
          'tsv',
          '@@',
          sql<string>`to_tsquery('english', f_unaccent(${searchQuery}))`,
        ),
      )
      .$if(!browseByFilters && !titleOnly && useCjkPath, (qb) =>
        qb.where((eb) =>
          eb.or([
            // ILIKE keeps the pg_trgm GIN indexes usable (the stock title
            // index is on lower(title); a bare-column title index ships with
            // the text_content one).
            eb('pages.title', 'ilike', `%${titleLikeQuery}%`),
            eb('pages.textContent', 'ilike', `%${titleLikeQuery}%`),
          ]),
        ),
      )
      .$if(!browseByFilters && titleOnly, (qb) =>
        qb.where((eb) =>
          eb('pages.title', 'ilike', `%${titleLikeQuery}%`),
        ),
      )
      .$if(Boolean(searchParams.creatorId), (qb) =>
        qb.where('creatorId', '=', searchParams.creatorId),
      )
      .$if(labelIds?.length > 0, (qb) =>
        qb.where(
          'id',
          'in',
          this.db
            .selectFrom('pageLabels')
            .select('pageId')
            .where('labelId', 'in', labelIds),
        ),
      )
      .where('deletedAt', 'is', null)
      .$if(browseByFilters, (qb) => qb.orderBy('updatedAt', 'desc'))
      .$if(!browseByFilters, (qb) => qb.orderBy('rank', 'desc'))
      .limit(hybridActive ? limit + offset : limit)
      .offset(hybridActive ? 0 : offset);

    if (!searchParams.shareId && !opts.publicPageIds) {
      queryResults = queryResults.select((eb) => this.pageRepo.withSpace(eb));
    }

    if (searchParams.spaceId && opts.userId) {
      queryResults = queryResults.where('spaceId', '=', searchParams.spaceId);
    } else if (opts.userId && !searchParams.spaceId) {
      // only search spaces the user is a member of
      queryResults = queryResults
        .where(
          'spaceId',
          'in',
          this.spaceMemberRepo.getUserSpaceIdsQuery(opts.userId),
        )
        .where('workspaceId', '=', opts.workspaceId);
    } else if (opts.publicPageIds && !opts.userId) {
      // Public space search: the allowed id set is computed from live DB
      // state by the controller on every request.
      if (opts.publicPageIds.length === 0) {
        return { items: [] };
      }
      queryResults = queryResults
        .where('id', 'in', opts.publicPageIds)
        .where('workspaceId', '=', opts.workspaceId);
    } else if (searchParams.shareId && !searchParams.spaceId && !opts.userId) {
      // search in shares
      const shareId = searchParams.shareId;
      const share = await this.shareRepo.findById(shareId);
      if (!share || share.workspaceId !== opts.workspaceId) {
        return { items: [] };
      }

      const isRestricted =
        await this.pagePermissionRepo.hasRestrictedAncestor(share.pageId);
      if (isRestricted) {
        return { items: [] };
      }

      const pageIdsToSearch = [];
      if (share.includeSubPages) {
        const pageList = await this.pageRepo.getPageAndDescendantsExcludingRestricted(
          share.pageId,
          {
            includeContent: false,
          },
        );

        pageIdsToSearch.push(...pageList.map((page) => page.id));
      } else {
        pageIdsToSearch.push(share.pageId);
      }

      if (pageIdsToSearch.length > 0) {
        queryResults = queryResults
          .where('id', 'in', pageIdsToSearch)
          .where('workspaceId', '=', opts.workspaceId);
      } else {
        return { items: [] };
      }
    } else {
      return { items: [] };
    }

    //@ts-ignore
    let results: any[] = await queryResults.execute();

    // patty fork (PAT-2331): hybrid semantic merge (RRF) for authenticated
    // member search with AI search enabled.
    const vectorHits = await vectorPromise;
    if (hybridActive && vectorHits.length > 0) {
      const scores = new Map<string, number>();
      results.forEach((r, i) =>
        scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (RRF_K + i + 1)),
      );
      vectorHits.forEach((h, i) =>
        scores.set(h.pageId, (scores.get(h.pageId) ?? 0) + 1 / (RRF_K + i + 1)),
      );

      const lexicalIds = new Set(results.map((r) => r.id));
      const vectorOnlyIds = vectorHits
        .filter((h) => !lexicalIds.has(h.pageId))
        .map((h) => h.pageId);

      if (vectorOnlyIds.length > 0) {
        const excerptById = new Map(
          vectorHits.map((h) => [h.pageId, h.excerpt]),
        );
        const vectorOnlyRows = await this.db
          .selectFrom('pages')
          .select([
            'id',
            'slugId',
            'title',
            'icon',
            'parentPageId',
            'creatorId',
            'createdAt',
            'updatedAt',
          ])
          .select((eb) => this.pageRepo.withSpace(eb))
          .where('id', 'in', vectorOnlyIds)
          .where('deletedAt', 'is', null)
          .execute();

        for (const row of vectorOnlyRows) {
          results.push({
            ...row,
            rank: 0,
            highlight: buildSnippetHighlight(
              excerptById.get(row.id) ?? '',
              query,
            ),
          });
        }
      }

      results.sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
    }

    // Filter results by page-level permissions (if user is authenticated)
    if (opts.userId && results.length > 0) {
      const pageIds = results.map((r: any) => r.id);
      const accessibleIds =
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds,
          userId: opts.userId,
          spaceId: searchParams.spaceId,
        });
      const accessibleSet = new Set(accessibleIds);
      results = results.filter((r: any) => accessibleSet.has(r.id));
    }

    if (hybridActive) {
      // single slice AFTER merge + permission filter
      results = results.slice(offset, offset + limit);
    }

    //@ts-ignore
    const searchResults = results.map((result: SearchResponseDto) => {
      result.wholeWord = true
      // patty fork (PAT-2331): JS-side highlight for CJK queries
      if (useCjkPath && !result.highlight && (result as any).textContent) {
        result.highlight = buildSnippetHighlight(
          (result as any).textContent,
          query,
        );
      }
      delete (result as any).textContent;
      if (!result.highlight) {
        result.matchedText = [];
        return result;
      }

      result.highlight = result.highlight
        .replace(/\r\n|\r|\n/g, ' ')
        .replace(/\s+/g, ' ');

      result.matchedText = [
        ...new Set(
          Array.from(
            result.highlight.matchAll(/<b>([^<]*)<\/b>/gi),
            (match) => match[1],
          ),
        ),
      ];

      return result;
    });

    return { items: searchResults };
  }

  async searchSuggestions(
    suggestion: SearchSuggestionDTO,
    userId: string,
    workspaceId: string,
  ) {
    let users = [];
    let groups = [];
    let pages = [];

    const limit = suggestion?.limit || 10;
    const query = suggestion.query.toLowerCase().trim();

    if (suggestion.includeUsers) {
      const userQuery = this.db
        .selectFrom('users')
        .select(['id', 'name', 'email', 'avatarUrl'])
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .where((eb) =>
          eb.or([
            eb(
              sql`LOWER(f_unaccent(users.name))`,
              'like',
              sql`LOWER(f_unaccent(${`%${query}%`}))`,
            ),
            eb(sql`users.email`, 'ilike', sql`f_unaccent(${`%${query}%`})`),
          ]),
        )
        .limit(limit);

      users = await userQuery.execute();
    }

    if (suggestion.includeGroups) {
      groups = await this.db
        .selectFrom('groups')
        .select(['id', 'name', 'description'])
        .where((eb) =>
          eb(
            sql`LOWER(f_unaccent(groups.name))`,
            'like',
            sql`LOWER(f_unaccent(${`%${query}%`}))`,
          ),
        )
        .where('workspaceId', '=', workspaceId)
        .limit(limit)
        .execute();
    }

    if (suggestion.includePages) {
      let pageSearch = this.db
        .selectFrom('pages')
        .select(['id', 'slugId', 'title', 'icon', 'spaceId'])
        .select((eb) => this.pageRepo.withSpace(eb))
        .where((eb) =>
          eb(
            sql`LOWER(f_unaccent(pages.title))`,
            'like',
            sql`LOWER(f_unaccent(${`%${query}%`}))`,
          ),
        )
        .where('deletedAt', 'is', null)
        .where('workspaceId', '=', workspaceId)
        .limit(limit);

      // search all spaces the user has access to, prioritizing the current space
      const userSpaceIds = await this.spaceMemberRepo.getUserSpaceIds(userId);

      if (userSpaceIds?.length > 0) {
        pageSearch = pageSearch.where('spaceId', 'in', userSpaceIds);

        if (suggestion?.spaceId) {
          pageSearch = pageSearch.orderBy(
            sql`CASE WHEN pages."space_id" = ${suggestion.spaceId} THEN 0 ELSE 1 END`,
            'asc',
          );
        }

        pages = await pageSearch.execute();
      }

      // Filter by page-level permissions
      if (pages.length > 0) {
        const pageIds = pages.map((p) => p.id);
        const accessibleIds =
          await this.pagePermissionRepo.filterAccessiblePageIds({
            pageIds,
            userId,
          });
        const accessibleSet = new Set(accessibleIds);
        pages = pages.filter((p) => accessibleSet.has(p.id));
      }
    }

    return { users, groups, pages };
  }
}
