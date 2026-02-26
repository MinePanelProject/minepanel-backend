import { boolean, integer, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

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

// --- Tables ---

export const users = pgTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: text('email').notNull().unique(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: roleEnum('role').default('USER').notNull(),
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
  difficulty: text('difficulty').default('normal').notNull(),
  gamemode: text('gamemode').default('survival').notNull(),
  pvp: boolean('pvp').default(true).notNull(),
  worldPath: text('world_path'),
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
