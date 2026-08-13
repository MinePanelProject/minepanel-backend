import { Module } from '@nestjs/common';
import { DbModule } from 'src/db/db.module';
import { DockerModule } from 'src/docker/docker.module';
import { ServerAccessController } from './server-access.controller';
import { ServerAccessService } from './server-access.service';
import { ServersController } from './servers.controller';
import { ServersService } from './servers.service';

@Module({
  imports: [DockerModule, DbModule],
  controllers: [ServersController, ServerAccessController],
  providers: [ServersService, ServerAccessService],
})
export class ServersModule {}
