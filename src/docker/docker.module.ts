import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Dockerode from 'dockerode';
import { DOCKERODE } from './docker.constants';
import { DockerService } from './docker.service';

@Module({
  providers: [
    DockerService,
    {
      provide: DOCKERODE,
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const docker = new Dockerode({
          socketPath: configService.get('DOCKER_SOCKET', '/var/run/docker.sock'),
        });

        try {
          await docker.ping();
          Logger.log('Docker connected', 'DockerModule');
        } catch (error) {
          Logger.error('Docker connection failed', error, 'DockerModule');
          process.exit(1);
        }

        return docker;
      },
    },
  ],
  exports: [DockerService, DOCKERODE],
})
export class DockerModule {}
