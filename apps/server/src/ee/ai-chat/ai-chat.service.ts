import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { sql } from 'kysely';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { escapeLike } from '../../common/helpers';
import { streamCompletionDeltas } from '../ai/ai-stream.util';
import { AiProviderService, AiProviderError } from '../ai/ai-provider.service';
import { AiAnswersService, citedChunksWithNumbers } from '../ai/ai-answers.service';

const HISTORY_LIMIT = 20;
const CONTEXT_PAGE_MAX_CHARS = 4000;
const ATTACHMENT_MAX_CHARS = 8000;

export interface SendMessageInput {
  chatId?: string;
  content: string;
  mentionedPageIds?: string[];
  contextPageId?: string;
  attachmentIds?: string[];
}

export type ChatStreamEvent =
  | { type: 'chat_created'; chatId: string }
  | { type: 'content'; text: string }
  | { type: 'done'; messageId: string }
  | { type: 'error'; message: string };

/**
 * PAT-2333: AI chat with workspace RAG. Conversation history is stored in
 * ai_chats / ai_chat_messages (pre-migrated upstream tables). Retrieval reuses
 * the PAT-2332 permission-filtered chunk search; streaming reuses the M3
 * think-tag filter.
 */
@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly aiAnswersService: AiAnswersService,
    private readonly aiProvider: AiProviderService,
  ) {}

  async createChat(workspaceId: string, userId: string) {
    return this.db
      .insertInto('aiChats')
      .values({ workspaceId, creatorId: userId })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async listChats(
    workspaceId: string,
    userId: string,
    opts: { limit?: number; cursor?: string },
  ) {
    const query = this.db
      .selectFrom('aiChats')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('creatorId', '=', userId)
      .where('deletedAt', 'is', null);

    return executeWithCursorPagination(query, {
      perPage: opts.limit || 25,
      cursor: opts.cursor,
      fields: [
        { expression: 'updatedAt', direction: 'desc' },
        { expression: 'id', direction: 'desc' },
      ],
      parseCursor: (cursor) => ({
        updatedAt: new Date(cursor.updatedAt),
        id: cursor.id,
      }),
    });
  }

  async findOwnChat(chatId: string, workspaceId: string, userId: string) {
    const chat = await this.db
      .selectFrom('aiChats')
      .selectAll()
      .where('id', '=', chatId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!chat) throw new NotFoundException('Chat not found');
    if (chat.creatorId !== userId) throw new ForbiddenException();
    return chat;
  }

  async getChatInfo(chatId: string, workspaceId: string, userId: string) {
    const chat = await this.findOwnChat(chatId, workspaceId, userId);
    const messages = await this.db
      .selectFrom('aiChatMessages')
      .select(['id', 'chatId', 'role', 'content', 'toolCalls', 'metadata', 'createdAt'])
      .where('chatId', '=', chatId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .limit(200)
      .execute();
    return { chat, messages };
  }

  async updateChatTitle(
    chatId: string,
    title: string,
    workspaceId: string,
    userId: string,
  ) {
    await this.findOwnChat(chatId, workspaceId, userId);
    await this.db
      .updateTable('aiChats')
      .set({ title: title?.slice(0, 255) || null, updatedAt: new Date() })
      .where('id', '=', chatId)
      .execute();
  }

  async deleteChat(chatId: string, workspaceId: string, userId: string) {
    await this.findOwnChat(chatId, workspaceId, userId);
    await this.db
      .updateTable('aiChats')
      .set({ deletedAt: new Date() })
      .where('id', '=', chatId)
      .execute();
    await this.db
      .updateTable('aiChatMessages')
      .set({ deletedAt: new Date() })
      .where('chatId', '=', chatId)
      .execute();
  }

  async searchChats(query: string, workspaceId: string, userId: string) {
    const q = query.trim();
    if (!q) return [];
    const like = `%${escapeLike(q)}%`;

    return this.db
      .selectFrom('aiChats')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('creatorId', '=', userId)
      .where('deletedAt', 'is', null)
      .where((eb) =>
        eb.or([
          eb(sql`lower(coalesce(ai_chats.title, ''))`, 'like', sql`lower(${like})`),
          eb(
            'id',
            'in',
            this.db
              .selectFrom('aiChatMessages')
              .select('chatId')
              .where('workspaceId', '=', workspaceId)
              .where('deletedAt', 'is', null)
              .where(
                sql`lower(coalesce(ai_chat_messages.content, ''))`,
                'like',
                sql`lower(${like})`,
              ),
          ),
        ]),
      )
      .orderBy('updatedAt', 'desc')
      .limit(25)
      .execute();
  }

  /** Persists a message row and returns it. */
  private async saveMessage(opts: {
    chatId: string;
    workspaceId: string;
    userId: string | null;
    role: 'user' | 'assistant';
    content: string;
    metadata?: Record<string, unknown>;
  }) {
    return this.db
      .insertInto('aiChatMessages')
      .values({
        chatId: opts.chatId,
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        role: opts.role,
        content: opts.content,
        metadata: opts.metadata
          ? (sql`${JSON.stringify(opts.metadata)}::text::jsonb` as never)
          : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  private async loadHistory(chatId: string) {
    const rows = await this.db
      .selectFrom('aiChatMessages')
      .select(['role', 'content'])
      .where('chatId', '=', chatId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(HISTORY_LIMIT)
      .execute();
    return rows.reverse();
  }

  /**
   * Context blocks for context/mentioned pages. Pages outside the user's
   * spaces — or restricted by page-level permissions — are excluded.
   */
  private async getPageContextBlocks(
    pageIds: string[],
    userId: string,
    userSpaceIds: string[],
  ): Promise<string[]> {
    const uniqueIds = [...new Set(pageIds)];
    if (uniqueIds.length === 0) return [];

    const pages = (
      await Promise.all(
        uniqueIds.map((id) =>
          this.pageRepo.findById(id, { includeTextContent: true }),
        ),
      )
    ).filter((p) => p && !p.deletedAt && userSpaceIds.includes(p.spaceId));
    if (pages.length === 0) return [];

    const accessible = new Set(
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds: pages.map((p) => p.id),
        userId,
      }),
    );

    return pages
      .filter((p) => accessible.has(p.id))
      .map(
        (p) =>
          `[Page: "${p.title}"]\n${(p.textContent ?? '').slice(0, CONTEXT_PAGE_MAX_CHARS)}`,
      );
  }

  private async getAttachmentContext(
    attachmentIds: string[],
    workspaceId: string,
  ): Promise<string> {
    if (!attachmentIds?.length) return '';
    const rows = await this.db
      .selectFrom('attachments')
      .select(['id', 'fileName', 'fileExt', 'mimeType'])
      .where('id', 'in', attachmentIds)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .execute();

    // Content extraction is intentionally conservative: only the file names
    // are surfaced to the model. (Binary parsing lives in attachment indexing,
    // which is out of scope for this fork.)
    if (rows.length === 0) return '';
    return rows.map((r) => `[Attached file: ${r.fileName}]`).join('\n');
  }

  /**
   * Streams a chat turn. `emit` receives ChatStreamEvent objects.
   */
  async sendMessage(opts: {
    input: SendMessageInput;
    workspaceId: string;
    userId: string;
    emit: (evt: ChatStreamEvent) => void;
    signal?: AbortSignal;
    knowledgeOnly?: boolean;
  }): Promise<void> {
    const { input, workspaceId, userId, emit, signal } = opts;

    if (!input.content?.trim()) {
      emit({ type: 'error', message: 'content is required' });
      return;
    }

    let chatId = input.chatId;
    if (chatId) {
      await this.findOwnChat(chatId, workspaceId, userId);
    } else {
      const chat = await this.createChat(workspaceId, userId);
      chatId = chat.id;
      emit({ type: 'chat_created', chatId });
    }

    // persist user message
    await this.saveMessage({
      chatId,
      workspaceId,
      userId,
      role: 'user',
      content: input.content,
      metadata: {
        mentionedPageIds: input.mentionedPageIds ?? [],
        contextPageId: input.contextPageId ?? null,
        attachmentIds: input.attachmentIds ?? [],
      },
    });

    // auto-title new chats from the first message
    await this.db
      .updateTable('aiChats')
      .set({ title: input.content.slice(0, 80), updatedAt: new Date() })
      .where('id', '=', chatId)
      .where('title', 'is', null)
      .execute();

    // ---- assemble context (independent lookups in parallel) ----
    const pageIds = [
      ...(input.contextPageId ? [input.contextPageId] : []),
      ...(input.mentionedPageIds ?? []),
    ];

    const [userSpaceIds, history] = await Promise.all([
      this.spaceMemberRepo.getUserSpaceIds(userId),
      this.loadHistory(chatId),
    ]);

    const [pageBlocks, attachmentBlock, ragChunks] = await Promise.all([
      this.getPageContextBlocks(pageIds, userId, userSpaceIds).catch((err) => {
        this.logger.warn(`context pages skipped: ${err?.['message']}`);
        return [] as string[];
      }),
      this.getAttachmentContext(input.attachmentIds ?? [], workspaceId),
      this.aiAnswersService
        .retrieveChunks({
          query: input.content,
          workspaceId,
          userId,
          limit: 8,
          userSpaceIds,
        })
        .catch((err) => {
          this.logger.warn(`RAG retrieval failed: ${err?.['message']}`);
          return [];
        }),
    ]);

    const contextBlocks: string[] = [...pageBlocks];
    if (attachmentBlock) contextBlocks.push(attachmentBlock);

    if (ragChunks.length > 0) {
      contextBlocks.push(
        ragChunks
          .map((c, i) => `[${i + 1}] (page: "${c.title}")\n${c.content}`)
          .join('\n\n'),
      );
    }

    // drop the just-saved user message from history; it goes in as the last turn
    const prior = history.slice(0, -1);

    const knowledgeOnly = opts.knowledgeOnly === true;
    const systemPrompt = [
      'You are the AI assistant of this knowledge base, in a chat conversation.',
      knowledgeOnly
        ? 'Answer ONLY from the provided workspace context, citing chunk numbers inline as [1], [2] when you use them. If it does not contain the answer, say you could not find it in the workspace documents — do not use general knowledge.'
        : 'Prefer the provided workspace context (numbered chunks and named pages) over general knowledge, and cite chunk numbers inline as [1], [2] when you use them.',
      'Give thorough, well-structured answers: cover all relevant details from the context (steps, numbers, conditions, exceptions), using short sections or bullet lists when that helps readability.',
      'Always answer in the same language as the user (Korean question -> Korean answer).',
      ...(knowledgeOnly
        ? []
        : [
            'If the workspace context does not contain the answer, say so honestly before falling back to general knowledge, and mark general knowledge clearly.',
          ]),
      '',
      'Workspace context:',
      contextBlocks.length > 0
        ? contextBlocks.join('\n\n')
        : '(no relevant workspace context found)',
    ].join('\n');

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...prior
        .filter((m) => m.content && (m.role === 'user' || m.role === 'assistant'))
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: input.content },
    ];

    let response: Response;
    try {
      response = await this.aiProvider.streamChatCompletion({
        messages,
        model: 'chat',
        signal,
      });
    } catch (err) {
      if (signal?.aborted) return;
      if (err instanceof AiProviderError) {
        emit({ type: 'error', message: err.message });
        return;
      }
      throw err;
    }

    const fullText = await streamCompletionDeltas(response, (text) => {
      if (!signal?.aborted) emit({ type: 'content', text });
    });

    // client disconnected mid-stream — don't persist a partial answer
    if (signal?.aborted) return;

    // provider returned nothing parseable — surface an error instead of
    // persisting an empty assistant message
    if (!fullText.trim()) {
      this.logger.error('AI provider returned an empty stream');
      emit({
        type: 'error',
        message: 'The AI provider returned an empty response',
      });
      return;
    }

    // persist only the sources the answer actually cites, with their [n] numbers
    const citedChunks = citedChunksWithNumbers(ragChunks, fullText);
    const sourceNote =
      citedChunks.length > 0
        ? JSON.stringify(this.aiAnswersService.buildSources(citedChunks))
        : '';

    const [assistantMessage] = await Promise.all([
      this.saveMessage({
        chatId,
        workspaceId,
        userId: null,
        role: 'assistant',
        content: fullText,
        metadata: sourceNote ? { sources: JSON.parse(sourceNote) } : undefined,
      }),
      this.db
        .updateTable('aiChats')
        .set({ updatedAt: new Date() })
        .where('id', '=', chatId)
        .execute(),
    ]);

    emit({ type: 'done', messageId: assistantMessage.id });
  }
}
