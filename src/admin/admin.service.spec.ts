import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { DrizzleDB } from 'src/db/db.module';
import { refreshTokens, type User } from 'src/db/schema';
import { AdminService } from './admin.service';

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

describe('AdminService', () => {
  let rows: User[];
  let countRows: { activeAdmins: number }[];
  let updatedRows: User[];
  let client: {
    select: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
  };
  let select: jest.Mock;
  let update: jest.Mock;
  let deleteMock: jest.Mock;
  let execute: jest.Mock;
  let transaction: jest.Mock;
  let where: jest.Mock;
  let updatedValues: Record<string, unknown>[];
  let deleteTables: unknown[];
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
        where: jest.fn((condition: unknown) => {
          where(condition);
          // count query is awaited directly on the where() result; find/list queries
          // call limit()/orderBy() on it, so the chain doubles as a resolved promise
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
      set: jest.fn((values: Record<string, unknown>) => {
        updatedValues.push(values);
        return {
          where: jest.fn(() => ({
            returning: jest.fn(async () => updatedRows),
          })),
        };
      }),
    }));
    deleteMock = jest.fn((table: unknown) => {
      deleteTables.push(table);
      return {
        where: jest.fn(async () => undefined),
      };
    });
    execute = jest.fn(async () => []);
    transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(client));

    client = { select, update, delete: deleteMock, execute, transaction };
    service = new AdminService(client as unknown as DrizzleDB);
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
      await expect(
        bcrypt.compare(result.tempPassword, stored.tempPasswordHash as string),
      ).resolves.toBe(true);

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
});
