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
import { Roles } from 'src/common/decorators/roles.decorator';
import { CreateServerDto } from './dto/create-server.dto';
import { ListServersQueryDto } from './dto/list-servers-query.dto';
import { ServerParamDto } from './dto/server-param.dto';
import { type PublicServer } from './public-server';
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
    return this.serversService.createServer(dto, user.id);
  }

  @ApiOperation({ summary: 'List visible servers' })
  @HttpCode(HttpStatus.OK)
  @Get()
  async list(
    @Query() query: ListServersQueryDto,
  ): Promise<{ data: PublicServer[]; total: number }> {
    return this.serversService.listServers(query);
  }

  @ApiOperation({ summary: 'Get a single visible server' })
  @HttpCode(HttpStatus.OK)
  @Get(':id')
  async get(@Param() param: ServerParamDto): Promise<PublicServer> {
    return this.serversService.getServer(param.id);
  }

  @Roles('ADMIN', 'MOD')
  @ApiOperation({ summary: 'Start a stopped server' })
  @HttpCode(HttpStatus.OK)
  @Post(':id/start')
  async start(@Param() param: ServerParamDto): Promise<PublicServer> {
    return this.serversService.startServer(param.id);
  }

  @Roles('ADMIN', 'MOD')
  @ApiOperation({ summary: 'Stop a running server' })
  @HttpCode(HttpStatus.OK)
  @Post(':id/stop')
  async stop(@Param() param: ServerParamDto): Promise<PublicServer> {
    return this.serversService.stopServer(param.id);
  }

  @Roles('ADMIN', 'MOD')
  @ApiOperation({ summary: 'Restart a running server' })
  @HttpCode(HttpStatus.OK)
  @Post(':id/restart')
  async restart(@Param() param: ServerParamDto): Promise<PublicServer> {
    return this.serversService.restartServer(param.id);
  }

  @Roles('ADMIN')
  @ApiOperation({ summary: 'Delete a stopped server and its container' })
  @HttpCode(HttpStatus.ACCEPTED)
  @Delete(':id')
  async delete(@Param() param: ServerParamDto): Promise<void> {
    return this.serversService.deleteServer(param.id);
  }

  private extractUser(req: Request): UserPayload {
    const user = req.user as UserPayload | undefined;

    if (!user) {
      throw new UnauthorizedException();
    }

    return user;
  }
}
