import { Module } from '@nestjs/common';
import { EmbeddingService } from './embedding.service';
import { PageEmbeddingService } from './page-embedding.service';
import { VectorSearchService } from './vector-search.service';
import { AiAnswersService } from './ai-answers.service';
import { AiController } from './ai.controller';
import { AiQueueProcessor } from './ai.processor';
import { AiProviderService } from './ai-provider.service';

/**
 * Patty fork's open replacement for the private EE `ai` module:
 * embedding pipeline (PAT-2330), hybrid search (PAT-2331), AI answers
 * (PAT-2332); AI chat (PAT-2333) lives in the sibling ee/ai-chat module.
 */
@Module({
  controllers: [AiController],
  providers: [
    EmbeddingService,
    PageEmbeddingService,
    VectorSearchService,
    AiAnswersService,
    AiQueueProcessor,
    AiProviderService,
  ],
  exports: [
    EmbeddingService,
    PageEmbeddingService,
    VectorSearchService,
    AiAnswersService,
    AiProviderService,
  ],
})
export class AiModule {}
