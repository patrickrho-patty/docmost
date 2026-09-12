import { type Kysely, sql } from 'kysely';

// PAT-2331: trigram index over page body text so the Korean/CJK lexical
// path (ILIKE + similarity) does not seq-scan. The stock 'english' FTS
// cannot segment CJK, so Korean body search goes through pg_trgm.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS pages_text_content_trgm_idx
    ON pages USING gin (text_content gin_trgm_ops)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS pages_text_content_trgm_idx`.execute(db);
}
