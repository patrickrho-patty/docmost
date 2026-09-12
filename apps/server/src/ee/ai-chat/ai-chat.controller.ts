import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '../../common/interceptors/file.interceptor';
import { FastifyReply } from 'fastify';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { AiChatService, SendMessageInput } from './ai-chat.service';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { AttachmentService } from '../../core/attachment/services/attachment.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { AttachmentType } from '../../core/attachment/attachment.constants';
import { initSseResponse } from '../ai/ai-stream.util';
import { getAiSettings } from '../../common/helpers';
import * as bytes from 'bytes';

class ListChatsDto {
  @IsOptional()
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;
}

class ChatIdDto {
  @IsNotEmpty()
  @IsUUID()
  chatId: string;
}

class UpdateChatDto extends ChatIdDto {
  @IsOptional()
  @IsString()
  title?: string;
}

class SearchChatsDto {
  @IsNotEmpty()
  @IsString()
  query: string;
}

class SendMessageDto {
  @IsOptional()
  @IsUUID()
  chatId?: string;

  @IsNotEmpty()
  @IsString()
  content: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  mentionedPageIds?: string[];

  @IsOptional()
  @IsUUID()
  contextPageId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  attachmentIds?: string[];
}

function requireAiChatEnabled(workspace: Workspace) {
  if (getAiSettings(workspace).chat !== true) {
    throw new ForbiddenException('AI chat is not enabled');
  }
}

/**
 * PAT-2333: AI chat API matching the client contract in
 * apps/client/src/ee/ai-chat/services/ai-chat-service.ts.
 */
@Controller('ai/chats')
@UseGuards(JwtAuthGuard)
export class AiChatController {
  private readonly logger = new Logger(AiChatController.name);

  constructor(
    private readonly aiChatService: AiChatService,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly attachmentService: AttachmentService,
    private readonly environmentService: EnvironmentService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    requireAiChatEnabled(workspace);
    return this.aiChatService.createChat(workspace.id, user.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post()
  async list(
    @Body() dto: ListChatsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    requireAiChatEnabled(workspace);
    return this.aiChatService.listChats(workspace.id, user.id, {
      limit: dto.limit,
      cursor: dto.cursor,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('info')
  async info(
    @Body() dto: ChatIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    requireAiChatEnabled(workspace);
    return this.aiChatService.getChatInfo(dto.chatId, workspace.id, user.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async update(
    @Body() dto: UpdateChatDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    requireAiChatEnabled(workspace);
    await this.aiChatService.updateChatTitle(
      dto.chatId,
      dto.title,
      workspace.id,
      user.id,
    );
    return { success: true };
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async delete(
    @Body() dto: ChatIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    requireAiChatEnabled(workspace);
    await this.aiChatService.deleteChat(dto.chatId, workspace.id, user.id);
    return { success: true };
  }

  @HttpCode(HttpStatus.OK)
  @Post('search')
  async search(
    @Body() dto: SearchChatsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    requireAiChatEnabled(workspace);
    return this.aiChatService.searchChats(dto.query, workspace.id, user.id);
  }

  /**
   * Chat file upload. Policy (chat ownership) stays here; file mechanics
   * go through AttachmentService like every other upload.
   */
  @Post('upload')
  @UseInterceptors(FileInterceptor)
  async upload(
    @Req() req: any,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    requireAiChatEnabled(workspace);

    const maxFileSize = bytes(this.environmentService.getFileUploadSizeLimit());
    let file = null;
    try {
      file = await req.file({
        limits: { fileSize: maxFileSize, fields: 3, files: 1 },
      });
    } catch (err: any) {
      this.logger.error(err?.message);
      throw new BadRequestException('Failed to upload file');
    }
    if (!file) throw new BadRequestException('Failed to upload file');

    const chatId = file.fields?.chatId?.value || null;

    // chat ownership: an upload may only attach to the caller's own chat
    if (chatId) {
      await this.aiChatService.findOwnChat(chatId, workspace.id, user.id);
    }

    const attachment = await this.attachmentService.uploadFile({
      filePromise: Promise.resolve(file),
      userId: user.id,
      workspaceId: workspace.id,
      type: AttachmentType.Chat,
      aiChatId: chatId,
    });
    if (!attachment) {
      throw new BadRequestException('Error processing file upload.');
    }

    const { id, fileName, fileExt, fileSize, mimeType } = attachment;
    return { id, fileName, fileExt, fileSize, mimeType };
  }

  /**
   * SSE chat turn. Event contract:
   *   data: {"type":"chat_created","chatId":"..."}
   *   data: {"type":"content","text":"..."}
   *   data: {"type":"done","messageId":"..."}
   *   data: {"type":"error","message":"..."}
   *   data: [DONE]
   */
  @HttpCode(HttpStatus.OK)
  @Post('send')
  async send(
    @Body() dto: SendMessageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Res() res: FastifyReply,
  ) {
    requireAiChatEnabled(workspace);
    if (getAiSettings(workspace).chatReadOnly === true) {
      throw new ForbiddenException('AI chat is read-only in this workspace');
    }

    const sse = initSseResponse(res);

    // stop burning LLM tokens when the client disconnects
    const abort = new AbortController();
    sse.bindAbort(abort);

    const input: SendMessageInput = {
      chatId: dto.chatId,
      content: dto.content,
      mentionedPageIds: dto.mentionedPageIds,
      contextPageId: dto.contextPageId,
      attachmentIds: dto.attachmentIds,
    };

    try {
      await this.aiChatService.sendMessage({
        input,
        workspaceId: workspace.id,
        userId: user.id,
        emit: (evt) => sse.emit(evt),
        signal: abort.signal,
        knowledgeOnly: getAiSettings(workspace).chatWorkspaceKnowledgeOnly === true,
      });
    } catch (err) {
      this.logger.error(`AI chat send failed: ${err?.['message'] ?? err}`);
      sse.emit({ type: 'error', message: 'Failed to generate a response' });
    } finally {
      sse.close();
    }
  }
}
