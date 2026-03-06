import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class EditUserDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsOptional()
  @IsString()
  username: string;
}
