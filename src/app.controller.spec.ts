import { HttpStatus } from '@nestjs/common';
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

  it('returns the exact protocol-1 panel info with a no-store header', () => {
    getConfig.mockImplementation((key: string, defaultValue?: string) => {
      if (key === 'PANEL_NAME') return 'MinePanel';
      if (key === 'PANEL_VERSION') return '1.0.0';
      return defaultValue;
    });
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    const res = { setHeader: jest.fn() };

    expect(controller.getInfo(res)).toEqual({
      name: 'MinePanel',
      version: '1.0.0',
      api: { protocolVersion: 1 },
      capabilities: {
        auth: {
          partitionedCookies: true,
          pkceAuthorizationCode: false,
        },
        realtime: {
          websocketTicket: false,
        },
      },
    });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('falls back to display defaults when panel name and version are unset', () => {
    getConfig.mockImplementation((_key: string, defaultValue?: string) => defaultValue);
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    const res = { setHeader: jest.fn() };

    const info = controller.getInfo(res);

    expect(info.name).toBe('MinePanel');
    expect(info.version).toBe('1.0');
    expect(info.api.protocolVersion).toBe(1);
  });

  it('reports ok for a healthy database and docker daemon', async () => {
    getConfig.mockReturnValue('1.0');
    executeDb.mockResolvedValue(undefined);
    pingDocker.mockResolvedValue(true);
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    const res = { status: jest.fn().mockReturnThis() };

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
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    const res = { status: jest.fn().mockReturnThis() };

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
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    const res = { status: jest.fn().mockReturnThis() };

    await expect(controller.getHealth(res)).resolves.toEqual({
      status: 'degraded',
      db: 'ok',
      docker: 'error',
      version: '1.0',
    });
    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
  });
});
