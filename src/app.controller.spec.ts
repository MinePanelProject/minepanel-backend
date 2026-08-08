import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { DRIZZLE } from 'src/db/db.module';
import { AppController } from './app.controller';
import { DockerService } from './docker/docker.service';

describe('AppController', () => {
  let controller: AppController;
  let getConfig: jest.Mock;
  let pingDocker: jest.Mock;
  let executeDb: jest.Mock;

  beforeEach(async () => {
    getConfig = jest.fn();
    pingDocker = jest.fn();
    executeDb = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: ConfigService, useValue: { get: getConfig } },
        { provide: DockerService, useValue: { ping: pingDocker } },
        { provide: DRIZZLE, useValue: { execute: executeDb } },
      ],
    }).compile();

    controller = module.get<AppController>(AppController);
  });

  it('returns the panel name and version from configuration', () => {
    getConfig.mockReturnValueOnce('MinePanel').mockReturnValueOnce('1.0.0');

    expect(controller.getInfo()).toEqual({ name: 'MinePanel', version: '1.0.0' });
  });

  it('reports ok for a healthy database and docker daemon', async () => {
    executeDb.mockResolvedValue(undefined);
    pingDocker.mockResolvedValue(true);

    await expect(controller.getHealth()).resolves.toEqual({ db: 'ok', docker: 'ok' });
  });

  it('reports error when the database query or docker ping fails', async () => {
    executeDb.mockRejectedValue(new Error('db down'));
    pingDocker.mockResolvedValue(false);

    await expect(controller.getHealth()).resolves.toEqual({ db: 'error', docker: 'error' });
  });
});
