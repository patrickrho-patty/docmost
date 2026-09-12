import { DB } from '@docmost/db/types/db';
import { PageEmbeddings } from '@docmost/db/types/embeddings.types';
import { PageTranslation } from '@docmost/db/types/translation.types';

export interface DbInterface extends DB {
  pageEmbeddings: PageEmbeddings;
  pageTranslations: PageTranslation;
}
