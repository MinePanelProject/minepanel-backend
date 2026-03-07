import { Module } from '@nestjs/common';
import { DbModule } from 'src/db/db.module';
import { DockerModule } from 'src/docker/docker.module';
import { ServersController } from './servers.controller';
import { ServersService } from './servers.service';

@Module({
  imports: [DockerModule, DbModule],
  controllers: [ServersController],
  providers: [ServersService],
})
export class ServersModule {}
