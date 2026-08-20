import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module';
import { DbModule, DRIZZLE, type DrizzleDB } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { DOCKERODE } from '../src/docker/docker.constants';
import { DockerModule } from '../src/docker/docker.module';
import { DockerService } from '../src/docker/docker.service';
import { GatewayModule } from '../src/gateway/gateway.module';
import { SocketIoAdapter } from '../src/gateway/socket-io.adapter';
import { SocketReservationService } from '../src/gateway/socket-reservation.service';
import { SetupModule } from '../src/setup/setup.module';
import { UsersModule } from '../src/users/users.module';

const isAddressInfo = (value: AddressInfo | string | null): value is AddressInfo =>
  typeof value === 'object' && value !== null;

import { assertSafeTestDatabase } from './test-database';

const ORIGIN = process.env.CORS_ORIGIN ?? 'http://127.0.0.1:5173';
const password = 'Round3HostPassword123!';

type Login = { cookies: string[]; accessToken: string };

const accessTokenFromCookies = (cookies: string[]): string => {
  const value = cookies.find((cookie) => cookie.startsWith('access_token='));
  if (!value) throw new Error('login did not return an access cookie');
  return decodeURIComponent(value.slice('access_token='.length).split(';')[0]);
};

const waitForStats = (socket: Socket, timeoutMs = 2000): Promise<Record<string, number>> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('system.stats timeout')), timeoutMs);
    socket.once('system.stats', (payload: Record<string, number>) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

describe('host metrics Socket.IO network e2e', () => {
  let sql: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: INestApplication;
  let port: number;
  const userIds: string[] = [];
  const clients: Socket[] = [];
  let hostInfo: jest.Mock;
  let diskInfo: jest.Mock;
  let freeMemory: jest.Mock;

  const createUser = async (role: 'ADMIN' | 'USER'): Promise<Login> => {
    const id = crypto.randomUUID();
    const suffix = id.slice(0, 12);
    await db.insert(schema.users).values({
      id,
      email: `${role.toLowerCase()}-${suffix}@example.com`,
      username: `${role.toLowerCase()}${suffix}`,
      passwordHash: await bcrypt.hash(password, 4),
      role,
      status: 'ACTIVE',
    });
    userIds.push(id);
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ identifier: `${role.toLowerCase()}${suffix}`, password })
      .expect(200);
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    const cookies = Array.isArray(response.headers['set-cookie'])
      ? response.headers['set-cookie']
      : response.headers['set-cookie'] === undefined
        ? []
        : [response.headers['set-cookie']];
    return { cookies, accessToken: accessTokenFromCookies(cookies) };
  };

  beforeAll(async () => {
    const databaseUrl = assertSafeTestDatabase();
    sql = postgres(databaseUrl, { max: 8 });
    db = drizzle(sql, { schema });

    hostInfo = jest.fn().mockResolvedValue({ totalRamMb: 4096, cpuCount: 8 });
    diskInfo = jest.fn().mockResolvedValue({ totalDiskMb: 100000, freeDiskMb: 50000 });
    freeMemory = jest.fn().mockReturnValue(2048);
    const docker = {
      ping: jest.fn().mockResolvedValue(true),
      getHostInfo: hostInfo,
      getHostDiskInfo: diskInfo,
      getHostFreeMemoryMb: freeMemory,
    };
    // SAFETY: The test-controlled value satisfies the concrete framework contract used by this assertion.
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        DbModule,
        SetupModule,
        UsersModule,
        AuthModule,
        DockerModule,
        GatewayModule,
      ],
    })
      .overrideProvider(DRIZZLE)
      // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
      .useValue(db as DrizzleDB)
      .overrideProvider(DockerService)
      .useValue(docker)
      .overrideProvider(DOCKERODE)
      .useValue({})
      .compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useWebSocketAdapter(
      new SocketIoAdapter(
        app.get(SocketReservationService),
        app.get(ConfigService),
        app.getHttpServer(),
      ),
    );
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address();
    if (!isAddressInfo(address)) {
      throw new Error('ephemeral listener did not expose a port');
    }
    port = address.port;
  });

  afterEach(async () => {
    const closing = clients.splice(0);
    await Promise.all(
      closing.map(
        (client) =>
          new Promise<void>((resolve) => {
            client.once('disconnect', () => resolve());
            client.close();
            // bounded fallback so a dead socket never hangs the suite
            setTimeout(resolve, 250);
          }),
      ),
    );
  });

  afterAll(async () => {
    for (const client of clients.splice(0)) client.close();
    await app.close();
    if (userIds.length > 0) await db.delete(schema.users).where(eq(schema.users.id, userIds[0]));
    for (const id of userIds.slice(1)) await db.delete(schema.users).where(eq(schema.users.id, id));
    await sql.end();
  });

  it('delivers exact stats to an admin using an access cookie and origin', async () => {
    const admin = await createUser('ADMIN');
    const client = io(`http://127.0.0.1:${port}`, {
      extraHeaders: { Origin: ORIGIN, Cookie: `access_token=${admin.accessToken}` },
      transports: ['polling', 'websocket'],
    });
    clients.push(client);
    const stats = waitForStats(client);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
    });
    const payload = await stats;
    expect(payload).toEqual({ totalRamMb: 4096, usedRamMb: 2048, freeDiskMb: 50000, cpuCount: 8 });
    expect(Object.keys(payload).sort()).toEqual([
      'cpuCount',
      'freeDiskMb',
      'totalRamMb',
      'usedRamMb',
    ]);
  });

  it('supports exactly one no-origin token fallback and shares one snapshot across two admins', async () => {
    const first = await createUser('ADMIN');
    const second = await createUser('ADMIN');
    hostInfo.mockClear();
    diskInfo.mockClear();
    freeMemory.mockClear();
    const fallback = io(`http://127.0.0.1:${port}`);
    clients.push(fallback);
    const firstStats = waitForStats(fallback);
    await new Promise<void>((resolve, reject) => {
      fallback.once('connect', resolve);
      fallback.once('connect_error', reject);
    });
    fallback.emit('auth', { accessToken: first.accessToken });
    await expect(firstStats).resolves.toEqual({
      totalRamMb: 4096,
      usedRamMb: 2048,
      freeDiskMb: 50000,
      cpuCount: 8,
    });

    const cookieClient = io(`http://127.0.0.1:${port}`, {
      extraHeaders: { Origin: ORIGIN, Cookie: `access_token=${second.accessToken}` },
    });
    clients.push(cookieClient);
    await new Promise<void>((resolve, reject) => {
      cookieClient.once('connect', resolve);
      cookieClient.once('connect_error', reject);
    });
    await expect(waitForStats(cookieClient)).resolves.toEqual({
      totalRamMb: 4096,
      usedRamMb: 2048,
      freeDiskMb: 50000,
      cpuCount: 8,
    });
    expect(hostInfo).toHaveBeenCalledTimes(1);
    expect(diskInfo).toHaveBeenCalledTimes(1);
    expect(freeMemory).toHaveBeenCalledTimes(1);
  });

  it.each(['http://evil.example', 'null'] as const)('rejects %s origin', async (origin) => {
    const admin = await createUser('ADMIN');
    const client = io(`http://127.0.0.1:${port}`, {
      extraHeaders: { Origin: origin, Cookie: `access_token=${admin.accessToken}` },
    });
    clients.push(client);
    await new Promise<void>((resolve) => {
      client.once('connect_error', () => resolve());
      client.once('connect', () => resolve());
    });
    expect(client.connected).toBe(false);
  });

  it('gives a non-admin no metrics', async () => {
    const user = await createUser('USER');
    const client = io(`http://127.0.0.1:${port}`, {
      extraHeaders: { Origin: ORIGIN, Cookie: `access_token=${user.accessToken}` },
    });
    clients.push(client);
    await new Promise<void>((resolve) => {
      client.once('disconnect', () => resolve());
      client.once('connect_error', () => resolve());
      client.once('connect', () => setTimeout(resolve, 100));
    });
    expect(client.connected).toBe(false);
  });
});
