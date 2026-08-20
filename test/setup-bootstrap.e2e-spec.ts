import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';
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

type Credentials = { email: string; username: string; password: string };

async function createApp(db: PostgresJsDatabase<typeof schema>): Promise<INestApplication> {
  // SAFETY: The test-controlled value satisfies the concrete framework contract used by this assertion.
  const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE)
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    .useValue(db as DrizzleDB)
    .overrideProvider(DockerService)
    .useValue({ ping: jest.fn().mockResolvedValue(true) })
    .overrideProvider(DOCKERODE)
    .useValue({})
    .compile();
  const app = moduleFixture.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['/health'] });
  await app.init();
  return app;
}

function credentials(label: string): Credentials {
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
  return {
    email: `${label}-${stamp}@example.com`,
    username: `${label}${stamp}`.slice(0, 32),
    password: 'AdminPassword123!',
  };
}

describe('Setup bootstrap (PostgreSQL e2e)', () => {
  let sql: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: INestApplication;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    process.env.SETUP_TOKEN = E2E_SETUP_TOKEN;
    const databaseUrl = assertSafeTestDatabase();
    sql = postgres(databaseUrl, { max: 8 });
    db = drizzle(sql, { schema });
    await db.delete(schema.setupState).where(eq(schema.setupState.id, 'singleton'));
    app = await createApp(db);
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds));
    }
    await db.delete(schema.setupState).where(eq(schema.setupState.id, 'singleton'));
    await app.close();
    await sql.end();
  });

  it('returns indistinguishable 401 responses for missing and wrong setup tokens', async () => {
    const body = credentials('missing');
    const missing = await request(app.getHttpServer())
      .post('/api/setup/init')
      .send(body)
      .expect(401);
    const wrong = await request(app.getHttpServer())
      .post('/api/setup/init')
      .set('X-Setup-Token', 'wrong-token')
      .send({ ...body, username: `${body.username}wrong` })
      .expect(401);
    expect(missing.body).toEqual({ error: 'SetupTokenInvalid' });
    expect(wrong.body).toEqual(missing.body);
  });

  it('rolls back the inserted admin when the setup flag update fails', async () => {
    const body = credentials('rollback');
    const triggerName = 'minepanel_setup_failure_trigger';
    const functionName = 'minepanel_setup_failure';
    let failureApp: INestApplication | undefined;

    try {
      await sql.unsafe(`
        CREATE OR REPLACE FUNCTION public.${functionName}()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RAISE EXCEPTION 'setup flag update injected failure';
        END;
        $$;
      `);
      await sql.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON setup_state`);
      await sql.unsafe(`
        CREATE TRIGGER ${triggerName}
        BEFORE UPDATE OF initial_admin_created ON setup_state
        FOR EACH ROW
        WHEN (NEW.id = 'singleton' AND NEW.initial_admin_created = true)
        EXECUTE FUNCTION public.${functionName}();
      `);

      failureApp = await createApp(db);
      await request(failureApp.getHttpServer())
        .post('/api/setup/init')
        .set('X-Setup-Token', E2E_SETUP_TOKEN)
        .send(body)
        .expect(500);

      const candidates = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, body.email));
      expect(candidates).toHaveLength(0);

      const [state] = await db
        .select()
        .from(schema.setupState)
        .where(eq(schema.setupState.id, 'singleton'));
      expect(state?.initialAdminCreated ?? false).toBe(false);
    } finally {
      if (failureApp !== undefined) await failureApp.close();
      await sql.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON setup_state`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS public.${functionName}()`);
      await db.delete(schema.users).where(eq(schema.users.email, body.email));
      await db.delete(schema.setupState).where(eq(schema.setupState.id, 'singleton'));
    }
  });

  it('allows exactly one admin under concurrent valid init requests', async () => {
    const first = credentials('racea');
    const second = credentials('raceb');
    const [responseA, responseB] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/setup/init')
        .set('X-Setup-Token', E2E_SETUP_TOKEN)
        .send(first),
      request(app.getHttpServer())
        .post('/api/setup/init')
        .set('X-Setup-Token', E2E_SETUP_TOKEN)
        .send(second),
    ]);
    expect([responseA.status, responseB.status].sort()).toEqual([201, 409]);
    const conflict = responseA.status === 409 ? responseA : responseB;
    expect(conflict.body).toEqual({ error: 'SetupAlreadyComplete' });

    const rows = await db
      .select()
      .from(schema.users)
      .where(inArray(schema.users.username, [first.username, second.username]));
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('ADMIN');
    expect(rows[0].status).toBe('ACTIVE');
    createdUserIds.push(rows[0].id);
    const [state] = await db
      .select()
      .from(schema.setupState)
      .where(eq(schema.setupState.id, 'singleton'));
    expect(state.initialAdminCreated).toBe(true);
  });
  it('returns 401 for missing and wrong tokens after a completed fallback-mode restart', async () => {
    const previousToken = process.env.SETUP_TOKEN;
    let coldBootApp: INestApplication | undefined;
    delete process.env.SETUP_TOKEN;

    try {
      coldBootApp = await createApp(db);
      const body = credentials('coldboot');
      const missing = await request(coldBootApp.getHttpServer())
        .post('/api/setup/init')
        .send(body)
        .expect(401);
      const wrong = await request(coldBootApp.getHttpServer())
        .post('/api/setup/init')
        .set('X-Setup-Token', 'wrong-token')
        .send({ ...body, username: `${body.username}wrong` })
        .expect(401);

      expect(missing.body).toEqual({ error: 'SetupTokenInvalid' });
      expect(wrong.body).toEqual(missing.body);
    } finally {
      if (coldBootApp !== undefined) await coldBootApp.close();
      if (previousToken === undefined) {
        delete process.env.SETUP_TOKEN;
      } else {
        process.env.SETUP_TOKEN = previousToken;
      }
    }
  });

  it('returns 409 for a valid token after setup completion', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/setup/init')
      .set('X-Setup-Token', E2E_SETUP_TOKEN)
      .send(credentials('after'))
      .expect(409);
    expect(response.body).toEqual({ error: 'SetupAlreadyComplete' });
  });
});

describe('Setup init throttling (PostgreSQL e2e)', () => {
  let sql: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: INestApplication;

  beforeAll(async () => {
    process.env.SETUP_TOKEN = E2E_SETUP_TOKEN;
    const databaseUrl = assertSafeTestDatabase();
    sql = postgres(databaseUrl, { max: 8 });
    db = drizzle(sql, { schema });
    await db.delete(schema.setupState).where(eq(schema.setupState.id, 'singleton'));
    app = await createApp(db);
  });

  afterAll(async () => {
    await db.delete(schema.setupState).where(eq(schema.setupState.id, 'singleton'));
    await app.close();
    await sql.end();
  });

  it('returns 429 on the sixth setup attempt from one client', async () => {
    const responses: Array<{ status: number }> = [];
    for (let index = 0; index < 6; index += 1) {
      responses.push(
        await request(app.getHttpServer())
          .post('/api/setup/init')
          .set('X-Setup-Token', 'wrong-token')
          .send(credentials(`throttle${index}`)),
      );
    }
    expect(responses.map((response) => response.status).sort()).toEqual([
      401, 401, 401, 401, 401, 429,
    ]);
  });
});
