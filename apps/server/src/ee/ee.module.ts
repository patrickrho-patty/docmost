import { Global, Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module';
import { AiChatModule } from './ai-chat/ai-chat.module';
import {
  AUDIT_SERVICE,
  NoopAuditService,
} from '../integrations/audit/audit.service';

/**
 * Patty fork's open EE replacement. app.module.ts loads this via
 * `require('./ee/ee.module')`. When this module loads, the stock
 * NoopAuditModule is skipped — so we must provide AUDIT_SERVICE here
 * (still a no-op implementation) to keep audit call sites working.
 */
@Global()
@Module({
  imports: [AiModule, AiChatModule],
  providers: [
    {
      provide: AUDIT_SERVICE,
      useClass: NoopAuditService,
    },
  ],
  exports: [AUDIT_SERVICE],
})
export class EeModule {}
