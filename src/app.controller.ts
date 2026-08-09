import { Controller, Get, HttpCode, HttpStatus, Inject, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import { Public } from './common/decorators/public.decorator';
import { DockerService } from './docker/docker.service';

@ApiTags('api')
@Controller()
export class AppController {
  constructor(
    private configService: ConfigService,
    private dockerService: DockerService,
    @Inject(DRIZZLE) private db: DrizzleDB,
  ) {}

  @Public()
  @ApiOperation({ summary: 'Returns `{ name, version }` for frontend listing' })
  @HttpCode(HttpStatus.OK)
  @Get('info')
  getInfo() {
    const name = this.configService.get<string>('PANEL_NAME');
    const version = this.configService.get<string>('PANEL_VERSION');

    return { name, version };
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
