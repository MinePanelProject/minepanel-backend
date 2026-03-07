import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, MaxLength, MinLength } from 'class-validator';

export class LoginUserDto {
  @ApiProperty()
  @Transform(({ value }) => value?.trim().toLowerCase())
  @IsNotEmpty()
  @MaxLength(254)
  @MinLength(3)
  identifier: string;

  @ApiProperty()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}
