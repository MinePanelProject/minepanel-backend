import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class ServerParamDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  id: string;
}
