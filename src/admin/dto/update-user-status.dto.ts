import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { type UserStatus, userStatusEnum } from 'src/db/schema';

export class UpdateUserStatusDto {
  @ApiProperty({ enum: userStatusEnum.enumValues, description: 'New user status' })
  @IsEnum(userStatusEnum.enumValues, { message: 'status must be ACTIVE, PENDING or BANNED' })
  status: UserStatus;
}
