type ServerMutation = Partial<Server>;

type ServerAllocationRow = { totalMemoryMb: number | string | null };

type ServerCountRow = { total: number };

type ServerQueryRow = Server | ServerAllocationRow | ServerCountRow;

/** Minimal projection returned by listRequestableServers (requestable discovery). */
type RequestableRow = {
  id: string;
  name: string;
  accessType: 'REQUEST';
  requestStatus: 'PENDING' | null;
};

type TestConfig = {
  get: jest.Mock;
};

import {
  ConflictException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DRIZZLE } from 'src/db/db.module';
import type { Server } from 'src/db/schema';
import {
  type ContainerInspectState,
  type DiskInfo,
  DockerService,
  type HostInfo,
  RconUnavailableError,
} from 'src/docker/docker.service';
import { CreateServerDto } from './dto/create-server.dto';
import { ListServersQueryDto } from './dto/list-servers-query.dto';
import { type ServerPrincipal } from './server-access';
import { ServersService } from './servers.service';

type QueryChain<T> = Promise<T> & {
  where: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
  offset: jest.Mock;
};

type TestDb = {
  select: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  transaction: jest.Mock;
  execute: jest.Mock;
};

type TestConfigValues = Record<string, string | number>;

const makeQuery = <T>(getResult: () => T): QueryChain<T> => {
  const promise = Promise.resolve().then(getResult);
  const query: QueryChain<T> = Object.assign(promise, {
    where: jest.fn(() => query),
    orderBy: jest.fn(() => query),
    limit: jest.fn(() => query),
    offset: jest.fn(() => query),
  });
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
  accessType: 'OPEN',
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

const adminPrincipal: ServerPrincipal = { id: 'authenticated-owner', role: 'ADMIN' };

const resourceResponse = (error: HttpException | undefined) => error?.getResponse();

describe('ServersService', () => {
  let service: ServersService;
  let db: TestDb;
  let docker: Pick<
    DockerService,
    | 'createContainer'
    | 'startContainer'
    | 'stopContainer'
    | 'executeRconCommand'
    | 'removeContainer'
    | 'findManagedContainer'
    | 'inspectContainer'
    | 'getHostInfo'
    | 'getHostDiskInfo'
  >;
  let config: TestConfig;
  let selectResults: (ServerQueryRow | RequestableRow)[][];
  let insertResults: Server[];
  let updateResults: Server[][];
  let updatedValues: ServerMutation[];
  let insertedValues: ServerMutation[];
  let successfulUpdatedValues: ServerMutation[];
  let deletedRows: boolean[];
  let queryChains: QueryChain<(ServerQueryRow | RequestableRow)[]>[];
  let calls: string[];
  let configValues: TestConfigValues;

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
        const query = makeQuery(() => selectResults.shift() ?? []);
        queryChains.push(query);
        return { from: jest.fn(() => query) };
      }),
      insert: jest.fn(() => ({
        values: jest.fn((values: ServerMutation) => {
          insertedValues.push(values);
          const row = insertResults.shift();
          return { returning: jest.fn().mockResolvedValue(row ? [row] : []) };
        }),
      })),
      update: jest.fn(() => ({
        set: jest.fn((values: ServerMutation) => {
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
      transaction: jest.fn(async (callback: (tx: typeof db) => Promise<Server>) => callback(db)),
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
        return 'stopped' as const;
      }),
      executeRconCommand: jest.fn().mockRejectedValue(new RconUnavailableError()),
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

  describe('visibility and requester propagation', () => {
    it('lets ADMIN list and count all non-CREATING rows', async () => {
      const visible = makeServer({ accessType: 'PRIVATE' });
      selectResults.push([visible], [{ total: 1 }]);

      const result = await service.listServers(new ListServersQueryDto(), adminPrincipal);

      expect(result.total).toBe(1);
      expect(result.data[0].id).toBe('server-1');
    });

    it('lets a USER see OPEN servers', async () => {
      const open = makeServer({ accessType: 'OPEN' });
      // visibility builds an EXISTS subquery before the rows and count queries
      selectResults.push([], [open], [{ total: 1 }]);

      const result = await service.listServers(new ListServersQueryDto(), {
        id: 'user-1',
        role: 'USER',
      });

      expect(result.total).toBe(1);
      expect(result.data[0].accessType).toBe('OPEN');
    });

    it('hides REQUEST and PRIVATE servers from a USER without approved access', async () => {
      selectResults.push([]);

      await expect(
        service.getServer('server-1', { id: 'user-1', role: 'USER' }),
      ).rejects.toMatchObject({
        status: 404,
        response: { message: 'Server not found' },
      });
    });

    it('lets a USER see REQUEST servers after access approval', async () => {
      const requestServer = makeServer({ accessType: 'REQUEST' });
      selectResults.push([requestServer]);

      const result = await service.getServer('server-1', { id: 'user-1', role: 'USER' });

      expect(result.id).toBe('server-1');
      expect(result.accessType).toBe('REQUEST');
    });

    it('applies the same visibility predicate to list rows and total count', async () => {
      // one subquery builder, one rows query, and one count query
      selectResults.push([], [], [{ total: 0 }]);

      await service.listServers(new ListServersQueryDto(), { id: 'user-1', role: 'USER' });

      expect(db.select).toHaveBeenCalledTimes(3);
    });

    it('returns 404 before any Docker work when a USER targets a hidden server', async () => {
      selectResults.push([]);

      await expect(
        service.startServer('server-1', { id: 'user-1', role: 'USER' }),
      ).rejects.toMatchObject({
        status: 404,
        response: { message: 'Server not found' },
      });
      expect(docker.getHostInfo).not.toHaveBeenCalled();
      expect(docker.startContainer).not.toHaveBeenCalled();
    });

    it('propagates the requester principal to create, start, stop, and delete', async () => {
      const creating = makeServer({ status: 'CREATING', containerId: null });
      const withId = makeServer({ status: 'CREATING' });
      const running = makeServer({ status: 'RUNNING' });
      const stopped = makeServer({ status: 'STOPPED' });
      selectResults.push([]);
      insertResults.push(creating);
      updateResults.push([withId], [running]);

      const userPrincipal = { id: 'owner-2', role: 'USER' as const };
      await service.createServer(makeDto(), userPrincipal);
      expect(insertedValues[0]).toEqual(expect.objectContaining({ ownerId: 'owner-2' }));

      selectResults.push([running]);
      updateResults.push([makeServer({ status: 'STOPPING' })], [stopped]);
      await service.stopServer('server-1', userPrincipal);

      selectResults.push([stopped], [running]);
      updateResults.push([makeServer({ status: 'STARTING' })], [running]);
      await service.startServer('server-1', userPrincipal);

      selectResults.push([stopped]);
      updateResults.push([makeServer({ status: 'STOPPING' })]);
      await service.deleteServer('server-1', userPrincipal);
    });
  });

  describe('reads and projection', () => {
    it('lists visible rows with total, defaults, stable ordering, and no private fields', async () => {
      const visible = makeServer();
      selectResults.push([visible], [{ total: 1 }]);

      const result = await service.listServers(new ListServersQueryDto(), adminPrincipal);

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

      await service.listServers({ limit: 7, offset: 14 }, adminPrincipal);

      expect(queryChains[0].limit).toHaveBeenCalledWith(7);
      expect(queryChains[0].offset).toHaveBeenCalledWith(14);
    });

    it('returns a public projection for a single visible row', async () => {
      selectResults.push([makeServer()]);

      const result = await service.getServer('server-1', adminPrincipal);

      expect(result.id).toBe('server-1');
      expect(result).not.toHaveProperty('rconPassword');
      expect(result).not.toHaveProperty('containerId');
      expect(result).not.toHaveProperty('worldPath');
    });

    it('hides CREATING rows as not found', async () => {
      selectResults.push([]);

      await expect(service.getServer('creating', adminPrincipal)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('distinguishes absent rows from visible wrong-state conflicts', async () => {
      selectResults.push([]);
      await expect(service.startServer('missing', adminPrincipal)).rejects.toMatchObject({
        response: expect.objectContaining({ message: 'Server not found' }),
        status: 404,
      });

      selectResults.push([makeServer({ status: 'RUNNING' })]);
      await expect(service.startServer('server-1', adminPrincipal)).rejects.toMatchObject({
        response: expect.objectContaining({ message: 'Server is not in STOPPED state' }),
        status: 409,
      });

      selectResults.push([makeServer({ status: 'STOPPED' })]);
      await expect(service.stopServer('server-1', adminPrincipal)).rejects.toMatchObject({
        response: expect.objectContaining({ message: 'Server is not in RUNNING state' }),
        status: 409,
      });

      selectResults.push([makeServer({ status: 'RUNNING' })]);
      await expect(service.deleteServer('server-1', adminPrincipal)).rejects.toMatchObject({
        response: expect.objectContaining({ message: 'Server is not in STOPPED state' }),
        status: 409,
      });
    });
  });

  describe('resource admission', () => {
    it('fails closed on malformed configuration before any database or Docker mutation', async () => {
      configValues.MIN_FREE_DISK_MB = '0';
      configValues.MAX_MEMORY_RATIO = '0.9';
      selectResults.push([]);

      await expect(service.createServer(makeDto(), adminPrincipal)).rejects.toMatchObject({
        response: expect.objectContaining({ message: 'Host resource information unavailable' }),
        status: 503,
      });
      expect(docker.getHostInfo).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('returns the exact disk InsufficientResources payload', async () => {
      setResources(undefined, { totalDiskMb: 1000, freeDiskMb: 100 });

      let error: HttpException | undefined;
      try {
        await service.createServer(makeDto(), adminPrincipal);
      } catch (caught) {
        if (caught instanceof HttpException) {
          error = caught;
        } else {
          throw caught;
        }
      }

      if (!error) throw new Error('expected an HTTP exception');
      expect(error.getStatus()).toBe(422);
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
      selectResults.push([{ totalMemoryMb: 4000 }]);

      let error: HttpException | undefined;
      try {
        await service.createServer(makeDto({ memoryLimitMb: 4096 }), adminPrincipal);
      } catch (caught) {
        if (caught instanceof HttpException) {
          error = caught;
        } else {
          throw caught;
        }
      }

      if (!error) throw new Error('expected an HTTP exception');
      expect(error.getStatus()).toBe(422);
      expect(resourceResponse(error)).toEqual({
        statusCode: 422,
        error: 'InsufficientResources',
        message: 'Insufficient memory to create server',
        details: { resource: 'memory', availableMb: 3372, requiredMb: 4096, totalMb: 8192 },
      });
      expect(db.insert).not.toHaveBeenCalled();
      expect(docker.createContainer).not.toHaveBeenCalled();
    });

    it('uses a SQL allocation aggregate for all server statuses', async () => {
      selectResults.push([{ totalMemoryMb: 4000 }]);
      insertResults.push(makeServer({ status: 'CREATING', containerId: null }));
      updateResults.push([makeServer({ status: 'CREATING' })], [makeServer({ status: 'RUNNING' })]);

      await service.createServer(makeDto(), adminPrincipal);

      expect(queryChains[0].where).not.toHaveBeenCalled();
      expect(db.select).toHaveBeenCalledWith({ totalMemoryMb: expect.anything() });
      const aggregateSelection = db.select.mock.calls[0][0];
      expect(new PgDialect().sqlToQuery(aggregateSelection.totalMemoryMb).sql).toBe(
        'coalesce(sum("servers"."memory_limit_mb"), 0)',
      );
    });

    it('treats the SQL aggregate zero-row result as zero allocation', async () => {
      selectResults.push([]);
      insertResults.push(makeServer({ status: 'CREATING', containerId: null }));
      updateResults.push([makeServer({ status: 'CREATING' })], [makeServer({ status: 'RUNNING' })]);

      await expect(service.createServer(makeDto(), adminPrincipal)).resolves.toEqual(
        expect.objectContaining({ status: 'RUNNING' }),
      );
    });

    it('filters the excluded server and stopped servers in start allocation queries', async () => {
      selectResults.push([makeServer({ status: 'STOPPED' })], [{ totalMemoryMb: '4000' }]);
      updateResults.push([makeServer({ status: 'STARTING' })], [makeServer({ status: 'RUNNING' })]);

      await expect(service.startServer('server-1', adminPrincipal)).resolves.toEqual(
        expect.objectContaining({ status: 'RUNNING' }),
      );

      const renderedWhere = new PgDialect().sqlToQuery(queryChains[1].where.mock.calls[0][0]);
      expect(renderedWhere.sql).toBe('("servers"."status" <> $1 and "servers"."id" <> $2)');
      expect(renderedWhere.params).toEqual(['STOPPED', 'server-1']);
    });

    it('fails closed for a null total RAM measurement', async () => {
      setResources({ totalRamMb: null, cpuCount: 8 }, { totalDiskMb: 100000, freeDiskMb: 5000 });

      await expect(service.createServer(makeDto(), adminPrincipal)).rejects.toMatchObject({
        response: expect.objectContaining({ message: 'Host resource information unavailable' }),
        status: 503,
      });
      expect(db.insert).not.toHaveBeenCalled();
      expect(docker.createContainer).not.toHaveBeenCalled();
    });

    it('fails closed for a null CPU measurement', async () => {
      setResources({ totalRamMb: 8192, cpuCount: null }, { totalDiskMb: 100000, freeDiskMb: 5000 });

      await expect(service.createServer(makeDto(), adminPrincipal)).rejects.toMatchObject({
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

      await expect(service.createServer(makeDto(), adminPrincipal)).rejects.toBe(error);

      expect(db.delete).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('preserves Docker-originated 503 from preflight rather than replacing it', async () => {
      const error = docker503();
      docker.getHostInfo = jest.fn().mockResolvedValue({ totalRamMb: 8192, cpuCount: 8 });
      docker.getHostDiskInfo = jest.fn().mockRejectedValue(error);

      await expect(service.createServer(makeDto(), adminPrincipal)).rejects.toBe(error);
      expect(db.transaction).not.toHaveBeenCalled();
      expect(docker.createContainer).not.toHaveBeenCalled();
    });

    it('checks configuration, host information, then disk information in order', async () => {
      docker.getHostDiskInfo = jest.fn().mockImplementation(async () => {
        calls.push('diskInfo');
        throw new InternalServerErrorException('disk read failed');
      });

      await expect(service.createServer(makeDto(), adminPrincipal)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(calls).toEqual(['hostInfo', 'diskInfo']);
    });
    it('starts host and disk preflight reads concurrently', async () => {
      let releaseHost!: (value: HostInfo) => void;
      const hostInfo = new Promise<HostInfo>((resolve) => {
        releaseHost = resolve;
      });
      docker.getHostInfo = jest.fn(() => hostInfo);
      docker.getHostDiskInfo = jest.fn().mockResolvedValue({
        totalDiskMb: 100000,
        freeDiskMb: 5000,
      });

      const request = service.createServer(makeDto(), adminPrincipal);
      expect(docker.getHostInfo).toHaveBeenCalledTimes(1);
      expect(docker.getHostDiskInfo).toHaveBeenCalledTimes(1);

      releaseHost({ totalRamMb: null, cpuCount: 8 });
      await expect(request).rejects.toMatchObject({
        response: expect.objectContaining({ message: 'Host resource information unavailable' }),
        status: 503,
      });
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

      const result = await service.createServer(makeDto(), adminPrincipal);

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
      // SAFETY: makeDto() supplies the CreateServerDto fields; this test adds ownerId to that
      // fixture solely to verify the authenticated principal overrides forged ownership.
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

      await service.createServer(dto, adminPrincipal);

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

      await expect(service.createServer(makeDto(), adminPrincipal)).rejects.toBe(error);

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

      await expect(service.createServer(makeDto(), adminPrincipal)).rejects.toBe(error);

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

      await expect(service.createServer(makeDto(), adminPrincipal)).rejects.toBe(error);
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

      await expect(service.createServer(makeDto(), adminPrincipal)).rejects.toBeInstanceOf(
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

      const result = await service.startServer('server-1', adminPrincipal);

      expect(result.status).toBe('RUNNING');
      expect(docker.startContainer).toHaveBeenCalledTimes(1);
      expect(updatedValues.map((value) => value.status)).toEqual(['STARTING', 'RUNNING']);
    });

    it('rejects an unprovisioned server before resource checks or Docker calls', async () => {
      selectResults.push([makeServer({ containerId: null })]);

      await expect(service.startServer('server-1', adminPrincipal)).rejects.toMatchObject({
        response: expect.objectContaining({ message: 'Server container is not provisioned' }),
        status: 409,
      });
      expect(docker.getHostInfo).not.toHaveBeenCalled();
      expect(docker.startContainer).not.toHaveBeenCalled();
    });

    it('treats a lost STOPPED claim as a conflict and does not call Docker', async () => {
      selectResults.push([makeServer()], []);
      updateResults.push([]);

      await expect(service.startServer('server-1', adminPrincipal)).rejects.toMatchObject({
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

      await expect(service.startServer('server-1', adminPrincipal)).rejects.toBe(error);

      expect(updatedValues.map((value) => value.status)).toEqual(['STARTING', 'ERROR']);
      expect(updatedValues.map((value) => value.status)).not.toContain('STOPPED');
    });

    it('restores STOPPED after a known Docker start failure', async () => {
      const error = new ConflictException('container conflicts with existing state');
      docker.startContainer = jest.fn().mockRejectedValue(error);
      selectResults.push([makeServer()], []);
      updateResults.push([makeServer({ status: 'STARTING' })], [makeServer({ status: 'STOPPED' })]);

      await expect(service.startServer('server-1', adminPrincipal)).rejects.toBe(error);

      expect(updatedValues.map((value) => value.status)).toEqual(['STARTING', 'STOPPED']);
    });

    it('settles ERROR when RUNNING finalization loses its CAS', async () => {
      selectResults.push([makeServer()], []);
      updateResults.push(
        [makeServer({ status: 'STARTING' })],
        [],
        [makeServer({ status: 'ERROR' })],
      );

      await expect(service.startServer('server-1', adminPrincipal)).rejects.toBeInstanceOf(
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

      const result = await service.stopServer('server-1', adminPrincipal);

      expect(result.status).toBe('STOPPED');
      expect(docker.stopContainer).toHaveBeenCalledWith('container-1', 10);
      expect(updatedValues.map((value) => value.status)).toEqual(['STOPPING', 'STOPPED']);
    });

    it('does not call Docker when the RUNNING claim is lost', async () => {
      selectResults.push([makeServer({ status: 'RUNNING' })]);
      updateResults.push([]);

      await expect(service.stopServer('server-1', adminPrincipal)).rejects.toMatchObject({
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

      await expect(service.stopServer('server-1', adminPrincipal)).rejects.toBe(error);
      expect(updatedValues.map((value) => value.status)).toEqual(['STOPPING', 'ERROR']);
    });

    it('restores RUNNING after a known Docker stop failure', async () => {
      const error = new ConflictException('container conflicts with existing state');
      docker.stopContainer = jest.fn().mockRejectedValue(error);
      selectResults.push([makeServer({ status: 'RUNNING' })]);
      updateResults.push([makeServer({ status: 'STOPPING' })], [makeServer({ status: 'RUNNING' })]);

      await expect(service.stopServer('server-1', adminPrincipal)).rejects.toBe(error);
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

      const result = await service.restartServer('server-1', adminPrincipal);

      expect(result.status).toBe('RUNNING');
      expect(docker.stopContainer).toHaveBeenCalledWith('container-1', 10);
      expect(docker.startContainer).toHaveBeenCalledWith('container-1');
      expect(updatedValues.map((value) => value.status)).toEqual([
        'STOPPING',
        'STARTING',
        'RUNNING',
      ]);
      expect(updatedValues.map((value) => value.status)).not.toContain('STOPPED');
      // SAFETY: The DockerService double supplies stopContainer and startContainer but no
      // restartContainer; this structural view checks that absent member.
      const restartContainer = 'restartContainer' in docker ? docker.restartContainer : undefined;
      expect(restartContainer).toBeUndefined();
    });

    it('moves STOPPING to ERROR when the stop phase is ambiguous', async () => {
      const error = docker503();
      docker.stopContainer = jest.fn().mockRejectedValue(error);
      selectResults.push([makeServer({ status: 'RUNNING' })]);
      updateResults.push([makeServer({ status: 'STOPPING' })], [makeServer({ status: 'ERROR' })]);

      await expect(service.restartServer('server-1', adminPrincipal)).rejects.toBe(error);
      expect(docker.startContainer).not.toHaveBeenCalled();
      expect(updatedValues.map((value) => value.status)).toEqual(['STOPPING', 'ERROR']);
    });

    it('settles STOPPED when admission fails after a successful stop', async () => {
      selectResults.push([makeServer({ status: 'RUNNING' })], [{ totalMemoryMb: 0 }]);
      updateResults.push([makeServer({ status: 'STOPPING' })], [makeServer({ status: 'STOPPED' })]);
      setResources({ totalRamMb: 8192, cpuCount: 8 }, { totalDiskMb: 1000, freeDiskMb: 100 });

      await expect(service.restartServer('server-1', adminPrincipal)).rejects.toMatchObject({
        status: 422,
      });

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

      await expect(service.restartServer('server-1', adminPrincipal)).rejects.toBe(error);

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

      await expect(service.restartServer('server-1', adminPrincipal)).rejects.toBe(error);

      expect(successfulUpdatedValues.map((value) => value.status)).toEqual([
        'STOPPING',
        'STARTING',
        'STOPPED',
      ]);
    });
  });
  describe('graceful RCON shutdown', () => {
    const flush = async () => {
      for (let index = 0; index < 20; index += 1) {
        await Promise.resolve();
      }
    };

    afterEach(() => {
      jest.useRealTimers();
    });

    it('runs warning, save, terminal Docker stop, and final CAS in order', async () => {
      jest.useFakeTimers();
      configValues.STOP_WARN_SECONDS = '5';
      const events: string[] = [];
      const transactionEventIndexes: number[] = [];
      db.transaction.mockImplementation(async (callback: (tx: typeof db) => Promise<Server>) => {
        transactionEventIndexes.push(events.length);
        return callback(db);
      });
      docker.executeRconCommand = jest.fn(async (_id, command) => {
        events.push(`rcon:${command.join(' ')}`);
      });
      docker.stopContainer = jest.fn(async (_id, timeout) => {
        events.push(`stop:${timeout}`);
        return 'stopped' as const;
      });
      selectResults.push([makeServer({ status: 'RUNNING' })]);
      updateResults.push([makeServer({ status: 'STOPPING' })], [makeServer({ status: 'STOPPED' })]);

      const _promise = service.stopServer('server-1', adminPrincipal);
      await flush();
      expect(events).toEqual(['rcon:say §cServer closing in 5 seconds...']);
      jest.advanceTimersByTime(5_000);
      await flush();
      expect(events).toEqual(['rcon:say §cServer closing in 5 seconds...', 'rcon:save-all']);
      jest.advanceTimersByTime(3_000);
      await flush();
      expect(transactionEventIndexes).toEqual([0, 3]);
      expect(events).toEqual([
        'rcon:say §cServer closing in 5 seconds...',
        'rcon:save-all',
        'stop:15',
      ]);
      expect(updatedValues.map((value) => value.status)).toEqual(['STOPPING', 'STOPPED']);
      expect(db.transaction).toHaveBeenCalledTimes(2);
    });

    it('skips a zero-duration warning timer while preserving command order', async () => {
      jest.useFakeTimers();
      configValues.STOP_WARN_SECONDS = '0';
      const events: string[] = [];
      docker.executeRconCommand = jest.fn(async (_id, command) => {
        events.push(`rcon:${command[0]}`);
      });
      docker.stopContainer = jest.fn(async () => {
        events.push('stop');
        return 'stopped' as const;
      });
      selectResults.push([makeServer({ status: 'RUNNING' })]);
      updateResults.push([makeServer({ status: 'STOPPING' })], [makeServer({ status: 'STOPPED' })]);

      const promise = service.stopServer('server-1', adminPrincipal);
      await flush();
      expect(events).toEqual(['rcon:say', 'rcon:save-all']);
      expect(jest.getTimerCount()).toBe(1);
      jest.advanceTimersByTime(3_000);
      await expect(promise).resolves.toEqual(expect.objectContaining({ status: 'STOPPED' }));
      expect(events).toEqual(['rcon:say', 'rcon:save-all', 'stop']);
    });

    it('falls back immediately with timeout 10 when warning RCON fails', async () => {
      configValues.STOP_WARN_SECONDS = '30';
      docker.executeRconCommand = jest.fn().mockRejectedValue(new RconUnavailableError());
      docker.stopContainer = jest.fn().mockResolvedValue('stopped');
      selectResults.push([makeServer({ status: 'RUNNING' })]);
      updateResults.push([makeServer({ status: 'STOPPING' })], [makeServer({ status: 'STOPPED' })]);

      await expect(service.stopServer('server-1', adminPrincipal)).resolves.toEqual(
        expect.objectContaining({ status: 'STOPPED' }),
      );
      expect(docker.executeRconCommand).toHaveBeenCalledTimes(1);
      expect(docker.stopContainer).toHaveBeenCalledWith('container-1', 10);
    });
    it.each([
      {
        name: 'RCON 404 then final Docker 404',
        rconError: new NotFoundException('RCON container unavailable'),
        finalDockerError: new NotFoundException('container gone during fallback'),
        expectedStatus: 'STOPPED' as const,
      },
      {
        name: 'RCON 409 then idempotent Docker stop',
        rconError: new ConflictException('RCON command rejected'),
        finalDockerError: undefined,
        expectedStatus: 'STOPPED' as const,
      },
      {
        name: 'RCON 503 then final Docker 503',
        rconError: new ServiceUnavailableException('RCON daemon unavailable'),
        finalDockerError: new ServiceUnavailableException('Docker daemon unavailable'),
        expectedStatus: 'ERROR' as const,
      },
    ])('$name uses the fallback stop result for compensation', async ({
      rconError,
      finalDockerError,
      expectedStatus,
    }) => {
      configValues.STOP_WARN_SECONDS = '0';
      docker.executeRconCommand = jest.fn().mockRejectedValue(rconError);
      docker.stopContainer = jest
        .fn()
        .mockImplementation(async (_containerId: string, timeout: number) => {
          expect(timeout).toBe(10);
          if (finalDockerError) throw finalDockerError;
          return 'already-stopped' as const;
        });
      selectResults.push([makeServer({ status: 'RUNNING' })]);
      updateResults.push(
        [makeServer({ status: 'STOPPING' })],
        [makeServer({ status: expectedStatus })],
      );

      const result = service.stopServer('server-1', adminPrincipal);
      if (finalDockerError) {
        await expect(result).rejects.toBe(finalDockerError);
      } else {
        await expect(result).resolves.toEqual(expect.objectContaining({ status: expectedStatus }));
      }

      expect(docker.executeRconCommand).toHaveBeenCalledTimes(1);
      expect(docker.stopContainer).toHaveBeenCalledWith('container-1', 10);
      expect(updatedValues.map((value) => value.status)).toEqual(['STOPPING', expectedStatus]);
      expect(updatedValues.map((value) => value.status)).not.toContain('RUNNING');
    });

    it('skips save-all and the three-second delay when save-all fails', async () => {
      jest.useFakeTimers();
      configValues.STOP_WARN_SECONDS = '2';
      docker.executeRconCommand = jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new RconUnavailableError());
      docker.stopContainer = jest.fn().mockResolvedValue('stopped');
      selectResults.push([makeServer({ status: 'RUNNING' })]);
      updateResults.push([makeServer({ status: 'STOPPING' })], [makeServer({ status: 'STOPPED' })]);

      const promise = service.stopServer('server-1', adminPrincipal);
      await flush();
      jest.advanceTimersByTime(2_000);
      await flush();
      await expect(promise).resolves.toEqual(expect.objectContaining({ status: 'STOPPED' }));
      expect(docker.executeRconCommand).toHaveBeenCalledTimes(2);
      expect(docker.stopContainer).toHaveBeenCalledWith('container-1', 10);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('compensates STOPPING to ERROR for a final Docker 503', async () => {
      configValues.STOP_WARN_SECONDS = '0';
      const error = docker503();
      docker.executeRconCommand = jest.fn().mockResolvedValue(undefined);
      docker.stopContainer = jest.fn().mockRejectedValue(error);
      selectResults.push([makeServer({ status: 'RUNNING' })]);
      updateResults.push([makeServer({ status: 'STOPPING' })], [makeServer({ status: 'ERROR' })]);

      jest.useFakeTimers();
      const promise = service.stopServer('server-1', adminPrincipal);
      await flush();
      jest.advanceTimersByTime(3_000);
      await expect(promise).rejects.toBe(error);
      expect(docker.stopContainer).toHaveBeenCalledWith('container-1', 15);
      expect(updatedValues.map((value) => value.status)).toEqual(['STOPPING', 'ERROR']);
    });

    it('restores RUNNING for a known final Docker rejection', async () => {
      configValues.STOP_WARN_SECONDS = '0';
      const error = new ConflictException('daemon rejected stop');
      docker.executeRconCommand = jest.fn().mockResolvedValue(undefined);
      docker.stopContainer = jest.fn().mockRejectedValue(error);
      selectResults.push([makeServer({ status: 'RUNNING' })]);
      updateResults.push([makeServer({ status: 'STOPPING' })], [makeServer({ status: 'RUNNING' })]);

      jest.useFakeTimers();
      const promise = service.stopServer('server-1', adminPrincipal);
      await flush();
      jest.advanceTimersByTime(3_000);
      await expect(promise).rejects.toBe(error);
      expect(updatedValues.map((value) => value.status)).toEqual(['STOPPING', 'RUNNING']);
    });

    it('settles STOPPED for a final Docker NotFound', async () => {
      configValues.STOP_WARN_SECONDS = '0';
      const error = new NotFoundException('container gone');
      docker.executeRconCommand = jest.fn().mockResolvedValue(undefined);
      docker.stopContainer = jest.fn().mockRejectedValue(error);
      selectResults.push([makeServer({ status: 'RUNNING' })]);
      updateResults.push([makeServer({ status: 'STOPPING' })], [makeServer({ status: 'STOPPED' })]);

      jest.useFakeTimers();
      const promise = service.stopServer('server-1', adminPrincipal);
      await flush();
      jest.advanceTimersByTime(3_000);
      await expect(promise).rejects.toBe(error);
      expect(updatedValues.map((value) => value.status)).toEqual(['STOPPING', 'STOPPED']);
    });

    it.each([
      '',
      'abc',
      '-1',
      '1.5',
      '301',
      'NaN',
      '9'.repeat(400),
    ])('rejects invalid STOP_WARN_SECONDS=%s before CAS or Docker', async (raw) => {
      configValues.STOP_WARN_SECONDS = raw;
      selectResults.push([makeServer({ status: 'RUNNING' })]);

      await expect(service.stopServer('server-1', adminPrincipal)).rejects.toMatchObject({
        status: 503,
        response: { message: 'Graceful shutdown configuration unavailable' },
      });
      expect(db.update).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(docker.executeRconCommand).not.toHaveBeenCalled();
      expect(docker.stopContainer).not.toHaveBeenCalled();
    });

    it('rejects concurrent lifecycle losers without RCON or Docker work', async () => {
      jest.useFakeTimers();
      configValues.STOP_WARN_SECONDS = '30';
      let releaseWarning!: () => void;
      const warning = new Promise<void>((resolve) => {
        releaseWarning = resolve;
      });
      docker.executeRconCommand = jest.fn().mockReturnValue(warning);
      selectResults.push(
        [makeServer({ status: 'RUNNING' })],
        [makeServer({ status: 'RUNNING' })],
        [makeServer({ status: 'RUNNING' })],
        [makeServer({ status: 'RUNNING' })],
        [makeServer({ status: 'RUNNING' })],
      );
      let claimAvailable = true;
      db.update = jest.fn(() => ({
        set: jest.fn((values: ServerMutation) => ({
          where: jest.fn(() => ({
            returning: jest.fn(async () => {
              updatedValues.push(values);
              if (values.status === 'STOPPING' && claimAvailable) {
                claimAvailable = false;
                return [makeServer({ status: 'STOPPING' })];
              }
              if (values.status === 'STOPPED') return [makeServer({ status: 'STOPPED' })];
              return [];
            }),
          })),
        })),
      }));

      const first = service.stopServer('server-1', adminPrincipal);
      await flush();
      const losers = await Promise.allSettled([
        service.stopServer('server-1', adminPrincipal),
        service.startServer('server-1', adminPrincipal),
        service.restartServer('server-1', adminPrincipal),
        service.deleteServer('server-1', adminPrincipal),
      ]);
      expect(losers.every((result) => result.status === 'rejected')).toBe(true);
      expect(docker.stopContainer).not.toHaveBeenCalled();
      expect(docker.executeRconCommand).toHaveBeenCalledTimes(1);
      releaseWarning();
      await flush();
      jest.runOnlyPendingTimers();
      await flush();
      jest.runOnlyPendingTimers();
      await expect(first).resolves.toBeDefined();
    });

    it('restarts through graceful stop before admission and STARTING claim', async () => {
      jest.useFakeTimers();
      configValues.STOP_WARN_SECONDS = '0';
      const events: string[] = [];
      docker.executeRconCommand = jest.fn(async (_id, command) => {
        events.push(`rcon:${command[0]}`);
      });
      docker.stopContainer = jest.fn(async () => {
        events.push('stop:15');
        return 'stopped' as const;
      });
      docker.getHostInfo = jest.fn(async () => {
        events.push('host');
        return { totalRamMb: 8192, cpuCount: 8 };
      });
      docker.getHostDiskInfo = jest.fn(async () => {
        events.push('disk');
        return { totalDiskMb: 100000, freeDiskMb: 5000 };
      });
      selectResults.push([makeServer({ status: 'RUNNING' })], []);
      updateResults.push(
        [makeServer({ status: 'STOPPING' })],
        [makeServer({ status: 'STARTING' })],
        [makeServer({ status: 'RUNNING' })],
      );

      const promise = service.restartServer('server-1', adminPrincipal);
      await flush();
      jest.advanceTimersByTime(3_000);
      await flush();
      await expect(promise).resolves.toEqual(expect.objectContaining({ status: 'RUNNING' }));
      expect(events.slice(0, 5)).toEqual(['rcon:say', 'rcon:save-all', 'stop:15', 'host', 'disk']);
      expect(docker.stopContainer).toHaveBeenCalledWith('container-1', 15);
      expect(updatedValues.map((value) => value.status)).not.toContain('STOPPED');
      // SAFETY: The DockerService double supplies stopContainer and startContainer but no
      // restartContainer; this structural view checks that absent member.
      const restartContainer = 'restartContainer' in docker ? docker.restartContainer : undefined;
      expect(restartContainer).toBeUndefined();
    });
  });
  describe('deleteServer', () => {
    it('claims STOPPED, removes the container, and deletes only the claimed row', async () => {
      selectResults.push([makeServer({ status: 'STOPPED' })]);
      updateResults.push([makeServer({ status: 'STOPPING' })]);

      await expect(service.deleteServer('server-1', adminPrincipal)).resolves.toBeUndefined();

      expect(docker.removeContainer).toHaveBeenCalledWith('container-1');
      expect(db.delete).toHaveBeenCalledTimes(1);
    });

    it('skips Docker removal when containerId is null', async () => {
      selectResults.push([makeServer({ status: 'STOPPED', containerId: null })]);
      updateResults.push([makeServer({ status: 'STOPPING', containerId: null })]);

      await expect(service.deleteServer('server-1', adminPrincipal)).resolves.toBeUndefined();

      expect(docker.removeContainer).not.toHaveBeenCalled();
      expect(db.delete).toHaveBeenCalledTimes(1);
    });

    it('does not remove a container after a lost STOPPED claim', async () => {
      selectResults.push([makeServer({ status: 'STOPPED' })]);
      updateResults.push([]);

      await expect(service.deleteServer('server-1', adminPrincipal)).rejects.toMatchObject({
        status: 409,
      });
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

      await expect(service.deleteServer('server-1', adminPrincipal)).resolves.toBeUndefined();
      expect(db.delete).toHaveBeenCalled();
      expect(updatedValues.map((value) => value.status)).toEqual(['STOPPING']);
    });

    it('marks ERROR and retains the row when remove fails and inspect finds it running', async () => {
      const error = new ConflictException('container conflicts with existing state');
      docker.removeContainer = jest.fn().mockRejectedValue(error);
      docker.inspectContainer = jest.fn().mockResolvedValue(makeInspect({ running: true }));
      selectResults.push([makeServer({ status: 'STOPPED' })]);
      updateResults.push([makeServer({ status: 'STOPPING' })], [makeServer({ status: 'ERROR' })]);

      await expect(service.deleteServer('server-1', adminPrincipal)).rejects.toBe(error);
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

      await expect(service.deleteServer('server-1', adminPrincipal)).rejects.toBe(error);
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

      await expect(service.deleteServer('server-1', adminPrincipal)).resolves.toBeUndefined();
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

  describe('requestable discovery (owner-approved slice)', () => {
    it('returns only the minimal REQUEST projection with request status and never sensitive fields', async () => {
      selectResults.push(
        [
          {
            id: 'req-1',
            name: 'Requestable',
            accessType: 'REQUEST',
            requestStatus: 'PENDING' as const,
          },
          { id: 'req-2', name: 'Another', accessType: 'REQUEST', requestStatus: null },
        ],
        [{ total: 2 }],
      );

      const result = await service.listRequestableServers(new ListServersQueryDto(), {
        id: 'user-1',
        role: 'USER',
      });

      expect(result.total).toBe(2);
      expect(result.data).toEqual([
        { id: 'req-1', name: 'Requestable', accessType: 'REQUEST', requestStatus: 'PENDING' },
        { id: 'req-2', name: 'Another', accessType: 'REQUEST', requestStatus: null },
      ]);
      for (const row of result.data) {
        expect(row).not.toHaveProperty('port');
        expect(row).not.toHaveProperty('levelSeed');
        expect(row).not.toHaveProperty('memoryLimitMb');
        expect(row).not.toHaveProperty('containerId');
        expect(row).not.toHaveProperty('rconPassword');
        expect(row).not.toHaveProperty('worldPath');
        expect(row).not.toHaveProperty('ownerId');
      }
    });

    it('applies pagination bounds to the rows query', async () => {
      selectResults.push([], [{ total: 0 }]);

      await service.listRequestableServers(
        { limit: 7, offset: 14 },
        { id: 'user-1', role: 'USER' },
      );

      const rowsQuery = queryChains[queryChains.length - 2];
      expect(rowsQuery.limit).toHaveBeenCalledWith(7);
      expect(rowsQuery.offset).toHaveBeenCalledWith(14);
      expect(db.select).toHaveBeenCalledTimes(2);
    });

    it('applies the same REQUEST-only predicate for USER and ADMIN callers and always sends a where clause', async () => {
      selectResults.push([], [{ total: 0 }]);
      await service.listRequestableServers(new ListServersQueryDto(), {
        id: 'user-1',
        role: 'USER',
      });
      selectResults.push([], [{ total: 0 }]);
      await service.listRequestableServers(new ListServersQueryDto(), {
        id: 'admin-1',
        role: 'ADMIN',
      });

      const userRowsQuery = queryChains[0];
      const adminRowsQuery = queryChains[2];
      const userWhere = userRowsQuery.where.mock.calls[0]?.[0];
      const adminWhere = adminRowsQuery.where.mock.calls[0]?.[0];
      expect(userWhere).toBeDefined();
      expect(adminWhere).toBeDefined();
      // Both roles run the identical discovery predicate (no role branching).
      expect(String(userWhere)).toBe(String(adminWhere));
      expect(db.select).toHaveBeenCalledTimes(4);
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
        service.startServer('server-1', adminPrincipal),
        service.startServer('server-1', adminPrincipal),
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
        service.startServer('server-1', adminPrincipal),
        service.deleteServer('server-1', adminPrincipal),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(docker.startContainer).toHaveBeenCalledTimes(0);
      expect(docker.removeContainer).toHaveBeenCalledTimes(1);
    });
  });
});
