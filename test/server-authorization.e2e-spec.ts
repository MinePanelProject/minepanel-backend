import 'reflect-metadata';
import crypto from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import cookieParser from 'cookie-parser';
import { eq, inArray } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AdminModule } from '../src/admin/admin.module';
import { AuthModule } from '../src/auth/auth.module';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../src/auth/guards/permissions.guard';
import { RolesGuard } from '../src/auth/guards/roles.guard';
import { CsrfOriginGuard } from '../src/common/guards/csrf-origin.guard';
import { DbModule, DRIZZLE, type DrizzleDB } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { DOCKERODE } from '../src/docker/docker.constants';
import { DockerModule } from '../src/docker/docker.module';
import { DockerService } from '../src/docker/docker.service';
import { GatewayModule } from '../src/gateway/gateway.module';
import { ServersModule } from '../src/servers/servers.module';
import { SetupModule } from '../src/setup/setup.module';
import { UsersModule } from '../src/users/users.module';
import { assertSafeTestDatabase } from './test-database';

type TestUser = schema.User;
type TestServer = schema.Server;
type Role = 'ADMIN' | 'MOD' | 'USER';

type DockerMock = {
  ping: jest.Mock;
  createContainer: jest.Mock;
  startContainer: jest.Mock;
  stopContainer: jest.Mock;
  executeRconCommand: jest.Mock;
  removeContainer: jest.Mock;
  findManagedContainer: jest.Mock;
  inspectContainer: jest.Mock;
  getHostInfo: jest.Mock;
  getHostDiskInfo: jest.Mock;
};

const sentinelDatabaseUrl = 'postgresql://unused:unused@127.0.0.1:1/ambient_sentinel';

const makeDocker = (): DockerMock => ({
  ping: jest.fn().mockResolvedValue(true),
  createContainer: jest.fn().mockResolvedValue('created-container'),
  startContainer: jest.fn().mockResolvedValue(undefined),
  stopContainer: jest.fn().mockResolvedValue('stopped'),
  executeRconCommand: jest.fn().mockResolvedValue(undefined),
  removeContainer: jest.fn().mockResolvedValue(undefined),
  findManagedContainer: jest.fn().mockResolvedValue(null),
  inspectContainer: jest.fn().mockResolvedValue({
    id: 'container-1',
    running: false,
    status: 'exited',
  }),
  getHostInfo: jest.fn().mockResolvedValue({ totalRamMb: 8192, cpuCount: 8 }),
  getHostDiskInfo: jest.fn().mockResolvedValue({ totalDiskMb: 100000, freeDiskMb: 10000 }),
});

