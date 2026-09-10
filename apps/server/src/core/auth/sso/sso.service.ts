import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { executeWithCursorPagination } from '../../../database/pagination/cursor-pagination';
import {
  CreateSsoProviderDto,
  SsoProvidersQueryDto,
  UpdateSsoProviderDto,
} from './dto/sso-provider.dto';
import { AuthProvider } from '@docmost/db/types/entity.types';
import { AuthProviderType } from './sso.constants';
import { OidcService } from './oidc/oidc.service';

@Injectable()
export class SsoService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly oidcService: OidcService,
  ) {}

  async getProviders(
    workspaceId: string,
    query: SsoProvidersQueryDto,
  ): Promise<any> {
    const queryBuilder = this.db
      .selectFrom('authProviders')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null);

    return executeWithCursorPagination(queryBuilder, {
      perPage: query?.limit ?? 100,
      cursor: query?.cursor,
      beforeCursor: query?.beforeCursor,
      fields: [
        { expression: 'authProviders.createdAt', direction: 'asc', key: 'createdAt' },
        { expression: 'authProviders.id', direction: 'asc', key: 'id' },
      ],
      parseCursor: (cursor) => ({
        createdAt: new Date(cursor.createdAt as unknown as string),
        id: cursor.id,
      }),
    });
  }

  async getProviderById(
    providerId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<AuthProvider | undefined> {
    const db = trx ?? this.db;
    return db
      .selectFrom('authProviders')
      .selectAll()
      .where('id', '=', providerId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  async getEnabledOidcProvider(
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<AuthProvider | undefined> {
    const db = trx ?? this.db;
    return db
      .selectFrom('authProviders')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('type', '=', AuthProviderType.OIDC)
      .where('isEnabled', '=', true)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .executeTakeFirst();
  }

  async createProvider(
    creatorId: string,
    workspaceId: string,
    dto: CreateSsoProviderDto,
  ): Promise<AuthProvider> {
    return this.db
      .insertInto('authProviders')
      .values({
        name: dto.name,
        type: dto.type,
        creatorId,
        workspaceId,
        isEnabled: false,
        allowSignup: false,
      })
      .returningAll()
      .executeTakeFirst();
  }

  async updateProvider(
    workspaceId: string,
    dto: UpdateSsoProviderDto,
  ): Promise<AuthProvider> {
    const provider = await this.getProviderById(dto.providerId, workspaceId);
    if (!provider) {
      throw new NotFoundException('SSO provider not found');
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    const updatable = [
      'name',
      'oidcIssuer',
      'oidcClientId',
      'oidcClientSecret',
      'isEnabled',
      'allowSignup',
      'groupSync',
    ];

    for (const field of updatable) {
      if (dto[field] !== undefined) {
        updates[field] = dto[field];
      }
    }

    // allowedGroups and exchangeClientIds live in the settings JSON column (no schema change)
    const settings = {
      ...((provider.settings as Record<string, unknown>) ?? {}),
    };
    let settingsChanged = false;
    if (dto.allowedGroups !== undefined) {
      const groups = (dto.allowedGroups ?? [])
        .map((g) => g.trim())
        .filter(Boolean);
      settings.allowedGroups = groups.length ? groups : null;
      settingsChanged = true;
    }
    if (dto.exchangeClientIds !== undefined) {
      const clientIds = (dto.exchangeClientIds ?? [])
        .map((id) => id.trim())
        .filter(Boolean);
      settings.exchangeClientIds = clientIds.length ? clientIds : null;
      settingsChanged = true;
    }
    if (settingsChanged) {
      updates.settings = settings;
    }

    // guard: enabling an OIDC provider requires complete configuration
    if (updates.isEnabled === true && provider.type === AuthProviderType.OIDC) {
      const issuer = (updates.oidcIssuer as string) ?? provider.oidcIssuer;
      const clientId =
        (updates.oidcClientId as string) ?? provider.oidcClientId;
      const clientSecret =
        (updates.oidcClientSecret as string) ?? provider.oidcClientSecret;
      if (!issuer || !clientId || !clientSecret) {
        throw new BadRequestException(
          'Cannot enable OIDC provider: issuer, client id and client secret are required',
        );
      }
    }

    const updated = await this.db
      .updateTable('authProviders')
      .set(updates)
      .where('id', '=', dto.providerId)
      .where('workspaceId', '=', workspaceId)
      .returningAll()
      .executeTakeFirst();

    // issuer/secret edits change discovery and JWKS material; drop the cache
    if (provider.oidcIssuer) {
      this.oidcService.invalidateDiscovery(provider.oidcIssuer);
    }
    if (dto.oidcIssuer && dto.oidcIssuer !== provider.oidcIssuer) {
      this.oidcService.invalidateDiscovery(dto.oidcIssuer);
    }

    return updated;
  }

  async deleteProvider(providerId: string, workspaceId: string): Promise<void> {
    const provider = await this.getProviderById(providerId, workspaceId);
    if (!provider) {
      throw new NotFoundException('SSO provider not found');
    }

    await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('authAccounts')
        .where('authProviderId', '=', providerId)
        .execute();
      await trx
        .deleteFrom('authProviders')
        .where('id', '=', providerId)
        .where('workspaceId', '=', workspaceId)
        .execute();
    });
  }
}
