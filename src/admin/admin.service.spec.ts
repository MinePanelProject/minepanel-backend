type UserMutation = Partial<User>;

type PermissionRow = typeof modPermissions.$inferSelect;

type PermissionListRow = Pick<PermissionRow, 'id' | 'permission'>;

type PermissionGrantRow = Pick<PermissionRow, 'id' | 'userId' | 'permission' | 'serverId'>;

type IdRow = { id: string };

type PermissionMutation = Partial<PermissionRow>;

type AdminQueryRow =
  | User
  | PermissionListRow
  | PermissionGrantRow
  | IdRow
  | { activeAdmins: number };

type AdminTable = typeof users | typeof refreshTokens | typeof modPermissions;

type AdminTransactionResult = PublicUser | PermissionGrantRow;

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { SQL } from 'drizzle-orm';
import { modPermissions, refreshTokens, type User, users } from 'src/db/schema';
import type { PublicUser } from 'src/users/public-user';
import { AdminService } from './admin.service';

const isStringValue = (value: string | null | undefined): value is string =>
  typeof value === 'string';

const makeUser = (overrides: Partial<User> = {}): User => ({
  id: 'user-1',
  email: 'admin@example.com',
  username: 'admin',
  passwordHash: '$2b$10$abcdefghijklmnopqrstuv',
  role: 'ADMIN',
  status: 'ACTIVE',
  totpSecret: null,
  totpEnabled: false,
  totpBackupCodes: null,
  tempPasswordHash: null,
  tempPasswordExpiresAt: null,
  mustChangePassword: false,
  minecraftUUID: null,
  minecraftName: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

type AdminClient = {
  select: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  execute: jest.Mock;
  transaction: jest.Mock;
};

type PermissionClient = AdminClient & { insert: jest.Mock };

describe('AdminService', () => {
  let rows: User[];
  let countRows: { activeAdmins: number }[];
  let updatedRows: User[];
  let client: AdminClient;
  let select: jest.Mock;
  let update: jest.Mock;
  let deleteMock: jest.Mock;
  let execute: jest.Mock;
  let transaction: jest.Mock;
  let where: jest.Mock;
  let updatedValues: UserMutation[];
  let deleteTables: AdminTable[];
  let service: AdminService;

  beforeEach(() => {
    rows = [];
    countRows = [{ activeAdmins: 2 }];
    updatedRows = [];
    updatedValues = [];
    deleteTables = [];
    where = jest.fn();

    select = jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn((condition: SQL) => {
          where(condition);
          // count query is awaited directly on the where() result; find/list queries
          // call limit()/orderBy() on it, so the chain doubles as a resolved promise
          // SAFETY: Drizzle's where() query producer returns a thenable chain; this double supplies
          // the limit() and orderBy() members consumed by AdminService.
          const chain = Promise.resolve(countRows) as Promise<{ activeAdmins: number }[]> & {
            limit: jest.Mock;
            orderBy: jest.Mock;
          };
          chain.limit = jest.fn(async () => rows);
          chain.orderBy = jest.fn(async () => rows);
          return chain;
        }),
      })),
    }));
    update = jest.fn(() => ({
      set: jest.fn((values: UserMutation) => {
        updatedValues.push(values);
        return {
          where: jest.fn(() => ({
            returning: jest.fn(async () => updatedRows),
          })),
        };
      }),
    }));
    deleteMock = jest.fn((table: AdminTable) => {
      deleteTables.push(table);
      return {
        where: jest.fn(async () => undefined),
      };
    });
    execute = jest.fn(async () => []);
    transaction = jest.fn(async (callback: (tx: AdminClient) => Promise<AdminTransactionResult>) =>
      callback(client),
    );

    client = { select, update, delete: deleteMock, execute, transaction };
    // SAFETY: AdminService consumes select, update, delete, execute, and transaction; this
    // Drizzle client double supplies exactly those collaborator members.
    service = new AdminService(client);
  });

  describe('listUsers', () => {
    it('returns only public user data', async () => {
      rows = [makeUser()];

      const result = await service.listUsers({});

      expect(result).toHaveLength(1);
      expect(result[0]).not.toHaveProperty('passwordHash');
      expect(result[0]).not.toHaveProperty('tempPasswordHash');
      expect(result[0]).not.toHaveProperty('totpSecret');
      expect(result[0]).not.toHaveProperty('totpBackupCodes');
    });

    it('applies no filter when neither status nor role is provided', async () => {
      await service.listUsers({});

      expect(where).toHaveBeenCalledWith(undefined);
    });

    it.each(['ACTIVE', 'PENDING', 'BANNED'] as const)('filters by status %s', async (status) => {
      await service.listUsers({ status });

      expect(where).toHaveBeenCalledWith(expect.anything());
    });

    it.each(['ADMIN', 'MOD', 'USER'] as const)('filters by role %s', async (role) => {
      await service.listUsers({ role });

      expect(where).toHaveBeenCalledWith(expect.anything());
    });

    it('combines status and role filters', async () => {
      await service.listUsers({ status: 'ACTIVE', role: 'ADMIN' });

      expect(where).toHaveBeenCalledWith(expect.anything());
    });
  });

  describe('updateStatus', () => {
    it('throws NotFoundException for a missing user', async () => {
      await expect(service.updateStatus('missing', 'BANNED')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws BadRequestException when the status is unchanged', async () => {
      rows = [makeUser({ status: 'ACTIVE' })];

      await expect(service.updateStatus('user-1', 'ACTIVE')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws ConflictException when banning the last active admin', async () => {
      rows = [makeUser()];
      countRows = [{ activeAdmins: 1 }];

      await expect(service.updateStatus('user-1', 'BANNED')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(update).not.toHaveBeenCalled();
    });

    it('bans a non-last active admin and revokes their refresh sessions', async () => {
      rows = [makeUser()];
      updatedRows = [makeUser({ status: 'BANNED' })];

      const result = await service.updateStatus('user-1', 'BANNED');

      expect(result.status).toBe('BANNED');
      expect(deleteMock).toHaveBeenCalledWith(refreshTokens);
      expect(deleteTables).toEqual([refreshTokens]);
      expect(execute).toHaveBeenCalledTimes(1); // advisory lock acquired
    });

    it('approves a pending user without session revocation or lock count', async () => {
      rows = [makeUser({ status: 'PENDING' })];
      updatedRows = [makeUser({ status: 'ACTIVE' })];

      const result = await service.updateStatus('user-1', 'ACTIVE');

      expect(result.status).toBe('ACTIVE');
      expect(deleteMock).not.toHaveBeenCalled();
      expect(select).toHaveBeenCalledTimes(1); // target lookup only, no count query
    });

    it('unbans a user without session revocation', async () => {
      rows = [makeUser({ status: 'BANNED' })];
      updatedRows = [makeUser({ status: 'ACTIVE' })];

      const result = await service.updateStatus('user-1', 'ACTIVE');

      expect(result.status).toBe('ACTIVE');
      expect(deleteMock).not.toHaveBeenCalled();
    });

    it('throws ConflictException when demoting status of the last active admin to PENDING', async () => {
      rows = [makeUser()];
      countRows = [{ activeAdmins: 1 }];

      await expect(service.updateStatus('user-1', 'PENDING')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('allows banning a banned-role user without triggering the last-admin check', async () => {
      rows = [makeUser({ role: 'MOD' })];
      countRows = [{ activeAdmins: 1 }];
      updatedRows = [makeUser({ role: 'MOD', status: 'BANNED' })];

      const result = await service.updateStatus('user-1', 'BANNED');

      expect(result.status).toBe('BANNED');
      expect(select).toHaveBeenCalledTimes(1); // no count query for non-admin targets
    });
  });

  describe('updateRole', () => {
    it('throws NotFoundException for a missing user', async () => {
      await expect(service.updateRole('missing', 'USER')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws BadRequestException when the role is unchanged', async () => {
      rows = [makeUser({ role: 'ADMIN' })];

      await expect(service.updateRole('user-1', 'ADMIN')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws ConflictException when demoting the last active admin', async () => {
      rows = [makeUser()];
      countRows = [{ activeAdmins: 1 }];

      await expect(service.updateRole('user-1', 'USER')).rejects.toBeInstanceOf(ConflictException);
      expect(update).not.toHaveBeenCalled();
    });

    it('demotes an active admin when another active admin remains', async () => {
      rows = [makeUser()];
      updatedRows = [makeUser({ role: 'MOD' })];

      const result = await service.updateRole('user-1', 'MOD');

      expect(result.role).toBe('MOD');
    });

    it('promotes a user to admin without running the count check', async () => {
      rows = [makeUser({ role: 'MOD' })];
      updatedRows = [makeUser({ role: 'ADMIN' })];

      const result = await service.updateRole('user-1', 'ADMIN');

      expect(result.role).toBe('ADMIN');
      expect(select).toHaveBeenCalledTimes(1); // target lookup only
    });
  });

  describe('resetPassword', () => {
    it('throws NotFoundException for a missing user', async () => {
      await expect(service.resetPassword('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns a cryptographically secure temporary password exactly once', async () => {
      rows = [makeUser()];

      const result = await service.resetPassword('user-1');

      expect(result.tempPassword).toMatch(/^[A-Za-z0-9_-]{16}$/);
      expect(updatedValues).toHaveLength(1);

      const stored = updatedValues[0];
      expect(stored.tempPasswordHash).toEqual(expect.any(String));
      expect(stored.tempPasswordHash).not.toBe(result.tempPassword);
      const tempPasswordHash = stored.tempPasswordHash;
      if (!isStringValue(tempPasswordHash)) {
        throw new Error('resetPassword did not store a string password hash');
      }
      await expect(
        // SAFETY: Drizzle update().set() produces tempPasswordHash; this captured row stores the
        // bcrypt hash passed to compare() below.
        bcrypt.compare(result.tempPassword, tempPasswordHash),
      ).resolves.toBe(true);

      // SAFETY: Drizzle update().set() produces tempPasswordExpiresAt; this captured Date is the
      // expiry member whose TTL is checked below.
      const expiresAt = stored.tempPasswordExpiresAt as Date;
      const ttl = expiresAt.getTime() - Date.now();
      expect(ttl).toBeGreaterThan(23 * 60 * 60 * 1000);
      expect(ttl).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
      expect(stored.mustChangePassword).toBe(true);
    });

    it('revokes every active refresh session of the target user', async () => {
      rows = [makeUser()];

      await service.resetPassword('user-1');

      expect(deleteMock).toHaveBeenCalledWith(refreshTokens);
      expect(deleteTables).toEqual([refreshTokens]);
    });
  });

  describe('removeTwoFactor', () => {
    it('throws NotFoundException for a missing user', async () => {
      await expect(service.removeTwoFactor('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws BadRequestException when two-factor is not enabled', async () => {
      rows = [makeUser({ totpEnabled: false })];

      await expect(service.removeTwoFactor('user-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('atomically clears the secret, enabled flag and backup codes in one update', async () => {
      rows = [
        makeUser({
          totpEnabled: true,
          totpSecret: 'encrypted-secret',
          totpBackupCodes: '["hash"]',
        }),
      ];
      updatedRows = [makeUser({ totpEnabled: false })];

      const result = await service.removeTwoFactor('user-1');

      expect(result.totpEnabled).toBe(false);
      expect(updatedValues).toEqual([
        { totpEnabled: false, totpSecret: null, totpBackupCodes: null },
      ]);
      expect(update).toHaveBeenCalledTimes(1);
    });
  });

  describe('mod permissions', () => {
    let permService: AdminService;
    let permClient: PermissionClient;
    let permSelectResults: AdminQueryRow[][];
    let permInsertReturning: PermissionGrantRow[][];
    let permUpdatedValues: PermissionMutation[];
    let permDeletedTables: AdminTable[];
    let permExecuteCalls: SQL[];

    const makeSelect = () => {
      const chain = {
        from: jest.fn(() => chain),
        where: jest.fn(() => chain),
        orderBy: jest.fn(async () => permSelectResults.shift() ?? []),
        limit: jest.fn(async () => permSelectResults.shift() ?? []),
      };
      return chain;
    };

    beforeEach(() => {
      permSelectResults = [];
      permInsertReturning = [];
      permUpdatedValues = [];
      permDeletedTables = [];
      permExecuteCalls = [];

      permClient = {
        select: jest.fn(makeSelect),
        insert: jest.fn(() => ({
          values: jest.fn((_values: PermissionMutation) => {
            const returningRows = permInsertReturning.shift() ?? [];
            return {
              onConflictDoNothing: jest.fn(() => ({
                returning: jest.fn().mockResolvedValue(returningRows),
              })),
            };
          }),
        })),
        update: jest.fn(() => ({
          set: jest.fn((values: PermissionMutation) => {
            permUpdatedValues.push(values);
            return {
              where: jest.fn(() => ({
                returning: jest.fn(async () => []),
              })),
            };
          }),
        })),
        delete: jest.fn((table: AdminTable) => {
          permDeletedTables.push(table);
          return {
            where: jest.fn(() => ({
              returning: jest.fn(async () => permSelectResults.shift() ?? []),
            })),
          };
        }),
        execute: jest.fn(async (...args: SQL[]) => {
          permExecuteCalls.push(...args);
          return [];
        }),
        transaction: jest.fn(
          async (callback: (tx: PermissionClient) => Promise<AdminTransactionResult>) =>
            callback(permClient),
        ),
      };

      // SAFETY: AdminService permission tests consume the captured execute and transaction
      // members; this Drizzle client double supplies that collaborator surface.
      permService = new AdminService(permClient);
    });

    it('lists mod permissions ordered by createdAt and id', async () => {
      permSelectResults = [
        [makeUser({ role: 'MOD' })],
        [{ id: 'perm-1', permission: 'SERVER_LIFECYCLE' }],
      ];

      const result = await permService.listModPermissions('user-1');

      expect(result).toHaveLength(1);
      expect(result[0].permission).toBe('SERVER_LIFECYCLE');
    });

    it('throws NotFoundException when listing permissions for a missing user', async () => {
      permSelectResults = [[]];

      await expect(permService.listModPermissions('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('grants a global permission to a MOD user', async () => {
      permSelectResults = [[makeUser({ role: 'MOD' })], []];
      permInsertReturning = [
        [{ id: 'perm-1', userId: 'user-1', permission: 'SERVER_LIFECYCLE', serverId: null }],
      ];

      const result = await permService.grantModPermission('user-1', {
        permission: 'SERVER_LIFECYCLE',
      });

      expect(result.permission).toBe('SERVER_LIFECYCLE');
      expect(result.serverId).toBeNull();
      expect(permExecuteCalls).toHaveLength(1);
    });

    it('grants a scoped permission when the server exists', async () => {
      permSelectResults = [[makeUser({ role: 'MOD' })], [{ id: 'server-1' }], []];
      permInsertReturning = [
        [{ id: 'perm-1', userId: 'user-1', permission: 'SERVER_LIFECYCLE', serverId: 'server-1' }],
      ];

      const result = await permService.grantModPermission('user-1', {
        permission: 'SERVER_LIFECYCLE',
        serverId: 'server-1',
      });

      expect(result.serverId).toBe('server-1');
    });

    it('rejects a scoped grant when the server does not exist', async () => {
      permSelectResults = [[makeUser({ role: 'MOD' })], []];

      await expect(
        permService.grantModPermission('user-1', {
          permission: 'SERVER_LIFECYCLE',
          serverId: 'missing',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a grant when the target is not a MOD', async () => {
      permSelectResults = [[makeUser({ role: 'USER' })]];

      await expect(
        permService.grantModPermission('user-1', { permission: 'SERVER_LIFECYCLE' }),
      ).rejects.toMatchObject({
        status: 400,
        response: { message: 'User is not a MOD' },
      });
    });

    it('rejects a duplicate global grant with 409', async () => {
      permSelectResults = [[makeUser({ role: 'MOD' })], [], [{ id: 'perm-1' }]];
      permInsertReturning = [[]];

      await expect(
        permService.grantModPermission('user-1', { permission: 'SERVER_LIFECYCLE' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { message: 'Permission grant already exists' },
      });
    });

    it('rejects whitespace serverId values so only null/omitted means global', async () => {
      permSelectResults = [[makeUser({ role: 'MOD' })]];

      await expect(
        permService.grantModPermission('user-1', {
          permission: 'SERVER_LIFECYCLE',
          serverId: '   ',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('revokes a permission by id and userId, preventing cross-user IDOR', async () => {
      permSelectResults = [[makeUser({})], [{ id: 'perm-1' }]];

      await expect(permService.revokeModPermission('user-1', 'perm-1')).resolves.toBeUndefined();
      expect(permDeletedTables).toContain(modPermissions);
    });

    it('returns 404 when revoking a permission id belonging to another user', async () => {
      permSelectResults = [[makeUser({})], []];

      await expect(permService.revokeModPermission('user-1', 'perm-2')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns 404 when revoking a permission for a missing user', async () => {
      permSelectResults = [[]];

      await expect(permService.revokeModPermission('missing', 'perm-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('deletes all mod permissions during a role change under the advisory lock', async () => {
      rows = [makeUser({ role: 'MOD' })];
      updatedRows = [makeUser({ role: 'USER' })];

      await service.updateRole('user-1', 'USER');

      expect(deleteMock).toHaveBeenCalledWith(modPermissions);
      expect(deleteTables).toContain(modPermissions);
      expect(execute).toHaveBeenCalled();
    });
  });
});
