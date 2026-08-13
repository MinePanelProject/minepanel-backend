import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID, MinLength } from 'class-validator';

export class ServerUserParamDto {
  @ApiProperty({ description: 'Server id' })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  id: string;

  @ApiProperty({ description: 'User id' })
  @IsUUID()
  userId: string;
}
