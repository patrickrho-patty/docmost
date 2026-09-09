import { type Kysely, sql } from 'kysely';

// PAT-2330: chunk embeddings for AI semantic search.
// Schema follows the upstream EE stub (`@docmost/db/types/embeddings.types`),
// with nullable page_id/attachment_id (a row embeds either) and a `content`
// column so RAG excerpts don't need a join back to pages.
//
// Dimension comes from AI_EMBEDDING_DIMENSION (default 1024 = bge-m3).
// Changing it later requires rebuilding this table.
export async function up(db: Kysely<any>): Promise<void> {
  const dim = parseInt(process.env.AI_EMBEDDING_DIMENSION ?? '1024', 10);
  if (!Number.isInteger(dim) || dim < 1 || dim > 16000) {
    throw new Error(
      `Invalid AI_EMBEDDING_DIMENSION: "${process.env.AI_EMBEDDING_DIMENSION}"`,
    );
  }

  await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db);

  await db.schema
    .createTable('page_embeddings')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('page_id', 'uuid', (col) =>
      col.references('pages.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.references('spaces.id').onDelete('cascade'),
    )
    .addColumn('attachment_id', 'uuid', (col) =>
      col.references('attachments.id').onDelete('cascade'),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.references('workspaces.id').onDelete('cascade').notNull(),
    )
    .addColumn('model_name', 'varchar', (col) => col.notNull())
    .addColumn('model_dimensions', 'integer', (col) => col.notNull())
    .addColumn('chunk_index', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('chunk_start', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('chunk_length', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('metadata', 'jsonb', (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn(
      'embedding',
      sql`vector(${sql.raw(String(dim))})`,
      (col) => col.notNull(),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('deleted_at', 'timestamptz', (col) => col)
    .execute();

  await db.schema
    .createIndex('idx_page_embeddings_workspace')
    .ifNotExists()
    .on('page_embeddings')
    .columns(['workspace_id'])
    .execute();

  await db.schema
    .createIndex('idx_page_embeddings_page')
    .ifNotExists()
    .on('page_embeddings')
    .columns(['page_id'])
    .execute();

  // one row per (page, chunk)
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_page_embeddings_page_chunk
    ON page_embeddings (page_id, chunk_index)
    WHERE page_id IS NOT NULL AND deleted_at IS NULL
  `.execute(db);

  // approximate nearest-neighbour search (cosine)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_page_embeddings_embedding_hnsw
    ON page_embeddings USING hnsw (embedding vector_cosine_ops)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('page_embeddings').ifExists().execute();
}
