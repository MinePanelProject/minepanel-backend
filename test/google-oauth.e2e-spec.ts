import { createHash } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { eq, inArray } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  GOOGLE_ID_TOKEN_VERIFIER,
  type GoogleIdTokenVerifier,
} from '../src/auth/google-token.service';
import { DRIZZLE, type DrizzleDB } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { DOCKERODE } from '../src/docker/docker.constants';
import { DockerService } from '../src/docker/docker.service';
import { assertSafeTestDatabase } from './test-database';

type GoogleClaims = {
  sub: string;
  email: string;
  nonce: string;
  name?: string;
};

const challengeHash = (challenge: string): string =>
  createHash('sha256').update(challenge).digest('hex');

const claimCredential = (claims: GoogleClaims): string => JSON.stringify(claims);

// SAFETY: supertest set-cookie arrives as string | string[] | undefined; the
// Array.isArray narrowing parses that transport shape at the boundary before
// each cookie pair is split on its first ';'.
const rawCookiePairs = (header: string[] | string | undefined): string[] => {
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header];
  return values.map((value) => value.split(';', 1)[0]);
};

describe('Google OAuth (PostgreSQL e2e)', () => {
  let sql: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: INestApplication;
  let requestOrdinal = 0;
  const userIds: string[] = [];
  const challenges: string[] = [];
  const previousGoogleClientId = process.env.GOOGLE_CLIENT_ID;

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_ID = 'google-e2e.apps.googleusercontent.com';
    sql = postgres(assertSafeTestDatabase(), { max: 8 });
    db = drizzle(sql, { schema });
    const verifier: GoogleIdTokenVerifier = {
      verifyIdToken: async ({ idToken, audience }) => {
        if (audience !== process.env.GOOGLE_CLIENT_ID) {
          throw new Error('Wrong recipient');
        }
        // SAFETY: the fake verifier parses the JSON credential string this suite
        // produced; JSON.parse's unknown is narrowed to the fixture's GoogleClaims
        // shape at this producer boundary.
        const claims = JSON.parse(idToken) as GoogleClaims;
        const now = Math.floor(Date.now() / 1000);
        return {
          getPayload: () => ({
            iss: 'https://accounts.google.com',
            sub: claims.sub,
            email: claims.email,
            email_verified: true,
            nonce: claims.nonce,
            name: claims.name,
            iat: now,
            exp: now + 60,
          }),
        };
      },
    };

    // SAFETY: drizzle(sql, { schema }) is the database producer; the cast
    // satisfies the DrizzleDB contract with the exact live-pg surface used by
    // the NestJS DRIZZLE provider in this e2e harness.
    const drizzleDb = db as DrizzleDB;
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DRIZZLE)
      .useValue(drizzleDb)
      .overrideProvider(DockerService)
      .useValue({ ping: jest.fn().mockResolvedValue(true) })
      .overrideProvider(DOCKERODE)
      .useValue({})
      .overrideProvider(GOOGLE_ID_TOKEN_VERIFIER)
      .useValue(verifier)
      .compile();

    app = moduleFixture.createNestApplication();
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    app.setGlobalPrefix('api', { exclude: ['/health'] });
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    if (challenges.length > 0) {
      await db
        .delete(schema.oauthChallenges)
        .where(inArray(schema.oauthChallenges.challengeHash, challenges.map(challengeHash)));
    }
    if (userIds.length > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    }
    if (app) await app.close();
    await sql.end();
    if (previousGoogleClientId === undefined) {
      delete process.env.GOOGLE_CLIENT_ID;
    } else {
      process.env.GOOGLE_CLIENT_ID = previousGoogleClientId;
    }
  });

  const createChallenge = async (): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/oauth/challenge')
      .set('X-Forwarded-For', `198.51.100.${(requestOrdinal % 250) + 1}`)
      .send({ provider: 'google' })
      .expect(200);
    expect(response.body.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    challenges.push(response.body.challenge);
    requestOrdinal += 1;
    return response.body.challenge;
  };

  const registerPasswordUser = async (email: string, username: string): Promise<void> => {
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, username, password: 'Password123!' })
      .expect(201);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    userIds.push(user.id);
  };

  it('validates challenge provider input and returns a raw Google challenge once', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/oauth/challenge')
      .send({ provider: 'github' })
      .expect(400);

    await createChallenge();
  });

  it('runs Google login through normal session, profile, refresh, and logout paths', async () => {
    const challenge = await createChallenge();
    const login = await request(app.getHttpServer())
      .post('/api/auth/oauth/google/login')
      .send({
        credential: claimCredential({
          sub: `google-provider-${Date.now()}`,
          email: `phase-f-provider-${Date.now()}@example.com`,
          nonce: challenge,
          name: 'Provider Player',
        }),
      })
      .expect(200);
    userIds.push(login.body.id);
    expect(login.body).toMatchObject({ googleId: expect.stringMatching(/^google-provider-/) });
    expect(login.body).not.toHaveProperty('accessToken');
    const cookies = rawCookiePairs(login.headers['set-cookie']);
    const accessCookie = cookies.find((value) => value.startsWith('access_token='));
    const refreshCookie = cookies.find((value) => value.startsWith('refresh_token='));
    expect(accessCookie).toBeDefined();
    expect(refreshCookie).toBeDefined();
    if (!accessCookie || !refreshCookie)
      throw new Error('Google login did not issue normal session cookies');

    await request(app.getHttpServer())
      .get('/api/auth/profile')
      .set('Cookie', accessCookie)
      .expect(200);
    const refreshed = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookie)
      .expect(200);
    const refreshedCookies = rawCookiePairs(refreshed.headers['set-cookie']);
    const nextAccess = refreshedCookies.find((value) => value.startsWith('access_token='));
    const nextRefresh = refreshedCookies.find((value) => value.startsWith('refresh_token='));
    if (!nextAccess || !nextRefresh)
      throw new Error('Refresh did not rotate normal session cookies');
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Cookie', [nextAccess, nextRefresh])
      .expect(200);
  });

  it('rejects a wrong nonce without consuming the issued challenge', async () => {
    const challenge = await createChallenge();
    await request(app.getHttpServer())
      .post('/api/auth/oauth/google/login')
      .send({
        credential: claimCredential({
          sub: `google-wrong-nonce-${Date.now()}`,
          email: `phase-f-wrong-nonce-${Date.now()}@example.com`,
          nonce: 'B'.repeat(43),
        }),
      })
      .expect(401);

    const [stored] = await db
      .select({ id: schema.oauthChallenges.id })
      .from(schema.oauthChallenges)
      .where(eq(schema.oauthChallenges.challengeHash, challengeHash(challenge)));
    expect(stored).toBeDefined();
  });

  it('requires authenticated confirmation before linking an email-matched password account', async () => {
    const suffix = Date.now();
    const email = `phase-f-link-${suffix}@example.com`;
    const username = `phaseflink${suffix.toString().slice(-8)}`;
    await registerPasswordUser(email, username);
    const [passwordUser] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email));

    const challenge = await createChallenge();
    const providerId = `google-link-${suffix}`;
    const unlinked = await request(app.getHttpServer())
      .post('/api/auth/oauth/google/login')
      .send({ credential: claimCredential({ sub: providerId, email, nonce: challenge }) })
      .expect(200);
    expect(unlinked.body).toEqual({ status: 'LinkConfirmationRequired' });
    expect(unlinked.headers['set-cookie']).toBeUndefined();
    const [beforeLink] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, passwordUser.id));
    expect(beforeLink.googleId).toBeNull();

    const passwordLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ identifier: username, password: 'Password123!' })
      .expect(200);
    const accessCookie = rawCookiePairs(passwordLogin.headers['set-cookie']).find((value) =>
      value.startsWith('access_token='),
    );
    if (!accessCookie) throw new Error('Password login did not issue an access cookie');

    const linkChallenge = await createChallenge();
    await request(app.getHttpServer())
      .post('/api/auth/oauth/google/link')
      .set('Cookie', accessCookie)
      .send({ credential: claimCredential({ sub: providerId, email, nonce: linkChallenge }) })
      .expect(200);
    const [linked] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, passwordUser.id));
    expect(linked.googleId).toBe(providerId);

    const laterChallenge = await createChallenge();
    await request(app.getHttpServer())
      .post('/api/auth/oauth/google/login')
      .send({ credential: claimCredential({ sub: providerId, email, nonce: laterChallenge }) })
      .expect(200);
  });

  it('does not allow password login for provider-only accounts', async () => {
    const challenge = await createChallenge();
    const login = await request(app.getHttpServer())
      .post('/api/auth/oauth/google/login')
      .send({
        credential: claimCredential({
          sub: `google-only-${Date.now()}`,
          email: `phase-f-only-${Date.now()}@example.com`,
          nonce: challenge,
          name: 'Only Provider',
        }),
      })
      .expect(200);
    userIds.push(login.body.id);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ identifier: login.body.username, password: 'Password123!' })
      .expect(401);
  });

  it('allows exactly one concurrent authenticated account to claim a Google subject', async () => {
    const suffix = Date.now();
    const firstEmail = `phase-f-race-a-${suffix}@example.com`;
    const secondEmail = `phase-f-race-b-${suffix}@example.com`;
    const firstUsername = `phasefracea${suffix.toString().slice(-7)}`;
    const secondUsername = `phasefraceb${suffix.toString().slice(-7)}`;
    await registerPasswordUser(firstEmail, firstUsername);
    await registerPasswordUser(secondEmail, secondUsername);
    const [firstLogin, secondLogin] = await Promise.all(
      [firstUsername, secondUsername].map((identifier) =>
        request(app.getHttpServer())
          .post('/api/auth/login')
          .send({ identifier, password: 'Password123!' })
          .expect(200),
      ),
    );
    const [firstAccess, secondAccess] = [firstLogin, secondLogin].map((response) =>
      rawCookiePairs(response.headers['set-cookie']).find((value) =>
        value.startsWith('access_token='),
      ),
    );
    if (!firstAccess || !secondAccess)
      throw new Error('Race test password login did not issue cookies');
    const [firstChallenge, secondChallenge] = await Promise.all([
      createChallenge(),
      createChallenge(),
    ]);
    const providerId = `google-race-${suffix}`;
    const results = await Promise.all([
      request(app.getHttpServer())
        .post('/api/auth/oauth/google/link')
        .set('Cookie', firstAccess)
        .send({
          credential: claimCredential({
            sub: providerId,
            email: firstEmail,
            nonce: firstChallenge,
          }),
        }),
      request(app.getHttpServer())
        .post('/api/auth/oauth/google/link')
        .set('Cookie', secondAccess)
        .send({
          credential: claimCredential({
            sub: providerId,
            email: secondEmail,
            nonce: secondChallenge,
          }),
        }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const claimants = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.googleId, providerId));
    expect(claimants).toHaveLength(1);
  });
});
