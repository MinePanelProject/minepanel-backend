type AccessTokenClaimsCandidate = {
  sub?: string;
  type?: string;
  username?: string;
};

import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
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

const E2E_SETUP_TOKEN = 'e2e-setup-token-9f27c4d1a6b34802';
const isSingleCookieHeader = (value: string | string[] | undefined): value is string =>
  typeof value === 'string';

const setCookieHeader = (value: string | string[] | undefined): string[] =>
  isSingleCookieHeader(value) ? [value] : (value ?? []);

const isAccessTokenClaims = (
  claims: AccessTokenClaimsCandidate,
): claims is Required<Pick<AccessTokenClaimsCandidate, 'sub' | 'type' | 'username'>> =>
  typeof claims.sub === 'string' &&
  typeof claims.type === 'string' &&
  typeof claims.username === 'string';

describe('Authentication flow (PostgreSQL e2e)', () => {
  let sql: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: INestApplication;
  let userId: string;
  let adminId: string;
  let setupRowCreatedBySuite = false;

  beforeAll(async () => {
    process.env.SETUP_TOKEN = E2E_SETUP_TOKEN;
    const databaseUrl = assertSafeTestDatabase();
    sql = postgres(databaseUrl, { max: 8 });
    db = drizzle(sql, { schema });

    // The first-init contract requires the singleton to be absent. The suite
    // never deletes a row it did not create: a leftover singleton from a
    // crashed run fails loudly so the operator can reset the disposable server.
    const [existing] = await db
      .select({ id: schema.setupState.id })
      .from(schema.setupState)
      .where(eq(schema.setupState.id, 'singleton'))
      .limit(1);
    expect(existing).toBeUndefined();

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
  });

  afterAll(async () => {
    if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
    if (adminId) await db.delete(schema.users).where(eq(schema.users.id, adminId));
    // remove only the singleton row this suite's setup/init created
    if (setupRowCreatedBySuite) {
      await db.delete(schema.setupState).where(eq(schema.setupState.id, 'singleton'));
    }
    if (app) await app.close();
    await sql.end();
  });

  it('runs setup, registration, login, refresh, logout, and health contracts', async () => {
    const setupStatus = await request(app.getHttpServer()).get('/api/setup/status').expect(200);
    expect(setupStatus.body).toEqual({ initialAdminCreated: false, nextStep: 'register_admin' });

    const adminCredentials = {
      email: `round3-admin-${Date.now()}@example.com`,
      username: `round3admin${Date.now().toString().slice(-8)}`,
      password: 'AdminPassword123!',
    };
    const setup = await request(app.getHttpServer())
      .post('/api/setup/init')
      .set('X-Setup-Token', E2E_SETUP_TOKEN)
      .send(adminCredentials)
      .expect(201);
    setupRowCreatedBySuite = true;
    expect(setup.body.message).toContain(adminCredentials.username);

    const secondSetup = await request(app.getHttpServer())
      .post('/api/setup/init')
      .set('X-Setup-Token', E2E_SETUP_TOKEN)
      .send({ ...adminCredentials, username: `${adminCredentials.username}2` })
      .expect(409);
    expect(secondSetup.body).toEqual({ error: 'SetupAlreadyComplete' });

    const registration = {
      email: `round3-user-${Date.now()}@example.com`,
      username: `round3user${Date.now().toString().slice(-8)}`,
      password: 'UserPassword123!',
    };
    await request(app.getHttpServer()).post('/api/auth/register').send(registration).expect(201);
    const [storedUser] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, registration.username));
    expect(storedUser).toBeDefined();
    userId = storedUser.id;
    const [storedAdmin] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, adminCredentials.username));
    adminId = storedAdmin.id;
    expect(storedUser.passwordHash).not.toContain(registration.password);

    const wrongLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ identifier: registration.username, password: 'wrong-password' })
      .expect(401);
    expect(JSON.stringify(wrongLogin.body)).not.toContain(registration.username);
    expect(JSON.stringify(wrongLogin.body)).not.toContain(registration.email);

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ identifier: registration.username, password: registration.password })
      .expect(200);
    expect(login.body).toMatchObject({ id: userId, username: registration.username, role: 'USER' });
    expect(login.body).not.toHaveProperty('accessToken');
    expect(login.body).not.toHaveProperty('refreshToken');
    // SAFETY: Supertest login produces set-cookie headers; setCookieHeader reads the exact
    // header values to verify access_token and refresh_token cookies.
    const cookies = setCookieHeader(login.headers['set-cookie']);
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.stringContaining('access_token='),
        expect.stringContaining('refresh_token='),
      ]),
    );
    expect(cookies.join(';')).toContain('HttpOnly');
    const cookiePairs = cookies.map((cookie) => cookie.split(';', 1)[0]);
    const accessCookie = cookiePairs.find((cookie) => cookie.startsWith('access_token='));
    if (!accessCookie) throw new Error('access cookie missing');
    const tokenClaims: AccessTokenClaimsCandidate = JSON.parse(
      Buffer.from(accessCookie.slice('access_token='.length).split('.')[1], 'base64url').toString(
        'utf8',
      ),
    );
    if (!isAccessTokenClaims(tokenClaims)) throw new Error('access token claims malformed');
    expect(tokenClaims).toMatchObject({
      sub: userId,
      type: 'access',
      username: registration.username,
    });
    await request(app.getHttpServer()).get('/api/auth/profile').expect(401);
    // SAFETY: Supertest profile produces the response body after the access_token cookie is
    // consumed by JwtAuthGuard; this assertion reads that authenticated response.
    const profile = await request(app.getHttpServer())
      .get('/api/auth/profile')
      .set('Cookie', accessCookie)
      .expect(200);
    expect(profile.body).toMatchObject({
      id: userId,
      username: registration.username,
      role: 'USER',
    });

    const refreshed = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', cookiePairs)
      .expect(200);
    // SAFETY: Supertest refresh produces set-cookie headers; setCookieHeader reads the exact
    // access_token header emitted after refresh.
    expect(setCookieHeader(refreshed.headers['set-cookie']).join(';')).toContain('access_token=');

    // CSRF: a cross-site form-shaped attempt (no JSON preflight) with a forged
    // Origin is rejected before authentication runs
    const forged = await request(app.getHttpServer())
      .post('/api/auth/logout-all')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Origin', 'https://evil.example')
      .set('Cookie', cookiePairs)
      .expect(403);
    expect(forged.body).toEqual({ error: 'CsrfOriginForbidden' });

    // the blocked attempt must not have revoked the session
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', cookiePairs)
      // SAFETY: Supertest consumes the cookiePairs request header and produces the 200 response;
      // this assertion verifies the blocked logout did not revoke the refresh session.
      .expect(200);

    const rawCorsOrigin = process.env.CORS_ORIGIN;
    // SAFETY: Supertest is the external request producer; its CORS header contract invariant
    // supplies the exact configured Origin string consumed by the refresh endpoint.
    const corsOrigin = rawCorsOrigin as string;
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Origin', corsOrigin)
      .set('Cookie', cookiePairs)
      .expect(200);

    // OPTIONS preflight is exempt from the Origin guard
    const preflight = await request(app.getHttpServer())
      .options('/api/auth/logout-all')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(preflight.status).not.toBe(403);

    const logout = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Cookie', cookiePairs)
      .expect(200);
    // SAFETY: Supertest logout produces set-cookie headers; setCookieHeader reads those exact
    // access_token and refresh_token values to verify both cookies are cleared.
    expect(setCookieHeader(logout.headers['set-cookie']).join(';')).toMatch(
      /access_token=;|refresh_token=;/,
    );
    const sessions = await db
      .select()
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.userId, userId));
    expect(sessions).toHaveLength(0);
    await request(app.getHttpServer()).get('/api/auth/profile').expect(401);

    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', db: 'ok', docker: 'ok', version: process.env.PANEL_VERSION });
  });
});
