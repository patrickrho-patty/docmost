import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class OidcExchangeDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(32768)
  accessToken: string;

  @IsOptional()
  @IsUUID()
  providerId?: string;
}
