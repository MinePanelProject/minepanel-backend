import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class EditUserDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  @IsOptional()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_]+$/)
  username: string;
}
