import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequiresPermission } from 'src/common/decorators/permissions.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { CreateServerDto } from './dto/create-server.dto';
import { ListServersQueryDto } from './dto/list-servers-query.dto';
import { ServerParamDto } from './dto/server-param.dto';
import { type PublicServer } from './public-server';
import { type ServerPrincipal } from './server-access';
import { ServersService } from './servers.service';

type UserPayload = { id: string; username: string; role: string; temporaryAuth?: boolean };

@ApiTags('servers')
@Controller('servers')
export class ServersController {
  constructor(private readonly serversService: ServersService) {}

  @Roles('ADMIN')
  @ApiOperation({ summary: 'Create and start a new server' })
  @HttpCode(HttpStatus.CREATED)
  @Post()
  async create(@Body() dto: CreateServerDto, @Req() req: Request): Promise<PublicServer> {
    const user = this.extractUser(req);
    return this.serversService.createServer(dto, this.toPrincipal(user));
  }

  @ApiOperation({ summary: 'List visible servers' })
  @HttpCode(HttpStatus.OK)
  @Get()
  async list(
    @Query() query: ListServersQueryDto,
    @Req() req: Request,
  ): Promise<{ data: PublicServer[]; total: number }> {
    return this.serversService.listServers(query, this.toPrincipal(this.extractUser(req)));
  }

  @ApiOperation({ summary: 'Get a single visible server' })
  @HttpCode(HttpStatus.OK)
  @Get(':id')
  async get(@Param() param: ServerParamDto, @Req() req: Request): Promise<PublicServer> {
    return this.serversService.getServer(param.id, this.toPrincipal(this.extractUser(req)));
  }

  @Roles('ADMIN', 'MOD')
  @RequiresPermission('SERVER_LIFECYCLE')
  @ApiOperation({ summary: 'Start a stopped server' })
  @HttpCode(HttpStatus.OK)
  @Post(':id/start')
  async start(@Param() param: ServerParamDto, @Req() req: Request): Promise<PublicServer> {
    return this.serversService.startServer(param.id, this.toPrincipal(this.extractUser(req)));
  }

  @Roles('ADMIN', 'MOD')
  @RequiresPermission('SERVER_LIFECYCLE')
  @ApiOperation({ summary: 'Stop a running server' })
  @HttpCode(HttpStatus.OK)
  @Post(':id/stop')
  async stop(@Param() param: ServerParamDto, @Req() req: Request): Promise<PublicServer> {
    return this.serversService.stopServer(param.id, this.toPrincipal(this.extractUser(req)));
  }

  @Roles('ADMIN', 'MOD')
  @RequiresPermission('SERVER_LIFECYCLE')
  @ApiOperation({ summary: 'Restart a running server' })
  @HttpCode(HttpStatus.OK)
  @Post(':id/restart')
  async restart(@Param() param: ServerParamDto, @Req() req: Request): Promise<PublicServer> {
    return this.serversService.restartServer(param.id, this.toPrincipal(this.extractUser(req)));
  }

  @Roles('ADMIN')
  @ApiOperation({ summary: 'Delete a stopped server and its container' })
  @HttpCode(HttpStatus.ACCEPTED)
  @Delete(':id')
  async delete(@Param() param: ServerParamDto, @Req() req: Request): Promise<void> {
    return this.serversService.deleteServer(param.id, this.toPrincipal(this.extractUser(req)));
  }

  private extractUser(req: Request): UserPayload {
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    const user = req.user as UserPayload | undefined;

    if (!user) {
      throw new UnauthorizedException();
    }

    return user;
  }

  private toPrincipal(user: UserPayload): ServerPrincipal {
    return { id: user.id, role: user.role };
  }
}
