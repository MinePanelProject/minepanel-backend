import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from './common/decorators/public.decorator';

@ApiTags('api')
@Controller()
export class AppController {
  constructor(private configService: ConfigService) {}

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
  getHealth() {
    return { status: 'ok' };
  }
}
