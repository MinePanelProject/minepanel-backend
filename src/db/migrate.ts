import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const ADVISORY_LOCK_KEY = 7333;

function validateDatabaseUrl(url: string): void {
  if (typeof url !== 'string' || url.length === 0 || url !== url.trim()) {
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

type JournalEntry = {
  tag: string;
};

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

  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  let journalRaw: string;

  try {
    journalRaw = await fs.readFile(journalPath, 'utf8');
  } catch {
    throw new Error('Missing migration journal');
  }

  let journal: { entries?: JournalEntry[] };

  try {
    journal = JSON.parse(journalRaw) as { entries?: JournalEntry[] };
  } catch {
    throw new Error('Invalid migration journal');
  }

  if (!Array.isArray(journal.entries)) {
    throw new Error('Invalid migration journal');
  }

  for (const entry of journal.entries) {
    if (typeof entry?.tag !== 'string') {
      throw new Error('Invalid migration journal');
    }

    const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);

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
): Promise<void> {
  validateDatabaseUrl(databaseUrl);
  await validateMigrationsFolder(migrationsFolder);

  Logger.log('Applying database migrations', 'Migrate');

  let lockClient: postgres.Sql | undefined;
  let migrationClient: postgres.Sql | undefined;

  try {
    lockClient = postgres(databaseUrl, {
      max: 1,
      idle_timeout: 0,
      max_lifetime: null,
    });
    await lockClient`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`;

    try {
      migrationClient = postgres(databaseUrl);
      const db = drizzle(migrationClient);
      await migrate(db, { migrationsFolder });
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
