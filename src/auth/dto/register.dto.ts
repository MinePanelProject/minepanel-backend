import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateUserDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_]+$/)
  username: string;

  @ApiProperty()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}
