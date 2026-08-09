import crypto from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { and, count, eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { AdminService } from '../src/admin/admin.service';
import type { DrizzleDB } from '../src/db/db.module';
import * as schema from '../src/db/schema';

// Requires a live PostgreSQL 16 with the drizzle migrations applied
// (bun run db:migrate) and an explicitly isolated TEST_DATABASE_URL pointing
// at it: this suite truncates shared tables before every test, so it must
// never run against the ambient DATABASE_URL. Not part of CI.
describe('AdminService last-admin protection (PostgreSQL integration)', () => {
  let sql: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let service: AdminService;

  beforeAll(async () => {
    const connectionString = process.env.TEST_DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'TEST_DATABASE_URL is required to run the destructive integration suite; ' +
          'it must point at an isolated test database, not DATABASE_URL',
      );
    }
    if (process.env.NODE_ENV === 'production') {
      throw new Error('refusing to run the destructive integration suite against production');
    }

    sql = postgres(connectionString, { max: 10 });
    db = drizzle(sql, { schema });
    service = new AdminService(db as unknown as DrizzleDB);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql`TRUNCATE refresh_tokens, users CASCADE`;
  });

  const createUser = async (overrides: Partial<schema.NewUser> = {}): Promise<schema.User> => {
    const suffix = crypto.randomBytes(4).toString('hex');
    const [user] = await db
      .insert(schema.users)
      .values({
        email: `user-${suffix}@example.com`,
        username: `user-${suffix}`,
        passwordHash: 'hashed-password',
        role: 'USER',
        status: 'ACTIVE',
        ...overrides,
      })
      .returning();
    return user;
  };

  const countActiveAdmins = async (): Promise<number> => {
    const [row] = await db
      .select({ activeAdmins: count() })
      .from(schema.users)
      .where(and(eq(schema.users.role, 'ADMIN'), eq(schema.users.status, 'ACTIVE')));
    return Number(row.activeAdmins);
  };

  it('rejects exactly one of two concurrent bans of the final active admins', async () => {
    const adminA = await createUser({ role: 'ADMIN', status: 'ACTIVE' });
    const adminB = await createUser({ role: 'ADMIN', status: 'ACTIVE' });

    const results = await Promise.allSettled([
      service.updateStatus(adminA.id, 'BANNED'),
      service.updateStatus(adminB.id, 'BANNED'),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect(await countActiveAdmins()).toBe(1);
  });

  it('keeps at least one active admin under heavy concurrent demotions and bans', async () => {
    const adminA = await createUser({ role: 'ADMIN', status: 'ACTIVE' });
    const adminB = await createUser({ role: 'ADMIN', status: 'ACTIVE' });
    await createUser({ role: 'MOD', status: 'ACTIVE' });

    const operations: Promise<unknown>[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      operations.push(service.updateStatus(adminA.id, attempt % 2 ? 'BANNED' : 'PENDING'));
      operations.push(service.updateRole(adminA.id, attempt % 2 ? 'USER' : 'MOD'));
      operations.push(service.updateStatus(adminB.id, attempt % 2 ? 'BANNED' : 'PENDING'));
      operations.push(service.updateRole(adminB.id, attempt % 2 ? 'USER' : 'MOD'));
    }

    const results = await Promise.allSettled(operations);

    expect(await countActiveAdmins()).toBeGreaterThanOrEqual(1);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(
      results.some(
        (result) => result.status === 'rejected' && result.reason instanceof ConflictException,
      ),
    ).toBe(true);
  });

  it('revokes all refresh sessions of a banned user', async () => {
    const admin = await createUser({ role: 'ADMIN', status: 'ACTIVE' });
    const victim = await createUser({ role: 'MOD', status: 'ACTIVE' });

    await db.insert(schema.refreshTokens).values([
      { token: 'hash-1', userId: victim.id, expiresAt: new Date(Date.now() + 60_000) },
      { token: 'hash-2', userId: victim.id, expiresAt: new Date(Date.now() + 60_000) },
    ]);
    await db.insert(schema.refreshTokens).values({
      token: 'hash-admin',
      userId: admin.id,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await service.updateStatus(victim.id, 'BANNED');

    const [remaining] = await db
      .select({ count: count() })
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.userId, victim.id));

    expect(Number(remaining.count)).toBe(0);

    const [adminSessions] = await db
      .select({ count: count() })
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.userId, admin.id));

    expect(Number(adminSessions.count)).toBe(1);
  });
});
