import { Inject, Injectable } from '@nestjs/common';
import type Dockerode from 'dockerode';
import { DOCKERODE } from './docker.constants';

@Injectable()
export class DockerService {
  constructor(@Inject(DOCKERODE) private docker: Dockerode) {}

  async ping() {
    try {
      await this.docker.ping();

      return true;
    } catch (_error) {
      return false;
    }
  }
}
