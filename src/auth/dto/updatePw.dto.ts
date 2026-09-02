import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, MinLength } from 'class-validator';
import { PasswordByteLimit } from './password-byte-limit';

export class UpdatePasswordDTO {
  @ApiProperty({ maxLength: 72, description: 'At most 72 UTF-8 bytes' })
  @IsNotEmpty()
  @PasswordByteLimit()
  oldPassword: string;

  @ApiProperty({ maxLength: 72, description: 'At most 72 UTF-8 bytes' })
  @IsNotEmpty()
  @MinLength(8)
  @PasswordByteLimit()
  newPassword: string;
}
