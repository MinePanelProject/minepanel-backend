type UserMutation = Partial<User>;

type UserTable = typeof users | typeof refreshTokens;

type UserDbFixture = {
  select: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  transaction: jest.Mock;
};

import { BadRequestException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import type { SQL } from 'drizzle-orm';
import { hashRefreshTokenId } from 'src/auth/refresh-token-id';
import { DRIZZLE } from 'src/db/db.module';
import { type RefreshToken, refreshTokens, type User, users } from 'src/db/schema';
import { UsersService } from './users.service';

const makeUser = (overrides: Partial<User> = {}): User => ({
  id: 'user-1',
  email: 'user@example.com',
  username: 'player',
  passwordHash: '$2b$10$abcdefghijklmnopqrstuv',
  googleId: null,
  githubId: null,
  role: 'USER',
  status: 'ACTIVE',
  totpSecret: null,
  totpEnabled: false,
  totpBackupCodes: null,
  tempPasswordHash: null,
  tempPasswordExpiresAt: null,
  mustChangePassword: false,
  minecraftUUID: null,
  minecraftName: null,
  minecraftVerified: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

describe('UsersService', () => {
  let service: UsersService;
  let rows: User[];
  let select: jest.Mock;
  let update: jest.Mock;
  let deleteMock: jest.Mock;
  let updatedRows: User[];
  let updatedValues: UserMutation[];
  let deleteCalls: { table: UserTable; where: SQL[] }[];
  let refreshTokenRows: Pick<RefreshToken, 'id' | 'tokenIdHash'>[];
  let whereSelect: jest.Mock;

  beforeEach(async () => {
    rows = [];
    updatedRows = [];
    updatedValues = [];
    refreshTokenRows = [];
    deleteCalls = [];
    whereSelect = jest.fn();

    select = jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn((condition: SQL) => {
          whereSelect(condition);
          // session listing is awaited directly on where(); user lookups call limit()
          // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
          const chain = Promise.resolve(refreshTokenRows) as Promise<
            Pick<RefreshToken, 'id' | 'tokenIdHash'>[]
          > & { limit: jest.Mock };
          chain.limit = jest.fn(async () => rows.slice(0, 1));
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
    deleteMock = jest.fn((table: UserTable) => ({
      where: jest.fn((...args: SQL[]) => {
        deleteCalls.push({ table, where: args });
        return Promise.resolve(undefined);
      }),
    }));
    const transaction = jest.fn(async (callback: (tx: UserDbFixture) => Promise<User | null>) =>
      callback(db),
    );
    const db: UserDbFixture = { select, update, delete: deleteMock, transaction };
    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: DRIZZLE, useValue: db }],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('finds a user by id', async () => {
    rows = [makeUser()];

    await expect(service.findById('user-1')).resolves.toEqual(makeUser());
  });

  it('returns null when no user matches the id', async () => {
    await expect(service.findById('missing')).resolves.toBeNull();
  });

  it('finds a user by email or username', async () => {
    rows = [makeUser()];

    await expect(service.findByIdentifier('player')).resolves.toEqual(makeUser());
    await expect(service.findByIdentifier('user@example.com')).resolves.toEqual(makeUser());
  });

  describe('updatePassword', () => {
    const oldHash = '$2b$04$.hAwu01MXvO.Y2rlKQI93.BGBLL6tcSTyKvOADxkbxFY8QBnt5x86';

    beforeEach(async () => {
      const newHash = await bcrypt.hash('NewPass123!', 4);
      updatedRows = [
        makeUser({
          passwordHash: newHash,
          tempPasswordHash: null,
          tempPasswordExpiresAt: null,
          mustChangePassword: false,
        }),
      ];
      refreshTokenRows = [{ id: 'tok-1', tokenIdHash: hashRefreshTokenId('current-refresh') }];
    });

    it('rejects a password change when neither the current nor a valid temp password matches', async () => {
      rows = [makeUser({ passwordHash: oldHash })];

      await expect(
        service.updatePassword(
          'user-1',
          { oldPassword: 'Nope123!', newPassword: 'NewPass123!' },
          'rt',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(update).not.toHaveBeenCalled();
    });
    it('rejects over-limit old and new passwords before reading the user', async () => {
      await expect(
        service.updatePassword(
          'user-1',
          { oldPassword: '😀'.repeat(19), newPassword: 'NewPass123!' },
          'current-refresh',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(select).not.toHaveBeenCalled();

      await expect(
        service.updatePassword(
          'user-1',
          { oldPassword: 'Password123!', newPassword: '😀'.repeat(19) },
          'current-refresh',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(select).not.toHaveBeenCalled();
    });

    it('rejects an OAuth-only account before updating its password', async () => {
      rows = [makeUser({ passwordHash: null })];

      await expect(
        service.updatePassword(
          'user-1',
          { oldPassword: 'Password123!', newPassword: 'NewPass123!' },
          'current-refresh',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(update).not.toHaveBeenCalled();
    });

    it('rejects an unconsumed temporary password as change proof on an ordinary session', async () => {
      const tempHash = await bcrypt.hash('TempPass123!', 4);
      rows = [
        makeUser({
          passwordHash: oldHash,
          tempPasswordHash: tempHash,
          tempPasswordExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
          mustChangePassword: true,
        }),
      ];

      await expect(
        service.updatePassword(
          'user-1',
          { oldPassword: 'TempPass123!', newPassword: 'NewPass123!' },
          'current-refresh',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(update).not.toHaveBeenCalled();
    });

    it('blocks an ordinary password change during forced recovery even with the primary password', async () => {
      rows = [
        makeUser({
          passwordHash: oldHash,
          tempPasswordHash: null,
          tempPasswordExpiresAt: null,
          mustChangePassword: true,
        }),
      ];

      await expect(
        service.updatePassword(
          'user-1',
          { oldPassword: 'password', newPassword: 'NewPass123!' },
          'current-refresh',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(update).not.toHaveBeenCalled();
    });

    it('accepts a consumed temporary credential only for its forced session', async () => {
      const tempHash = await bcrypt.hash('TempPass123!', 4);
      rows = [
        makeUser({
          passwordHash: oldHash,
          tempPasswordHash: tempHash,
          tempPasswordExpiresAt: null,
          mustChangePassword: true,
        }),
      ];

      await expect(
        service.updatePassword(
          'user-1',
          { oldPassword: 'TempPass123!', newPassword: 'NewPass123!' },
          'current-refresh',
          true,
        ),
      ).resolves.toMatchObject({ mustChangePassword: false });
      expect(deleteCalls.length).toBeGreaterThan(0);
    });

    it('allows only one forced completion to commit the new password', async () => {
      const tempHash = await bcrypt.hash('TempPass123!', 4);
      rows = [
        makeUser({
          passwordHash: oldHash,
          tempPasswordHash: tempHash,
          tempPasswordExpiresAt: null,
          mustChangePassword: true,
        }),
      ];

      await expect(
        service.updatePassword(
          'user-1',
          { oldPassword: 'TempPass123!', newPassword: 'NewPass123!' },
          'current-refresh',
          true,
        ),
      ).resolves.toMatchObject({ mustChangePassword: false });

      // the conditional update now matches nothing, exactly as a concurrent
      // winner would have left the row
      updatedRows = [];
      await expect(
        service.updatePassword(
          'user-1',
          { oldPassword: 'TempPass123!', newPassword: 'NewPass123!' },
          'current-refresh',
          true,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(deleteCalls).toHaveLength(1);
    });

    it('rejects an expired temporary password as change proof', async () => {
      const tempHash = await bcrypt.hash('TempPass123!', 4);
      rows = [
        makeUser({
          passwordHash: oldHash,
          tempPasswordHash: tempHash,
          tempPasswordExpiresAt: new Date(Date.now() - 1000),
        }),
      ];

      await expect(
        service.updatePassword(
          'user-1',
          { oldPassword: 'TempPass123!', newPassword: 'NewPass123!' },
          'rt',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(update).not.toHaveBeenCalled();
    });
  });
});
