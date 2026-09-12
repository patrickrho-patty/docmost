import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventName } from '../../common/events/event.contants';
import { InjectQueue } from '@nestjs/bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { Queue } from 'bullmq';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { embedJobOptions } from '../../integrations/queue/embed-job.utils';

export class PageEvent {
  pageIds: string[];
  workspaceId: string;
}

@Injectable()
export class PageListener {
  private readonly logger = new Logger(PageListener.name);

  constructor(
    private readonly environmentService: EnvironmentService,
    @InjectQueue(QueueName.SEARCH_QUEUE) private searchQueue: Queue,
    @InjectQueue(QueueName.AI_QUEUE) private aiQueue: Queue,
  ) {}

  @OnEvent(EventName.PAGE_CREATED)
  async handlePageCreated(event: PageEvent) {
    const { pageIds, workspaceId } = event;
    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_CREATED, {
        pageIds,
      });
    }

    await this.aiQueue.add(
      QueueJob.PAGE_CREATED,
      { pageIds, workspaceId },
      embedJobOptions(pageIds),
    );
  }

  @OnEvent(EventName.PAGE_UPDATED)
  async handlePageUpdated(event: PageEvent) {
    const { pageIds, workspaceId } = event;

    await this.searchQueue.add(QueueJob.PAGE_UPDATED, { pageIds });

    // patty fork (PAT-2330): keep embeddings fresh on content updates too.
    // The collab persistence path also enqueues PAGE_CONTENT_UPDATED;
    // identical jobIds coalesce the burst into one delayed job.
    await this.aiQueue.add(
      QueueJob.PAGE_UPDATED,
      { pageIds, workspaceId },
      embedJobOptions(pageIds),
    );
  }

  @OnEvent(EventName.PAGE_DELETED)
  async handlePageDeleted(event: PageEvent) {
    const { pageIds, workspaceId } = event;
    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_DELETED, { pageIds });
    }

    await this.aiQueue.add(QueueJob.PAGE_DELETED, { pageIds, workspaceId });
  }

  @OnEvent(EventName.PAGE_SOFT_DELETED)
  async handlePageSoftDeleted(event: PageEvent) {
    const { pageIds, workspaceId } = event;

    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_SOFT_DELETED, { pageIds });
    }

    await this.aiQueue.add(QueueJob.PAGE_SOFT_DELETED, {
      pageIds,
      workspaceId,
    });
  }

  @OnEvent(EventName.PAGE_RESTORED)
  async handlePageRestored(event: PageEvent) {
    const { pageIds, workspaceId } = event;
    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_RESTORED, { pageIds });
    }

    await this.aiQueue.add(QueueJob.PAGE_RESTORED, { pageIds, workspaceId }, embedJobOptions(pageIds));
  }

  isTypesense(): boolean {
    return this.environmentService.getSearchDriver() === 'typesense';
  }
}
