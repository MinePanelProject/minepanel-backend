import {
  ConflictException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService, type ConfigService as ConfigServiceType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { DRIZZLE } from 'src/db/db.module';
import type { Server } from 'src/db/schema';
import {
  type ContainerInspectState,
  type DiskInfo,
  DockerService,
  type HostInfo,
} from 'src/docker/docker.service';
import { CreateServerDto } from './dto/create-server.dto';
import { ListServersQueryDto } from './dto/list-servers-query.dto';
import { ServersService } from './servers.service';

type QueryChain<T> = Promise<T> & {
  where: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
  offset: jest.Mock;
};

const makeQuery = <T>(result: T): QueryChain<T> => {
  const query = Promise.resolve(result) as QueryChain<T>;
  query.where = jest.fn(() => query);
  query.orderBy = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  query.offset = jest.fn(() => query);
  return query;
};

const makeServer = (overrides: Partial<Server> = {}): Server => ({
  id: 'server-1',
  name: 'Survival',
  provider: 'PAPER',
  version: '1.21.1',
  port: 25565,
  containerId: 'container-1',
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
  worldPath: '/mc-data/server-1',
  rconPassword: 'secret',
  ownerId: 'owner-1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const makeDto = (overrides: Partial<CreateServerDto> = {}): CreateServerDto => ({
  name: 'Survival',
  provider: 'PAPER',
  version: '1.21.1',
  port: 25565,
  ...overrides,
});

const makeInspect = (overrides: Partial<ContainerInspectState> = {}): ContainerInspectState => ({
  id: 'container-1',
  name: '/mc-server-1',
  image: 'itzg/minecraft-server',
  status: 'running',
  running: true,
  restartCount: 0,
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '',
  exitCode: 0,
  oomKilled: false,
  ...overrides,
});

const docker503 = () => new ServiceUnavailableException('Docker daemon unreachable');

const resourceResponse = (error: unknown): unknown =>
  error instanceof HttpException ? error.getResponse() : undefined;

describe('ServersService', () => {
  let service: ServersService;
  let db: {
    select: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    transaction: jest.Mock;
    execute: jest.Mock;
  };
  let docker: Pick<
    DockerService,
    | 'createContainer'
    | 'startContainer'
    | 'stopContainer'
    | 'removeContainer'
    | 'findManagedContainer'
    | 'inspectContainer'
    | 'getHostInfo'
    | 'getHostDiskInfo'
  >;
  let config: Pick<ConfigServiceType, 'get'>;
  let selectResults: unknown[];
  let insertResults: Server[];
  let updateResults: unknown[][];
  let updatedValues: Record<string, unknown>[];
  let insertedValues: Record<string, unknown>[];
  let successfulUpdatedValues: Record<string, unknown>[];
  let deletedRows: unknown[];
  let queryChains: QueryChain<unknown>[];
  let calls: string[];
  let configValues: Record<string, string | number>;

  const setResources = (
    hostInfo: HostInfo = { totalRamMb: 8192, cpuCount: 8 },
    diskInfo: DiskInfo = { totalDiskMb: 100000, freeDiskMb: 5000 },
  ) => {
    docker.getHostInfo = jest.fn().mockImplementation(async () => {
      calls.push('hostInfo');
      return hostInfo;
    });
    docker.getHostDiskInfo = jest.fn().mockImplementation(async () => {
      calls.push('diskInfo');
      return diskInfo;
    });
  };

  beforeEach(async () => {
    selectResults = [];
    insertResults = [];
    updateResults = [];
    updatedValues = [];
    insertedValues = [];
    successfulUpdatedValues = [];
    deletedRows = [];
    queryChains = [];
    calls = [];
    configValues = {};

    db = {
      select: jest.fn(() => {
        const query = makeQuery(selectResults.shift() ?? []);
        queryChains.push(query);
        return { from: jest.fn(() => query) };
      }),
      insert: jest.fn(() => ({
        values: jest.fn((values: Record<string, unknown>) => {
          insertedValues.push(values);
          const row = insertResults.shift();
          return { returning: jest.fn().mockResolvedValue(row ? [row] : []) };
        }),
      })),
      update: jest.fn(() => ({
        set: jest.fn((values: Record<string, unknown>) => {
          updatedValues.push(values);
          return {
            where: jest.fn(() => ({
              returning: jest.fn(async () => {
                const rows = updateResults.shift() ?? [];
                if (rows.length > 0) successfulUpdatedValues.push(values);
                return rows;
              }),
            })),
          };
        }),
      })),
      delete: jest.fn(() => ({
        where: jest.fn(() => {
          deletedRows.push(true);
          return Promise.resolve(undefined);
        }),
      })),
      transaction: jest.fn(async (callback: (tx: typeof db) => Promise<unknown>) => callback(db)),
      execute: jest.fn().mockResolvedValue(undefined),
    };

    docker = {
      createContainer: jest.fn(async () => {
        calls.push('createContainer');
        return 'container-1';
      }),
      startContainer: jest.fn(async () => {
        calls.push('startContainer');
      }),
      stopContainer: jest.fn(async () => {
        calls.push('stopContainer');
      }),
      removeContainer: jest.fn(async () => {
        calls.push('removeContainer');
      }),
      findManagedContainer: jest.fn().mockResolvedValue(null),
      inspectContainer: jest.fn().mockResolvedValue(makeInspect()),
      getHostInfo: jest.fn().mockResolvedValue({ totalRamMb: 8192, cpuCount: 8 }),
      getHostDiskInfo: jest.fn().mockResolvedValue({ totalDiskMb: 100000, freeDiskMb: 5000 }),
    };
    config = {
      get: jest.fn((key: string, fallback?: string | number) => configValues[key] ?? fallback),
    };
    setResources();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServersService,
        { provide: DRIZZLE, useValue: db },
        { provide: DockerService, useValue: docker },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get<ServersService>(ServersService);
  });

  describe('reads and projection', () => {
    it('lists visible rows with total, defaults, stable ordering, and no private fields', async () => {
      const visible = makeServer();
      selectResults.push([visible], [{ total: 1 }]);

      const result = await service.listServers(new ListServersQueryDto());

      expect(result).toEqual({ data: [expect.objectContaining({ id: 'server-1' })], total: 1 });
      expect(result.data[0]).not.toHaveProperty('rconPassword');
      expect(result.data[0]).not.toHaveProperty('containerId');
      expect(result.data[0]).not.toHaveProperty('worldPath');
      expect(queryChains[0].limit).toHaveBeenCalledWith(20);
      expect(queryChains[0].offset).toHaveBeenCalledWith(0);
      expect(db.select).toHaveBeenCalledTimes(2);
    });

    it('honors explicit pagination values', async () => {
      selectResults.push([], [{ total: 0 }]);

      await service.listServers({ limit: 7, offset: 14 });

      expect(queryChains[0].limit).toHaveBeenCalledWith(7);
      expect(queryChains[0].offset).toHaveBeenCalledWith(14);
    });

    it('returns a public projection for a single visible row', async () => {
      selectResults.push([makeServer()]);

      const result = await service.getServer('server-1');

      expect(result.id).toBe('server-1');
      expect(result).not.toHaveProperty('rconPassword');
      expect(result).not.toHaveProperty('containerId');
      expect(result).not.toHaveProperty('worldPath');
    });

    it('hides CREATING rows as not found', async () => {
      selectResults.push([]);

      await expect(service.getServer('creating')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('distinguishes absent rows from visible wrong-state conflicts', async () => {
      selectResults.push([]);
      await expect(service.startServer('missing')).rejects.toMatchObject({
        response: expect.objectContaining({ message: 'Server not found' }),
        status: 404,
      });

      selectResults.push([makeServer({ status: 'RUNNING' })]);
      await expect(service.startServer('server-1')).rejects.toMatchObject({
        response: expect.objectContaining({ message: 'Server is not in STOPPED state' }),
        status: 409,
      });

      selectResults.push([makeServer({ status: 'STOPPED' })]);
      await expect(service.stopServer('server-1')).rejects.toMatchObject({
        response: expect.objectContaining({ message: 'Server is not in RUNNING state' }),
        status: 409,
      });

      selectResults.push([makeServer({ status: 'RUNNING' })]);
      await expect(service.deleteServer('server-1')).rejects.toMatchObject({
        response: expect.objectContaining({ message: 'Server is not in STOPPED state' }),
        status: 409,
      });
    });
  });

  describe('resource admission', () => {
    it('fails closed on malformed configuration before any database or Docker mutation', async () => {
      configValues = { MIN_FREE_DISK_MB: '0', MAX_MEMORY_RATIO: '0.9' };
      selectResults.push([]);

      await expect(service.createServer(makeDto(), 'owner-1')).rejects.toMatchObject({
        response: expect.objectContaining({ message: 'Host resource information unavailable' }),
        status: 503,
      });
      expect(docker.getHostInfo).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('returns the exact disk InsufficientResources payload', async () => {
      setResources(undefined, { totalDiskMb: 1000, freeDiskMb: 100 });

      let error: unknown;
      try {
        await service.createServer(makeDto(), 'owner-1');
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(422);
      expect(resourceResponse(error)).toEqual({
        statusCode: 422,
        error: 'InsufficientResources',
        message: 'Insufficient disk space to create server',
        details: { resource: 'disk', availableMb: 100, requiredMb: 2048, totalMb: 1000 },
      });
      expect(db.transaction).not.toHaveBeenCalled();
      expect(docker.createContainer).not.toHaveBeenCalled();
    });

    it('returns the exact memory InsufficientResources payload after locked allocation', async () => {
      selectResults.push([{ id: 'other', memoryLimitMb: 4000 }]);

      let error: unknown;
      try {
        await service.createServer(makeDto({ memoryLimitMb: 4096 }), 'owner-1');
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(422);
      expect(resourceResponse(error)).toEqual({
        statusCode: 422,
        error: 'InsufficientResources',
        message: 'Insufficient memory to create server',
        details: { resource: 'memory', availableMb: 3372, requiredMb: 4096, totalMb: 8192 },
      });
      expect(db.insert).not.toHaveBeenCalled();
      expect(docker.createContainer).not.toHaveBeenCalled();
    });

    it('sums every existing server regardless of status for the create allocation', async () => {
      selectResults.push([{ id: 'stopped', memoryLimitMb: 4000 }]);
      insertResults.push(makeServer({ status: 'CREATING', containerId: null }));
      updateResults.push([makeServer({ status: 'CREATING' })], [makeServer({ status: 'RUNNING' })]);

      await service.createServer(makeDto(), 'owner-1');

      // the create allocation query must not filter STOPPED rows
      expect(queryChains[0].where).not.toHaveBeenCalled();
    });

    it('fails closed for a null total RAM measurement', async () => {
      setResources({ totalRamMb: null, cpuCount: 8 }, { totalDiskMb: 100000, freeDiskMb: 5000 });

      await expect(service.createServer(makeDto(), 'owner-1')).rejects.toMatchObject({
        response: expect.objectContaining({ message: 'Host resource information unavailable' }),
        status: 503,
      });
      expect(db.insert).not.toHaveBeenCalled();
      expect(docker.createContainer).not.toHaveBeenCalled();
    });

    it('fails closed for a null CPU measurement', async () => {
      setResources({ totalRamMb: 8192, cpuCount: null }, { totalDiskMb: 100000, freeDiskMb: 5000 });

      await expect(service.createServer(makeDto(), 'owner-1')).rejects.toMatchObject({
        response: expect.objectContaining({ message: 'Host resource information unavailable' }),
        status: 503,
      });
      expect(db.insert).not.toHaveBeenCalled();
      expect(docker.createContainer).not.toHaveBeenCalled();
    });
    it('retains CREATING when managed-container absence cannot be confirmed', async () => {
      const error = docker503();
      docker.createContainer = jest.fn().mockRejectedValue(error);
      docker.findManagedContainer = jest.fn().mockResolvedValue({ unavailable: true });
      selectResults.push([]);
      insertResults.push(makeServer({ status: 'CREATING', containerId: null }));

      await expect(service.createServer(makeDto(), 'owner-1')).rejects.toBe(error);

      expect(db.delete).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('preserves Docker-originated 503 from preflight rather than replacing it', async () => {
      const error = docker503();
      docker.getHostInfo = jest.fn().mockResolvedValue({ totalRamMb: 8192, cpuCount: 8 });
      docker.getHostDiskInfo = jest.fn().mockRejectedValue(error);

      await expect(service.createServer(makeDto(), 'owner-1')).rejects.toBe(error);
      expect(db.transaction).not.toHaveBeenCalled();
      expect(docker.createContainer).not.toHaveBeenCalled();
    });

    it('checks configuration, host information, then disk information in order', async () => {
      docker.getHostDiskInfo = jest.fn().mockImplementation(async () => {
        calls.push('diskInfo');
        throw new InternalServerErrorException('disk read failed');
      });

      await expect(service.createServer(makeDto(), 'owner-1')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(calls).toEqual(['hostInfo', 'diskInfo']);
    });
  });

  describe('createServer', () => {
    it('inserts CREATING, persists the container id, starts, and finalizes RUNNING', async () => {
      const creating = makeServer({ status: 'CREATING', containerId: null });
      const withId = makeServer({ status: 'CREATING' });
      const running = makeServer({ status: 'RUNNING' });
      selectResults.push([]);
      insertResults.push(creating);
      updateResults.push([withId], [running]);

      const result = await service.createServer(makeDto(), 'authenticated-owner');

      expect(result).toEqual(expect.objectContaining({ id: 'server-1', status: 'RUNNING' }));
      expect(result).not.toHaveProperty('containerId');
      expect(insertedValues[0]).toEqual(
        expect.objectContaining({
          status: 'CREATING',
          ownerId: 'authenticated-owner',
          maxPlayers: 20,
          difficulty: 'NORMAL',
          gamemode: 'SURVIVAL',
          pvp: true,
          memoryLimitMb: 2048,
          onlineMode: true,
          viewDistance: 10,
          allowFlight: false,
        }),
      );
      expect(calls).toEqual(['hostInfo', 'diskInfo', 'createContainer', 'startContainer']);
      expect(docker.createContainer).toHaveBeenCalledWith(creating);
      expect(docker.startContainer).toHaveBeenCalledWith('container-1');
      expect(updatedValues.map((value) => value.status)).toEqual([undefined, 'RUNNING']);
    });

    it('uses the authenticated owner and never accepts an owner id from the DTO', async () => {
      const dto = makeDto() as CreateServerDto & { ownerId?: string };
      dto.ownerId = 'forged-owner';
      const creating = makeServer({
        ownerId: 'authenticated-owner',
        status: 'CREATING',
        containerId: null,
      });
      insertResults.push(creating);
      updateResults.push([makeServer({ status: 'CREATING' })], [makeServer({ status: 'RUNNING' })]);
      selectResults.push([]);

      await service.createServer(dto, 'authenticated-owner');

      expect(insertedValues[0]).toEqual(
        expect.objectContaining({ ownerId: 'authenticated-owner' }),
      );
      expect(insertedValues[0]).not.toHaveProperty('forged-owner');
    });

    it('deletes the provisional row when create fails before a container exists', async () => {
      const error = new NotFoundException('Docker image or network not found');
      docker.createContainer = jest.fn().mockRejectedValue(error);
      selectResults.push([]);
      insertResults.push(makeServer({ status: 'CREATING', containerId: null }));

      await expect(service.createServer(makeDto(), 'owner-1')).rejects.toBe(error);

      expect(docker.findManagedContainer).toHaveBeenCalledWith('server-1');
      expect(db.delete).toHaveBeenCalledTimes(1);
      expect(docker.startContainer).not.toHaveBeenCalled();
    });

    it('attaches a managed container and marks ERROR when create outcome is ambiguous', async () => {
      const error = docker503();
      docker.createContainer = jest.fn().mockRejectedValue(error);
      docker.findManagedContainer = jest.fn().mockResolvedValue({ id: 'recovered', running: true });
      selectResults.push([]);
      insertResults.push(makeServer({ status: 'CREATING', containerId: null }));

      await expect(service.createServer(makeDto(), 'owner-1')).rejects.toBe(error);

      expect(db.delete).not.toHaveBeenCalled();
      expect(updatedValues).toEqual([
        expect.objectContaining({ containerId: 'recovered', status: 'ERROR' }),
      ]);
    });

    it('retains CREATING when managed-container absence cannot be confirmed', async () => {
      const error = docker503();
      docker.createContainer = jest.fn().mockRejectedValue(error);
      docker.findManagedContainer = jest.fn().mockResolvedValue({ unavailable: true });
      selectResults.push([]);
      insertResults.push(makeServer({ status: 'CREATING', containerId: null }));

      await expect(service.createServer(makeDto(), 'owner-1')).rejects.toBe(error);
      expect(db.delete).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('compensates a failed container-id persistence without orphaning a managed container', async () => {
      const created = makeServer({ status: 'CREATING', containerId: null });
      docker.createContainer = jest.fn().mockResolvedValue('container-1');
      docker.findManagedContainer = jest
        .fn()
        .mockResolvedValue({ id: 'container-1', running: false });
      selectResults.push([]);
      insertResults.push(created);
      updateResults.push([]);

      await expect(service.createServer(makeDto(), 'owner-1')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );

      expect(docker.findManagedContainer).toHaveBeenCalledWith('server-1');
    });
  });

  describe('startServer', () => {
    it('claims STOPPED before Docker start and finalizes RUNNING', async () => {
      const stopped = makeServer({ status: 'STOPPED' });
      const starting = makeServer({ status: 'STARTING' });
      const running = makeServer({ status: 'RUNNING' });
      selectResults.push([stopped], []);
      updateResults.push([starting], [running]);

      const result = await service.startServer('server-1');

      expect(result.status).toBe('RUNNING');
      expect(docker.startContainer).toHaveBeenCalledTimes(1);
      expect(updatedValues.map((value) => value.status)).toEqual(['STARTING', 'RUNNING']);
    });

    it('rejects an unprovisioned server before resource checks or Docker calls', async () => {
      selectResults.push([makeServer({ containerId: null })]);

      await expect(service.startServer('server-1')).rejects.toMatchObject({
        response: expect.objectContaining({ message: 'Server container is not provisioned' }),
        status: 409,
      });
      expect(docker.getHostInfo).not.toHaveBeenCalled();
      expect(docker.startContainer).not.toHaveBeenCalled();
    });

    it('treats a lost STOPPED claim as a conflict and does not call Docker', async () => {
      selectResults.push([makeServer()], []);
      updateResults.push([]);

      await expect(service.startServer('server-1')).rejects.toMatchObject({
        response: expect.objectContaining({ message: 'Server is not in STOPPED state' }),
        status: 409,
      });
      expect(docker.startContainer).not.toHaveBeenCalled();
    });

    it('moves STARTING to ERROR on an ambiguous Docker 503', async () => {
      const error = docker503();
      docker.startContainer = jest.fn().mockRejectedValue(error);
      selectResults.push([makeServer()], []);
      updateResults.push([makeServer({ status: 'STARTING' })], [makeServer({ status: 'ERROR' })]);

      await expect(service.startServer('server-1')).rejects.toBe(error);

      expect(updatedValues.map((value) => value.status)).toEqual(['STARTING', 'ERROR']);
      expect(updatedValues.map((value) => value.status)).not.toContain('STOPPED');
    });

    it('restores STOPPED after a known Docker start failure', async () => {
      const error = new ConflictException('container conflicts with existing state');
      docker.startContainer = jest.fn().mockRejectedValue(error);
      selectResults.push([makeServer()], []);
      updateResults.push([makeServer({ status: 'STARTING' })], [makeServer({ status: 'STOPPED' })]);

      await expect(service.startServer('server-1')).rejects.toBe(error);

      expect(updatedValues.map((value) => value.status)).toEqual(['STARTING', 'STOPPED']);
    });

    it('settles ERROR when RUNNING finalization loses its CAS', async () => {
      selectResults.push([makeServer()], []);
      updateResults.push(
        [makeServer({ status: 'STARTING' })],
        [],
        [makeServer({ status: 'ERROR' })],
      );

      await expect(service.startServer('server-1')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(docker.startContainer).toHaveBeenCalledTimes(1);
      expect(updatedValues.map((value) => value.status)).toEqual(['STARTING', 'RUNNING', 'ERROR']);
    });
  });

  describe('stopServer', () => {
    it('claims RUNNING, stops the container, and finalizes STOPPED', async () => {
      selectResults.push([makeServer({ status: 'RUNNING' })]);
      updateResults.push([makeServer({ status: 'STOPPING' })], [makeServer({ status: 'STOPPED' })]);

      const result = await service.stopServer('server-1');

      expect(result.status).toBe('STOPPED');
      expect(docker.stopContainer).toHaveBeenCalledWith('container-1');
      expect(updatedValues.map((value) => value.status)).toEqual(['STOPPING', 'STOPPED']);
    });

    it('does not call Docker when the RUNNING claim is lost', async () => {
      selectResults.push([makeServer({ status: 'RUNNING' })]);
      updateResults.push([]);

      await expect(service.stopServer('server-1')).rejects.toMatchObject({
        response: expect.objectContaining({ message: 'Server is not in RUNNING state' }),
        status: 409,
      });
      expect(docker.stopContainer).not.toHaveBeenCalled();
    });

    it('moves STOPPING to ERROR on an ambiguous Docker 503', async () => {
      const error = docker503();
      docker.stopContainer = jest.fn().mockRejectedValue(error);
      selectResults.push([makeServer({ status: 'RUNNING' })]);
      updateResults.push([makeServer({ status: 'STOPPING' })], [makeServer({ status: 'ERROR' })]);

      await expect(service.stopServer('server-1')).rejects.toBe(error);
      expect(updatedValues.map((value) => value.status)).toEqual(['STOPPING', 'ERROR']);
    });

    it('restores RUNNING after a known Docker stop failure', async () => {
      const error = new ConflictException('container conflicts with existing state');
      docker.stopContainer = jest.fn().mockRejectedValue(error);
      selectResults.push([makeServer({ status: 'RUNNING' })]);
      updateResults.push([makeServer({ status: 'STOPPING' })], [makeServer({ status: 'RUNNING' })]);

      await expect(service.stopServer('server-1')).rejects.toBe(error);
      expect(updatedValues.map((value) => value.status)).toEqual(['STOPPING', 'RUNNING']);
    });
  });

  describe('restartServer', () => {
    it('stops then starts without publishing STOPPED or using a Docker restart primitive', async () => {
      const running = makeServer({ status: 'RUNNING' });
      selectResults.push([running], []);
      updateResults.push(
        [makeServer({ status: 'STOPPING' })],
        [makeServer({ status: 'STARTING' })],
        [makeServer({ status: 'RUNNING' })],
      );

      const result = await service.restartServer('server-1');

      expect(result.status).toBe('RUNNING');
      expect(docker.stopContainer).toHaveBeenCalledWith('container-1');
      expect(docker.startContainer).toHaveBeenCalledWith('container-1');
      expect(updatedValues.map((value) => value.status)).toEqual([
        'STOPPING',
        'STARTING',
        'RUNNING',
      ]);
      expect(updatedValues.map((value) => value.status)).not.toContain('STOPPED');
      expect(
        (docker as unknown as { restartContainer?: jest.Mock }).restartContainer,
      ).toBeUndefined();
    });

    it('moves STOPPING to ERROR when the stop phase is ambiguous', async () => {
      const error = docker503();
      docker.stopContainer = jest.fn().mockRejectedValue(error);
      selectResults.push([makeServer({ status: 'RUNNING' })]);
      updateResults.push([makeServer({ status: 'STOPPING' })], [makeServer({ status: 'ERROR' })]);

      await expect(service.restartServer('server-1')).rejects.toBe(error);
      expect(docker.startContainer).not.toHaveBeenCalled();
      expect(updatedValues.map((value) => value.status)).toEqual(['STOPPING', 'ERROR']);
    });

    it('settles STOPPED when admission fails after a successful stop', async () => {
      selectResults.push([makeServer({ status: 'RUNNING' })], []);
      updateResults.push([makeServer({ status: 'STOPPING' })], [makeServer({ status: 'STOPPED' })]);
      setResources(undefined, { totalDiskMb: 1000, freeDiskMb: 100 });

      await expect(service.restartServer('server-1')).rejects.toMatchObject({ status: 422 });

      expect(docker.stopContainer).toHaveBeenCalledTimes(1);
      expect(docker.startContainer).not.toHaveBeenCalled();
      expect(successfulUpdatedValues.map((value) => value.status)).toEqual(['STOPPING', 'STOPPED']);
    });

    it('marks ERROR when the post-stop Docker start is ambiguous', async () => {
      const error = docker503();
      docker.startContainer = jest.fn().mockRejectedValue(error);
      selectResults.push([makeServer({ status: 'RUNNING' })], []);
      updateResults.push(
        [makeServer({ status: 'STOPPING' })],
        [makeServer({ status: 'STARTING' })],
        [makeServer({ status: 'ERROR' })],
      );

      await expect(service.restartServer('server-1')).rejects.toBe(error);

      expect(successfulUpdatedValues.map((value) => value.status)).toEqual([
        'STOPPING',
        'STARTING',
        'ERROR',
      ]);
    });

    it('settles STOPPED when the post-stop Docker start fails with a known error', async () => {
      const error = new ConflictException('container conflicts with existing state');
      docker.startContainer = jest.fn().mockRejectedValue(error);
      selectResults.push([makeServer({ status: 'RUNNING' })], []);
      updateResults.push(
        [makeServer({ status: 'STOPPING' })],
        [makeServer({ status: 'STARTING' })],
        [makeServer({ status: 'STOPPED' })],
      );

      await expect(service.restartServer('server-1')).rejects.toBe(error);

      expect(successfulUpdatedValues.map((value) => value.status)).toEqual([
        'STOPPING',
        'STARTING',
        'STOPPED',
      ]);
    });
  });
  describe('deleteServer', () => {
    it('claims STOPPED, removes the container, and deletes only the claimed row', async () => {
      selectResults.push([makeServer({ status: 'STOPPED' })]);
      updateResults.push([makeServer({ status: 'STOPPING' })]);

      await expect(service.deleteServer('server-1')).resolves.toBeUndefined();

      expect(docker.removeContainer).toHaveBeenCalledWith('container-1');
      expect(db.delete).toHaveBeenCalledTimes(1);
    });

    it('skips Docker removal when containerId is null', async () => {
      selectResults.push([makeServer({ status: 'STOPPED', containerId: null })]);
      updateResults.push([makeServer({ status: 'STOPPING', containerId: null })]);

      await expect(service.deleteServer('server-1')).resolves.toBeUndefined();

      expect(docker.removeContainer).not.toHaveBeenCalled();
      expect(db.delete).toHaveBeenCalledTimes(1);
    });

    it('does not remove a container after a lost STOPPED claim', async () => {
      selectResults.push([makeServer({ status: 'STOPPED' })]);
      updateResults.push([]);

      await expect(service.deleteServer('server-1')).rejects.toMatchObject({ status: 409 });
      expect(docker.removeContainer).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('deletes the row when remove fails but inspect confirms the container is absent', async () => {
      const error = new ConflictException('container conflicts with existing state');
      docker.removeContainer = jest.fn().mockRejectedValue(error);
      docker.inspectContainer = jest
        .fn()
        .mockRejectedValue(new NotFoundException('container not found'));
      selectResults.push([makeServer({ status: 'STOPPED' })]);
      updateResults.push([makeServer({ status: 'STOPPING' })]);

      await expect(service.deleteServer('server-1')).resolves.toBeUndefined();
      expect(db.delete).toHaveBeenCalled();
      expect(updatedValues.map((value) => value.status)).toEqual(['STOPPING']);
    });

    it('marks ERROR and retains the row when remove fails and inspect finds it running', async () => {
      const error = new ConflictException('container conflicts with existing state');
      docker.removeContainer = jest.fn().mockRejectedValue(error);
      docker.inspectContainer = jest.fn().mockResolvedValue(makeInspect({ running: true }));
      selectResults.push([makeServer({ status: 'STOPPED' })]);
      updateResults.push([makeServer({ status: 'STOPPING' })], [makeServer({ status: 'ERROR' })]);

      await expect(service.deleteServer('server-1')).rejects.toBe(error);
      expect(db.delete).not.toHaveBeenCalled();
      expect(updatedValues.map((value) => value.status)).toEqual(['STOPPING', 'ERROR']);
      expect(updatedValues.map((value) => value.status)).not.toContain('STOPPED');
    });

    it('marks ERROR and retains the row when remove outcome is unconfirmable', async () => {
      const error = docker503();
      docker.removeContainer = jest.fn().mockRejectedValue(error);
      docker.inspectContainer = jest.fn().mockRejectedValue(error);
      selectResults.push([makeServer({ status: 'STOPPED' })]);
      updateResults.push([makeServer({ status: 'STOPPING' })], [makeServer({ status: 'ERROR' })]);

      await expect(service.deleteServer('server-1')).rejects.toBe(error);
      expect(db.delete).not.toHaveBeenCalled();
      expect(updatedValues.map((value) => value.status)).toEqual(['STOPPING', 'ERROR']);
    });

    it('proceeds with deletion when remove fails but inspect confirms the container is stopped', async () => {
      const error = new ConflictException('container conflicts with existing state');
      docker.removeContainer = jest.fn().mockRejectedValue(error);
      docker.inspectContainer = jest
        .fn()
        .mockResolvedValue(makeInspect({ running: false, status: 'exited' }));
      selectResults.push([makeServer({ status: 'STOPPED' })]);
      updateResults.push([makeServer({ status: 'STOPPING' })]);

      await expect(service.deleteServer('server-1')).resolves.toBeUndefined();
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe('startup reconciliation', () => {
    it('reconciles running and stopped containers and awaits all inspect work', async () => {
      const running = makeServer({ id: 'running', status: 'STARTING', containerId: 'running-c' });
      const stopped = makeServer({ id: 'stopped', status: 'STOPPING', containerId: 'stopped-c' });
      selectResults.push([running, stopped]);
      docker.inspectContainer = jest
        .fn()
        .mockResolvedValueOnce(makeInspect({ id: 'running-c', running: true }))
        .mockResolvedValueOnce(makeInspect({ id: 'stopped-c', running: false, status: 'exited' }));

      await expect(service.onModuleInit()).resolves.toBeUndefined();

      expect(docker.inspectContainer).toHaveBeenCalledTimes(2);
      expect(updatedValues.map((value) => value.status)).toEqual(['RUNNING', 'STOPPED']);
    });

    it('uses managed-container lookup for null ids and clears a confirmed absence', async () => {
      const provisional = makeServer({ status: 'CREATING', containerId: null });
      selectResults.push([provisional]);
      docker.findManagedContainer = jest.fn().mockResolvedValue(null);

      await service.onModuleInit();

      expect(docker.findManagedContainer).toHaveBeenCalledWith('server-1');
      expect(updatedValues).toEqual([
        expect.objectContaining({ status: 'STOPPED', containerId: null }),
      ]);
    });

    it('recovers a null-id row from the managed lookup', async () => {
      const provisional = makeServer({ status: 'CREATING', containerId: null });
      selectResults.push([provisional]);
      docker.findManagedContainer = jest.fn().mockResolvedValue({ id: 'recovered', running: true });

      await service.onModuleInit();

      expect(updatedValues).toEqual([
        expect.objectContaining({ status: 'RUNNING', containerId: 'recovered' }),
      ]);
    });

    it('does one warning and zero writes when any inspect reports daemon unavailability', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const first = makeServer({ id: 'first', status: 'STARTING' });
      const second = makeServer({ id: 'second', status: 'RUNNING' });
      selectResults.push([first, second]);
      docker.inspectContainer = jest
        .fn()
        .mockResolvedValueOnce(makeInspect({ id: 'container-1', running: true }))
        .mockRejectedValueOnce(docker503());

      await service.onModuleInit();

      expect(db.update).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('leaves a row unchanged after an unexpected inspect error', async () => {
      selectResults.push([makeServer({ status: 'STARTING' })]);
      docker.inspectContainer = jest.fn().mockRejectedValue(new Error('malformed inspect'));

      await service.onModuleInit();

      expect(db.update).not.toHaveBeenCalled();
      expect(docker.findManagedContainer).not.toHaveBeenCalled();
    });

    it('attempts reconciliation with the full snapshot CAS and accepts a stale-write rejection', async () => {
      selectResults.push([makeServer({ status: 'STARTING' })]);
      docker.inspectContainer = jest.fn().mockResolvedValue(makeInspect({ running: true }));
      updateResults.push([]);

      await service.onModuleInit();

      expect(db.update).toHaveBeenCalledTimes(1);
      expect(updatedValues).toEqual([
        expect.objectContaining({ status: 'RUNNING', containerId: 'container-1' }),
      ]);
    });
  });

  describe('concurrency claims', () => {
    it('allows only one same-server start claimant and one Docker start', async () => {
      selectResults.push([makeServer()], [makeServer()]);
      selectResults.push([], []);
      updateResults.push(
        [makeServer({ status: 'STARTING' })],
        [],
        [makeServer({ status: 'RUNNING' })],
      );

      const results = await Promise.allSettled([
        service.startServer('server-1'),
        service.startServer('server-1'),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(docker.startContainer).toHaveBeenCalledTimes(1);
    });

    it('allows exactly one claimant when start races delete', async () => {
      selectResults.push([makeServer()], [makeServer()]);
      selectResults.push([]);
      updateResults.push([makeServer({ status: 'STOPPING' })], []);

      const results = await Promise.allSettled([
        service.startServer('server-1'),
        service.deleteServer('server-1'),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(docker.startContainer).toHaveBeenCalledTimes(0);
      expect(docker.removeContainer).toHaveBeenCalledTimes(1);
    });
  });
});
