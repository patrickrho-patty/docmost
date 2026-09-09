import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { PageEmbeddingService } from './page-embedding.service';

interface IPageEmbeddingJob {
  pageIds: string[];
  workspaceId?: string;
}

interface IWorkspaceEmbeddingJob {
  workspaceId: string;
}

/**
 * PAT-2330: consumes the AI_QUEUE jobs emitted by page.listener.ts (page
 * lifecycle), persistence.extension.ts (collab content saves), and
 * workspace.service.ts (AI search enable/disable backfill).
 */
@Processor(QueueName.AI_QUEUE)
export class AiQueueProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(AiQueueProcessor.name);

  constructor(private readonly pageEmbeddingService: PageEmbeddingService) {
    super();
  }

  async process(job: Job): Promise<void> {
    try {
      switch (job.name) {
        case QueueJob.PAGE_CREATED:
        case QueueJob.PAGE_UPDATED:
        case QueueJob.PAGE_RESTORED:
        case QueueJob.PAGE_CONTENT_UPDATED: {
          const { pageIds } = job.data as IPageEmbeddingJob;
          await this.pageEmbeddingService.embedPages(pageIds);
          break;
        }

        case QueueJob.PAGE_DELETED:
        case QueueJob.PAGE_SOFT_DELETED: {
          const { pageIds } = job.data as IPageEmbeddingJob;
          await this.pageEmbeddingService.deleteByPageIds(pageIds);
          break;
        }

        case QueueJob.WORKSPACE_CREATE_EMBEDDINGS: {
          const { workspaceId } = job.data as IWorkspaceEmbeddingJob;
          await this.pageEmbeddingService.backfillWorkspace(workspaceId);
          break;
        }

        case QueueJob.WORKSPACE_DELETE_EMBEDDINGS: {
          const { workspaceId } = job.data as IWorkspaceEmbeddingJob;
          await this.pageEmbeddingService.deleteByWorkspaceId(workspaceId);
          break;
        }

        default:
          this.logger.warn(`Unhandled AI queue job: ${job.name}`);
      }
    } catch (err) {
      this.logger.error(`AI queue job ${job.name} failed`, err);
      throw err;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
