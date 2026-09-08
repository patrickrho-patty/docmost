import { Module } from '@nestjs/common';
import { SsoController } from './sso.controller';
import { SsoService } from './sso.service';
import { OidcAuthController } from './oidc/oidc-auth.controller';
import { OidcService } from './oidc/oidc.service';
import { OidcUserProvisionService } from './oidc/oidc-user-provision.service';
import { AuthModule } from '../auth.module';

/**
 * Community OIDC SSO for Docmost (patty fork).
 *
 * Implements the SSO provider admin API (`/api/sso/*`) and the OIDC
 * authorization-code flow (`/api/sso/oidc/:providerId/login|callback`)
 * against the tables and client UI that already ship in the open-source
 * edition. Replaces the enterprise `ee/` submodule for OIDC-only setups.
 */
@Module({
  imports: [AuthModule],
  controllers: [SsoController, OidcAuthController],
  providers: [SsoService, OidcService, OidcUserProvisionService],
  exports: [SsoService, OidcService],
})
export class SsoModule {}
