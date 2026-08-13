import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsOptional, IsString, ValidateIf } from 'class-validator';
import { type ModPermission, modPermissionEnum } from 'src/db/schema';

export class GrantModPermissionDto {
  @ApiProperty({ enum: modPermissionEnum.enumValues, description: 'Permission to grant' })
  @IsIn(modPermissionEnum.enumValues)
  permission: ModPermission;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Server id for scoped permission; omit or null for global',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((o: GrantModPermissionDto) => o.serverId !== null && o.serverId !== undefined)
  @IsString()
  @IsNotEmpty()
  serverId?: string | null;
}
