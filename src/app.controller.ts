import { Controller, Get, HttpCode, HttpStatus, Inject, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import { Public } from './common/decorators/public.decorator';
import { DockerService } from './docker/docker.service';

export const PANEL_PROTOCOL_VERSION = 1;

export interface PanelCapabilities {
  auth: {
    partitionedCookies: boolean;
    pkceAuthorizationCode: boolean;
  };
  realtime: {
    websocketTicket: boolean;
  };
}

export interface PanelInfo {
  name: string;
  version: string;
  api: { protocolVersion: number };
  capabilities: PanelCapabilities;
}

@ApiTags('api')
@Controller()
export class AppController {
  constructor(
    private configService: ConfigService,
    private dockerService: DockerService,
    @Inject(DRIZZLE) private db: DrizzleDB,
  ) {}

  @Public()
  @ApiOperation({
    summary: 'Panel metadata and capability discovery (protocol 1); name/version are display-only',
  })
  @ApiResponse({ status: 200, description: 'Protocol-1 panel info with capability flags' })
  @HttpCode(HttpStatus.OK)
  @Get('info')
  getInfo(@Res({ passthrough: true }) res: Response): PanelInfo {
    res.setHeader('Cache-Control', 'no-store');

    return {
      name: this.configService.get<string>('PANEL_NAME', 'MinePanel'),
      version: this.configService.get<string>('PANEL_VERSION', '1.0'),
      api: { protocolVersion: PANEL_PROTOCOL_VERSION },
      capabilities: {
        auth: {
          partitionedCookies: true,
          pkceAuthorizationCode: false,
        },
        realtime: {
          websocketTicket: false,
        },
      },
    };
  }

  @Public()
  @ApiOperation({ summary: 'Liveness check (db + docker status)' })
  @Get('health')
  async getHealth(@Res({ passthrough: true }) res: Response) {
    const db = this.db
      .execute(sql`SELECT 1`)
      .then(() => 'ok' as const)
      .catch(() => 'error' as const);
    const docker = this.dockerService.ping().then((ok) => (ok ? 'ok' : 'error'));

    const [dbStatus, dockerStatus] = await Promise.all([db, docker]);
    const healthy = dbStatus === 'ok' && dockerStatus === 'ok';

    res.status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: healthy ? 'ok' : 'degraded',
      db: dbStatus,
      docker: dockerStatus,
      version: this.configService.get<string>('PANEL_VERSION', '1.0'),
    };
  }
}
