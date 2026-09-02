import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, Matches, MaxLength, MinLength } from 'class-validator';
import { PasswordByteLimit } from './password-byte-limit';

export class CreateUserDto {
  @ApiProperty()
  @Transform(({ value }) => value?.trim().toLowerCase())
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty()
  @Transform(({ value }) => value?.trim().toLowerCase())
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_]+$/)
  username: string;

  @ApiProperty({ maxLength: 72, description: 'At most 72 UTF-8 bytes' })
  @IsNotEmpty()
  @MinLength(8)
  @PasswordByteLimit()
  password: string;
}
