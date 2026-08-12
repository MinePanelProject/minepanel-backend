import 'reflect-metadata';
import crypto from 'node:crypto';
import {
  CanActivate,
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  type INestApplication,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { inArray } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Request } from 'express';
import postgres from 'postgres';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DRIZZLE, type DrizzleDB } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { DOCKERODE } from '../src/docker/docker.constants';
import { type ContainerInspectState, DockerService } from '../src/docker/docker.service';
import { ServersModule } from '../src/servers/servers.module';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const canonicalDatabaseTarget = (value: string): string => {
  const parsed = new URL(value);
  const host = parsed.hostname.toLowerCase();
  // localhost / 127.0.0.1 / ::1 / 0.0.0.0 are the same target
  const canonicalHost =
    host === 'localhost' || host === '::1' || host === '0.0.0.0' ? '127.0.0.1' : host;
  const port = parsed.port || '5432';
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  return `${canonicalHost}:${port}/${database}`;
};

const assertSafeTestEnvironment = (): string => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to run the lifecycle e2e suite in production');
  }
  if (!TEST_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL is required for the lifecycle e2e suite');
  }

  const ambientDatabaseUrl = process.env.DATABASE_URL;
  if (
    ambientDatabaseUrl &&
    canonicalDatabaseTarget(TEST_DATABASE_URL) === canonicalDatabaseTarget(ambientDatabaseUrl)
  ) {
    throw new Error('TEST_DATABASE_URL must target a different database than DATABASE_URL');
  }

  return TEST_DATABASE_URL;
};

type TestUser = schema.User;
type TestServer = schema.Server;
type TestDocker = Pick<
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

type TestRequest = Request & {
  user?: { id: string; username: string; role: string };
};

@Injectable()
class E2eAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TestRequest>();
    const id = request.header('x-test-user-id');
    const role = request.header('x-test-role');

    if (!id || !role) {
      throw new UnauthorizedException();
    }

    request.user = { id, username: 'e2e-user', role };
    return true;
  }
}

@Injectable()
class E2eRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<string[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles) return true;

    const request = context.switchToHttp().getRequest<TestRequest>();
    if (!request.user || !roles.includes(request.user.role)) {
      throw new ForbiddenException();
    }

    return true;
  }
}

