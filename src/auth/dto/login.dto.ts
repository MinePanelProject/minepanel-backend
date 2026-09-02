import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, MaxLength, MinLength } from 'class-validator';
import { PasswordByteLimit } from './password-byte-limit';

export class LoginUserDto {
  @ApiProperty()
  @Transform(({ value }) => value?.trim().toLowerCase())
  @IsNotEmpty()
  @MaxLength(254)
  @MinLength(3)
  identifier: string;

  @ApiProperty({ maxLength: 72, description: 'At most 72 UTF-8 bytes' })
  @IsNotEmpty()
  @MinLength(8)
  @PasswordByteLimit()
  password: string;
}
