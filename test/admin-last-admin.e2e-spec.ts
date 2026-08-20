import { randomBytes } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { and, count, eq, inArray } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { AdminService } from '../src/admin/admin.service';
import type { DrizzleDB } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { assertSafeTestDatabase } from './test-database';

// Requires a live PostgreSQL 16 with migrations applied to TEST_DATABASE_URL.
// Containment is fixture-ID only: this suite never truncates, never mutates
// rows it did not create, and never issues server-level DDL. The last-admin
// boundary tests additionally require that NO other ACTIVE ADMIN rows exist on
// the test server (they assert their population precondition and fail loudly
// with a reset hint otherwise — they never modify foreign rows).
describe('AdminService last-admin protection (PostgreSQL integration)', () => {
  let sql: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let service: AdminService;

  let trackedUserIds: string[];
  let baselineActiveAdmins: number;

  beforeAll(async () => {
    const connectionString = assertSafeTestDatabase();
    sql = postgres(connectionString, { max: 10 });
    db = drizzle(sql, { schema });
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    service = new AdminService(db as DrizzleDB);
    baselineActiveAdmins = await countActiveAdmins();
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(() => {
    trackedUserIds = [];
  });

  afterEach(async () => {
    if (trackedUserIds.length > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, trackedUserIds));
    }
  });

  const createUser = async (overrides: Partial<schema.NewUser> = {}): Promise<schema.User> => {
    const suffix = randomBytes(4).toString('hex');
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
    trackedUserIds.push(user.id);
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
    // The invariant boundary fires only when the suite's two admins are the
    // only active admins. This suite never mutates rows it did not create, so
    // a dirty test server (leftover ACTIVE ADMINs from crashed runs) makes the
    // boundary unverifiable — fail loudly instead of skipping coverage.
    expect(baselineActiveAdmins).toBe(0);
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
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect(await countActiveAdmins()).toBe(1);
  });

  it('keeps at least one active admin under heavy concurrent demotions and bans', async () => {
    expect(baselineActiveAdmins).toBe(0);
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
