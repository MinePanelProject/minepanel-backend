import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { type Role, roleEnum } from 'src/db/schema';

export class UpdateUserRoleDto {
  @ApiProperty({ enum: roleEnum.enumValues, description: 'New role' })
  @IsEnum(roleEnum.enumValues, { message: 'role must be ADMIN, MOD or USER' })
  role: Role;
}