describe('Servers lifecycle (PostgreSQL e2e)', () => {
  let sql: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: INestApplication<App>;
  let docker: TestDocker;
  let trackedServerIds: Set<string>;
  let trackedUserIds: Set<string>;
  let nextPort: number;

  const makeInspect = (id: string, running: boolean): ContainerInspectState => ({
    id,
    name: `/mc-${id}`,
    image: 'itzg/minecraft-server',
    status: running ? 'running' : 'exited',
    running,
    restartCount: 0,
    startedAt: '',
    finishedAt: '',
    exitCode: running ? 0 : 0,
    oomKilled: false,
  });

  const makeDocker = (): TestDocker => ({
    createContainer: jest.fn().mockResolvedValue('created-container'),
    startContainer: jest.fn().mockResolvedValue(undefined),
    stopContainer: jest.fn().mockResolvedValue(undefined),
    removeContainer: jest.fn().mockResolvedValue(undefined),
    findManagedContainer: jest.fn().mockResolvedValue(null),
    inspectContainer: jest.fn().mockImplementation(async (id: string) => makeInspect(id, false)),
    getHostInfo: jest.fn().mockResolvedValue({ totalRamMb: 8192, cpuCount: 8 }),
    getHostDiskInfo: jest.fn().mockResolvedValue({ totalDiskMb: 100000, freeDiskMb: 10000 }),
  });

  const resetDocker = (): void => {
    docker.getHostInfo = jest.fn().mockResolvedValue({ totalRamMb: 8192, cpuCount: 8 });
    docker.getHostDiskInfo = jest
      .fn()
      .mockResolvedValue({ totalDiskMb: 100000, freeDiskMb: 10000 });
    docker.startContainer = jest.fn().mockResolvedValue(undefined);
    docker.stopContainer = jest.fn().mockResolvedValue(undefined);
    docker.removeContainer = jest.fn().mockResolvedValue(undefined);
    docker.findManagedContainer = jest.fn().mockResolvedValue(null);
    docker.inspectContainer = jest
      .fn()
      .mockImplementation(async (id: string) => makeInspect(id, false));
  };

  const bootApp = async (dockerOverride?: TestDocker): Promise<INestApplication<App>> => {
    docker = dockerOverride ?? makeDocker();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), ServersModule],
      providers: [
        { provide: APP_GUARD, useClass: E2eAuthGuard },
        { provide: APP_GUARD, useClass: E2eRolesGuard },
      ],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db as unknown as DrizzleDB)
      .overrideProvider(DockerService)
      .useValue(docker)
      .overrideProvider(DOCKERODE)
      .useValue({})
      .compile();

    const nextApp = moduleFixture.createNestApplication<App>();
    nextApp.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    nextApp.setGlobalPrefix('api');
    await nextApp.init();
    return nextApp;
  };

  const createUser = async (role: 'ADMIN' | 'MOD' | 'USER' = 'ADMIN'): Promise<TestUser> => {
    const id = crypto.randomUUID();
    const [user] = await db
      .insert(schema.users)
      .values({
        id,
        email: `${id}@example.com`,
        username: `e2e-${id.slice(0, 12)}`,
        passwordHash: 'not-used-in-this-suite',
        role,
        status: 'ACTIVE',
      })
      .returning();
    trackedUserIds.add(user.id);
    return user;
  };

  const createServer = async (
    ownerId: string,
    overrides: Partial<schema.NewServer> = {},
  ): Promise<TestServer> => {
    const id = crypto.randomUUID();
    const [server] = await db
      .insert(schema.servers)
      .values({
        id,
        name: `E2E ${id.slice(0, 8)}`,
        provider: 'PAPER',
        version: '1.21.1',
        port: nextPort++,
        containerId: `container-${id}`,
        status: 'STOPPED',
        maxPlayers: 20,
        difficulty: 'NORMAL',
        gamemode: 'SURVIVAL',
        pvp: true,
        memoryLimitMb: 2048,
        ownerId,
        ...overrides,
      })
      .returning();
    trackedServerIds.add(server.id);
    return server;
  };

  const auth = (user: TestUser) => ({
    'x-test-user-id': user.id,
    'x-test-role': user.role,
  });

  const readServer = async (id: string): Promise<TestServer | undefined> => {
    const rows = await db
      .select()
      .from(schema.servers)
      .where(inArray(schema.servers.id, [id]));
    return rows[0];
  };
  const waitForDockerStart = async (): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (jest.isMockFunction(docker.startContainer) && docker.startContainer.mock.calls.length > 0)
        return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const hostCalls = jest.isMockFunction(docker.getHostInfo)
      ? docker.getHostInfo.mock.calls.length
      : -1;
    const diskCalls = jest.isMockFunction(docker.getHostDiskInfo)
      ? docker.getHostDiskInfo.mock.calls.length
      : -1;
    throw new Error(`Docker start was not invoked (host ${hostCalls}, disk ${diskCalls})`);
  };

  beforeAll(async () => {
    const connectionString = assertSafeTestEnvironment();
    sql = postgres(connectionString, { max: 8 });
    await sql`SELECT 1`;
    db = drizzle(sql, { schema });
    trackedServerIds = new Set();
    trackedUserIds = new Set();
    nextPort = 25000;
    app = await bootApp();
  });

  beforeEach(() => {
    if (docker) resetDocker();
  });

  afterEach(async () => {
    if (!db || !trackedServerIds || !trackedUserIds) return;

    if (trackedServerIds.size > 0) {
      await db.delete(schema.servers).where(inArray(schema.servers.id, [...trackedServerIds]));
    }
    if (trackedUserIds.size > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, [...trackedUserIds]));
    }
    trackedServerIds.clear();
    trackedUserIds.clear();
  });

  afterAll(async () => {
    await app?.close();
    await sql?.end();
  });

  it('binds the app to the test Drizzle client and the pre-init Docker mock', () => {
    expect(app.get(DRIZZLE)).toBe(db);
    expect(app.get(DockerService)).toBe(docker);
  });

  it('returns public reads while Docker is unavailable', async () => {
    const user = await createUser('USER');
    const server = await createServer(user.id, { status: 'STOPPED' });
    docker.getHostInfo = jest.fn().mockRejectedValue(new Error('daemon down'));
    docker.getHostDiskInfo = jest.fn().mockRejectedValue(new Error('daemon down'));

    await request(app.getHttpServer())
      .get('/api/servers')
      .set(auth(user))
      .expect(200)
      .expect((response) => {
        expect(response.body.total).toBe(1);
        expect(response.body.data[0].id).toBe(server.id);
        expect(response.body.data[0]).not.toHaveProperty('rconPassword');
        expect(response.body.data[0]).not.toHaveProperty('containerId');
        expect(response.body.data[0]).not.toHaveProperty('worldPath');
      });

    await request(app.getHttpServer()).get(`/api/servers/${server.id}`).set(auth(user)).expect(200);
  });

  it('returns 409 for start while already STARTING', async () => {
    const user = await createUser();
    const server = await createServer(user.id, { status: 'STARTING' });

    await request(app.getHttpServer())
      .post(`/api/servers/${server.id}/start`)
      .set(auth(user))
      .expect(409)
      .expect((response) => {
        expect(response.body.message).toBe('Server is not in STOPPED state');
      });
    expect(docker.startContainer).not.toHaveBeenCalled();
  });

  it('returns exact memory admission details when RAM is insufficient', async () => {
    const user = await createUser();
    const server = await createServer(user.id, { memoryLimitMb: 2048 });
    await createServer(user.id, { memoryLimitMb: 2048, status: 'RUNNING' });
    docker.getHostInfo = jest.fn().mockResolvedValue({ totalRamMb: 4096, cpuCount: 8 });

    await request(app.getHttpServer())
      .post(`/api/servers/${server.id}/start`)
      .set(auth(user))
      .expect(422)
      .expect((response) => {
        expect(response.body).toEqual({
          statusCode: 422,
          error: 'InsufficientResources',
          message: 'Insufficient memory to start server',
          details: {
            resource: 'memory',
            availableMb: 1638,
            requiredMb: 2048,
            totalMb: 4096,
          },
        });
      });

    expect(await readServer(server.id)).toEqual(expect.objectContaining({ status: 'STOPPED' }));
    expect(docker.startContainer).not.toHaveBeenCalled();
  });

  it('returns 409 for deleting a RUNNING server and 202 for a STOPPED server', async () => {
    const user = await createUser();
    const running = await createServer(user.id, { status: 'RUNNING' });
    const stopped = await createServer(user.id, { status: 'STOPPED' });

    await request(app.getHttpServer())
      .delete(`/api/servers/${running.id}`)
      .set(auth(user))
      .expect(409)
      .expect((response) => {
        expect(response.body.message).toBe('Server is not in STOPPED state');
      });

    await request(app.getHttpServer())
      .delete(`/api/servers/${stopped.id}`)
      .set(auth(user))
      .expect(202)
      .expect((response) => expect(response.body).toEqual({}));

    expect(await readServer(stopped.id)).toBeUndefined();
  });

  it('keeps a preflight Docker 503 before any claim or write', async () => {
    const user = await createUser();
    const server = await createServer(user.id);
    const error = new ServiceUnavailableException('Docker daemon unreachable');
    docker.getHostInfo = jest.fn().mockRejectedValue(error);

    await request(app.getHttpServer())
      .post(`/api/servers/${server.id}/start`)
      .set(auth(user))
      .expect(503)
      .expect((response) => expect(response.body.message).toBe('Docker daemon unreachable'));

    expect(await readServer(server.id)).toEqual(expect.objectContaining({ status: 'STOPPED' }));
    expect(docker.startContainer).not.toHaveBeenCalled();
  });

  it('marks a post-claim Docker 503 as ERROR without claiming false success', async () => {
    const user = await createUser();
    const server = await createServer(user.id);
    const error = new ServiceUnavailableException('Docker daemon unreachable');
    docker.startContainer = jest.fn().mockRejectedValue(error);

    await request(app.getHttpServer())
      .post(`/api/servers/${server.id}/start`)
      .set(auth(user))
      .expect(503)
      .expect((response) => expect(response.body.message).toBe('Docker daemon unreachable'));

    expect(await readServer(server.id)).toEqual(expect.objectContaining({ status: 'ERROR' }));
  });

  it('allows one same-row start claimant and one Docker start under a double-start race', async () => {
    const user = await createUser();
    const server = await createServer(user.id);
    let releaseStart: (() => void) | undefined;
    const startBlocked = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    docker.startContainer = jest.fn().mockImplementation(() => startBlocked);

    const first = request(app.getHttpServer())
      .post(`/api/servers/${server.id}/start`)
      .set(auth(user));
    const firstResponsePromise = first.then((response) => response);
    await waitForDockerStart();

    const second = await request(app.getHttpServer())
      .post(`/api/servers/${server.id}/start`)
      .set(auth(user));
    expect(second.status).toBe(409);
    expect(second.body.message).toBe('Server is not in STOPPED state');

    releaseStart?.();
    expect((await firstResponsePromise).status).toBe(200);
    expect(docker.startContainer).toHaveBeenCalledTimes(1);
  });

  it('admits only one of two different rows when concurrent memory capacity fits either alone', async () => {
    const user = await createUser();
    const first = await createServer(user.id, { memoryLimitMb: 2048 });
    const second = await createServer(user.id, { memoryLimitMb: 2048 });
    docker.getHostInfo = jest.fn().mockResolvedValue({ totalRamMb: 4096, cpuCount: 8 });
    let releaseStart: (() => void) | undefined;
    const startBlocked = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    docker.startContainer = jest.fn().mockImplementation(() => startBlocked);

    const firstRequest = request(app.getHttpServer())
      .post(`/api/servers/${first.id}/start`)
      .set(auth(user));
    const firstResponsePromise = firstRequest.then((response) => response);
    await waitForDockerStart();

    const secondResponse = await request(app.getHttpServer())
      .post(`/api/servers/${second.id}/start`)
      .set(auth(user));
    expect(secondResponse.status).toBe(422);
    expect(secondResponse.body.details).toEqual(
      expect.objectContaining({ resource: 'memory', requiredMb: 2048 }),
    );

    releaseStart?.();
    expect((await firstResponsePromise).status).toBe(200);
    expect(docker.startContainer).toHaveBeenCalledTimes(1);
  });

  it('lets exactly one claimant win a start-versus-delete race', async () => {
    const user = await createUser();
    const server = await createServer(user.id);
    let releaseStart: (() => void) | undefined;
    const startBlocked = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    docker.startContainer = jest.fn().mockImplementation(() => startBlocked);

    const startRequest = request(app.getHttpServer())
      .post(`/api/servers/${server.id}/start`)
      .set(auth(user));
    // fire the request without awaiting — the race requires it to be in flight
    void startRequest.then((response) => response);
    await waitForDockerStart();

    const deleteResponse = await request(app.getHttpServer())
      .delete(`/api/servers/${server.id}`)
      .set(auth(user));
    expect(deleteResponse.status).toBe(409);
    releaseStart?.();
    expect(docker.startContainer).toHaveBeenCalledTimes(1);
    expect(docker.removeContainer).not.toHaveBeenCalled();
  });

  it('reconciles a CREATING row whose managed container existed before id persistence', async () => {
    const user = await createUser();
    const server = await createServer(user.id, { status: 'CREATING', containerId: null });
    await app.close();
    const recoveredDocker = makeDocker();
    recoveredDocker.findManagedContainer = jest
      .fn()
      .mockResolvedValue({ id: 'recovered-container', running: true });
    app = await bootApp(recoveredDocker);
    expect(recoveredDocker.findManagedContainer).toHaveBeenCalledWith(server.id);

    expect(await readServer(server.id)).toEqual(
      expect.objectContaining({ status: 'RUNNING', containerId: 'recovered-container' }),
    );
  });

  it('marks ERROR when remove conflicts and inspect proves the supposedly-stopped container is running', async () => {
    const user = await createUser();
    const server = await createServer(user.id);
    const conflict = new ConflictException('container conflicts with existing state');
    docker.removeContainer = jest.fn().mockRejectedValue(conflict);
    docker.inspectContainer = jest.fn().mockResolvedValue(makeInspect(server.containerId!, true));

    await request(app.getHttpServer())
      .delete(`/api/servers/${server.id}`)
      .set(auth(user))
      .expect(409);

    expect(await readServer(server.id)).toEqual(expect.objectContaining({ status: 'ERROR' }));
  });

  it('reconciles a fresh app boot from mocked inspect outcomes', async () => {
    const user = await createUser();
    const server = await createServer(user.id, {
      status: 'STARTING',
      containerId: 'boot-container',
    });
    await app.close();
    const bootDocker = makeDocker();
    bootDocker.inspectContainer = jest.fn().mockResolvedValue(makeInspect('boot-container', false));
    app = await bootApp(bootDocker);

    expect(await readServer(server.id)).toEqual(
      expect.objectContaining({ status: 'STOPPED', containerId: 'boot-container' }),
    );
  });
});
