import { boolean, integer, pgEnum, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';

// --- Enums ---

export const roleEnum = pgEnum('role', ['ADMIN', 'MOD', 'USER']);
export const serverProviderEnum = pgEnum('server_provider', [
  'VANILLA',
  'PAPER',
  'PURPUR',
  'FABRIC',
  'FORGE',
]);
export const serverStatusEnum = pgEnum('server_status', [
  'STOPPED',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'ERROR',
]);
export const DifficultyEnum = pgEnum('server_difficulty', ['PEACEFUL', 'EASY', 'NORMAL', 'HARD']);
export const GamemodeEnum = pgEnum('server_gamemode', [
  'SURVIVAL',
  'CREATIVE',
  'ADVENTURE',
  'SPECTATOR',
]);

export const userStatusEnum = pgEnum('user_status', ['ACTIVE', 'PENDING', 'BANNED']);

// --- Tables ---

export const users = pgTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: varchar('email', { length: 254 }).notNull().unique(),
  username: varchar('username', { length: 32 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: roleEnum('role').default('USER').notNull(),
  status: userStatusEnum('status').default('ACTIVE').notNull(),
  totpSecret: text('totp_secret'),
  totpEnabled: boolean('totp_enabled').default(false).notNull(),
  totpBackupCodes: text('totp_backup_codes'),
  tempPasswordHash: text('temp_password_hash'),
  tempPasswordExpiresAt: timestamp('temp_password_expires_at'),
  mustChangePassword: boolean('must_change_password').default(false).notNull(),
  minecraftUUID: text('minecraft_uuid').unique(),
  minecraftName: text('minecraft_name'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .notNull()
    .$onUpdateFn(() => new Date()),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  token: text('token').notNull().unique(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const setupState = pgTable('setup_state', {
  id: text('id').primaryKey().default('singleton'),
  initialAdminCreated: boolean('initial_admin_created').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .notNull()
    .$onUpdateFn(() => new Date()),
});

export const servers = pgTable('servers', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text('name').notNull(),
  provider: serverProviderEnum('provider').notNull(),
  version: text('version').notNull(),
  port: integer('port').notNull().unique(),
  containerId: text('container_id').unique(),
  status: serverStatusEnum('status').default('STOPPED').notNull(),
  maxPlayers: integer('max_players').default(20).notNull(),
  difficulty: DifficultyEnum('difficulty').default('NORMAL').notNull(),
  gamemode: GamemodeEnum('gamemode').default('SURVIVAL').notNull(),
  pvp: boolean('pvp').default(true).notNull(),
  memoryLimitMb: integer('memory_limit_mb').default(2048).notNull(),
  motd: text('motd'),
  levelSeed: text('level_seed'),
  onlineMode: boolean('online_mode').default(true).notNull(),
  viewDistance: integer('view_distance').default(10).notNull(),
  allowFlight: boolean('allow_flight').default(false).notNull(),
  worldPath: text('world_path'),
  rconPassword: text('rcon_password'),
  ownerId: text('owner_id')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .notNull()
    .$onUpdateFn(() => new Date()),
});

// --- Inferred types ---

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type Server = typeof servers.$inferSelect;
export type Role = (typeof roleEnum.enumValues)[number];
export type ServerProvider = (typeof serverProviderEnum.enumValues)[number];
export type ServerStatus = (typeof serverStatusEnum.enumValues)[number];
export type Difficulty = (typeof DifficultyEnum.enumValues)[number];
export type Gamemode = (typeof GamemodeEnum.enumValues)[number];
export type UserStatus = (typeof userStatusEnum.enumValues)[number];
