import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { AuthProviderType } from '../sso.constants';

export class CreateSsoProviderDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(50)
  name: string;

  @IsNotEmpty()
  @IsString()
  type: AuthProviderType;
}

export class UpdateSsoProviderDto {
  @IsUUID()
  providerId: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;

  @IsOptional()
  @IsString()
  oidcIssuer?: string;

  @IsOptional()
  @IsString()
  oidcClientId?: string;

  @IsOptional()
  @IsString()
  oidcClientSecret?: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  allowSignup?: boolean;

  @IsOptional()
  @IsBoolean()
  groupSync?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedGroups?: string[];
}

export class SsoProviderIdDto {
  @IsNotEmpty()
  @IsUUID()
  providerId: string;
}

export class SsoProvidersQueryDto {
  @IsOptional()
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsString()
  beforeCursor?: string;
}
