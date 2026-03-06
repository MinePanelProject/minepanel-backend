import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, MaxLength, MinLength } from 'class-validator';

export class UpdatePasswordDTO {
  @ApiProperty()
  @IsNotEmpty()
  oldPassword: string;

  @ApiProperty()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  newPassword: string;
}
