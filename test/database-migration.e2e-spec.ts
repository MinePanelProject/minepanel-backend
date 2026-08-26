import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { runProductionMigrations } from 'src/db/migrate';
import { assertSafeTestDatabase } from './test-database';

describe('Database migrations (PostgreSQL e2e)', () => {
  let adminSql: postgres.Sql;
  let testDatabaseUrl: string;
  let adminBaseUrl: string;
  let createdDatabaseNames: string[];
  let tempFolders: string[];
  let originalDatabaseUrl: string | undefined;

  const realMigrationsFolder = path.resolve(process.cwd(), 'drizzle');
  const sentinelDatabaseUrl = 'postgresql://unused:unused@127.0.0.1:1/ambient_sentinel';

  const makeDatabaseName = (label: string): string =>
    `minepanel_migration_${label}_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

  const createBlankDatabase = async (label: string): Promise<string> => {
    const name = makeDatabaseName(label);
    const escaped = name.replace(/"/g, '""');
    await adminSql.unsafe(`CREATE DATABASE "${escaped}"`);
    createdDatabaseNames.push(name);
    return `${adminBaseUrl}/${name}`;
  };

  const withDatabaseConnection = async <T>(
    databaseUrl: string,
    fn: (sql: postgres.Sql) => Promise<T>,
  ): Promise<T> => {
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      return await fn(sql);
    } finally {
      await sql.end();
    }
  };

  const journalRowCount = async (databaseUrl: string): Promise<number> =>
    withDatabaseConnection(databaseUrl, async (sql) => {
      const rows = await sql`SELECT count(*) AS count FROM drizzle.__drizzle_migrations`;
      return Number(rows[0].count);
    });

  const hasCreatingStatus = async (databaseUrl: string): Promise<boolean> =>
    withDatabaseConnection(databaseUrl, async (sql) => {
      const rows = await sql`
        SELECT 1 FROM pg_enum
        WHERE enumtypid = 'public.server_status'::regtype AND enumlabel = 'CREATING'
      `;
      return rows.length > 0;
    });

  const serversTableExists = async (databaseUrl: string): Promise<boolean> =>
    withDatabaseConnection(databaseUrl, async (sql) => {
      const rows = await sql`
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'servers'
      `;
      return rows.length > 0;
    });

  const readJournal = async (): Promise<{ entries: Array<{ tag: string }> }> => {
    const raw = await fs.readFile(path.join(realMigrationsFolder, 'meta', '_journal.json'), 'utf8');
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    return JSON.parse(raw) as { entries: Array<{ tag: string }> };
  };

  const createTempMigrationsFolder = async (
    journalEntries: Array<{ tag: string }>,
    sqlFiles: Record<string, string>,
  ): Promise<string> => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-e2e-'));
    tempFolders.push(folder);

    await fs.mkdir(path.join(folder, 'meta'));
    await fs.writeFile(
      path.join(folder, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'postgresql', entries: journalEntries }),
      'utf8',
    );

    for (const [name, content] of Object.entries(sqlFiles)) {
      await fs.writeFile(path.join(folder, name), content, 'utf8');
    }

    return folder;
  };

  const copyThreeMigrationFolder = async (): Promise<string> => {
    const journal = await readJournal();
    const entries = journal.entries.slice(0, 3);
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-e2e-upgrade-'));
    tempFolders.push(folder);

    await fs.mkdir(path.join(folder, 'meta'));
    await fs.writeFile(
      path.join(folder, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
      'utf8',
    );

    for (const entry of entries) {
      await fs.copyFile(
        path.join(realMigrationsFolder, `${entry.tag}.sql`),
        path.join(folder, `${entry.tag}.sql`),
      );
    }

    return folder;
  };

  const seedPrePhase15Server = async (databaseUrl: string): Promise<string> => {
    const serverId = crypto.randomUUID();
    await withDatabaseConnection(databaseUrl, async (sql) => {
      // explicit IDs are required; the repo uses crypto.randomUUID() as a
      // Drizzle runtime default, not a database default
      await sql`
        INSERT INTO servers (
          id, name, provider, version, port, status, max_players, difficulty,
          gamemode, pvp, memory_limit_mb, online_mode, view_distance, allow_flight,
          owner_id
        ) VALUES (
          ${serverId}, 'Legacy', 'PAPER', '1.21.1', 25565, 'STOPPED', 20, 'NORMAL',
          'SURVIVAL', true, 2048, true, 10, false,
          (SELECT id FROM users WHERE username = 'migration-admin' LIMIT 1)
        )
      `;
    });
    return serverId;
  };

  const seedMigrationAdmin = async (databaseUrl: string): Promise<void> => {
    await withDatabaseConnection(databaseUrl, async (sql) => {
      await sql`
        INSERT INTO users (
          id, email, username, password_hash, role, status
        ) VALUES (
          ${crypto.randomUUID()}, 'admin@example.com', 'migration-admin',
          'not-used', 'ADMIN', 'ACTIVE'
        )
      `;
    });
  };

  const readServerAccessType = async (
    databaseUrl: string,
    serverId: string,
  ): Promise<string | null> =>
    withDatabaseConnection(databaseUrl, async (sql) => {
      const rows = await sql`SELECT access_type FROM servers WHERE id = ${serverId}`;
      // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
      return (rows[0]?.access_type as string | undefined) ?? null;
    });

  const hasAccessTypeEnum = async (databaseUrl: string): Promise<boolean> =>
    withDatabaseConnection(databaseUrl, async (sql) => {
      // regtype casts throw on missing types; use the catalog directly so the
      // pre-0003 state can be asserted as false without erroring
      const rows = await sql`
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'access_type' AND t.typnamespace = 'public'::regnamespace
          AND e.enumlabel = 'PRIVATE'
      `;
      return rows.length > 0;
    });

  const hasServerAccessCheck = async (databaseUrl: string): Promise<boolean> =>
    withDatabaseConnection(databaseUrl, async (sql) => {
      const rows = await sql`
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'server_access'
          AND constraint_name = 'server_access_status_approved_at_total_check'
      `;
      return rows.length > 0;
    });

  const hasModPermissionPartialUnique = async (databaseUrl: string): Promise<boolean> =>
    withDatabaseConnection(databaseUrl, async (sql) => {
      const rows = await sql`
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'mod_permissions_user_permission_unique_idx'
      `;
      return rows.length > 0;
    });

  const countRefreshTokens = async (databaseUrl: string): Promise<number> =>
    withDatabaseConnection(databaseUrl, async (sql) => {
      const rows = await sql`SELECT count(*) AS count FROM refresh_tokens`;
      return Number(rows[0].count);
    });

  beforeAll(async () => {
    originalDatabaseUrl = process.env.DATABASE_URL;

    // Never mask a real ambient database: the suite must run with the sentinel
    // DATABASE_URL (or none). Fail loudly instead of silently proceeding.
    if (originalDatabaseUrl !== undefined && originalDatabaseUrl !== sentinelDatabaseUrl) {
      throw new Error(
        'Ambient DATABASE_URL is set to a non-sentinel value; run the migration e2e suite with the sentinel DATABASE_URL (or unset).',
      );
    }

    process.env.DATABASE_URL = sentinelDatabaseUrl;

    testDatabaseUrl = assertSafeTestDatabase();
    const base = new URL(testDatabaseUrl);
    adminBaseUrl = `${base.protocol}//${base.username}:${base.password}@${base.hostname}:${base.port}`;

    adminSql = postgres(testDatabaseUrl, { max: 1 });
    await adminSql`SELECT 1`;

    createdDatabaseNames = [];
    tempFolders = [];
  });

  afterAll(async () => {
    // safe even when beforeAll failed (adminSql/arrays may be unset); the
    // ambient DATABASE_URL restore always runs, even if cleanup rejects
    try {
      if (adminSql !== undefined) {
        for (const name of createdDatabaseNames ?? []) {
          const escaped = name.replace(/"/g, '""');
          try {
            await adminSql.unsafe(`DROP DATABASE IF EXISTS "${escaped}" WITH (FORCE)`);
          } catch {
            // cleanup best-effort
          }
        }

        await adminSql.end();
      }

      for (const folder of tempFolders ?? []) {
        await fs.rm(folder, { recursive: true, force: true });
      }
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }
  });

  it('applies the full migration chain to a fresh database', async () => {
    const databaseUrl = await createBlankDatabase('fresh');

    await runProductionMigrations(databaseUrl, realMigrationsFolder);

    await expect(journalRowCount(databaseUrl)).resolves.toBe(7);
    await expect(serversTableExists(databaseUrl)).resolves.toBe(true);
    await expect(hasCreatingStatus(databaseUrl)).resolves.toBe(true);
    await expect(hasAccessTypeEnum(databaseUrl)).resolves.toBe(true);
  });

  it('is a no-op when rerun against an already migrated database', async () => {
    const databaseUrl = await createBlankDatabase('rerun');

    await runProductionMigrations(databaseUrl, realMigrationsFolder);
    await runProductionMigrations(databaseUrl, realMigrationsFolder);

    await expect(journalRowCount(databaseUrl)).resolves.toBe(7);
    await expect(hasCreatingStatus(databaseUrl)).resolves.toBe(true);
  });

  it('serializes concurrent migrations on a blank database', async () => {
    const databaseUrl = await createBlankDatabase('concurrent');

    await Promise.all([
      runProductionMigrations(databaseUrl, realMigrationsFolder),
      runProductionMigrations(databaseUrl, realMigrationsFolder),
    ]);

    await expect(journalRowCount(databaseUrl)).resolves.toBe(7);
    await expect(hasCreatingStatus(databaseUrl)).resolves.toBe(true);
  });

  it('applies only missing migrations on an upgraded database and defaults accessType to OPEN', async () => {
    const databaseUrl = await createBlankDatabase('upgrade');
    const threeMigrationFolder = await copyThreeMigrationFolder();

    await runProductionMigrations(databaseUrl, threeMigrationFolder);
    await expect(journalRowCount(databaseUrl)).resolves.toBe(3);
    await expect(hasCreatingStatus(databaseUrl)).resolves.toBe(true);
    await expect(hasAccessTypeEnum(databaseUrl)).resolves.toBe(false);

    await seedMigrationAdmin(databaseUrl);
    const serverId = await seedPrePhase15Server(databaseUrl);
    // the pre-0004 schema stores bcrypt hashes of raw tokens; seed one legacy
    // row so the upgrade demonstrably clears it (documented re-login)
    await withDatabaseConnection(databaseUrl, async (sql) => {
      await sql`
        INSERT INTO refresh_tokens (id, token, user_id, expires_at)
        VALUES (
          ${crypto.randomUUID()}, 'legacy-bcrypt-token-hash',
          (SELECT id FROM users WHERE username = 'migration-admin' LIMIT 1),
          now() + interval '7 days'
        )
      `;
    });
    await expect(countRefreshTokens(databaseUrl)).resolves.toBe(1);

    await runProductionMigrations(databaseUrl, realMigrationsFolder);
    await expect(journalRowCount(databaseUrl)).resolves.toBe(7);
    await expect(readServerAccessType(databaseUrl, serverId)).resolves.toBe('OPEN');
    await expect(hasAccessTypeEnum(databaseUrl)).resolves.toBe(true);
    await expect(hasServerAccessCheck(databaseUrl)).resolves.toBe(true);
    await expect(hasModPermissionPartialUnique(databaseUrl)).resolves.toBe(true);
    // 0004 deletes every legacy row: the migrated database holds no sessions
    await expect(countRefreshTokens(databaseUrl)).resolves.toBe(0);
  });

  it('0005 fails loudly on username case-collisions instead of merging users (D-10)', async () => {
    const databaseUrl = await createBlankDatabase('collision');
    const threeMigrationFolder = await copyThreeMigrationFolder();

    await runProductionMigrations(databaseUrl, threeMigrationFolder);
    await seedMigrationAdmin(databaseUrl);
    // `Bob` and `bob` are distinct accounts under the case-sensitive pre-0005
    // schema; canonical lowercase would merge them, so the migration MUST stop.
    await withDatabaseConnection(databaseUrl, async (sql) => {
      await sql`
        INSERT INTO users (id, email, username, password_hash, role, status)
        VALUES
          (${crypto.randomUUID()}, 'bob@example.com', 'Bob', 'not-used', 'USER', 'ACTIVE'),
          (${crypto.randomUUID()}, 'bob2@example.com', 'bob', 'not-used', 'USER', 'ACTIVE')
      `;
    });

    // runProductionMigrations wraps any migration failure in a generic message
    // (same surface the corrupted-folder test asserts); the collision-specific
    // Postgres exception is logged, not rethrown. The invariant here is: the
    // chain FAILS, 0005 does not apply, and neither account is merged or lost.
    await expect(runProductionMigrations(databaseUrl, realMigrationsFolder)).rejects.toThrow(
      'Database migration failed',
    );
    // The migrator applies all pending migrations in one transaction, so the
    // 0005 failure rolled back 0003-0005: only the earlier three-migration run
    // (0000-0002) remains journaled, and no partial 0003-0005 state exists.
    await expect(journalRowCount(databaseUrl)).resolves.toBe(3);
    // Both accounts are untouched: no silent merge or data loss.
    const usernames = await withDatabaseConnection(databaseUrl, async (sql) => {
      const rows =
        await sql`SELECT username FROM users WHERE email IN ('bob@example.com', 'bob2@example.com')`;
      // SAFETY: username is a varchar column in the users schema; the seeded rows
      // were inserted with exact string literals, so their type is string.
      return rows.map((row) => row.username as string).sort();
    });
    expect(usernames).toEqual(['Bob', 'bob']);
  });

  it('rejects a corrupted migrations folder without writing partial journal rows', async () => {
    const databaseUrl = await createBlankDatabase('corrupted');
    const corruptedFolder = await createTempMigrationsFolder(
      [{ tag: '0000_corrupted_migration' }],
      { '0000_corrupted_migration.sql': 'THIS IS NOT VALID SQL;' },
    );

    await expect(runProductionMigrations(databaseUrl, corruptedFolder)).rejects.toThrow(
      'Database migration failed',
    );
    await expect(journalRowCount(databaseUrl)).resolves.toBe(0);
  });

  it('rejects a non-postgres URL before touching the database', async () => {
    await expect(
      runProductionMigrations(
        'mysql://user:password@localhost:5432/minepanel',
        realMigrationsFolder,
      ),
    ).rejects.toThrow('Invalid database URL');
  });
});
