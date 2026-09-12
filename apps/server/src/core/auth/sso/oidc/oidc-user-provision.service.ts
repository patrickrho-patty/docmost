import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { SignupService } from '../../services/signup.service';
import { CreateUserDto } from '../../dto/create-user.dto';
import { User } from '@docmost/db/types/entity.types';
import { isUserDisabled } from '../../../../common/helpers/utils';
import { OidcUserInfo } from './oidc.service';
import type { AuthProvider } from '@docmost/db/types/entity.types';

@Injectable()
export class OidcUserProvisionService {
  private readonly logger = new Logger(OidcUserProvisionService.name);

  constructor(
    private userRepo: UserRepo,
    private signupService: SignupService,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  /**
   * Resolves an OIDC identity to a workspace user:
   * 1. existing auth_account link (provider sub -> user)
   * 2. existing user with matching email (auto-link)
   * 3. new user when the provider allows signup
   */
  async resolveOrCreateUser(
    provider: AuthProvider,
    userInfo: OidcUserInfo,
    workspaceId: string,
  ): Promise<User> {
    const linkedUserId = await this.findLinkedUserId(
      provider.id,
      userInfo.providerUserId,
      workspaceId,
    );

    if (linkedUserId) {
      const user = await this.userRepo.findById(linkedUserId, workspaceId);
      if (!user || isUserDisabled(user)) {
        throw new UnauthorizedException('User is disabled');
      }
      return user;
    }

    if (!userInfo.email) {
      throw new UnauthorizedException(
        'The identity provider did not return an email address',
      );
    }

    if (userInfo.emailVerified === false) {
      throw new ForbiddenException(
        'The identity provider reports this email address as unverified',
      );
    }

    const existingUser = await this.userRepo.findByEmail(
      userInfo.email,
      workspaceId,
    );

    if (existingUser) {
      if (isUserDisabled(existingUser)) {
        throw new UnauthorizedException('User is disabled');
      }
      await this.linkAuthProvider(
        existingUser.id,
        provider.id,
        userInfo.providerUserId,
        workspaceId,
      );
      return existingUser;
    }

    if (!provider.allowSignup) {
      throw new ForbiddenException(
        'No account exists for this email and signup is disabled for this SSO provider',
      );
    }

    const createUserDto: CreateUserDto = {
      name: userInfo.name || userInfo.email.split('@')[0],
      email: userInfo.email,
      password: randomBytes(24).toString('hex'),
    } as CreateUserDto;

    const user = await this.signupService.signup(
      createUserDto,
      workspaceId,
    );

    await this.linkAuthProvider(
      user.id,
      provider.id,
      userInfo.providerUserId,
      workspaceId,
    );

    this.logger.log(
      `provisioned user ${user.email} via OIDC provider ${provider.name}`,
    );

    return user;
  }

  private async findLinkedUserId(
    authProviderId: string,
    providerUserId: string,
    workspaceId: string,
  ): Promise<string | null> {
    const account = await this.db
      .selectFrom('authAccounts')
      .select(['userId'])
      .where('authProviderId', '=', authProviderId)
      .where('providerUserId', '=', providerUserId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    return account?.userId ?? null;
  }

  private async linkAuthProvider(
    userId: string,
    authProviderId: string,
    providerUserId: string,
    workspaceId: string,
  ): Promise<void> {
    const existing = await this.db
      .selectFrom('authAccounts')
      .select(['id'])
      .where('authProviderId', '=', authProviderId)
      .where('providerUserId', '=', providerUserId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();

    if (existing) {
      return;
    }

    await this.db
      .insertInto('authAccounts')
      .values({
        userId,
        authProviderId,
        providerUserId,
        workspaceId,
      })
      .execute();
  }
}
