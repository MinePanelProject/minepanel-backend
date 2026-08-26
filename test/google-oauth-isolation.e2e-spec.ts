import { createHash } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  GOOGLE_ID_TOKEN_VERIFIER,
  type GoogleIdTokenVerifier,
} from '../src/auth/google-token.service';
import { DRIZZLE, type DrizzleDB } from '../src/db/db.module';
import { runProductionMigrations } from '../src/db/migrate';
import * as schema from '../src/db/schema';
import { DOCKERODE } from '../src/docker/docker.constants';
import { DockerService } from '../src/docker/docker.service';
import { assertSafeTestDatabase } from './test-database';

type GoogleClaims = { sub: string; email: string; nonce: string };

const claimCredential = (claims: GoogleClaims): string => JSON.stringify(claims);

// SAFETY: both test backends trust the same Google client id (the confused-
// deputy premise: aud cannot distinguish them); the verifier therefore accepts
// any well-formed token with a matching audience exactly like a shared Google
// client would, and emits the claims that GoogleTokenService validates.
const makeVerifier = (clientId: string): GoogleIdTokenVerifier => ({
  verifyIdToken: async ({ idToken, audience }) => {
    if (audience !== clientId) {
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
        iat: now - 10,
        exp: now + 60,
      }),
    };
  },
});

describe('Google OAuth cross-backend isolation (PostgreSQL e2e)', () => {
  let adminSql: postgres.Sql;
  let sqlA: postgres.Sql;
  let sqlB: postgres.Sql;
  let dbA: PostgresJsDatabase<typeof schema>;
  let dbB: PostgresJsDatabase<typeof schema>;
  let appA: INestApplication;
  let appB: INestApplication;
  const clientId = 'shared-e2e.apps.googleusercontent.com';

  const createApp = async (
    database: PostgresJsDatabase<typeof schema>,
  ): Promise<INestApplication> => {
    // SAFETY: drizzle(sql, { schema }) is the database producer; the cast
    // satisfies the DrizzleDB contract with the exact live-pg surface used by
    // the NestJS DRIZZLE provider in this e2e harness.
    const drizzleDb = database as DrizzleDB;
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DRIZZLE)
      .useValue(drizzleDb)
      .overrideProvider(DockerService)
      .useValue({ ping: jest.fn().mockResolvedValue(true) })
      .overrideProvider(DOCKERODE)
      .useValue({})
      .overrideProvider(GOOGLE_ID_TOKEN_VERIFIER)
      .useValue(makeVerifier(clientId))
      .compile();

    const app = moduleFixture.createNestApplication();
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    app.setGlobalPrefix('api', { exclude: ['/health'] });
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    return app;
  };

  const requestChallenge = async (app: INestApplication): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/oauth/challenge')
      .set('X-Forwarded-For', `198.51.100.${(Date.now() % 250) + 1}`)
      .send({ provider: 'google' })
      .expect(200);
    // SAFETY: the challenge endpoint response body is the raw challenge string
    // produced by this harness; the cast narrows the JSON body to that exact
    // contract before it is returned.
    return response.body.challenge as string;
  };

  const googleLogin = (app: INestApplication, claims: GoogleClaims): request.Test =>
    request(app.getHttpServer())
      .post('/api/auth/oauth/google/login')
      .send({ credential: claimCredential(claims) });

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_ID = clientId;
    adminSql = postgres(assertSafeTestDatabase(), { max: 1 });

    await adminSql.unsafe('CREATE DATABASE "minepanel_isolation_b"');
    const databaseBUrl = new URL(assertSafeTestDatabase());
    databaseBUrl.pathname = '/minepanel_isolation_b';

    // SAFETY: the isolation instance is a real second database; running the
    // production chain against it mirrors how each self-hosted backend migrates.
    await runProductionMigrations(
      databaseBUrl.toString(),
      require('node:path').resolve(process.cwd(), 'drizzle'),
    );

    sqlA = postgres(assertSafeTestDatabase(), { max: 4 });
    sqlB = postgres(databaseBUrl.toString(), { max: 4 });
    dbA = drizzle(sqlA, { schema });
    dbB = drizzle(sqlB, { schema });

    appA = await createApp(dbA);
    appB = await createApp(dbB);
  });

  afterAll(async () => {
    if (appA) await appA.close();
    if (appB) await appB.close();
    if (sqlA) await sqlA.end();
    if (sqlB) await sqlB.end();
    try {
      await adminSql.unsafe('DROP DATABASE IF EXISTS "minepanel_isolation_b" WITH (FORCE)');
    } catch {
      // best-effort cleanup
    }
    await adminSql.end();
  });

  it('does not let a token minted against backend A authenticate to backend B', async () => {
    const aChallenge = await requestChallenge(appA);
    const sub = `shared-sub-${Date.now()}`;
    const email = `isolation-a-${Date.now()}@example.com`;

    // backend A accepts its own challenge-bound token
    const loginA = await googleLogin(appA, { sub, email, nonce: aChallenge }).expect(200);
    expect(loginA.headers['set-cookie']).toBeDefined();

    // a NEW Google token with the same sub/email and the SAME nonce backend A
    // issued (and consumed) is presented to backend B, which shares the Google
    // client: the challenge row lives only in A's table, so B rejects it
    const replayedToB = await googleLogin(appB, { sub, email, nonce: aChallenge }).expect(401);
    expect(replayedToB.body).toEqual({ error: 'InvalidGoogleChallenge' });
  });

  it('keeps each backend challenge table isolated (hash rows never cross backends)', async () => {
    const bChallenge = await requestChallenge(appB);
    const hash = createHash('sha256').update(bChallenge).digest('hex');

    // SAFETY: challengeHash is a text column in the oauth_challenges schema;
    // eq() against the computed digest is the exact producer contract.
    const [inA] = await dbA
      .select({ id: schema.oauthChallenges.id })
      .from(schema.oauthChallenges)
      .where(eq(schema.oauthChallenges.challengeHash, hash));
    const [inB] = await dbB
      .select({ id: schema.oauthChallenges.id })
      .from(schema.oauthChallenges)
      .where(eq(schema.oauthChallenges.challengeHash, hash));

    expect(inA).toBeUndefined();
    expect(inB).toBeDefined();
  });
});
