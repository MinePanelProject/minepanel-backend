import crypto from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import cookieParser from 'cookie-parser';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DRIZZLE, type DrizzleDB } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { DOCKERODE } from '../src/docker/docker.constants';
import { DockerService } from '../src/docker/docker.service';
import { assertSafeTestDatabase } from './test-database';

const E2E_SETUP_TOKEN = 'e2e-setup-token-rotation';
const isSingleCookieHeader = (value: string | string[] | undefined): value is string =>
  typeof value === 'string';

const setCookieHeader = (value: string | string[] | undefined): string[] =>
  isSingleCookieHeader(value) ? [value] : (value ?? []);

describe('Refresh rotation (PostgreSQL e2e)', () => {
  let sql: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: INestApplication;
  let userId: string;
  let identifier: string;

  beforeAll(async () => {
    process.env.SETUP_TOKEN = E2E_SETUP_TOKEN;
    const databaseUrl = assertSafeTestDatabase();
    sql = postgres(databaseUrl, { max: 8 });
    db = drizzle(sql, { schema });

    // SAFETY: drizzle(sql, { schema }) is the database producer; the NestJS DRIZZLE contract
    // invariant is the exact DrizzleDB query/schema surface consumed by useValue.
    const database = db as DrizzleDB;
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DRIZZLE)
      .useValue(database)
      .overrideProvider(DockerService)
      .useValue({ ping: jest.fn().mockResolvedValue(true) })
      .overrideProvider(DOCKERODE)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['/health'] });
    app.use(cookieParser());
    await app.init();

    const id = crypto.randomUUID();
    const username = `rotation${id.slice(0, 12)}`;
    const [user] = await db
      .insert(schema.users)
      .values({
        id,
        email: `rotation-${id.slice(0, 12)}@example.com`,
        username,
        passwordHash: await bcrypt.hash('UserPassword123!', 4),
        role: 'USER',
        status: 'ACTIVE',
      })
      .returning();
    userId = user.id;
    identifier = username;
  });

  afterAll(async () => {
    if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
    if (app) await app.close();
    await sql.end();
  });

  const loginRefreshCookie = async (): Promise<string> => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ identifier, password: 'UserPassword123!' })
      .expect(200);
    const refreshCookie = setCookieHeader(login.headers['set-cookie']).find((cookie) =>
      cookie.startsWith('refresh_token='),
    );
    if (!refreshCookie) throw new Error('refresh cookie missing after login');
    return refreshCookie;
  };

  it('admits exactly one winner when the same refresh cookie is used concurrently', async () => {
    const refreshCookie = await loginRefreshCookie();

    const results = await Promise.allSettled([
      request(app.getHttpServer()).post('/api/auth/refresh').set('Cookie', refreshCookie),
      request(app.getHttpServer()).post('/api/auth/refresh').set('Cookie', refreshCookie),
    ]);

    const statuses = results.map((result) =>
      result.status === 'fulfilled' ? result.value.status : -1,
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);

    const loser = results.find(
      (result) => result.status === 'fulfilled' && result.value.status !== 200,
    );
    const loserResponse = loser?.status === 'fulfilled' ? loser.value : undefined;
    expect(loserResponse?.status).toBe(401);
    // the losing request may see the consumed row disappear before its delete
    // (RefreshTokenExpired) or find the delete already applied (RefreshTokenInvalid)
    expect(['RefreshTokenExpired', 'RefreshTokenInvalid']).toContain(loserResponse?.body?.error);

    // only the winning successor row exists; the loser minted nothing
    const rows = await db
      .select()
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.userId, userId));
    expect(rows).toHaveLength(1);
    const rowBeforeRotation = rows[0];

    const winner = results.find(
      (result) => result.status === 'fulfilled' && result.value.status === 200,
    );
    const winnerResponse = winner?.status === 'fulfilled' ? winner.value : undefined;
    const winnerRefreshCookie = setCookieHeader(winnerResponse?.headers['set-cookie']).find(
      (cookie) => cookie.startsWith('refresh_token='),
    );
    if (!winnerRefreshCookie) throw new Error('winner successor cookie missing');

    // the successor is the valid session: it rotates again into a new row
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', winnerRefreshCookie)
      .expect(200);
    const rotatedRows = await db
      .select()
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.userId, userId));
    expect(rotatedRows).toHaveLength(1);
    expect(rotatedRows[0].id).not.toBe(rowBeforeRotation.id);
  });

  it('rejects sequential replay of an already rotated refresh cookie', async () => {
    const refreshCookie = await loginRefreshCookie();

    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookie)
      .expect(200);

    const replay = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookie)
      .expect(401);
    expect(replay.body).toEqual({ error: 'RefreshTokenExpired' });
  });
});
