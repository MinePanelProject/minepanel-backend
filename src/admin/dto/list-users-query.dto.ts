import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { type Role, roleEnum, type UserStatus, userStatusEnum } from 'src/db/schema';

export class ListUsersQueryDto {
  @ApiPropertyOptional({ enum: userStatusEnum.enumValues, description: 'Filter by user status' })
  @IsOptional()
  @IsEnum(userStatusEnum.enumValues, { message: 'status must be ACTIVE, PENDING or BANNED' })
  status?: UserStatus;

  @ApiPropertyOptional({ enum: roleEnum.enumValues, description: 'Filter by role' })
  @IsOptional()
  @IsEnum(roleEnum.enumValues, { message: 'role must be ADMIN, MOD or USER' })
  role?: Role;
}
