import { createHash } from 'node:crypto';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { verifySync } from 'otplib';
import type { User } from 'src/db/schema';
import type { UsersService } from 'src/users/users.service';
import { AuthService } from './auth.service';

jest.mock('otplib', () => ({
  verifySync: jest.fn(),
}));

// keep real bcrypt behavior but make compare countable across module copies
jest.mock('bcrypt', () => {
  const actual = jest.requireActual('bcrypt');
  return {
    ...actual,
    compare: jest.fn((data: string, hash: string) => actual.compare(data, hash)),
    hash: jest.fn((data: string, rounds?: number) => actual.hash(data, rounds)),
  };
});

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
    select: jest.Mock;
    delete: jest.Mock;
  };
  let jwtService: Pick<JwtService, 'signAsync' | 'verifyAsync'>;
  let usersService: Pick<UsersService, 'findById' | 'findByIdentifier'>;
  let service: AuthService;
  let storedBackupCodes: string | null;
  let updatedValues: Record<string, unknown>[];
  let tempCredentialConsumed: boolean;
  let userRows: User[];
  let refreshTokenRows: { id: string; token: string; expiresAt: Date }[];
  let verifyPayload: { sub: string; type?: string; temporaryAuth?: boolean };

  const createService = (user: User) => {
    storedBackupCodes = user.totpBackupCodes;
    updatedValues = [];
    tempCredentialConsumed = false;
    userRows = [user];
    refreshTokenRows = [];
    verifyPayload = { sub: 'user-1', type: 'refresh' };
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
              returning: jest.fn(async () => {
                if ('tempPasswordExpiresAt' in values) {
                  if (tempCredentialConsumed) {
                    return [];
                  }
                  tempCredentialConsumed = true;
                }
                return [{ id: user.id }];
              }),
            })),
          };
        }),
      })),
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => {
            const chain = Promise.resolve(refreshTokenRows) as Promise<
              { id: string; token: string; expiresAt: Date }[]
            > & { limit: jest.Mock };
            chain.limit = jest.fn(async () => userRows.slice(0, 1));
            return chain;
          }),
        })),
      })),
      delete: jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) })),
    };
    jwtService = {
      signAsync: jest.fn(
        async (payload: {
          type?: string;
          sub: string;
          temporaryAuth?: boolean;
          temporaryCredentialFingerprint?: string;
        }) => (payload.type === 'pre-auth' ? `pre-auth-${payload.sub}` : `token-${payload.sub}`),
      ),
      verifyAsync: jest.fn(async () => verifyPayload),
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

  it('rejects the primary password while forced recovery is active', async () => {
    createService(
      makeUser({
        totpEnabled: false,
        tempPasswordHash: null,
        tempPasswordExpiresAt: null,
        mustChangePassword: true,
      }),
    );

    await expect(
      service.loginUser({ identifier: 'player', password: 'password' }),
    ).rejects.toMatchObject({
      response: { message: 'Wrong credentials', statusCode: 401 },
    });
    expect(db.insert).not.toHaveBeenCalled();
    expect(updatedValues).toHaveLength(0);
  });

  it('does not issue a normal 2FA pre-auth challenge while forced recovery is active', async () => {
    createService(
      makeUser({
        tempPasswordHash: null,
        tempPasswordExpiresAt: null,
        mustChangePassword: true,
      }),
    );

    await expect(
      service.loginUser({ identifier: 'player', password: 'password' }),
    ).rejects.toMatchObject({
      response: { message: 'Wrong credentials', statusCode: 401 },
    });
    expect(jwtService.signAsync).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects a normal 2FA completion while forced recovery is active', async () => {
    createService(
      makeUser({
        tempPasswordHash: null,
        tempPasswordExpiresAt: null,
        mustChangePassword: true,
      }),
    );
    mockedVerifySync.mockReturnValue({ valid: true });

    await expect(service.completeTwoFactorLogin('user-1', '123456')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('allows only one completed session for a temporary password', async () => {
    const tempHash = await bcrypt.hash('TempPass123!', 4);
    createService(
      makeUser({
        totpEnabled: false,
        tempPasswordHash: tempHash,
        tempPasswordExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        mustChangePassword: true,
      }),
    );

    const first = await service.loginUser({ identifier: 'player', password: 'TempPass123!' });

    expect('requiresTwoFactor' in first).toBe(false);
    await expect(
      service.loginUser({ identifier: 'player', password: 'TempPass123!' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(updatedValues).toContainEqual({ tempPasswordExpiresAt: null });
  });

  it('allows at most one concurrent temporary-password session', async () => {
    const tempHash = await bcrypt.hash('TempPass123!', 4);
    createService(
      makeUser({
        totpEnabled: false,
        tempPasswordHash: tempHash,
        tempPasswordExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        mustChangePassword: true,
      }),
    );

    const results = await Promise.allSettled([
      service.loginUser({ identifier: 'player', password: 'TempPass123!' }),
      service.loginUser({ identifier: 'player', password: 'TempPass123!' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired temporary password', async () => {
    const tempHash = await bcrypt.hash('TempPass123!', 4);
    createService(
      makeUser({
        totpEnabled: false,
        tempPasswordHash: tempHash,
        tempPasswordExpiresAt: new Date(Date.now() - 1000),
        mustChangePassword: true,
      }),
    );

    await expect(
      service.loginUser({ identifier: 'player', password: 'TempPass123!' }),
    ).rejects.toMatchObject({
      response: { message: 'Wrong credentials', statusCode: 401 },
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects a wrong temporary password', async () => {
    const tempHash = await bcrypt.hash('TempPass123!', 4);
    createService(
      makeUser({
        totpEnabled: false,
        tempPasswordHash: tempHash,
        tempPasswordExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        mustChangePassword: true,
      }),
    );

    await expect(
      service.loginUser({ identifier: 'player', password: 'WrongTempPass!' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(updatedValues).toHaveLength(0);
  });

  it('does not consume a temporary credential before successful 2FA', async () => {
    const tempHash = await bcrypt.hash('TempPass123!', 4);
    const temporaryCredentialFingerprint = createHash('sha256').update(tempHash).digest('hex');
    createService(
      makeUser({
        tempPasswordHash: tempHash,
        tempPasswordExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        mustChangePassword: true,
      }),
    );

    const challenge = await service.loginUser({
      identifier: 'player',
      password: 'TempPass123!',
    });
    expect(challenge).toEqual({ requiresTwoFactor: true, preAuthToken: 'pre-auth-user-1' });
    expect(updatedValues).toHaveLength(0);

    await expect(
      service.completeTwoFactorLogin('user-1', '000000', true, temporaryCredentialFingerprint),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(updatedValues).toHaveLength(0);
  });

  it('rejects a stale temporary pre-auth before it can consume a backup code', async () => {
    const backupCode = 'a1b2c3d4-e5f6a7b8';
    const codesJson = JSON.stringify([await bcrypt.hash(backupCode, 4)]);
    const staleFingerprint = createHash('sha256').update('replaced-temp-hash').digest('hex');
    createService(
      makeUser({
        totpBackupCodes: codesJson,
        tempPasswordHash: 'current-temp-hash',
        tempPasswordExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        mustChangePassword: true,
      }),
    );

    await expect(
      service.completeTwoFactorLogin('user-1', backupCode, true, staleFingerprint),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(storedBackupCodes).toBe(codesJson);
  });

  it('rejects a temporary pre-auth whose credential was already consumed before it can use a backup code', async () => {
    const backupCode = 'a1b2c3d4-e5f6a7b8';
    const codesJson = JSON.stringify([await bcrypt.hash(backupCode, 4)]);
    const fingerprint = createHash('sha256').update('current-temp-hash').digest('hex');
    createService(
      makeUser({
        totpBackupCodes: codesJson,
        tempPasswordHash: 'current-temp-hash',
        tempPasswordExpiresAt: null,
        mustChangePassword: true,
      }),
    );

    await expect(
      service.completeTwoFactorLogin('user-1', backupCode, true, fingerprint),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(storedBackupCodes).toBe(codesJson);
  });

  it('allows only one completed 2FA session for a temporary password', async () => {
    const tempHash = await bcrypt.hash('TempPass123!', 4);
    const temporaryCredentialFingerprint = createHash('sha256').update(tempHash).digest('hex');
    createService(
      makeUser({
        tempPasswordHash: tempHash,
        tempPasswordExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        mustChangePassword: true,
      }),
    );

    await service.loginUser({ identifier: 'player', password: 'TempPass123!' });
    mockedVerifySync.mockReturnValue({ valid: true });

    const results = await Promise.allSettled([
      service.completeTwoFactorLogin('user-1', '123456', true, temporaryCredentialFingerprint),
      service.completeTwoFactorLogin('user-1', '123456', true, temporaryCredentialFingerprint),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(updatedValues).toContainEqual({ tempPasswordExpiresAt: null });
  });

  it('rejects an access token presented to the refresh endpoint', async () => {
    createService(makeUser({ totpEnabled: false }));
    verifyPayload = { sub: 'user-1', type: 'access' };

    await expect(service.refreshTokens('access-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects a pre-auth token presented to the refresh endpoint', async () => {
    createService(makeUser({ totpEnabled: false }));
    verifyPayload = { sub: 'user-1', type: 'pre-auth' };

    await expect(service.refreshTokens('pre-auth-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rotates a correctly typed refresh token into a new session', async () => {
    const currentRefresh = 'refresh-token-1';
    createService(makeUser({ totpEnabled: false }));
    refreshTokenRows = [
      {
        id: 'tok-1',
        token: await bcrypt.hash(currentRefresh, 4),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    ];

    const result = await service.refreshTokens(currentRefresh);

    expect(result.accessToken).toBe('token-user-1');
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('rejects an ordinary refresh token during forced recovery even with a matching row', async () => {
    const currentRefresh = 'refresh-token-1';
    createService(makeUser({ totpEnabled: false }));
    userRows = [makeUser({ totpEnabled: false, mustChangePassword: true })];
    refreshTokenRows = [
      {
        id: 'tok-1',
        token: await bcrypt.hash(currentRefresh, 4),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    ];
    verifyPayload = { sub: 'user-1', type: 'refresh' };

    await expect(service.refreshTokens(currentRefresh)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('still rotates a temporary refresh token during forced recovery', async () => {
    const currentRefresh = 'refresh-token-1';
    createService(makeUser({ totpEnabled: false }));
    userRows = [makeUser({ totpEnabled: false, mustChangePassword: true })];
    refreshTokenRows = [
      {
        id: 'tok-1',
        token: await bcrypt.hash(currentRefresh, 4),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    ];
    verifyPayload = { sub: 'user-1', type: 'refresh', temporaryAuth: true };

    const result = await service.refreshTokens(currentRefresh);

    expect(result.accessToken).toBe('token-user-1');
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a missing user', 'missing', 'whatever', 'reject'],
    ['a user without a temporary reset', 'none', 'whatever', 'reject'],
    ['a user with an active temporary reset', 'active', 'whatever', 'reject'],
    ['a user with an expired temporary reset', 'expired', 'whatever', 'reject'],
    ['a user with the correct primary password', 'primary', 'password', 'allow'],
    ['a forced user with the correct primary password', 'forced-primary', 'password', 'reject'],
  ] as const)('performs the same number of bcrypt comparisons for %s', async (_label, state, password, outcome) => {
    const tempHash = await bcrypt.hash('TempPass123!', 4);
    let user: User | null;
    switch (state) {
      case 'missing':
        user = null;
        break;
      case 'none':
        user = makeUser({ tempPasswordHash: null, tempPasswordExpiresAt: null });
        break;
      case 'active':
        user = makeUser({
          tempPasswordHash: tempHash,
          tempPasswordExpiresAt: new Date(Date.now() + 60 * 1000),
        });
        break;
      case 'expired':
        user = makeUser({
          tempPasswordHash: tempHash,
          tempPasswordExpiresAt: new Date(Date.now() - 60 * 1000),
        });
        break;
      case 'forced-primary':
        user = makeUser({
          totpEnabled: false,
          tempPasswordHash: null,
          tempPasswordExpiresAt: null,
          mustChangePassword: true,
        });
        break;
      default:
        user = makeUser({ totpEnabled: false });
    }

    createService(user ?? makeUser());
    if (user === null) {
      usersService.findByIdentifier = jest.fn().mockResolvedValue(null);
    }

    if (outcome === 'allow') {
      await service.loginUser({ identifier: 'player', password });
    } else {
      await expect(service.loginUser({ identifier: 'player', password })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }

    expect(bcrypt.compare as jest.Mock).toHaveBeenCalledTimes(2);
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

  it('rejects a wrong password without issuing or storing a session', async () => {
    createService(makeUser({ totpEnabled: false }));

    await expect(
      service.loginUser({ identifier: 'player', password: 'definitely-wrong' }),
    ).rejects.toMatchObject({
      response: { message: 'Wrong credentials', statusCode: 401 },
    });
    expect(db.insert).not.toHaveBeenCalled();
    expect(jwtService.signAsync).not.toHaveBeenCalled();
  });
  it('rejects duplicate username or email before hashing or inserting', async () => {
    createService(makeUser());
    const hashSpy = bcrypt.hash as jest.Mock;
    hashSpy.mockClear();
    const createUser = jest.fn();
    usersService = { ...usersService, createUser } as unknown as UsersService;

    await expect(
      service.registerUser({
        email: 'user@example.com',
        username: 'player',
        password: 'Password123!',
      }),
    ).rejects.toMatchObject({
      response: { message: 'User already exists', statusCode: 409 },
    });
    expect(hashSpy).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
  });
});
