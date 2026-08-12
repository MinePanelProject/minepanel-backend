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

  const copyTwoMigrationFolder = async (): Promise<string> => {
    const journal = await readJournal();
    const entries = journal.entries.slice(0, 2);
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

    await expect(journalRowCount(databaseUrl)).resolves.toBe(3);
    await expect(serversTableExists(databaseUrl)).resolves.toBe(true);
    await expect(hasCreatingStatus(databaseUrl)).resolves.toBe(true);
  });

  it('is a no-op when rerun against an already migrated database', async () => {
    const databaseUrl = await createBlankDatabase('rerun');

    await runProductionMigrations(databaseUrl, realMigrationsFolder);
    await runProductionMigrations(databaseUrl, realMigrationsFolder);

    await expect(journalRowCount(databaseUrl)).resolves.toBe(3);
    await expect(hasCreatingStatus(databaseUrl)).resolves.toBe(true);
  });

  it('serializes concurrent migrations on a blank database', async () => {
    const databaseUrl = await createBlankDatabase('concurrent');

    await Promise.all([
      runProductionMigrations(databaseUrl, realMigrationsFolder),
      runProductionMigrations(databaseUrl, realMigrationsFolder),
    ]);

    await expect(journalRowCount(databaseUrl)).resolves.toBe(3);
    await expect(hasCreatingStatus(databaseUrl)).resolves.toBe(true);
  });

  it('applies only missing migrations on an upgraded database', async () => {
    const databaseUrl = await createBlankDatabase('upgrade');
    const twoMigrationFolder = await copyTwoMigrationFolder();

    await runProductionMigrations(databaseUrl, twoMigrationFolder);
    await expect(journalRowCount(databaseUrl)).resolves.toBe(2);
    await expect(hasCreatingStatus(databaseUrl)).resolves.toBe(false);

    await runProductionMigrations(databaseUrl, realMigrationsFolder);
    await expect(journalRowCount(databaseUrl)).resolves.toBe(3);
    await expect(hasCreatingStatus(databaseUrl)).resolves.toBe(true);
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
