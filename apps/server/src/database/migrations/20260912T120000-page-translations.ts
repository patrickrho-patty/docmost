import { type Kysely, sql } from 'kysely';

// PAT-2723: cached AI page translations + shared job state.
//
// One row per (page, source content hash, target language). `source_hash` is
// sha256 of the exact source-block HTML the client sent, so any page edit
// invalidates automatically (hash mismatch = cache miss = retranslate).
// `status` carries the shared job lifecycle: a row is created in_progress
// when a translation job starts, accumulates validated `blocks` as they
// stream in, and flips to complete when the job finishes. Clients poll this
// via POST /ai/translate/status to see in-progress jobs started by others.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('page_translations')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('page_id', 'uuid', (col) =>
      col.references('pages.id').onDelete('cascade').notNull(),
    )
    .addColumn('source_hash', 'text', (col) => col.notNull())
    .addColumn('target_lang', 'varchar(10)', (col) =>
      col.notNull().defaultTo('ko'),
    )
    .addColumn('status', 'varchar(20)', (col) =>
      col.notNull().defaultTo('in_progress'),
    )
    .addColumn('blocks', 'jsonb', (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addColumn('done_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('total_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_by', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // one cached translation per page version. Non-partial on purpose: the
  // startJob upsert uses plain ON CONFLICT (columns), which cannot target a
  // partial unique index. target_lang is always 'ko' for now; adding a
  // second language later means widening this index, not just the column.
  await db.schema
    .createIndex('idx_page_translations_page_hash')
    .ifNotExists()
    .on('page_translations')
    .columns(['page_id', 'source_hash'])
    .unique()
    .execute();

  await db.schema
    .createIndex('idx_page_translations_page')
    .ifNotExists()
    .on('page_translations')
    .columns(['page_id'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('page_translations').ifExists().execute();
}
