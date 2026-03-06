import { Controller, Get, HttpCode, HttpStatus, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
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
  @HttpCode(HttpStatus.OK)
  @Get('health')
  async getHealth() {
    const db = this.db
      .execute(sql`SELECT 1`)
      .then(() => 'ok' as const)
      .catch(() => 'error' as const);
    const docker = this.dockerService.ping().then((ok) => (ok ? 'ok' : 'error'));

    const [dbOK, dockerOK] = await Promise.all([db, docker]);

    return { db: dbOK, docker: dockerOK };
  }
}
