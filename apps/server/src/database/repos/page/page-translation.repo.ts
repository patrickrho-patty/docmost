import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Selectable, sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx } from '@docmost/db/utils';
import {
  PageTranslation,
  TranslatedBlock,
} from '@docmost/db/types/translation.types';

export type PageTranslationRow = Selectable<PageTranslation>;

/**
 * PAT-2723: cached AI page translations + shared job rows.
 *
 * One row per (pageId, sourceHash) where sourceHash is sha256 of the exact
 * source-block HTML the client sent — any page edit changes the hash and
 * therefore misses the cache. `status` carries the shared job lifecycle
 * (in_progress while a job runs, complete when done); see ai-translate.service.
 */
@Injectable()
export class PageTranslationRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findByPageAndHash(
    pageId: string,
    sourceHash: string,
    trx?: KyselyTransaction,
  ): Promise<PageTranslationRow | undefined> {
    const db = dbOrTx(this.db, trx);
    return db
      .selectFrom('pageTranslations')
      .selectAll()
      .where('pageId', '=', pageId)
      .where('sourceHash', '=', sourceHash)
      .executeTakeFirst();
  }

  /** Create the job row, or reset an existing (stale/failed) one. */
  async startJob(opts: {
    pageId: string;
    sourceHash: string;
    totalCount: number;
    createdBy: string;
  }): Promise<void> {
    await this.db
      .insertInto('pageTranslations')
      .values({
        pageId: opts.pageId,
        sourceHash: opts.sourceHash,
        totalCount: opts.totalCount,
        createdBy: opts.createdBy,
        status: 'in_progress',
        blocks: sql`'[]'::jsonb`,
        doneCount: 0,
      })
      .onConflict((oc) =>
        oc.columns(['pageId', 'sourceHash']).doUpdateSet({
          status: 'in_progress',
          blocks: sql`'[]'::jsonb`,
          doneCount: 0,
          totalCount: opts.totalCount,
          createdBy: opts.createdBy,
          updatedAt: new Date(),
        }),
      )
      .execute();
  }

  async updateBlocks(
    pageId: string,
    sourceHash: string,
    blocks: TranslatedBlock[],
  ): Promise<void> {
    await this.db
      .updateTable('pageTranslations')
      .set({
        blocks: sql`${JSON.stringify(blocks)}::text::jsonb`,
        doneCount: blocks.length,
        updatedAt: new Date(),
      })
      .where('pageId', '=', pageId)
      .where('sourceHash', '=', sourceHash)
      .execute();
  }

  async markComplete(pageId: string, sourceHash: string): Promise<void> {
    await this.db
      .updateTable('pageTranslations')
      .set({ status: 'complete', updatedAt: new Date() })
      .where('pageId', '=', pageId)
      .where('sourceHash', '=', sourceHash)
      .execute();
  }

  async deleteByPageAndHash(
    pageId: string,
    sourceHash: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .deleteFrom('pageTranslations')
      .where('pageId', '=', pageId)
      .where('sourceHash', '=', sourceHash)
      .execute();
  }
}
