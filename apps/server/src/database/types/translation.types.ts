import { Generated, Json, Timestamp } from '@docmost/db/types/db';

export interface TranslatedBlock {
  id: number;
  html: string;
}

// PAT-2723: cached AI translation of a page (targetLang 'ko') keyed by the
// sha256 of the source-block HTML the client sent. `status` carries the
// shared job lifecycle: in_progress while a job runs, complete when done.
export interface PageTranslation {
  id: Generated<string>;
  pageId: string;
  sourceHash: string;
  targetLang: Generated<string>;
  status: Generated<string>;
  blocks: Generated<Json>;
  doneCount: Generated<number>;
  totalCount: Generated<number>;
  createdBy: string;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}
