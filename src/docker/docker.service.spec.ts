import type { StatsFs } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { Readable } from 'node:stream';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Server } from 'src/db/schema';
import { DOCKERODE } from './docker.constants';
import {
  type DiskInfo,
  DockerService,
  type HostInfo,
  RconUnavailableError,
} from './docker.service';

type ExecInspectResult =
  | { Running: boolean; ExitCode: number }
  | { Running: string; ExitCode: number }
  | { Running: boolean; ExitCode?: undefined }
  | { Running?: undefined; ExitCode: number };

const makeServer = (overrides?: Partial<Server>): Server => ({
  id: 'abc-123',
  name: 'Test Server',
  provider: 'PAPER',
  version: '1.21.1',
  port: 25570,
  containerId: null,
  status: 'STOPPED',
  maxPlayers: 20,
  difficulty: 'NORMAL',
  gamemode: 'SURVIVAL',
  pvp: true,
  memoryLimitMb: 2048,
  motd: null,
  levelSeed: null,
  onlineMode: true,
  viewDistance: 10,
  allowFlight: false,
  worldPath: null,
  rconPassword: null,
  ownerId: 'owner-1',
  accessType: 'OPEN',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const makeConfigMock = (overrides: Record<string, string | number> = {}) => {
  const map = new Map<string, string | number>(Object.entries(overrides));

  return {
    map,
    get: jest.fn((key: string, defaultValue?: string | number) => {
      if (map.has(key)) return map.get(key);
      return defaultValue;
    }),
  };
};

const makeDaemonError = (code: string): Error =>
  Object.assign(new Error(`connect ${code} /var/run/docker.sock`), { code });

const makeStatusError = (statusCode: number): Error =>
  Object.assign(new Error(`status ${statusCode}`), { statusCode });

type FakeDocker = {
  ping: jest.Mock;
  info: jest.Mock;
  createContainer: jest.Mock;
  getContainer: jest.Mock;
};

describe('DockerService', () => {
  let service: DockerService;
  let fakeDocker: FakeDocker;
  let configMock: { map: Map<string, string | number>; get: jest.Mock };
  let statfsSpy: jest.SpyInstance;

  beforeEach(async () => {
    fakeDocker = {
      ping: jest.fn(),
      info: jest.fn(),
      createContainer: jest.fn(),
      getContainer: jest.fn((id: string) => ({
        id,
        start: jest.fn(),
        stop: jest.fn(),
        remove: jest.fn(),
        inspect: jest.fn(),
      })),
    };
    configMock = makeConfigMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DockerService,
        { provide: DOCKERODE, useValue: fakeDocker },
        { provide: ConfigService, useValue: configMock },
      ],
    }).compile();

    service = module.get<DockerService>(DockerService);
  });

  afterEach(() => {
    statfsSpy?.mockRestore();
    jest.useRealTimers();
  });

  it('returns true when the docker daemon responds to ping', async () => {
    fakeDocker.ping.mockResolvedValue(undefined);

    await expect(service.ping()).resolves.toBe(true);
  });

  it('returns false when the docker daemon ping fails', async () => {
    fakeDocker.ping.mockRejectedValue(new Error('daemon unreachable'));

    await expect(service.ping()).resolves.toBe(false);
  });

  it.each([
    [0, 0],
    [1024 * 1024 + 123, 1],
    [3 * 1024 * 1024 + 999, 3],
  ])('returns host free memory in floored MiB for %d bytes', (bytes, expected) => {
    const freeMemorySpy = jest.spyOn(os, 'freemem').mockReturnValue(bytes);

    expect(service.getHostFreeMemoryMb()).toBe(expected);

    freeMemorySpy.mockRestore();
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    Number.MAX_SAFE_INTEGER + 1,
    1.5,
  ])('returns null for malformed host free memory %p without throwing', (bytes) => {
    const freeMemorySpy = jest.spyOn(os, 'freemem').mockReturnValue(bytes);

    expect(() => service.getHostFreeMemoryMb()).not.toThrow();
    expect(service.getHostFreeMemoryMb()).toBeNull();

    freeMemorySpy.mockRestore();
  });

  describe('createContainer', () => {
    it('creates a container with the exact hardened config', async () => {
      fakeDocker.createContainer.mockResolvedValue({ id: 'container-id-1' });

      await expect(service.createContainer(makeServer())).resolves.toBe('container-id-1');

      expect(fakeDocker.createContainer).toHaveBeenCalledTimes(1);
      expect(fakeDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'mc-abc-123',
          Image: 'itzg/minecraft-server',
          ExposedPorts: { '25565/tcp': {} },
          Env: expect.arrayContaining([
            'EULA=TRUE',
            'ENABLE_RCON=TRUE',
            'TYPE=PAPER',
            'VERSION=1.21.1',
            'MEMORY=2048M',
          ]),
          Labels: { 'minepanel.server-id': 'abc-123', 'minepanel.managed': 'true' },
          HostConfig: {
            Binds: ['/mc-data/abc-123:/data'],
            Memory: 2048 * 1024 * 1024,
            PortBindings: { '25565/tcp': [{ HostPort: '25570' }] },
            Privileged: false,
            CapAdd: [],
            NetworkMode: 'minepanel_network',
            RestartPolicy: { Name: 'unless-stopped' },
          },
        }),
      );

      const config = fakeDocker.createContainer.mock.calls[0][0];
      expect(config).not.toHaveProperty('Cmd');
      expect(config).not.toHaveProperty('Tty');
      expect(config).not.toHaveProperty('User');
      expect(config.HostConfig).not.toHaveProperty('Devices');
      expect(config.HostConfig).not.toHaveProperty('Volumes');
      expect(config.HostConfig.Binds).toHaveLength(1);
    });

    it('maps the env whitelist from the server', async () => {
      fakeDocker.createContainer.mockResolvedValue({ id: 'c1' });

      await service.createContainer(makeServer());

      const env: string[] = fakeDocker.createContainer.mock.calls[0][0].Env;
      expect(env).toEqual(
        expect.arrayContaining([
          'EULA=TRUE',
          'ENABLE_RCON=TRUE',
          'TYPE=PAPER',
          'VERSION=1.21.1',
          'MEMORY=2048M',
          'MAX_PLAYERS=20',
          'DIFFICULTY=normal',
          'MODE=survival',
          'ONLINE_MODE=TRUE',
          'VIEW_DISTANCE=10',
          'ALLOW_FLIGHT=FALSE',
          'PVP=TRUE',
        ]),
      );
      expect(env).toHaveLength(12);
    });

    it('supports env variants for booleans, motd, and seed', async () => {
      fakeDocker.createContainer.mockResolvedValue({ id: 'c1' });

      await service.createContainer(
        makeServer({
          onlineMode: false,
          allowFlight: true,
          pvp: false,
          motd: 'Hello\nWorld',
          levelSeed: 'abc\r\ndef',
        }),
      );

      const env: string[] = fakeDocker.createContainer.mock.calls[0][0].Env;
      expect(env).toContain('ONLINE_MODE=FALSE');
      expect(env).toContain('ALLOW_FLIGHT=TRUE');
      expect(env).toContain('PVP=FALSE');
      expect(env).toContain('MOTD=Hello World');
      expect(env).toContain('SEED=abc def');
    });

    it('rejects env keys outside the whitelist', async () => {
      fakeDocker.createContainer.mockResolvedValue({ id: 'c1' });

      await service.createContainer(makeServer({ motd: 'Welcome', levelSeed: '42' }));

      const env: string[] = fakeDocker.createContainer.mock.calls[0][0].Env;
      const keys = env.map((entry) => entry.split('=')[0]);
      const whitelist = new Set([
        'EULA',
        'ENABLE_RCON',
        'TYPE',
        'VERSION',
        'MEMORY',
        'MAX_PLAYERS',
        'DIFFICULTY',
        'MODE',
        'ONLINE_MODE',
        'VIEW_DISTANCE',
        'ALLOW_FLIGHT',
        'PVP',
        'MOTD',
        'SEED',
      ]);

      expect(keys.every((key) => whitelist.has(key))).toBe(true);
      expect(keys).toEqual(expect.arrayContaining([...whitelist]));
      expect(new Set(keys).size).toBe(keys.length);
      expect(env.filter((entry) => entry.startsWith('ENABLE_RCON=')).length).toBe(1);
      expect(env).not.toContain(expect.stringMatching(/^RCON_PASSWORD=/));
      expect(env).not.toContain(expect.stringMatching(/^RCON_PORT=/));
    });

    it.each([
      { port: 25565, ok: true },
      { port: 25665, ok: true },
      { port: 25564, ok: false },
      { port: 25666, ok: false },
    ])('accepts port $port when ok=$ok', async ({ port, ok }) => {
      fakeDocker.createContainer.mockResolvedValue({ id: 'c1' });

      if (ok) {
        await expect(service.createContainer(makeServer({ port }))).resolves.toBe('c1');
      } else {
        await expect(service.createContainer(makeServer({ port }))).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(fakeDocker.createContainer).not.toHaveBeenCalled();
      }
    });

    it.each([25570.5, NaN])('rejects non-integer port %s before calling docker', async (port) => {
      fakeDocker.createContainer.mockResolvedValue({ id: 'c1' });

      await expect(service.createContainer(makeServer({ port }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fakeDocker.createContainer).not.toHaveBeenCalled();
    });

    it('rejects an inverted port range before calling docker', async () => {
      configMock = makeConfigMock({ MC_PORT_MIN: 30000, MC_PORT_MAX: 20000 });
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DockerService,
          { provide: DOCKERODE, useValue: fakeDocker },
          { provide: ConfigService, useValue: configMock },
        ],
      }).compile();
      service = module.get<DockerService>(DockerService);

      await expect(service.createContainer(makeServer())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fakeDocker.createContainer).not.toHaveBeenCalled();
    });

    it.each([
      'host',
      'none',
      'container:other',
    ])('rejects %s as DOCKER_NETWORK before calling docker', async (network) => {
      configMock.map.set('DOCKER_NETWORK', network);

      await expect(service.createContainer(makeServer())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fakeDocker.createContainer).not.toHaveBeenCalled();
    });

    it.each([
      '../escape',
      'a/b',
      '.',
      '..',
      'bad id',
    ])('rejects server id %j as a path traversal attempt', async (id) => {
      await expect(service.createContainer(makeServer({ id }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fakeDocker.createContainer).not.toHaveBeenCalled();
    });

    it.each([
      '',
      'data',
      './data',
      '../data',
      '.',
      '..',
    ])('rejects relative or dot-segment MC_DATA_PATH %j before calling docker', async (mcDataPath) => {
      configMock.map.set('MC_DATA_PATH', mcDataPath);

      await expect(service.createContainer(makeServer())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fakeDocker.createContainer).not.toHaveBeenCalled();
    });

    it('accepts a rooted path', async () => {
      fakeDocker.createContainer.mockResolvedValue({ id: 'c1' });
      configMock.map.set('MC_DATA_PATH', '/mc-data/');

      await expect(service.createContainer(makeServer())).resolves.toBe('c1');
      expect(fakeDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: expect.objectContaining({
            Binds: ['/mc-data/abc-123:/data'],
          }),
        }),
      );
    });

    it('rejects whitespace-padded MC_DATA_PATH for compose parity', async () => {
      configMock.map.set('MC_DATA_PATH', ' /mc-data/ ');

      await expect(service.createContainer(makeServer())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fakeDocker.createContainer).not.toHaveBeenCalled();
    });

    it('canonicalizes a trailing slash on an absolute path', async () => {
      fakeDocker.createContainer.mockResolvedValue({ id: 'c1' });
      configMock.map.set('MC_DATA_PATH', '/mc-data/');

      await expect(service.createContainer(makeServer())).resolves.toBe('c1');
      expect(fakeDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: expect.objectContaining({
            Binds: ['/mc-data/abc-123:/data'],
          }),
        }),
      );
    });

    it('uses MC_DATA_BIND_SOURCE verbatim when configured (Windows host path)', async () => {
      fakeDocker.createContainer.mockResolvedValue({ id: 'c1' });
      configMock.map.set('MC_DATA_PATH', '/mc-data');
      configMock.map.set('MC_DATA_BIND_SOURCE', 'C:\\Users\\me\\.minepanel\\mc-data');

      await expect(service.createContainer(makeServer())).resolves.toBe('c1');
      expect(fakeDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: expect.objectContaining({
            // passed through to the daemon unnormalized; Docker Desktop translates it
            Binds: ['C:\\Users\\me\\.minepanel\\mc-data/abc-123:/data'],
          }),
        }),
      );
    });

    it('rejects dot-segment MC_DATA_BIND_SOURCE before calling docker', async () => {
      configMock.map.set('MC_DATA_PATH', '/mc-data');
      configMock.map.set('MC_DATA_BIND_SOURCE', '/mc-data/../etc');

      await expect(service.createContainer(makeServer())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fakeDocker.createContainer).not.toHaveBeenCalled();
    });

    it('rejects whitespace-padded MC_DATA_BIND_SOURCE', async () => {
      configMock.map.set('MC_DATA_PATH', '/mc-data');
      configMock.map.set('MC_DATA_BIND_SOURCE', ' /mc-data ');

      await expect(service.createContainer(makeServer())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fakeDocker.createContainer).not.toHaveBeenCalled();
    });

    it('resolves a valid data directory for a normal server id', async () => {
      fakeDocker.createContainer.mockResolvedValue({ id: 'c1' });

      await service.createContainer(makeServer({ id: 'valid-id_1' }));

      expect(fakeDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: expect.objectContaining({
            Binds: ['/mc-data/valid-id_1:/data'],
          }),
        }),
      );
    });

    it('enforces security invariants', async () => {
      fakeDocker.createContainer.mockResolvedValue({ id: 'c1' });

      await service.createContainer(makeServer());

      const config = fakeDocker.createContainer.mock.calls[0][0];
      expect(config.Image).toBe('itzg/minecraft-server');
      expect(config.HostConfig.NetworkMode).toBe('minepanel_network');
      expect(config.HostConfig.NetworkMode).not.toBe('host');
      expect(config.HostConfig.Binds).toHaveLength(1);
      expect(config.HostConfig.CapAdd).toEqual([]);
      expect(config.HostConfig.Privileged).toBe(false);
      expect(Object.keys(config.ExposedPorts)).toEqual(['25565/tcp']);
      expect(config.HostConfig.PortBindings).not.toHaveProperty('25575/tcp');
    });
    it('throws ServiceUnavailableException when the daemon is unreachable', async () => {
      fakeDocker.createContainer.mockRejectedValue(makeDaemonError('ECONNREFUSED'));

      await expect(service.createContainer(makeServer())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('throws ConflictException for a 409 from docker', async () => {
      fakeDocker.createContainer.mockRejectedValue(makeStatusError(409));

      await expect(service.createContainer(makeServer())).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws BadRequestException for a 400 from docker', async () => {
      fakeDocker.createContainer.mockRejectedValue(makeStatusError(400));

      await expect(service.createContainer(makeServer())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it.each([502, 503, 504])('maps HTTP %s to ServiceUnavailableException', async (statusCode) => {
      fakeDocker.createContainer.mockRejectedValue(makeStatusError(statusCode));

      await expect(service.createContainer(makeServer())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it.each([
      null,
      undefined,
    ])('maps a %s thrown value to InternalServerErrorException without TypeError', async (thrown) => {
      fakeDocker.createContainer.mockRejectedValue(thrown);

      const error = await service.createContainer(makeServer()).catch((e: Error) => e);
      expect(error).toBeInstanceOf(InternalServerErrorException);
      expect(error).not.toBeInstanceOf(TypeError);
    });

    it.each([
      'boom',
      42,
      {},
    ])('maps a %s thrown value to InternalServerErrorException', async (thrown) => {
      fakeDocker.createContainer.mockRejectedValue(thrown);

      const error = await service.createContainer(makeServer()).catch((e: Error) => e);
      expect(error).toBeInstanceOf(InternalServerErrorException);
      expect(error).not.toBeInstanceOf(TypeError);
    });

    it('classifies a create-time 404 as a missing image or network', async () => {
      fakeDocker.createContainer.mockRejectedValue(makeStatusError(404));

      const error = await service.createContainer(makeServer()).catch((e: Error) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error).not.toBeInstanceOf(ServiceUnavailableException);
      expect(error instanceof Error ? error.message : String(error)).toContain('image or network');
    });
  });

  describe('startContainer', () => {
    it('starts the container', async () => {
      const start = jest.fn().mockResolvedValue(undefined);
      fakeDocker.getContainer.mockReturnValue({ id: 'c1', start });

      await expect(service.startContainer('c1')).resolves.toBeUndefined();
      expect(start).toHaveBeenCalledTimes(1);
    });

    it('treats 304 as idempotent', async () => {
      const start = jest.fn().mockRejectedValue(makeStatusError(304));
      fakeDocker.getContainer.mockReturnValue({ id: 'c1', start });

      await expect(service.startContainer('c1')).resolves.toBeUndefined();
    });

    it('throws NotFoundException for a 404', async () => {
      const start = jest.fn().mockRejectedValue(makeStatusError(404));
      fakeDocker.getContainer.mockReturnValue({ id: 'c1', start });

      await expect(service.startContainer('c1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ServiceUnavailableException when the daemon is unreachable', async () => {
      const start = jest.fn().mockRejectedValue(makeDaemonError('ENOENT'));
      fakeDocker.getContainer.mockReturnValue({ id: 'c1', start });

      await expect(service.startContainer('c1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('stopContainer', () => {
    it('stops with the default timeout', async () => {
      const stop = jest.fn().mockResolvedValue(undefined);
      fakeDocker.getContainer.mockReturnValue({ id: 'c1', stop });

      await service.stopContainer('c1');

      expect(stop).toHaveBeenCalledWith({ t: 30 });
    });

    it('stops with a custom timeout', async () => {
      const stop = jest.fn().mockResolvedValue(undefined);
      fakeDocker.getContainer.mockReturnValue({ id: 'c1', stop });

      await service.stopContainer('c1', 10);

      expect(stop).toHaveBeenCalledWith({ t: 10 });
    });

    it.each([
      NaN,
      Infinity,
      -Infinity,
      -5,
      0.5,
      56,
      999999,
    ])('rejects stop timeout %s before docker', async (timeout) => {
      const stop = jest.fn().mockResolvedValue(undefined);
      fakeDocker.getContainer.mockReturnValue({ id: 'c1', stop });

      await expect(service.stopContainer('c1', timeout)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(stop).not.toHaveBeenCalled();
    });

    it('accepts t=0 for immediate kill', async () => {
      const stop = jest.fn().mockResolvedValue(undefined);
      fakeDocker.getContainer.mockReturnValue({ id: 'c1', stop });

      await service.stopContainer('c1', 0);

      expect(stop).toHaveBeenCalledWith({ t: 0 });
    });

    it('accepts the upper bound 55', async () => {
      const stop = jest.fn().mockResolvedValue(undefined);
      fakeDocker.getContainer.mockReturnValue({ id: 'c1', stop });

      await service.stopContainer('c1', 55);

      expect(stop).toHaveBeenCalledWith({ t: 55 });
    });

    it('returns stopped on a 204-style success', async () => {
      const stop = jest.fn().mockResolvedValue(undefined);
      fakeDocker.getContainer.mockReturnValue({ id: 'c1', stop });

      await expect(service.stopContainer('c1')).resolves.toBe('stopped');
    });

    it('returns already-stopped when Docker reports 304', async () => {
      const stop = jest.fn().mockRejectedValue(makeStatusError(304));
      fakeDocker.getContainer.mockReturnValue({ id: 'c1', stop });

      await expect(service.stopContainer('c1')).resolves.toBe('already-stopped');
    });

    it('throws ServiceUnavailableException when the daemon is unreachable', async () => {
      const stop = jest.fn().mockRejectedValue(makeDaemonError('ECONNREFUSED'));
      fakeDocker.getContainer.mockReturnValue({ id: 'c1', stop });

      await expect(service.stopContainer('c1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('removeContainer', () => {
    it('removes with force false', async () => {
      const remove = jest.fn().mockResolvedValue(undefined);
      fakeDocker.getContainer.mockReturnValue({ id: 'c1', remove });

      await service.removeContainer('c1');

      expect(remove).toHaveBeenCalledWith({ force: false });
    });

    it('treats 404 as idempotent', async () => {
      const remove = jest.fn().mockRejectedValue(makeStatusError(404));
      fakeDocker.getContainer.mockReturnValue({ id: 'c1', remove });

      await expect(service.removeContainer('c1')).resolves.toBeUndefined();
    });

    it('throws ServiceUnavailableException when the daemon is unreachable', async () => {
      const remove = jest.fn().mockRejectedValue(makeDaemonError('ENOENT'));
      fakeDocker.getContainer.mockReturnValue({ id: 'c1', remove });

      await expect(service.removeContainer('c1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('inspectContainer', () => {
    it('returns the mapped inspect state', async () => {
      fakeDocker.getContainer.mockReturnValue({
        id: 'c1',
        inspect: jest.fn().mockResolvedValue({
          Id: 'cid-1',
          Name: '/mc-abc',
          Config: { Image: 'itzg/minecraft-server' },
          State: {
            Status: 'running',
            Running: true,
            StartedAt: '2026-01-01T00:00:00Z',
            FinishedAt: '0001-01-01T00:00:00Z',
            ExitCode: 0,
            OOMKilled: false,
          },
          RestartCount: 2,
        }),
      });

      await expect(service.inspectContainer('c1')).resolves.toEqual({
        id: 'cid-1',
        name: '/mc-abc',
        image: 'itzg/minecraft-server',
        status: 'running',
        running: true,
        restartCount: 2,
        startedAt: '2026-01-01T00:00:00Z',
        finishedAt: '0001-01-01T00:00:00Z',
        exitCode: 0,
        oomKilled: false,
      });
    });

    it('throws ServiceUnavailableException when the daemon is unreachable', async () => {
      fakeDocker.getContainer.mockReturnValue({
        id: 'c1',
        inspect: jest.fn().mockRejectedValue(makeDaemonError('ECONNREFUSED')),
      });

      await expect(service.inspectContainer('c1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('throws InternalServerErrorException for a 500', async () => {
      fakeDocker.getContainer.mockReturnValue({
        id: 'c1',
        inspect: jest.fn().mockRejectedValue(makeStatusError(500)),
      });

      const error = await service.inspectContainer('c1').catch((e: Error) => e);
      expect(error).toBeInstanceOf(InternalServerErrorException);
      expect(error).not.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('getHostInfo', () => {
    it('converts docker.info bytes to MB and returns CPU count', async () => {
      fakeDocker.info.mockResolvedValue({ MemTotal: 17179869184, NCPU: 8 });

      // SAFETY: The test-controlled value satisfies the concrete framework contract used by this assertion.
      await expect(service.getHostInfo()).resolves.toEqual({
        totalRamMb: 16384,
        cpuCount: 8,
        // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
      } as HostInfo);
    });

    it('returns nulls for malformed fields', async () => {
      fakeDocker.info.mockResolvedValue({ MemTotal: undefined, NCPU: '8' });

      // SAFETY: The test-controlled value satisfies the concrete framework contract used by this assertion.
      await expect(service.getHostInfo()).resolves.toEqual({
        totalRamMb: null,
        cpuCount: null,
        // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
      } as HostInfo);
    });

    it('returns null for negative memory', async () => {
      fakeDocker.info.mockResolvedValue({ MemTotal: -5, NCPU: 8 });

      // SAFETY: The test-controlled value satisfies the concrete framework contract used by this assertion.
      await expect(service.getHostInfo()).resolves.toEqual({
        totalRamMb: null,
        cpuCount: 8,
        // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
      } as HostInfo);
    });

    it('returns nulls for zero MemTotal and NCPU', async () => {
      fakeDocker.info.mockResolvedValue({ MemTotal: 0, NCPU: 0 });

      // SAFETY: The test-controlled value satisfies the concrete framework contract used by this assertion.
      await expect(service.getHostInfo()).resolves.toEqual({
        totalRamMb: null,
        cpuCount: null,
        // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
      } as HostInfo);
    });

    it.each([null, undefined])('returns nulls for a %s docker.info response', async (info) => {
      fakeDocker.info.mockResolvedValue(info);

      // SAFETY: The test-controlled value satisfies the concrete framework contract used by this assertion.
      await expect(service.getHostInfo()).resolves.toEqual({
        totalRamMb: null,
        cpuCount: null,
        // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
      } as HostInfo);
    });

    it('returns null for fractional MemTotal and NCPU', async () => {
      fakeDocker.info.mockResolvedValue({ MemTotal: 123.5, NCPU: 7.5 });

      // SAFETY: The test-controlled value satisfies the concrete framework contract used by this assertion.
      await expect(service.getHostInfo()).resolves.toEqual({
        totalRamMb: null,
        cpuCount: null,
        // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
      } as HostInfo);
    });

    it('throws ServiceUnavailableException when the daemon is unreachable', async () => {
      fakeDocker.info.mockRejectedValue(makeDaemonError('ECONNREFUSED'));

      await expect(service.getHostInfo()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('getHostDiskInfo', () => {
    it('converts statfs blocks to MB', async () => {
      // SAFETY: Node's StatsFs type has more fields, but DockerService reads only these three fields.
      statfsSpy = jest
        .spyOn(fs, 'statfs')
        .mockResolvedValue({ bsize: 4096, blocks: 1000000, bavail: 500000 } as StatsFs);

      // SAFETY: The test-controlled value satisfies the concrete framework contract used by this assertion.
      await expect(service.getHostDiskInfo()).resolves.toEqual({
        totalDiskMb: 3906,
        freeDiskMb: 1953,
        // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
      } as DiskInfo);
    });

    it('returns nulls when statfs fails', async () => {
      statfsSpy = jest.spyOn(fs, 'statfs').mockRejectedValue(new Error('no such path'));

      // SAFETY: The test-controlled value satisfies the concrete framework contract used by this assertion.
      await expect(service.getHostDiskInfo()).resolves.toEqual({
        totalDiskMb: null,
        freeDiskMb: null,
        // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
      } as DiskInfo);
    });

    it('stats the same canonical root used for container binds', async () => {
      // SAFETY: The test-controlled value satisfies the concrete framework contract used by this assertion.
      statfsSpy = jest.spyOn(fs, 'statfs').mockResolvedValue({
        bsize: 4096,
        blocks: 1_000_000,
        bavail: 500_000,
        // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
      } as StatsFs);
      configMock.map.set('MC_DATA_PATH', '/mc-data/');

      await service.getHostDiskInfo();

      expect(statfsSpy.mock.calls[0][0]).toBe('/mc-data');
    });

    it('rejects a relative MC_DATA_PATH', async () => {
      configMock.map.set('MC_DATA_PATH', 'data');

      await expect(service.getHostDiskInfo()).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      { bavail: 1_000_001 },
      { blocks: -5 },
      { bavail: -5 },
      { bsize: 4096.5 },
      { blocks: 1_000_000.5 },
      { bsize: 0 },
      { bsize: NaN },
    ])('returns nulls for statfs %j', async (override) => {
      // SAFETY: The test-controlled value satisfies the concrete framework contract used by this assertion.
      statfsSpy = jest.spyOn(fs, 'statfs').mockResolvedValue({
        bsize: 4096,
        blocks: 1_000_000,
        bavail: 500_000,
        ...override,
        // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
      } as StatsFs);

      // SAFETY: The test-controlled value satisfies the concrete framework contract used by this assertion.
      await expect(service.getHostDiskInfo()).resolves.toEqual({
        totalDiskMb: null,
        freeDiskMb: null,
        // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
      } as DiskInfo);
    });
  });
  describe('executeRconCommand', () => {
    const makeExec = (inspectResult: ExecInspectResult = { Running: false, ExitCode: 0 }) => {
      const stream = Readable.from(['discarded output']);
      const start = jest.fn().mockResolvedValue(stream);
      const inspect = jest.fn().mockResolvedValue(inspectResult);
      const exec = jest.fn().mockResolvedValue({ start, inspect });
      fakeDocker.getContainer.mockReturnValue({ id: 'c1', exec });
      return { exec, start, inspect, stream };
    };

    it('executes fixed argv with non-interactive attached output and drains it', async () => {
      const { exec, start, inspect } = makeExec();

      await expect(service.executeRconCommand('c1', ['say', 'hello'])).resolves.toBeUndefined();

      expect(fakeDocker.getContainer).toHaveBeenCalledWith('c1');
      expect(exec).toHaveBeenCalledWith(
        expect.objectContaining({
          Cmd: ['rcon-cli', 'say', 'hello'],
          AttachStdin: false,
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
        }),
      );
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ Detach: false, Tty: false }));
      expect(inspect).toHaveBeenCalled();
    });
    it('rejects invalid argv before any Docker call', async () => {
      const commands: readonly (readonly string[])[] = [
        [],
        [''],
        ['say', 'hello', 'extra'],
        ['say', 'line\nbreak'],
        ['say', 'line\rbreak'],
        ['say', 'nul\0byte'],
        ['say', 'x'.repeat(256)],
      ];

      for (const command of commands) {
        await expect(service.executeRconCommand('c1', command)).rejects.toBeInstanceOf(
          RconUnavailableError,
        );
      }
      expect(fakeDocker.getContainer).not.toHaveBeenCalled();
    });

    it('rejects a command whose combined UTF-8 size exceeds 256 bytes', async () => {
      const command = ['say', 'é'.repeat(128)];

      await expect(service.executeRconCommand('c1', command)).rejects.toBeInstanceOf(
        RconUnavailableError,
      );
      expect(fakeDocker.getContainer).not.toHaveBeenCalled();
    });

    it.each([
      { Running: true, ExitCode: 0 },
      { Running: false, ExitCode: 1 },
      { Running: 'false', ExitCode: 0 },
      { Running: false },
      { ExitCode: 0 },
    ])('rejects malformed or unsuccessful inspect result %j', async (inspectResult) => {
      makeExec(inspectResult);

      await expect(service.executeRconCommand('c1', ['save-all'])).rejects.toBeInstanceOf(
        RconUnavailableError,
      );
    });

    it('maps stream errors to RconUnavailableError and does not buffer output', async () => {
      const stream = new Readable({ read() {} });
      const start = jest.fn().mockResolvedValue(stream);
      const inspect = jest.fn();
      const exec = jest.fn().mockResolvedValue({ start, inspect });
      fakeDocker.getContainer.mockReturnValue({ exec });
      const promise = service.executeRconCommand('c1', ['save-all']);
      await Promise.resolve();
      await Promise.resolve();
      stream.emit('error', new Error('stream failed'));

      await expect(promise).rejects.toBeInstanceOf(RconUnavailableError);
      expect(inspect).not.toHaveBeenCalled();
    });

    it('aborts and cleans up a stalled command at the single 10 second deadline', async () => {
      jest.useFakeTimers();
      const stream = new Readable({ read() {} });
      const start = jest.fn().mockResolvedValue(stream);
      const inspect = jest.fn();
      const exec = jest.fn().mockResolvedValue({ start, inspect });
      fakeDocker.getContainer.mockReturnValue({ exec });
      const promise = service.executeRconCommand('c1', ['save-all']);
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(10_000);
      await expect(promise).rejects.toBeInstanceOf(RconUnavailableError);
      expect(stream.destroyed).toBe(true);
      expect(inspect).not.toHaveBeenCalled();
    });

    it('preserves typed daemon transport failures', async () => {
      fakeDocker.getContainer.mockImplementationOnce(() => {
        throw makeDaemonError('ECONNREFUSED');
      });

      await expect(service.executeRconCommand('c1', ['save-all'])).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it.each([
      [404, NotFoundException],
      [409, ConflictException],
      [503, ServiceUnavailableException],
    ] as const)('preserves typed HTTP %s transport failures', async (statusCode, ErrorType) => {
      fakeDocker.getContainer.mockReturnValue({
        exec: jest.fn().mockRejectedValue(makeStatusError(statusCode)),
      });

      await expect(service.executeRconCommand('c1', ['save-all'])).rejects.toBeInstanceOf(
        ErrorType,
      );
    });

    it('does not log command argv or command output', async () => {
      const { stream } = makeExec();
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

      await service.executeRconCommand('c1', ['say', 'secret']);

      expect(log).not.toHaveBeenCalled();
      expect(stream.destroyed).toBe(true);
      log.mockRestore();
    });
  });
});