describe('Server authorization (PostgreSQL e2e)', () => {
  let sql: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: INestApplication<App>;
  let docker: DockerMock;
  let admin: TestUser;
  let mod: TestUser;
  let user: TestUser;
  let adminAgent: request.SuperAgentTest;
  let modAgent: request.SuperAgentTest;
  let userAgent: request.SuperAgentTest;
  let trackedUserIds: Set<string>;
  let trackedServerIds: Set<string>;
  let trackedPermissionIds: Set<string>;
  let trackedAccessIds: Set<string>;
  let originalDatabaseUrl: string | undefined;
  let nextPort: number;

  const hashPassword = (password: string): string => bcrypt.hashSync(password, 10);

  const createUser = async (role: Role, username: string): Promise<TestUser> => {
    const id = crypto.randomUUID();
    const [u] = await db
      .insert(schema.users)
      .values({
        id,
        email: `${username}@example.com`,
        username,
        passwordHash: hashPassword('Password123!'),
        role,
        status: 'ACTIVE',
      })
      .returning();
    trackedUserIds.add(u.id);
    return u;
  };

  const createServer = async (
    accessType: schema.AccessType,
    status: schema.ServerStatus = 'STOPPED',
  ): Promise<TestServer> => {
    const id = crypto.randomUUID();
    const [s] = await db
      .insert(schema.servers)
      .values({
        id,
        name: `Auth ${id.slice(0, 8)}`,
        provider: 'PAPER',
        version: '1.21.1',
        port: nextPort++,
        containerId: `container-${id}`,
        status,
        maxPlayers: 20,
        difficulty: 'NORMAL',
        gamemode: 'SURVIVAL',
        pvp: true,
        memoryLimitMb: 2048,
        ownerId: admin.id,
        accessType,
      })
      .returning();
    trackedServerIds.add(s.id);
    return s;
  };

  const approveAccess = async (serverId: string, userId: string): Promise<void> => {
    const [row] = await db
      .insert(schema.serverAccess)
      .values({
        id: crypto.randomUUID(),
        serverId,
        userId,
        status: 'APPROVED',
        approvedAt: new Date(),
      })
      .returning();
    trackedAccessIds.add(row.id);
  };

  const createPendingRequest = async (serverId: string, userId: string): Promise<void> => {
    const [row] = await db
      .insert(schema.serverAccess)
      .values({
        id: crypto.randomUUID(),
        serverId,
        userId,
        status: 'PENDING',
      })
      .returning();
    trackedAccessIds.add(row.id);
  };

  const grantPermission = async (
    userId: string,
    permission: schema.ModPermission,
    serverId?: string,
  ): Promise<string> => {
    const [row] = await db
      .insert(schema.modPermissions)
      .values({
        id: crypto.randomUUID(),
        userId,
        permission,
        serverId: serverId ?? null,
      })
      .returning();
    trackedPermissionIds.add(row.id);
    return row.id;
  };

  const loginAgent = async (username: string): Promise<request.SuperAgentTest> => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/auth/login')
      .send({ identifier: username, password: 'Password123!' })
      .expect(200);
    return agent;
  };

  beforeAll(async () => {
    originalDatabaseUrl = process.env.DATABASE_URL;
    if (originalDatabaseUrl !== undefined && originalDatabaseUrl !== sentinelDatabaseUrl) {
      throw new Error(
        'Ambient DATABASE_URL is set to a non-sentinel value; run the authorization e2e suite with the sentinel DATABASE_URL.',
      );
    }
    process.env.DATABASE_URL = sentinelDatabaseUrl;
    // the graceful stop sleeps warnSeconds+3s; keep lifecycle tests fast
    process.env.STOP_WARN_SECONDS = '0';

    const databaseUrl = assertSafeTestDatabase();
    sql = postgres(databaseUrl, { max: 8 });
    db = drizzle(sql, { schema });

    // the suite's setup/init flow requires an absent singleton; on a shared
    // disposable server a crashed run may leave one — the singleton is this
    // suite's own fixture during its run, so reset it (and clean it in afterAll)
    await db.delete(schema.setupState).where(eq(schema.setupState.id, 'singleton'));

    trackedUserIds = new Set();
    trackedServerIds = new Set();
    trackedPermissionIds = new Set();
    trackedAccessIds = new Set();
    nextPort = 26000;

    docker = makeDocker();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        DbModule,
        SetupModule,
        UsersModule,
        AuthModule,
        AdminModule,
        DockerModule,
        ServersModule,
        GatewayModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: CsrfOriginGuard },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
      ],
    })
      // the AppModule throttler (10/min/IP) would 429 the suite's request volume;
      // the module graph above deliberately excludes ThrottlerModule
      .overrideProvider(DRIZZLE)
      .useValue(db as unknown as DrizzleDB)
      .overrideProvider(DockerService)
      .useValue(docker as unknown as DockerService)
      .overrideProvider(DOCKERODE)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication<App>();
    app.setGlobalPrefix('api', { exclude: ['/health'] });
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    // create first admin through the public setup API
    const setupAgent = request.agent(app.getHttpServer());
    const adminUsername = `auth_admin_${Date.now()}`;
    await setupAgent
      .post('/api/setup/init')
      .send({
        email: `${adminUsername}@example.com`,
        username: adminUsername,
        password: 'Password123!',
      })
      .expect(201);
    const [adminRow] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, adminUsername));
    admin = adminRow;
    trackedUserIds.add(admin.id);
    adminAgent = await loginAgent(adminUsername);

    mod = await createUser('MOD', `auth_mod_${Date.now()}`);
    user = await createUser('USER', `auth_user_${Date.now()}`);
    modAgent = await loginAgent(mod.username);
    userAgent = await loginAgent(user.username);
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    // tests create servers/access/permissions and assert absolute totals; clean
    // the previous test's tracked fixtures so each test sees only its own
    if (trackedAccessIds.size > 0) {
      await db
        .delete(schema.serverAccess)
        .where(inArray(schema.serverAccess.id, [...trackedAccessIds]));
      trackedAccessIds.clear();
    }
    if (trackedPermissionIds.size > 0) {
      await db
        .delete(schema.modPermissions)
        .where(inArray(schema.modPermissions.id, [...trackedPermissionIds]));
      trackedPermissionIds.clear();
    }
    if (trackedServerIds.size > 0) {
      await db.delete(schema.servers).where(inArray(schema.servers.id, [...trackedServerIds]));
      trackedServerIds.clear();
    }
    // fixture-scoped sweep: API-created grants/access rows for the suite's own
    // principals may not be in the tracked sets — remove them so tests are
    // hermetic (the mod/user fixtures are owned by this suite)
    if (mod !== undefined && user !== undefined) {
      await db
        .delete(schema.modPermissions)
        .where(inArray(schema.modPermissions.userId, [mod.id, user.id]));
      await db
        .delete(schema.serverAccess)
        .where(inArray(schema.serverAccess.userId, [mod.id, user.id]));
    }
  });

  afterAll(async () => {
    try {
      if (trackedAccessIds.size > 0) {
        await db
          .delete(schema.serverAccess)
          .where(inArray(schema.serverAccess.id, [...trackedAccessIds]));
      }
      if (trackedPermissionIds.size > 0) {
        await db
          .delete(schema.modPermissions)
          .where(inArray(schema.modPermissions.id, [...trackedPermissionIds]));
      }
      if (trackedServerIds.size > 0) {
        await db.delete(schema.servers).where(inArray(schema.servers.id, [...trackedServerIds]));
      }
      // remove the setup singleton this suite's setup/init created
      await db.delete(schema.setupState).where(eq(schema.setupState.id, 'singleton'));
      if (trackedUserIds.size > 0) {
        await db.delete(schema.users).where(inArray(schema.users.id, [...trackedUserIds]));
      }
      await app?.close();
      await sql?.end();
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }
  });

  it('binds the app to the test Drizzle client and the pre-init Docker mock', () => {
    expect(app.get(DRIZZLE)).toBe(db);
    expect(app.get(DockerService)).toBe(docker);
  });

  describe('visibility matrix', () => {
    it('shows OPEN servers to ADMIN, MOD, and USER with matching totals', async () => {
      const server = await createServer('OPEN');

      for (const agent of [adminAgent, modAgent, userAgent]) {
        const response = await agent.get('/api/servers').expect(200);
        expect(response.body.total).toBe(1);
        expect(response.body.data[0].id).toBe(server.id);
        expect(response.body.data[0]).toHaveProperty('accessType', 'OPEN');
        expect(response.body.data[0]).not.toHaveProperty('rconPassword');
      }
    });

    it('shows REQUEST servers only to ADMIN and approved users', async () => {
      const server = await createServer('REQUEST');
      await approveAccess(server.id, user.id);

      const adminList = await adminAgent.get('/api/servers').expect(200);
      expect(adminList.body.total).toBe(1);

      const userList = await userAgent.get('/api/servers').expect(200);
      expect(userList.body.total).toBe(1);

      const modList = await modAgent.get('/api/servers').expect(200);
      expect(modList.body.total).toBe(0);
    });

    it('shows PRIVATE servers only to ADMIN and directly assigned users', async () => {
      const server = await createServer('PRIVATE');
      await approveAccess(server.id, user.id);

      const adminList = await adminAgent.get('/api/servers').expect(200);
      expect(adminList.body.total).toBe(1);

      const userList = await userAgent.get('/api/servers').expect(200);
      expect(userList.body.total).toBe(1);

      const modList = await modAgent.get('/api/servers').expect(200);
      expect(modList.body.total).toBe(0);
    });

    it('hides CREATING servers from everyone', async () => {
      await createServer('OPEN', 'CREATING');

      const response = await adminAgent.get('/api/servers').expect(200);
      expect(response.body.total).toBe(0);
    });
  });

  describe('owner has no visibility bypass', () => {
    it('returns 404 when a USER owner tries to access their own PRIVATE server', async () => {
      const userOwner = await createUser('USER', `owner-${Date.now()}`);
      const ownerAgent = await loginAgent(userOwner.username);
      const server = await db
        .insert(schema.servers)
        .values({
          id: crypto.randomUUID(),
          name: 'Owner private',
          provider: 'PAPER',
          version: '1.21.1',
          port: nextPort++,
          containerId: 'container-owner',
          status: 'STOPPED',
          maxPlayers: 20,
          difficulty: 'NORMAL',
          gamemode: 'SURVIVAL',
          pvp: true,
          memoryLimitMb: 2048,
          ownerId: userOwner.id,
          accessType: 'PRIVATE',
        })
        .returning()
        .then((rows) => rows[0]);
      trackedServerIds.add(server.id);
      trackedUserIds.add(userOwner.id);

      await ownerAgent.get(`/api/servers/${server.id}`).expect(404);
    });
  });

  describe('REQUEST state machine', () => {
    it('creates a PENDING request, hides it from list/get, and reveals it after approval', async () => {
      const server = await createServer('REQUEST');

      const created = await userAgent.post(`/api/servers/${server.id}/request-access`).expect(201);
      expect(created.body.status).toBe('PENDING');
      trackedAccessIds.add(
        await db
          .select({ id: schema.serverAccess.id })
          .from(schema.serverAccess)
          .where(eq(schema.serverAccess.userId, user.id))
          .limit(1)
          .then((rows) => rows[0].id),
      );

      // pending request does not make the server visible
      const userList = await userAgent.get('/api/servers').expect(200);
      expect(userList.body.total).toBe(0);
      await userAgent.get(`/api/servers/${server.id}`).expect(404);

      // owner can see their own pending request
      const myRequest = await userAgent
        .get(`/api/servers/${server.id}/my-access-request`)
        .expect(200);
      expect(myRequest.body.status).toBe('PENDING');

      // admin sees sanitized pending list
      const pending = await adminAgent.get(`/api/servers/${server.id}/access-requests`).expect(200);
      expect(pending.body).toHaveLength(1);
      expect(pending.body[0]).toMatchObject({
        userId: user.id,
        username: user.username,
        email: user.email,
        status: 'PENDING',
      });
      expect(pending.body[0]).not.toHaveProperty('passwordHash');

      // approve
      await adminAgent
        .post(`/api/servers/${server.id}/access-requests/${user.id}/approve`)
        .expect(200);

      // now visible
      const visible = await userAgent.get('/api/servers').expect(200);
      expect(visible.body.total).toBe(1);
      await userAgent.get(`/api/servers/${server.id}`).expect(200);

      // revoke
      await adminAgent.delete(`/api/servers/${server.id}/access-requests/${user.id}`).expect(204);

      // hidden again
      const hidden = await userAgent.get('/api/servers').expect(200);
      expect(hidden.body.total).toBe(0);
      await userAgent.get(`/api/servers/${server.id}/my-access-request`).expect(404);

      // re-request works
      const recreated = await userAgent
        .post(`/api/servers/${server.id}/request-access`)
        .expect(201);
      expect(recreated.body.status).toBe('PENDING');
    });

    it('returns 409 for duplicate pending or already-approved requests', async () => {
      const server = await createServer('REQUEST');
      await userAgent.post(`/api/servers/${server.id}/request-access`).expect(201);
      await userAgent
        .post(`/api/servers/${server.id}/request-access`)
        .expect(409)
        .expect((response) => {
          expect(response.body.message).toBe('Access request already pending');
        });

      await adminAgent
        .post(`/api/servers/${server.id}/access-requests/${user.id}/approve`)
        .expect(200);
      await userAgent
        .post(`/api/servers/${server.id}/request-access`)
        .expect(409)
        .expect((response) => {
          expect(response.body.message).toBe('Server access already approved');
        });
    });
  });

  describe('PRIVATE assignment', () => {
    it('returns 404 for self-request, allows ADMIN assignment, and revokes cleanly', async () => {
      const server = await createServer('PRIVATE');

      await userAgent
        .post(`/api/servers/${server.id}/request-access`)
        .expect(404)
        .expect((response) => {
          expect(response.body.message).toBe('Server not found');
        });

      await adminAgent
        .post(`/api/servers/${server.id}/access-requests/${user.id}/approve`)
        .expect(200);

      const visible = await userAgent.get('/api/servers').expect(200);
      expect(visible.body.total).toBe(1);

      await adminAgent.delete(`/api/servers/${server.id}/access-requests/${user.id}`).expect(204);
      const hidden = await userAgent.get('/api/servers').expect(200);
      expect(hidden.body.total).toBe(0);
    });
  });

  describe('OPEN access', () => {
    it('returns 409 for request-access and creates no row', async () => {
      const server = await createServer('OPEN');

      await userAgent
        .post(`/api/servers/${server.id}/request-access`)
        .expect(409)
        .expect((response) => {
          expect(response.body.message).toBe('Server access is already open');
        });

      const rows = await db
        .select()
        .from(schema.serverAccess)
        .where(eq(schema.serverAccess.serverId, server.id));
      expect(rows).toHaveLength(0);
    });
  });

  describe('concurrency invariants', () => {
    it('creates exactly one PENDING row for concurrent duplicate requests', async () => {
      const server = await createServer('REQUEST');

      const results = await Promise.allSettled([
        userAgent.post(`/api/servers/${server.id}/request-access`),
        userAgent.post(`/api/servers/${server.id}/request-access`),
        userAgent.post(`/api/servers/${server.id}/request-access`),
      ]);

      // supertest resolves with the HTTP response even for 409 — distinguish by
      // response status, not allSettled state
      const created = results.filter(
        (r) => r.status === 'fulfilled' && (r.value as { status: number }).status === 201,
      );
      const conflicts = results.filter(
        (r) => r.status === 'fulfilled' && (r.value as { status: number }).status === 409,
      );
      expect(created).toHaveLength(1);
      expect(conflicts).toHaveLength(2);

      const rows = await db
        .select()
        .from(schema.serverAccess)
        .where(eq(schema.serverAccess.serverId, server.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('PENDING');
    });

    it('keeps approvedAt non-null when concurrent approvals race', async () => {
      const server = await createServer('REQUEST');
      await createPendingRequest(server.id, user.id);

      const results = await Promise.allSettled([
        adminAgent.post(`/api/servers/${server.id}/access-requests/${user.id}/approve`),
        adminAgent.post(`/api/servers/${server.id}/access-requests/${user.id}/approve`),
        adminAgent.post(`/api/servers/${server.id}/access-requests/${user.id}/approve`),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expect(fulfilled.length + rejected.length).toBe(3);

      const [row] = await db
        .select()
        .from(schema.serverAccess)
        .where(eq(schema.serverAccess.serverId, server.id));
      expect(row.status).toBe('APPROVED');
      expect(row.approvedAt).not.toBeNull();
    });
  });

  describe('ADMIN permission CRUD', () => {
    it('grants global and scoped MOD permissions', async () => {
      const globalResponse = await adminAgent
        .post(`/api/admin/users/${mod.id}/permissions`)
        .send({ permission: 'SERVER_LIFECYCLE' })
        .expect(201);
      expect(globalResponse.body.serverId).toBeNull();
      trackedPermissionIds.add(globalResponse.body.id);

      const openServer = await createServer('OPEN');
      const scopedResponse = await adminAgent
        .post(`/api/admin/users/${mod.id}/permissions`)
        .send({ permission: 'SERVER_LIFECYCLE', serverId: openServer.id })
        .expect(201);
      expect(scopedResponse.body.serverId).toBe(openServer.id);
      trackedPermissionIds.add(scopedResponse.body.id);

      const list = await adminAgent.get(`/api/admin/users/${mod.id}/permissions`).expect(200);
      expect(list.body).toHaveLength(2);
    });

    it('returns 409 for duplicate grants and 400 for non-MOD targets', async () => {
      await adminAgent
        .post(`/api/admin/users/${mod.id}/permissions`)
        .send({ permission: 'SERVER_LIFECYCLE' })
        .expect(201);

      await adminAgent
        .post(`/api/admin/users/${mod.id}/permissions`)
        .send({ permission: 'SERVER_LIFECYCLE' })
        .expect(409)
        .expect((response) => {
          expect(response.body.message).toBe('Permission grant already exists');
        });

      await adminAgent
        .post(`/api/admin/users/${user.id}/permissions`)
        .send({ permission: 'SERVER_LIFECYCLE' })
        .expect(400)
        .expect((response) => {
          expect(response.body.message).toBe('User is not a MOD');
        });
    });

    it('prevents cross-user revocation with a 404', async () => {
      const otherMod = await createUser('MOD', `other_mod_${Date.now()}`);
      const [perm] = await db
        .insert(schema.modPermissions)
        .values({
          id: crypto.randomUUID(),
          userId: otherMod.id,
          permission: 'SERVER_LIFECYCLE',
          serverId: null,
        })
        .returning();
      trackedPermissionIds.add(perm.id);
      trackedUserIds.add(otherMod.id);

      await adminAgent
        .delete(`/api/admin/users/${mod.id}/permissions/${perm.id}`)
        .expect(404)
        .expect((response) => {
          expect(response.body.message).toBe('Permission grant not found');
        });
    });
  });

  describe('MOD lifecycle gates', () => {
    it('returns 403 without calling Docker when MOD has no permission', async () => {
      const server = await createServer('OPEN', 'STOPPED');

      await modAgent.post(`/api/servers/${server.id}/start`).expect(403);
      expect(docker.startContainer).not.toHaveBeenCalled();
      expect(docker.getHostInfo).not.toHaveBeenCalled();
    });

    it('returns 403 when MOD has only a wrong-scope permission', async () => {
      const otherServer = await createServer('OPEN', 'STOPPED');
      const targetServer = await createServer('OPEN', 'STOPPED');
      await grantPermission(mod.id, 'SERVER_LIFECYCLE', otherServer.id);

      await modAgent.post(`/api/servers/${targetServer.id}/start`).expect(403);
      expect(docker.startContainer).not.toHaveBeenCalled();
    });

    it('returns 404 when MOD has permission but the server is hidden', async () => {
      const server = await createServer('PRIVATE', 'STOPPED');
      await grantPermission(mod.id, 'SERVER_LIFECYCLE', server.id);

      await modAgent.post(`/api/servers/${server.id}/start`).expect(404);
      expect(docker.startContainer).not.toHaveBeenCalled();
    });

    it('allows start/stop/restart with a visible scoped permission', async () => {
      const server = await createServer('OPEN', 'STOPPED');
      await grantPermission(mod.id, 'SERVER_LIFECYCLE', server.id);

      await modAgent.post(`/api/servers/${server.id}/start`).expect(200);
      expect(docker.startContainer).toHaveBeenCalledTimes(1);

      jest.clearAllMocks();
      await modAgent.post(`/api/servers/${server.id}/restart`).expect(200);
      expect(docker.stopContainer).toHaveBeenCalled();
      expect(docker.startContainer).toHaveBeenCalled();

      jest.clearAllMocks();
      await modAgent.post(`/api/servers/${server.id}/stop`).expect(200);
      expect(docker.stopContainer).toHaveBeenCalled();
    }, 20000);

    it('allows lifecycle with a visible global permission', async () => {
      const server = await createServer('OPEN', 'STOPPED');
      await grantPermission(mod.id, 'SERVER_LIFECYCLE');

      await modAgent.post(`/api/servers/${server.id}/start`).expect(200);
      expect(docker.startContainer).toHaveBeenCalledTimes(1);
    });

    it('allows ADMIN bypass even without explicit permission', async () => {
      const server = await createServer('OPEN', 'STOPPED');

      await adminAgent.post(`/api/servers/${server.id}/start`).expect(200);
      expect(docker.startContainer).toHaveBeenCalledTimes(1);
    });

    it('returns 403 for a USER role before any Docker call', async () => {
      const server = await createServer('OPEN', 'STOPPED');

      await userAgent.post(`/api/servers/${server.id}/start`).expect(403);
      expect(docker.startContainer).not.toHaveBeenCalled();
      expect(docker.getHostInfo).not.toHaveBeenCalled();
    });
  });

  describe('role change clears permissions', () => {
    it('removes all MOD permissions on role change and subsequent lifecycle requests fail', async () => {
      const server = await createServer('OPEN', 'STOPPED');
      await grantPermission(mod.id, 'SERVER_LIFECYCLE', server.id);

      await modAgent.post(`/api/servers/${server.id}/start`).expect(200);

      await adminAgent.patch(`/api/admin/users/${mod.id}/role`).send({ role: 'USER' }).expect(200);

      const permissions = await db
        .select()
        .from(schema.modPermissions)
        .where(eq(schema.modPermissions.userId, mod.id));
      expect(permissions).toHaveLength(0);

      await modAgent.post(`/api/servers/${server.id}/start`).expect(403);
      expect(docker.startContainer).toHaveBeenCalledTimes(1); // only the first call
    });
  });

  describe('CSRF Origin behavior', () => {
    it('rejects a hostile Origin on request-access before reaching the service', async () => {
      const server = await createServer('REQUEST');

      const response = await userAgent
        .post(`/api/servers/${server.id}/request-access`)
        .set('Origin', 'https://evil.example')
        .expect(403);
      expect(response.body).toEqual({ error: 'CsrfOriginForbidden' });

      const rows = await db
        .select()
        .from(schema.serverAccess)
        .where(eq(schema.serverAccess.serverId, server.id));
      expect(rows).toHaveLength(0);
    });

    it('allows the canonical Origin on a mutating route', async () => {
      const server = await createServer('REQUEST');

      const response = await userAgent
        .post(`/api/servers/${server.id}/request-access`)
        .set('Origin', process.env.CORS_ORIGIN as string)
        .expect(201);
      expect(response.body.status).toBe('PENDING');
    });

    it('allows a missing Origin header on a mutating route', async () => {
      const server = await createServer('REQUEST');

      // supertest does not send an Origin header by default
      const response = await userAgent.post(`/api/servers/${server.id}/request-access`).expect(201);
      expect(response.body.status).toBe('PENDING');
    });
  });
});
