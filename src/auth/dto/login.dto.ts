import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, MaxLength, MinLength } from 'class-validator';

export class LoginUserDto {
  @ApiProperty()
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
