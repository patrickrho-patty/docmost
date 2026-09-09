import { Module } from '@nestjs/common';
import { AiChatController } from './ai-chat.controller';
import { AiChatService } from './ai-chat.service';
import { AiModule } from '../ai/ai.module';
import { AttachmentModule } from '../../core/attachment/attachment.module';

@Module({
  imports: [AiModule, AttachmentModule],
  controllers: [AiChatController],
  providers: [AiChatService],
})
export class AiChatModule {}
