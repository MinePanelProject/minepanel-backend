type AccessTokenClaimsCandidate = {
  sub?: string;
  type?: string;
  username?: string;
};

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
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

type RefreshTokenClaimsCandidate = {
  jti?: unknown;
};

describe('Authentication flow (PostgreSQL e2e)', () => {
  let sql: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: INestApplication;
  let userId: string;
  let adminId: string;
  let casingUserId: string | undefined;
  let providerOnlyUserId: string;
  let passwordChangeUserId: string | undefined;
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
    // production trust-proxy contract (src/main.ts): per-client throttling uses
    // X-Forwarded-For; the per-test XFF values in this suite split throttle
    // budgets instead of collapsing every request onto one shared IP
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    app.setGlobalPrefix('api', { exclude: ['/health'] });
    app.use(cookieParser());
    // production pipe contract (src/main.ts): whitelist + transform so DTO
    // canonicalization (D-10 username/email lowercase) applies over HTTP
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
    if (adminId) await db.delete(schema.users).where(eq(schema.users.id, adminId));
    if (casingUserId) await db.delete(schema.users).where(eq(schema.users.id, casingUserId));
    if (providerOnlyUserId) {
      await db.delete(schema.users).where(eq(schema.users.id, providerOnlyUserId));
    }
    if (passwordChangeUserId) {
      await db.delete(schema.users).where(eq(schema.users.id, passwordChangeUserId));
    }
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
    expect(storedUser.status).toBe('ACTIVE');

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

    // SPEC §8.3 replay contract: the refresh above rotated the session, so the
    // original cookie is consumed — reusing it must 401 instead of minting a
    // second successor. This also proves the blocked logout kept no row alive.
    const replay = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', cookiePairs)
      .expect(401);
    expect(replay.body).toEqual({ error: 'RefreshTokenExpired' });

    // SAFETY: Supertest refresh produces set-cookie headers; setCookieHeader reads the exact
    // refresh_token header emitted by the accepted rotation just before the replay.
    const rotatedRefreshCookie = setCookieHeader(refreshed.headers['set-cookie']).find((cookie) =>
      cookie.startsWith('refresh_token='),
    );
    if (!rotatedRefreshCookie) throw new Error('rotated refresh cookie missing');

    const rawCorsOrigin = process.env.CORS_ORIGIN;
    // SAFETY: Supertest is the external request producer; its CORS header contract invariant
    // supplies the exact configured Origin string consumed by the refresh endpoint.
    const corsOrigin = rawCorsOrigin as string;
    // the successor session survives the rejected replay and rotates again
    const corsRefreshed = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Origin', corsOrigin)
      .set('Cookie', rotatedRefreshCookie)
      .expect(200);

    // OPTIONS preflight is exempt from the Origin guard
    const preflight = await request(app.getHttpServer())
      .options('/api/auth/logout-all')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(preflight.status).not.toBe(403);

    const logout = await request(app.getHttpServer())
      .post('/api/auth/logout')
      // SAFETY: Supertest consumes the corsRefreshed cookie pair; the logout clears the
      // exact session the CORS refresh just emitted.
      .set('Cookie', setCookieHeader(corsRefreshed.headers['set-cookie']))
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

  it('keeps the current refresh session and revokes others on a normal password change', async () => {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
    const credentials = {
      email: `pwchange-${suffix}@example.com`,
      username: `pwchange${suffix}`.slice(0, 32),
      password: 'UserPassword123!',
    };
    await request(app.getHttpServer()).post('/api/auth/register').send(credentials).expect(201);
    const [registered] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, credentials.username));
    expect(registered).toBeDefined();
    passwordChangeUserId = registered.id;

    const decodeRefreshJti = (cookie: string): string => {
      const claims: RefreshTokenClaimsCandidate = JSON.parse(
        Buffer.from(cookie.slice('refresh_token='.length).split('.')[1], 'base64url').toString(
          'utf8',
        ),
      );
      if (typeof claims.jti !== 'string') throw new Error('refresh cookie jti missing');
      return claims.jti;
    };

    // SAFETY: login/refresh routes are throttled per client IP under trust
    // proxy; these requests carry distinct loopback XFF values so the added
    // password-retention scenario never crowds the suite's shared-IP budget.
    const firstLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('X-Forwarded-For', '198.51.100.101')
      .send({ identifier: credentials.username, password: credentials.password })
      .expect(200);
    const firstCookies = setCookieHeader(firstLogin.headers['set-cookie']).map(
      (cookie) => cookie.split(';', 1)[0],
    );
    const firstRefresh = firstCookies.find((cookie) => cookie.startsWith('refresh_token='));
    if (!firstRefresh) throw new Error('first refresh cookie missing');

    const secondLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('X-Forwarded-For', '198.51.100.102')
      .send({ identifier: credentials.username, password: credentials.password })
      .expect(200);
    const secondCookies = setCookieHeader(secondLogin.headers['set-cookie']).map(
      (cookie) => cookie.split(';', 1)[0],
    );

    const rowsBefore = await db
      .select()
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.userId, registered.id));
    expect(rowsBefore).toHaveLength(2);

    // normal password change while holding the first session: the current
    // session row must survive, every other session must be revoked
    await request(app.getHttpServer())
      .patch('/api/auth/password')
      .set('X-Forwarded-For', '198.51.100.103')
      .set('Cookie', firstCookies)
      .send({ oldPassword: credentials.password, newPassword: 'NewPassword456!' })
      .expect(200);

    const rowsAfter = await db
      .select()
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.userId, registered.id));
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0].tokenIdHash).toBe(hashRefreshTokenId(decodeRefreshJti(firstRefresh)));

    // the retained first session still rotates into a successor
    const rotated = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('X-Forwarded-For', '198.51.100.104')
      .set('Cookie', firstCookies)
      .expect(200);
    const rotatedCookies = setCookieHeader(rotated.headers['set-cookie']).map(
      (cookie) => cookie.split(';', 1)[0],
    );
    expect(rotatedCookies.join(';')).toContain('refresh_token=');

    // the rotated successor is the live session under the jti key: it rotates again
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('X-Forwarded-For', '198.51.100.105')
      .set('Cookie', rotatedCookies)
      .expect(200);

    // the revoked second session's cookie must fail with the replay machine code
    const revoked = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('X-Forwarded-For', '198.51.100.106')
      .set('Cookie', secondCookies)
      .expect(401);
    expect(revoked.body).toEqual({ error: 'RefreshTokenExpired' });
  });

  it('rejects password login for an active provider-only account', async () => {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
    const [providerOnlyUser] = await db
      .insert(schema.users)
      .values({
        email: `provider-only-${suffix}@example.com`,
        username: `provideronly${suffix}`.slice(0, 32),
        passwordHash: null,
        googleId: `google-${suffix}`,
        status: 'ACTIVE',
      })
      .returning({ id: schema.users.id });
    providerOnlyUserId = providerOnlyUser.id;

    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ identifier: `provideronly${suffix}`.slice(0, 32), password: 'Password123!' })
      .expect(401);

    expect(response.body).toEqual({
      error: 'Unauthorized',
      message: 'Wrong credentials',
      statusCode: 401,
    });
  });

  it('canonicalizes usernames to lowercase at registration and login (D-10)', async () => {
    const stamp = Date.now();
    const mixedCase = `CaseUser${stamp.toString().slice(-10)}`;
    const email = `case-${stamp}@example.com`;
    // SAFETY: login/register routes are throttled per client IP under trust
    // proxy; these requests carry a distinct loopback XFF value so the D-10
    // scenario never crowds the suite's shared-IP budget.
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .set('X-Forwarded-For', '198.51.100.110')
      .send({ email, username: mixedCase, password: 'UserPassword123!' })
      .expect(201);

    const [stored] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, mixedCase.toLowerCase()));
    expect(stored).toBeDefined();
    casingUserId = stored?.id;
    // canonical lowercase at write: `CaseUser…` persisted as `caseuser…`
    expect(stored.username).toBe(mixedCase.toLowerCase());

    // login lowercases the identifier: the original casing and an all-uppercase
    // variant both resolve to the canonical account
    for (const identifier of [mixedCase, mixedCase.toUpperCase()]) {
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('X-Forwarded-For', '198.51.100.111')
        .send({ identifier, password: 'UserPassword123!' })
        .expect(200);
      expect(login.body.username).toBe(mixedCase.toLowerCase());
    }

    // casing-only duplicate (`Bob` vs `bob`) is rejected: both canonicalize to
    // the same lowercase value, so the second registration collides
    const collision = await request(app.getHttpServer())
      .post('/api/auth/register')
      .set('X-Forwarded-For', '198.51.100.112')
      .send({
        email: `case-${stamp}-dup@example.com`,
        username: mixedCase.toUpperCase(),
        password: 'UserPassword123!',
      })
      .expect(409);
    expect(collision.body).toEqual({
      message: 'User already exists',
      error: 'Conflict',
      statusCode: 409,
    });
  });
});
