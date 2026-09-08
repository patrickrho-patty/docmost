import {
  Controller,
  Get,
  HttpStatus,
  Logger,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { EnvironmentService } from '../../../../integrations/environment/environment.service';
import { SessionService } from '../../../session/session.service';
import { Public } from '../../../../common/decorators/public.decorator';
import { SkipTransform } from '../../../../common/decorators/skip-transform.decorator';
import { OidcService } from './oidc.service';
import { OidcUserProvisionService } from './oidc-user-provision.service';
import { SsoService } from '../sso.service';
import type { AuthProvider } from '@docmost/db/types/entity.types';
import {
  SSO_TXN_COOKIE,
  SSO_TXN_COOKIE_MAX_AGE,
} from '../sso.constants';

interface OidcTxn {
  providerId: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  redirect: string | null;
}

@Public()
@Controller('sso/oidc')
export class OidcAuthController {
  private readonly logger = new Logger(OidcAuthController.name);

  constructor(
    private ssoService: SsoService,
    private oidcService: OidcService,
    private provisionService: OidcUserProvisionService,
    private sessionService: SessionService,
    private environmentService: EnvironmentService,
  ) {}

  @SkipTransform()
  @Get(':providerId/login')
  async login(
    @Param('providerId') providerId: string,
    @Query('redirect') redirect: string | undefined,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const workspaceId = (req.raw as any).workspaceId as string | null;
    if (!workspaceId) {
      return this.redirectToLogin(res, 'workspace-not-found');
    }

    const provider = await this.ssoService.getProviderById(
      providerId,
      workspaceId,
    );
    if (!provider || !provider.isEnabled || provider.type !== 'oidc') {
      return this.redirectToLogin(res, 'provider-not-found');
    }

    const callbackUrl = this.buildCallbackUrl(providerId);

    let authRequest;
    try {
      authRequest = await this.oidcService.buildAuthorizationRequest(
        provider.oidcIssuer,
        provider.oidcClientId,
        provider.oidcClientSecret,
        callbackUrl,
      );
    } catch (err) {
      this.logger.error(
        `failed to build OIDC authorization request for provider ${provider.name}: ${(err as Error).message}`,
      );
      return this.redirectToLogin(res, 'idp-unreachable');
    }

    const txn: OidcTxn = {
      providerId,
      state: authRequest.state,
      nonce: authRequest.nonce,
      codeVerifier: authRequest.codeVerifier,
      redirect: this.sanitizeRedirect(redirect),
    };

    res.setCookie(SSO_TXN_COOKIE, Buffer.from(JSON.stringify(txn)).toString('base64url'), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SSO_TXN_COOKIE_MAX_AGE,
      secure: this.environmentService.isHttps(),
    });

    return res.redirect(authRequest.authorizationUrl, HttpStatus.FOUND);
  }

  @SkipTransform()
  @Get(':providerId/callback')
  async callback(
    @Param('providerId') providerId: string,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const workspaceId = (req.raw as any).workspaceId as string | null;
    if (!workspaceId) {
      return this.redirectToLogin(res, 'workspace-not-found');
    }

    const txn = this.readTxnCookie(req);
    if (!txn || txn.providerId !== providerId) {
      return this.redirectToLogin(res, 'invalid-state');
    }

    const provider = await this.ssoService.getProviderById(
      providerId,
      workspaceId,
    );
    if (!provider || !provider.isEnabled || provider.type !== 'oidc') {
      return this.redirectToLogin(res, 'provider-not-found');
    }

    // rebuild the callback URL from trusted config + the incoming query
    // to survive reverse proxies that strip scheme/host information
    const requestUrl = new URL(this.buildCallbackUrl(providerId));
    requestUrl.search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

    let userInfo;
    try {
      userInfo = await this.oidcService.exchangeCodeForUserInfo(
        provider.oidcIssuer,
        provider.oidcClientId,
        provider.oidcClientSecret,
        requestUrl.href,
        txn.state,
        txn.nonce,
        txn.codeVerifier,
      );
    } catch (err) {
      this.logger.warn(`OIDC callback rejected: ${(err as Error).message}`);
      return this.redirectToLogin(res, 'idp-login-failed');
    }

    // group-based access control: enforced on every login (new and existing users)
    if (!this.isGroupAllowed(provider, userInfo.groups)) {
      this.logger.warn(
        `OIDC login denied: user is not in any allowed group for provider ${provider.name}`,
      );
      return this.redirectToLogin(res, 'group-not-authorized');
    }

    let user;
    try {
      user = await this.provisionService.resolveOrCreateUser(
        provider,
        userInfo,
        workspaceId,
      );
    } catch (err) {
      this.logger.warn(`OIDC user provisioning rejected: ${(err as Error).message}`);
      return this.redirectToLogin(res, 'account-not-allowed');
    }

    const authToken = await this.sessionService.createSessionAndToken(user);

    res.clearCookie(SSO_TXN_COOKIE, { path: '/' });
    res.setCookie('authToken', authToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: this.environmentService.getCookieExpiresIn(),
      secure: this.environmentService.isHttps(),
    });

    const appUrl = this.environmentService.getAppUrl().replace(/\/$/, '');
    return res.redirect(`${appUrl}${txn.redirect || '/'}`, HttpStatus.FOUND);
  }

  private readTxnCookie(req: FastifyRequest): OidcTxn | null {
    const raw = req.cookies?.[SSO_TXN_COOKIE];
    if (!raw) return null;
    try {
      const txn = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
      if (typeof txn?.state !== 'string' || typeof txn?.nonce !== 'string' || typeof txn?.codeVerifier !== 'string') {
        return null;
      }
      return txn as OidcTxn;
    } catch {
      return null;
    }
  }

  private buildCallbackUrl(providerId: string): string {
    const appUrl = this.environmentService.getAppUrl().replace(/\/$/, '');
    return `${appUrl}/api/sso/oidc/${providerId}/callback`;
  }

  // only allow same-origin relative paths as the post-login destination
  private sanitizeRedirect(redirect: string | undefined): string | null {
    if (!redirect) return null;
    if (!redirect.startsWith('/') || redirect.startsWith('//')) return null;
    return redirect;
  }

  private isGroupAllowed(provider: AuthProvider, claimGroups: string[]): boolean {
    const settings = provider.settings as Record<string, unknown> | null;
    const allowedGroups = (settings?.allowedGroups as string[] | null) ?? null;
    // no allowlist configured -> access is not group-restricted
    if (!allowedGroups || allowedGroups.length === 0) {
      return true;
    }
    return allowedGroups.some((allowed) => claimGroups.includes(allowed));
  }

  private redirectToLogin(res: FastifyReply, reason: string) {
    const appUrl = this.environmentService.getAppUrl().replace(/\/$/, '');
    return res.redirect(`${appUrl}/login?error=${encodeURIComponent(reason)}`, HttpStatus.FOUND);
  }
}
