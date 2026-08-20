import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import type { MigrationDependencies } from './migrate';
import { runProductionMigrations } from './migrate';

type MockSql = jest.Mock & {
  end: jest.Mock;
};

type CreatedClient = {
  tag: 'lock' | 'migration';
  sql: MockSql;
};

type JournalEntryFixture = { tag: string } | null;
type SqlTemplateValue = string | number | boolean | null | undefined;
type PostgresOptions = {
  max?: number;
  idle_timeout?: number;
  max_lifetime?: number | null;
};

const mockPostgres = jest.fn();
const mockDrizzle = jest.fn();
const mockMigrate = jest.fn();

describe('runProductionMigrations', () => {
  const validUrl = 'postgresql://user:password@localhost:5432/minepanel';
  const realMigrationsFolder = path.resolve(process.cwd(), 'drizzle');

  let createdClients: CreatedClient[];
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let tempFolders: string[];

  const createMockSql = (): MockSql => {
    const query =
      /* SAFETY: jest.fn().mockResolvedValue is the MockSql producer; runProductionMigrations
      calls its query function and later reads the attached end member. */
      jest.fn().mockResolvedValue([]) as MockSql;
    query.end = jest.fn().mockResolvedValue(undefined);
    return query;
  };

  // SAFETY: mockPostgres is the postgres producer; runProductionMigrations consumes this
  // exact dependency member as its SQL client factory.
  const postgresDependency = mockPostgres as never;
  // SAFETY: mockDrizzle is the drizzle producer; runProductionMigrations consumes this exact
  // dependency member to wrap the lock client.
  const drizzleDependency = mockDrizzle as never;
  // SAFETY: mockMigrate is the migration producer; runProductionMigrations consumes this
  // exact dependency member to apply migrations.
  const migrateDependency = mockMigrate as never;
  const dependencies: MigrationDependencies = {
    postgres: postgresDependency,
    drizzle: drizzleDependency,
    migrate: migrateDependency,
  };

  const run = (databaseUrl = validUrl, migrationsFolder = realMigrationsFolder) =>
    runProductionMigrations(databaseUrl, migrationsFolder, dependencies);

  const createTempFolder = async (
    journalEntries: JournalEntryFixture[],
    sqlFiles: Record<string, string>,
  ): Promise<string> => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-spec-'));
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

  const lockClient = (): MockSql => createdClients.find((client) => client.tag === 'lock')!.sql;
  const migrationClient = (): MockSql =>
    createdClients.find((client) => client.tag === 'migration')!.sql;

  beforeEach(() => {
    jest.clearAllMocks();

    createdClients = [];
    tempFolders = [];

    logSpy = jest.spyOn(Logger, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);

    mockPostgres.mockImplementation((_url: string, _options?: PostgresOptions) => {
      const tag: 'lock' | 'migration' = createdClients.length === 0 ? 'lock' : 'migration';
      const sql = createMockSql();
      createdClients.push({ tag, sql });
      return sql;
    });

    mockDrizzle.mockReturnValue({});
    mockMigrate.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    logSpy.mockRestore();
    errorSpy.mockRestore();

    for (const folder of tempFolders) {
      await fs.rm(folder, { recursive: true, force: true });
    }
  });

  it('applies migrations using the default migrations folder', async () => {
    await run(validUrl);

    expect(mockMigrate).toHaveBeenCalledWith(expect.anything(), {
      migrationsFolder: realMigrationsFolder,
    });
  });

  it('acquires advisory lock 7333 before running migrations', async () => {
    await run(validUrl);

    const lock = lockClient();
    const firstCall = lock.mock.calls[0];
    expect(firstCall).toBeDefined();

    const rawValues = firstCall!.slice(1);
    // SAFETY: lockClient() is the database MockSql producer; its template contract invariant
    // supplies the SQL values after index zero consumed by this assertion.
    const values = rawValues as SqlTemplateValue[];
    expect(values).toContain(7333);

    const migrateCallOrder = mockMigrate.mock.invocationCallOrder[0];
    const lockCallOrder = lock.mock.invocationCallOrder[0];
    expect(migrateCallOrder).toBeGreaterThan(lockCallOrder);
  });

  it('releases the advisory lock and ends both clients on success', async () => {
    await run(validUrl);

    const lock = lockClient();
    const migration = migrationClient();

    const unlockCalls = lock.mock.calls.filter((call) => {
      const rawStrings = call[0];
      // SAFETY: lockClient() is the database MockSql producer; its TemplateStringsArray contract
      // invariant supplies the SQL text consumed to identify pg_advisory_unlock.
      const strings = rawStrings as TemplateStringsArray;
      return String(strings).includes('pg_advisory_unlock');
    });
    expect(unlockCalls.length).toBe(1);

    expect(lock.end).toHaveBeenCalledWith({ timeout: 5 });
    expect(migration.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it('releases the lock and ends clients when migration fails', async () => {
    mockMigrate.mockRejectedValue(new Error('syntax error at or near "BOOM"'));

    await expect(run(validUrl)).rejects.toThrow('Database migration failed');

    const lock = lockClient();
    const migration = migrationClient();

    expect(lock.end).toHaveBeenCalledWith({ timeout: 5 });
    expect(migration.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it('ends clients even when the advisory unlock itself fails', async () => {
    const lock = createMockSql();
    lock.mockImplementation((strings: TemplateStringsArray, ..._values: SqlTemplateValue[]) => {
      const text = String(strings);
      if (text.includes('pg_advisory_unlock')) {
        return Promise.reject(new Error('unlock failed'));
      }
      return Promise.resolve([]);
    });

    mockPostgres.mockReturnValue(lock);

    await run(validUrl);

    expect(lock.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it('rejects a blank database URL before opening any client', async () => {
    await expect(run('')).rejects.toThrow('Invalid database URL');
    expect(mockPostgres).not.toHaveBeenCalled();
  });

  it('rejects a non-postgres database URL before opening any client', async () => {
    await expect(run('mysql://user:password@localhost/db')).rejects.toThrow('Invalid database URL');
    expect(mockPostgres).not.toHaveBeenCalled();
  });

  it('rejects a missing migrations folder before opening any client', async () => {
    const missing = path.join(os.tmpdir(), 'does-not-exist-migrate-spec');

    await expect(run(validUrl, missing)).rejects.toThrow('Invalid migration folder');
    expect(mockPostgres).not.toHaveBeenCalled();
  });

  it('rejects a file path used as migrations folder', async () => {
    const file = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-spec-file-'));
    tempFolders.push(file);
    const nested = path.join(file, 'not-a-folder');
    await fs.writeFile(nested, 'content', 'utf8');

    await expect(run(validUrl, nested)).rejects.toThrow('Invalid migration folder');
    expect(mockPostgres).not.toHaveBeenCalled();
  });

  it('rejects a missing migration journal before opening any client', async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-spec-no-journal-'));
    tempFolders.push(folder);

    await expect(run(validUrl, folder)).rejects.toThrow('Missing migration journal');
    expect(mockPostgres).not.toHaveBeenCalled();
  });

  it('rejects an invalid migration journal before opening any client', async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-spec-bad-journal-'));
    tempFolders.push(folder);
    await fs.mkdir(path.join(folder, 'meta'));
    await fs.writeFile(path.join(folder, 'meta', '_journal.json'), 'not json', 'utf8');

    await expect(run(validUrl, folder)).rejects.toThrow('Invalid migration journal');
    expect(mockPostgres).not.toHaveBeenCalled();
  });

  it('rejects a JSON journal with a non-object root before opening any client', async () => {
    const folder = await createTempFolder([], {});
    await fs.writeFile(path.join(folder, 'meta', '_journal.json'), 'null', 'utf8');

    await expect(run(validUrl, folder)).rejects.toThrow('Invalid migration journal');
    expect(mockPostgres).not.toHaveBeenCalled();
  });

  it('rejects a null journal entry before opening any client', async () => {
    const folder = await createTempFolder([null], {});

    await expect(run(validUrl, folder)).rejects.toThrow('Invalid migration journal');
    expect(mockPostgres).not.toHaveBeenCalled();
  });

  it.each([
    '',
    '.',
    '..',
    '../outside',
    'nested/migration',
    '0000;drop',
    'nested\\migration',
    path.resolve(os.tmpdir(), 'outside'),
  ])('rejects unsafe journal tag %j before opening any client', async (tag) => {
    const folder = await createTempFolder([{ tag }], {});

    await expect(run(validUrl, folder)).rejects.toThrow('Invalid migration journal');
    expect(mockPostgres).not.toHaveBeenCalled();
  });

  it('rejects a journal entry with a missing SQL file before opening any client', async () => {
    const folder = await createTempFolder([{ tag: '0000_missing_migration' }], {});

    await expect(run(validUrl, folder)).rejects.toThrow('Missing migration file');
    expect(mockPostgres).not.toHaveBeenCalled();
  });

  it('sanitizes thrown messages and logs on migration failure', async () => {
    mockMigrate.mockRejectedValue(new Error('relation "users" already exists'));

    await expect(run(validUrl)).rejects.toThrow('Database migration failed');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('Database migration failed', 'Migrate');

    const thrownMessage = String(await run(validUrl).catch((error) => error));
    expect(thrownMessage).not.toContain(validUrl);
    expect(thrownMessage).not.toContain('postgres://');
  });

  it('logs only sanitized messages during a successful run', async () => {
    await run(validUrl);

    expect(logSpy).toHaveBeenCalledWith('Applying database migrations', 'Migrate');
    expect(logSpy).toHaveBeenCalledWith('Database migrations complete', 'Migrate');

    for (const call of logSpy.mock.calls) {
      const message = String(call[0]);
      expect(message).not.toContain(validUrl);
      expect(message).not.toContain('postgres://');
    }
  });
});
