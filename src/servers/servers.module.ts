import { Module } from '@nestjs/common';
import { ServersController } from './servers.controller';

@Module({
  controllers: [ServersController]
})
export class ServersModule {}
