import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const ADVISORY_LOCK_KEY = 7333;

const isTrimmedNonEmptyString = (value: string): value is string =>
  typeof value === 'string' && value.length > 0 && value === value.trim();

type JournalEntry = { tag: string };
type Journal = { entries: JournalEntry[] };

const isJournalTag = (tag: string): boolean =>
  isTrimmedNonEmptyString(tag) &&
  /^[A-Za-z0-9_-]+$/u.test(tag) &&
  !path.isAbsolute(tag) &&
  !tag.includes('/') &&
  !tag.includes('\\');

const isJournalEntry = (entry: unknown): entry is JournalEntry =>
  entry !== null &&
  typeof entry === 'object' &&
  !Array.isArray(entry) &&
  'tag' in entry &&
  typeof entry.tag === 'string' &&
  isJournalTag(entry.tag);

const isJournal = (value: unknown): value is Journal =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  'entries' in value &&
  Array.isArray(value.entries) &&
  value.entries.every(isJournalEntry);

export type MigrationDependencies = {
  postgres: typeof postgres;
  drizzle: typeof drizzle;
  migrate: typeof migrate;
};

const defaultDependencies: MigrationDependencies = { postgres, drizzle, migrate };

function validateDatabaseUrl(url: string): void {
  if (!isTrimmedNonEmptyString(url)) {
    throw new Error('Invalid database URL');
  }
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid database URL');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('Invalid database URL');
  }
}

async function validateMigrationsFolder(migrationsFolder: string): Promise<void> {
  let folderStat: Stats;

  try {
    folderStat = await fs.stat(migrationsFolder);
  } catch {
    throw new Error('Invalid migration folder');
  }

  if (!folderStat.isDirectory()) {
    throw new Error('Invalid migration folder');
  }

  const migrationRoot = path.resolve(migrationsFolder);
  const journalPath = path.join(migrationRoot, 'meta', '_journal.json');
  let journalRaw: string;

  try {
    journalRaw = await fs.readFile(journalPath, 'utf8');
  } catch {
    throw new Error('Missing migration journal');
  }

  let journal: unknown;

  try {
    journal = JSON.parse(journalRaw);
  } catch {
    throw new Error('Invalid migration journal');
  }

  if (!isJournal(journal)) {
    throw new Error('Invalid migration journal');
  }

  for (const entry of journal.entries) {
    const sqlPath = path.resolve(migrationRoot, `${entry.tag}.sql`);
    const relativePath = path.relative(migrationRoot, sqlPath);
    if (
      relativePath === '' ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error('Invalid migration journal');
    }

    try {
      await fs.access(sqlPath, fs.constants.F_OK);
    } catch {
      throw new Error('Missing migration file');
    }
  }
}

export async function runProductionMigrations(
  databaseUrl: string,
  migrationsFolder = path.resolve(process.cwd(), 'drizzle'),
  dependencies: MigrationDependencies = defaultDependencies,
): Promise<void> {
  validateDatabaseUrl(databaseUrl);
  await validateMigrationsFolder(migrationsFolder);

  Logger.log('Applying database migrations', 'Migrate');

  let lockClient: postgres.Sql | undefined;
  let migrationClient: postgres.Sql | undefined;

  try {
    lockClient = dependencies.postgres(databaseUrl, {
      max: 1,
      idle_timeout: 0,
      max_lifetime: null,
    });
    await lockClient`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`;

    try {
      migrationClient = dependencies.postgres(databaseUrl);
      const db = dependencies.drizzle(migrationClient);
      await dependencies.migrate(db, { migrationsFolder });
      Logger.log('Database migrations complete', 'Migrate');
    } finally {
      try {
        await lockClient`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
      } catch {
        // unlock failure is not recoverable; continue to close clients
      }
    }
  } catch {
    Logger.error('Database migration failed', 'Migrate');
    throw new Error('Database migration failed');
  } finally {
    if (lockClient !== undefined) {
      try {
        await lockClient.end({ timeout: 5 });
      } catch {
        // ignore close errors
      }
    }

    if (migrationClient !== undefined) {
      try {
        await migrationClient.end({ timeout: 5 });
      } catch {
        // ignore close errors
      }
    }
  }
}
