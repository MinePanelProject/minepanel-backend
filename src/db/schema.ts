import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

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
  'CREATING',
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
export const accessTypeEnum = pgEnum('access_type', ['OPEN', 'REQUEST', 'PRIVATE']);
export const serverAccessStatusEnum = pgEnum('server_access_status', ['PENDING', 'APPROVED']);
export const modPermissionEnum = pgEnum('mod_permission', [
  'SERVER_LIFECYCLE',
  'SERVER_CONFIG',
  'PLUGIN_MANAGEMENT',
  'WHITELIST_MANAGEMENT',
  'USER_MANAGEMENT',
  'FILE_MANAGER',
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
  accessType: accessTypeEnum('access_type').default('OPEN').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .notNull()
    .$onUpdateFn(() => new Date()),
});

export const serverAccess = pgTable(
  'server_access',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    status: serverAccessStatusEnum('status').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    approvedAt: timestamp('approved_at'),
  },
  (table) => [
    unique('server_access_user_id_server_id_unique').on(table.userId, table.serverId),
    index('server_access_server_id_status_created_at_id_idx').on(
      table.serverId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index('server_access_user_id_server_id_idx').on(table.userId, table.serverId),
    check(
      'server_access_status_approved_at_total_check',
      sql`(${table.status} = 'PENDING' AND ${table.approvedAt} IS NULL) OR (${table.status} = 'APPROVED' AND ${table.approvedAt} IS NOT NULL)`,
    ),
  ],
);

export const modPermissions = pgTable(
  'mod_permissions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    permission: modPermissionEnum('permission').notNull(),
    serverId: text('server_id').references(() => servers.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('mod_permissions_user_permission_unique_idx')
      .on(table.userId, table.permission)
      .where(sql`${table.serverId} IS NULL`),
    unique('mod_permissions_user_permission_server_unique').on(
      table.userId,
      table.permission,
      table.serverId,
    ),
    index('mod_permissions_server_id_idx').on(table.serverId),
    index('mod_permissions_user_permission_server_lookup_idx').on(
      table.userId,
      table.permission,
      table.serverId,
    ),
  ],
);

// --- Inferred types ---

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type Server = typeof servers.$inferSelect;
export type NewServer = typeof servers.$inferInsert;
export type ServerAccess = typeof serverAccess.$inferSelect;
export type NewServerAccess = typeof serverAccess.$inferInsert;
export type ModPermission = (typeof modPermissionEnum.enumValues)[number];
export type ModPermissionRow = typeof modPermissions.$inferSelect;
export type NewModPermission = typeof modPermissions.$inferInsert;
export type Role = (typeof roleEnum.enumValues)[number];
export type ServerProvider = (typeof serverProviderEnum.enumValues)[number];
export type ServerStatus = (typeof serverStatusEnum.enumValues)[number];
export type AccessType = (typeof accessTypeEnum.enumValues)[number];
export type ServerAccessStatus = (typeof serverAccessStatusEnum.enumValues)[number];
export type Difficulty = (typeof DifficultyEnum.enumValues)[number];
export type Gamemode = (typeof GamemodeEnum.enumValues)[number];
export type UserStatus = (typeof userStatusEnum.enumValues)[number];
