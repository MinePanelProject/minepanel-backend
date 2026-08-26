import crypto from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import cookieParser from 'cookie-parser';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashRefreshTokenId } from '../src/auth/refresh-token-id';
import { DRIZZLE, type DrizzleDB } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { DOCKERODE } from '../src/docker/docker.constants';
import { DockerService } from '../src/docker/docker.service';
import { assertSafeTestDatabase } from './test-database';

const E2E_SETUP_TOKEN = 'e2e-setup-token-session-hygiene';
const isSingleCookieHeader = (value: string | string[] | undefined): value is string =>
  typeof value === 'string';

const setCookieHeader = (value: string | string[] | undefined): string[] =>
  isSingleCookieHeader(value) ? [value] : (value ?? []);

describe('Session hygiene (PostgreSQL e2e)', () => {
  let sql: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: INestApplication;
  let userId: string;
  let identifier: string;
  let expiredRowId: string | undefined;

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
    const username = `hygiene${id.slice(0, 12)}`;
    const [user] = await db
      .insert(schema.users)
      .values({
        id,
        email: `hygiene-${id.slice(0, 12)}@example.com`,
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

  const loginCookie = async (prefix: string): Promise<string> => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ identifier, password: 'UserPassword123!' })
      .expect(200);
    const cookie = setCookieHeader(login.headers['set-cookie']).find((entry) =>
      entry.startsWith(`${prefix}=`),
    );
    if (!cookie) throw new Error(`${prefix} cookie missing after login`);
    return cookie;
  };

  it('rejects refresh without a cookie as RefreshTokenMissing', async () => {
    const missing = await request(app.getHttpServer()).post('/api/auth/refresh').expect(401);
    expect(missing.body).toEqual({ error: 'RefreshTokenMissing' });
  });

  it('rejects a refresh token whose database row has expired', async () => {
    const jwtService = app.get(JwtService);
    const jti = crypto.randomBytes(32).toString('base64url');
    const refreshToken = await jwtService.signAsync(
      {
        sub: userId,
        type: 'refresh',
        jti,
      },
      { expiresIn: '1m' },
    );
    const [expiredRow] = await db
      .insert(schema.refreshTokens)
      .values({
        tokenIdHash: hashRefreshTokenId(jti),
        userId,
        expiresAt: new Date(Date.now() - 1000),
      })
      .returning();
    expiredRowId = expiredRow.id;

    const response = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', `refresh_token=${refreshToken}`)
      .expect(401);
    expect(response.body).toEqual({ error: 'RefreshTokenExpired' });
  });

  it('rejects a refresh token whose JWT exp has passed', async () => {
    const jwtService = app.get(JwtService);
    const expiredToken = await jwtService.signAsync(
      {
        sub: userId,
        type: 'refresh',
        jti: crypto.randomBytes(32).toString('base64url'),
      },
      { expiresIn: '1ms' },
    );
    // let the single-millisecond expiry elapse before the request reaches verifyAsync
    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', `refresh_token=${expiredToken}`)
      .expect(401);
    expect(response.body).toEqual({ error: 'RefreshTokenExpired' });
  });

  it('lists only non-expired sessions and never exposes the token hash', async () => {
    const accessCookie = await loginCookie('access_token');
    const [anotherExpiredRow] = await db
      .insert(schema.refreshTokens)
      .values({
        tokenIdHash: `expired-${crypto.randomUUID()}`,
        userId,
        expiresAt: new Date(Date.now() - 60_000),
      })
      .returning();

    const stored = await db
      .select()
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.userId, userId));
    // one live login row plus two expired rows must be in the database
    expect(stored).toHaveLength(3);

    const response = await request(app.getHttpServer())
      .get('/api/auth/sessions')
      .set('Cookie', accessCookie)
      .expect(200);
    expect(response.body).toHaveLength(1);
    const sessionIds = response.body.map((session: { id: string }) => session.id);
    expect(sessionIds).not.toContain(expiredRowId);
    expect(sessionIds).not.toContain(anotherExpiredRow.id);
    expect(response.body[0]).not.toHaveProperty('tokenIdHash');
  });
});
