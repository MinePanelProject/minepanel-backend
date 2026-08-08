import { Test, type TestingModule } from '@nestjs/testing';
import { DOCKERODE } from './docker.constants';
import { DockerService } from './docker.service';

describe('DockerService', () => {
  let service: DockerService;
  let ping: jest.Mock;

  beforeEach(async () => {
    ping = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [DockerService, { provide: DOCKERODE, useValue: { ping } }],
    }).compile();

    service = module.get<DockerService>(DockerService);
  });

  it('returns true when the docker daemon responds to ping', async () => {
    ping.mockResolvedValue(undefined);

    await expect(service.ping()).resolves.toBe(true);
  });

  it('returns false when the docker daemon ping fails', async () => {
    ping.mockRejectedValue(new Error('daemon unreachable'));

    await expect(service.ping()).resolves.toBe(false);
  });
});
