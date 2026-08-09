import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class UserParamDto {
  @ApiProperty({ description: 'User id' })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S+/)
  id: string;
}
