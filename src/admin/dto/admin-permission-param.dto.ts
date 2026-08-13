import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class AdminPermissionParamDto {
  @ApiProperty({ description: 'User id' })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S+/)
  id: string;

  @ApiProperty({ description: 'Permission grant id' })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S+/)
  permId: string;
}
