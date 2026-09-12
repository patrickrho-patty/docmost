import { type Kysely, sql } from 'kysely';

// PAT-2331 follow-up: the stock pages_title_trgm_idx is an expression index
// on lower(title) — bare-column `title ILIKE` predicates (CJK search path)
// cannot use it. Add a bare-column trigram index for those.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS pages_title_bare_trgm_idx
    ON pages USING gin (title gin_trgm_ops)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS pages_title_bare_trgm_idx`.execute(db);
}
