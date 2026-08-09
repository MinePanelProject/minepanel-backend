import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Response } from 'express';
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
    getConfig.mockReturnValue('1.0');
    executeDb.mockResolvedValue(undefined);
    pingDocker.mockResolvedValue(true);
    const res = { status: jest.fn().mockReturnThis() } as unknown as Response;

    await expect(controller.getHealth(res)).resolves.toEqual({
      status: 'ok',
      db: 'ok',
      docker: 'ok',
      version: '1.0',
    });
    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
  });

  it('reports degraded when the database query fails', async () => {
    getConfig.mockReturnValue('1.0');
    executeDb.mockRejectedValue(new Error('db down'));
    pingDocker.mockResolvedValue(true);
    const res = { status: jest.fn().mockReturnThis() } as unknown as Response;

    await expect(controller.getHealth(res)).resolves.toEqual({
      status: 'degraded',
      db: 'error',
      docker: 'ok',
      version: '1.0',
    });
    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('reports degraded when the docker ping fails', async () => {
    getConfig.mockReturnValue('1.0');
    executeDb.mockResolvedValue(undefined);
    pingDocker.mockResolvedValue(false);
    const res = { status: jest.fn().mockReturnThis() } as unknown as Response;

    await expect(controller.getHealth(res)).resolves.toEqual({
      status: 'degraded',
      db: 'ok',
      docker: 'error',
      version: '1.0',
    });
    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
  });
});
