import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class TwoFactorTokenDto {
  @ApiProperty({
    description: 'Six-digit TOTP or lowercase hexadecimal backup code',
    maxLength: 17,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(17)
  @Matches(/^(?:\d{6}|[a-f0-9]{8}-[a-f0-9]{8})$/)
  token: string;
}
