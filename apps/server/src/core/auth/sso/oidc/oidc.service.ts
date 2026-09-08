import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as oidcClient from 'openid-client';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

export interface OidcAuthorizationRequest {
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcUserInfo {
  providerUserId: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

const DISCOVERY_CACHE_TTL_MS = 10 * 60 * 1000;

type OidcClaims = Record<string, unknown>;

@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);
  private discoveryCache = new Map<
    string,
    { config: oidcClient.Configuration; expiresAt: number }
  >();

  private isLocalHttpIssuer(issuer: string): boolean {
    return issuer.startsWith('http://localhost') || issuer.startsWith('http://127.0.0.1');
  }

  async discover(
    issuer: string,
    clientId: string,
    clientSecret: string,
  ): Promise<oidcClient.Configuration> {
    const cacheKey = `${issuer}|${clientId}`;
    const cached = this.discoveryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.config;
    }

    // openid-client is HTTPS-only by default; local dev IdPs need an opt-out
    const insecure = this.isLocalHttpIssuer(issuer);
    const options = insecure
      ? { execute: [oidcClient.allowInsecureRequests] }
      : undefined;

    const config = await oidcClient.discovery(
      new URL(issuer),
      clientId,
      clientSecret,
      undefined,
      options as any,
    );

    if (insecure) {
      oidcClient.allowInsecureRequests(config);
    }

    this.discoveryCache.set(cacheKey, {
      config,
      expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS,
    });
    return config;
  }

  async buildAuthorizationRequest(
    issuer: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string,
  ): Promise<OidcAuthorizationRequest> {
    const config = await this.discover(issuer, clientId, clientSecret);

    const state = randomUUID();
    const nonce = oidcClient.randomNonce();
    const codeVerifier = oidcClient.randomPKCECodeVerifier();
    const codeChallenge =
      await oidcClient.calculatePKCECodeChallenge(codeVerifier);

    const authorizationUrl = oidcClient.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return {
      authorizationUrl: authorizationUrl.href,
      state,
      nonce,
      codeVerifier,
    };
  }

  async exchangeCodeForUserInfo(
    issuer: string,
    clientId: string,
    clientSecret: string,
    callbackUrl: string,
    expectedState: string,
    expectedNonce: string,
    codeVerifier: string,
  ): Promise<OidcUserInfo> {
    let config: oidcClient.Configuration;
    try {
      config = await this.discover(issuer, clientId, clientSecret);
    } catch (err) {
      this.logger.error(
        `OIDC discovery failed for issuer ${issuer}: ${(err as Error).message}`,
      );
      throw new UnauthorizedException('Failed to contact the identity provider');
    }

    const tokens = await oidcClient.authorizationCodeGrant(
      config,
      new URL(callbackUrl),
      {
        pkceCodeVerifier: codeVerifier,
        expectedState,
        expectedNonce,
      },
    );

    const idTokenClaims: OidcClaims = (tokens.claims() as OidcClaims) ?? {};
    let claims: OidcClaims = { ...idTokenClaims };

    // prefer fresh claims from the userinfo endpoint when available
    if (tokens.access_token) {
      try {
        const userinfo = await oidcClient.fetchUserInfo(
          config,
          tokens.access_token,
          idTokenClaims.sub as string,
        );
        claims = { ...claims, ...userinfo };
      } catch (err) {
        this.logger.warn(
          `OIDC userinfo fetch failed, using id_token claims: ${(err as Error).message}`,
        );
      }
    }

    const sub = claims.sub;
    if (typeof sub !== 'string' || !sub) {
      throw new UnauthorizedException(
        'OIDC login failed: no subject claim returned',
      );
    }

    const email =
      typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
    const name =
      (typeof claims.name === 'string' && claims.name) ||
      (typeof claims.given_name === 'string' && claims.given_name) ||
      (typeof claims.preferred_username === 'string' &&
        claims.preferred_username) ||
      null;
    const avatarUrl =
      typeof claims.picture === 'string' ? claims.picture : null;

    return {
      providerUserId: sub,
      email,
      name,
      avatarUrl,
    };
  }

  invalidateDiscovery(issuer: string) {
    for (const key of this.discoveryCache.keys()) {
      if (key.startsWith(`${issuer}|`)) {
        this.discoveryCache.delete(key);
      }
    }
  }
}
