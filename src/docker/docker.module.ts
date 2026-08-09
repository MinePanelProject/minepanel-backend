import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Dockerode from 'dockerode';
import { DOCKER_REQUEST_TIMEOUT_MS, DOCKERODE } from './docker.constants';
import { DockerService } from './docker.service';

@Module({
  providers: [
    DockerService,
    {
      provide: DOCKERODE,
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const socketPath = configService.get('DOCKER_SOCKET', '/var/run/docker.sock');

        // docker-modem prefers the ambient DOCKER_HOST env var over socketPath and throws on
        // malformed values during construction — both break the local-socket/same-filesystem
        // storage contract. The variable is suppressed only for the synchronous constructor
        // call and restored immediately after, even when construction throws.
        const ambientDockerHost = process.env.DOCKER_HOST;
        if (ambientDockerHost !== undefined) {
          Logger.warn(
            'Ambient DOCKER_HOST is unsupported; forcing the configured local Docker socket',
            'DockerModule',
          );
          delete process.env.DOCKER_HOST;
        }

        let docker: Dockerode;
        try {
          docker = new Dockerode({ socketPath, timeout: DOCKER_REQUEST_TIMEOUT_MS });
        } finally {
          if (ambientDockerHost !== undefined) {
            process.env.DOCKER_HOST = ambientDockerHost;
          } else {
            delete process.env.DOCKER_HOST;
          }
        }

        try {
          await docker.ping();
          Logger.log('Docker connected', 'DockerModule');
        } catch {
          Logger.warn(
            'Docker daemon unreachable at startup — continuing without Docker',
            'DockerModule',
          );
        }

        return docker;
      },
    },
  ],
  exports: [DockerService, DOCKERODE],
})
export class DockerModule {}
