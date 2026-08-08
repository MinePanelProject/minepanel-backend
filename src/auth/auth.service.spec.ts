import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { verifySync } from 'otplib';
import type { DrizzleDB } from 'src/db/db.module';
import type { User } from 'src/db/schema';
import type { UsersService } from 'src/users/users.service';
import { AuthService } from './auth.service';

jest.mock('otplib', () => ({
  verifySync: jest.fn(),
}));

jest.mock('src/common/crypto.util', () => ({
  decrypt: jest.fn().mockReturnValue('secret'),
  encrypt: jest.fn(),
}));
const mockedVerifySync = jest.mocked(verifySync);

const makeUser = (overrides: Partial<User> = {}): User => ({
  id: 'user-1',
  email: 'user@example.com',
  username: 'player',
  passwordHash: '$2b$04$.hAwu01MXvO.Y2rlKQI93.BGBLL6tcSTyKvOADxkbxFY8QBnt5x86',
  role: 'USER',
  status: 'ACTIVE',
  totpSecret: 'encrypted-secret',
  totpEnabled: true,
  totpBackupCodes: null,
  tempPasswordHash: 'temporary-password-hash',
  tempPasswordExpiresAt: null,
  mustChangePassword: false,
  minecraftUUID: null,
  minecraftName: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('AuthService', () => {
  let db: {
    insert: jest.Mock;
    update: jest.Mock;
  };
  let jwtService: Pick<JwtService, 'signAsync'>;
  let usersService: Pick<UsersService, 'findById' | 'findByIdentifier'>;
  let service: AuthService;
  let storedBackupCodes: string | null;
  let updatedValues: Record<string, unknown>[];

  const createService = (user: User) => {
    storedBackupCodes = user.totpBackupCodes;
    updatedValues = [];
    db = {
      insert: jest.fn(() => ({ values: jest.fn().mockResolvedValue(undefined) })),
      update: jest.fn(() => ({
        set: jest.fn((values: Record<string, unknown>) => {
          updatedValues.push(values);
          if ('totpBackupCodes' in values) {
            storedBackupCodes = values.totpBackupCodes as string | null;
          }
          return {
            where: jest.fn(() => ({
              returning: jest.fn().mockResolvedValue([{ id: user.id }]),
            })),
          };
        }),
      })),
    };
    jwtService = {
      signAsync: jest.fn(async (payload: { type?: string; sub: string }) =>
        payload.type === 'pre-auth' ? `pre-auth-${payload.sub}` : `token-${payload.sub}`,
      ),
    };
    usersService = {
      findByIdentifier: jest.fn().mockResolvedValue(user),
      findById: jest.fn().mockImplementation(async () => ({
        ...user,
        totpBackupCodes: storedBackupCodes,
      })),
    };
    service = new AuthService(
      usersService as UsersService,
      jwtService as JwtService,
      db as unknown as DrizzleDB,
      { get: jest.fn().mockReturnValue('a'.repeat(64)) } as unknown as ConfigService,
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedVerifySync.mockReturnValue({ valid: false });
  });

  it('creates one session for a non-2FA login and sanitizes the returned user', async () => {
    createService(makeUser({ totpEnabled: false }));

    const result = await service.loginUser({ identifier: 'player', password: 'password' });

    expect('requiresTwoFactor' in result).toBe(false);
    if ('requiresTwoFactor' in result) {
      return;
    }
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(result.user).not.toHaveProperty('passwordHash');
    expect(result.user).not.toHaveProperty('totpSecret');
    expect(result.user).not.toHaveProperty('totpBackupCodes');
    expect(result.user).not.toHaveProperty('tempPasswordHash');
  });

  it('returns a five-minute pre-auth challenge without creating a session', async () => {
    createService(makeUser());

    const result = await service.loginUser({ identifier: 'player', password: 'password' });

    expect(result).toEqual({ requiresTwoFactor: true, preAuthToken: 'pre-auth-user-1' });
    expect(jwtService.signAsync).toHaveBeenCalledWith(
      { sub: 'user-1', type: 'pre-auth' },
      { expiresIn: '5m' },
    );
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('does not issue a session for an invalid TOTP code', async () => {
    createService(makeUser());

    await expect(service.completeTwoFactorLogin('user-1', '000000')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('completes a valid TOTP login with exactly one refresh session', async () => {
    createService(makeUser());
    mockedVerifySync.mockReturnValue({ valid: true });

    const result = await service.completeTwoFactorLogin('user-1', '123456');

    expect(result.accessToken).toBe('token-user-1');
    expect(result.refreshToken).toBe('token-user-1');
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('consumes a backup code and rejects its reuse', async () => {
    const backupCode = 'a1b2c3d4-e5f6a7b8';
    createService(
      makeUser({ totpBackupCodes: JSON.stringify([await bcrypt.hash(backupCode, 4)]) }),
    );

    await service.completeTwoFactorLogin('user-1', backupCode);
    await expect(service.completeTwoFactorLogin('user-1', backupCode)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(storedBackupCodes).toBe('[]');
  });

  it('locks a user after five failures and resets failures after a success', async () => {
    createService(makeUser());

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(service.completeTwoFactorLogin('user-1', '000000')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }

    mockedVerifySync.mockReturnValue({ valid: true });
    await service.completeTwoFactorLogin('user-1', '123456');
    mockedVerifySync.mockReturnValue({ valid: false });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.completeTwoFactorLogin('user-1', '000000')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }

    await expect(service.completeTwoFactorLogin('user-1', '000000')).rejects.toMatchObject({
      status: 429,
    });
  });

  it('clears all two-factor state when disabling two-factor authentication', async () => {
    createService(makeUser());
    mockedVerifySync.mockReturnValue({ valid: true });

    await expect(service.disable2FA('user-1', '123456')).resolves.toBe(true);
    expect(updatedValues).toContainEqual({
      totpEnabled: false,
      totpSecret: null,
      totpBackupCodes: null,
    });
  });

  it.each([
    ['PENDING', 'AccountPending'],
    ['BANNED', 'AccountBanned'],
  ] as const)('rejects %s users before or after two-factor login', async (status, error) => {
    createService(makeUser({ status }));

    await expect(
      service.loginUser({ identifier: 'player', password: 'password' }),
    ).rejects.toMatchObject({
      response: { error },
    });
    await expect(service.completeTwoFactorLogin('user-1', '123456')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects invalid encryption key configuration at startup', () => {
    expect(
      () =>
        new AuthService(
          {} as UsersService,
          {} as JwtService,
          {} as DrizzleDB,
          { get: jest.fn().mockReturnValue('not-a-key') } as unknown as ConfigService,
        ),
    ).toThrow('Invalid ENCRYPTION_KEY');
  });
});
