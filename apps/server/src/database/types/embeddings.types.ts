import { Json, Timestamp, Generated } from '@docmost/db/types/db';

// embeddings type (upstream EE stub; patty fork adjustments:
// pageId/attachmentId are nullable — a row embeds either a page or an
// attachment — and `content` stores the chunk text for RAG excerpts)
export interface PageEmbeddings {
  id: Generated<string>;
  pageId: string | null;
  spaceId: string | null;
  modelName: string;
  modelDimensions: number;
  workspaceId: string;
  attachmentId: string | null;
  content: string;
  embedding: number[];
  chunkIndex: Generated<number>;
  chunkStart: Generated<number>;
  chunkLength: Generated<number>;
  metadata: Generated<Json>;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
  deletedAt: Timestamp | null;
}
