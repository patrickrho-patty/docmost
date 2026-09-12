import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { AiAnswersService } from './ai-answers.service';
import { AiTranslateService, TranslateBlock } from './ai-translate.service';
import { initSseResponse } from './ai-stream.util';
import { getAiSettings } from '../../common/helpers';

export class AiAnswersDto {
  @IsNotEmpty()
  @IsString()
  query: string;

  @IsOptional()
  @IsUUID()
  spaceId?: string;
}

export class AiTranslateDto {
  @IsNotEmpty()
  @IsUUID()
  pageId: string;

  @IsArray()
  blocks: TranslateBlock[];

  /**
   * Client-computed version key: sha256 (hex) of the blocks' normalized
   * text. Every viewer derives the identical key from the same document
   * (HTML serialization would be browser-dependent; text is not), so jobs
   * and cache entries are shared across users. See use-page-translate.ts.
   */
  @IsNotEmpty()
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  sourceHash: string;

  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class AiTranslateStatusDto {
  @IsNotEmpty()
  @IsUUID()
  pageId: string;

  @IsNotEmpty()
  @IsString()
  sourceHash: string;
}

/**
 * PAT-2332: AI answers (SSE) matching the client contract in
 * apps/client/src/ee/ai/services/ai-search-service.ts:
 *   data: {"content": "..."}   — streamed answer text
 *   data: {"sources": [...]}   — cited pages
 *   data: {"error": "..."}     — failure
 *   data: [DONE]               — end of stream
 */
@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(
    private readonly aiAnswersService: AiAnswersService,
    private readonly aiTranslateService: AiTranslateService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('answers')
  async answers(
    @Body() dto: AiAnswersDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Res() res: FastifyReply,
  ) {
    if (getAiSettings(workspace).search !== true) {
      throw new ForbiddenException('AI search is not enabled');
    }
    if (!dto.query?.trim()) {
      throw new BadRequestException('query is required');
    }

    const sse = initSseResponse(res);

    // stop burning LLM tokens when the client disconnects
    const abort = new AbortController();
    sse.bindAbort(abort);

    try {
      await this.aiAnswersService.streamAnswer({
        query: dto.query,
        workspaceId: workspace.id,
        userId: user.id,
        spaceId: dto.spaceId,
        write: (obj) => sse.emit(obj),
        signal: abort.signal,
      });
    } catch (err) {
      this.logger.error(`AI answers failed: ${err?.['message'] ?? err}`);
      sse.emit({ error: 'Failed to generate an answer' });
    } finally {
      sse.close();
    }
  }

  // Client sends this as a best-effort warm-up signal; no-op in this fork.
  @HttpCode(HttpStatus.OK)
  @Post('vector-cache-hint')
  vectorCacheHint() {
    return { success: true };
  }

  /**
   * PAT-2723: view-only AI translation of a page into Korean (SSE).
   * Blocks arrive from the client (what the reader is rendering); each
   * finished translation streams back as {"block":{id,html}} so the view
   * fills in progressively. See use-page-translate.ts for the client half.
   *
   * Unlike /answers, client disconnect does NOT abort the job: translation
   * is shared state — other viewers may be watching the same stream, and a
   * finished job warms the per-page-version cache.
   */
  @HttpCode(HttpStatus.OK)
  @Post('translate')
  async translate(
    @Body() dto: AiTranslateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Res() res: FastifyReply,
  ) {
    if (getAiSettings(workspace).search !== true) {
      throw new ForbiddenException('AI is not enabled');
    }

    const sse = initSseResponse(res);

    try {
      await this.aiTranslateService.streamPageTranslation({
        pageId: dto.pageId,
        blocks: dto.blocks ?? [],
        sourceHash: dto.sourceHash,
        userId: user.id,
        force: dto.force === true,
        write: (obj) => sse.emit(obj),
      });
    } catch (err) {
      this.logger.error(`AI translate failed: ${err?.['message'] ?? err}`);
      sse.emit({ error: 'Failed to translate the page' });
    } finally {
      sse.close();
    }
  }

  /**
   * PAT-2723: lightweight job-state probe for the translate toggle's status
   * poller. Plain JSON (not SSE): { state: 'none' | 'in_progress' | 'cached',
   * done?, total? }.
   */
  @HttpCode(HttpStatus.OK)
  @Post('translate/status')
  async translateStatus(
    @Body() dto: AiTranslateStatusDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if (getAiSettings(workspace).search !== true) {
      throw new ForbiddenException('AI is not enabled');
    }

    const status = await this.aiTranslateService.getStatus({
      pageId: dto.pageId,
      sourceHash: dto.sourceHash,
      userId: user.id,
    });
    if (status === null) {
      throw new NotFoundException('Page not found');
    }
    return status;
  }
}
