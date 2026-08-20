import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Roles } from 'src/common/decorators/roles.decorator';
import { ServerParamDto } from './dto/server-param.dto';
import { ServerUserParamDto } from './dto/server-user-param.dto';
import {
  type AccessRequestProjection,
  type MyAccessRequestProjection,
  type ServerPrincipal,
} from './server-access';
import { ServerAccessService } from './server-access.service';

@ApiTags('servers')
@Controller('servers')
export class ServerAccessController {
  constructor(private readonly serverAccessService: ServerAccessService) {}

  @Post(':id/request-access')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Request access to a REQUEST server' })
  async requestAccess(
    @Param() params: ServerParamDto,
    @Req() req: Request,
  ): Promise<MyAccessRequestProjection> {
    return this.serverAccessService.requestAccess(params.id, this.extractPrincipal(req));
  }

  @Get(':id/my-access-request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get the current user access request for a server' })
  async getMyAccessRequest(
    @Param() params: ServerParamDto,
    @Req() req: Request,
  ): Promise<MyAccessRequestProjection> {
    return this.serverAccessService.getMyAccessRequest(params.id, this.extractPrincipal(req));
  }

  @Get(':id/access-requests')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List pending access requests for a REQUEST server' })
  async listAccessRequests(@Param() params: ServerParamDto): Promise<AccessRequestProjection[]> {
    return this.serverAccessService.listAccessRequests(params.id);
  }

  @Post(':id/access-requests/:userId/approve')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve or assign access for a user on a server' })
  async approveAccess(@Param() params: ServerUserParamDto): Promise<AccessRequestProjection> {
    return this.serverAccessService.approveAccess(params.id, params.userId);
  }

  @Delete(':id/access-requests/:userId')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Reject a pending request or revoke approved access' })
  async revokeAccess(@Param() params: ServerUserParamDto): Promise<void> {
    return this.serverAccessService.revokeAccess(params.id, params.userId);
  }

  private extractPrincipal(req: Request): ServerPrincipal {
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    const user = req.user as { id: string; role: string } | undefined;

    if (!user) {
      throw new ForbiddenException();
    }

    return { id: user.id, role: user.role };
  }
}
