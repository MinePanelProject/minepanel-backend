import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from 'src/common/decorators/roles.decorator';
import { type PublicUser } from 'src/users/public-user';
import { AdminService } from './admin.service';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { UserParamDto } from './dto/user-param.dto';

@ApiTags('admin')
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('users')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List users, optionally filtered by status or role' })
  async listUsers(@Query() query: ListUsersQueryDto): Promise<PublicUser[]> {
    return this.adminService.listUsers(query);
  }

  @Patch('users/:id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a user status (approve, ban, unban)' })
  async updateStatus(
    @Param() params: UserParamDto,
    @Body() body: UpdateUserStatusDto,
  ): Promise<PublicUser> {
    return this.adminService.updateStatus(params.id, body.status);
  }

  @Patch('users/:id/role')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a user role (ADMIN, MOD, USER)' })
  async updateRole(
    @Param() params: UserParamDto,
    @Body() body: UpdateUserRoleDto,
  ): Promise<PublicUser> {
    return this.adminService.updateRole(params.id, body.role);
  }

  @Post('users/:id/reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset a user password to a single-use temporary password' })
  async resetPassword(@Param() params: UserParamDto): Promise<{ tempPassword: string }> {
    return this.adminService.resetPassword(params.id);
  }

  @Delete('users/:id/2fa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove two-factor authentication (emergency recovery)' })
  async removeTwoFactor(@Param() params: UserParamDto): Promise<PublicUser> {
    return this.adminService.removeTwoFactor(params.id);
  }
}
