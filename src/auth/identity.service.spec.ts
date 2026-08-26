import { ConfigService } from '@nestjs/config';
import { type User, users } from 'src/db/schema';
import { IdentityService } from './identity.service';

const makeUser = (overrides: Partial<User> = {}): User => ({
  id: 'user-1',
  email: 'user@example.com',
  username: 'player',
  passwordHash: null,
  googleId: 'google-user-1',
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
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('IdentityService', () => {
  let selectRows: User[][];
  let insertValues: jest.Mock;
  let service: IdentityService;

  beforeEach(() => {
    selectRows = [];
    insertValues = jest.fn(() => ({ returning: jest.fn().mockResolvedValue([makeUser()]) }));
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({ limit: jest.fn(async () => selectRows.shift() ?? []) })),
        })),
      })),
      insert: jest.fn(() => ({ values: insertValues })),
    };
    const configService = Object.assign(new ConfigService(), {
      get: jest.fn((key: string) => (key === 'REQUIRE_ADMIN_APPROVAL' ? 'true' : undefined)),
    });

    // SAFETY: the test-producer db mock structurally satisfies the select/insert
    // surface IdentityService consumes; 'never' bypasses only the compile-time
    // DrizzleDB requirement for this hand-rolled fixture.
    service = new IdentityService(db as never, configService);
  });

  it('authenticates an identity already linked to the provider', async () => {
    const linkedUser = makeUser();
    selectRows = [[linkedUser]];

    await expect(
      service.resolveProviderIdentity({
        provider: 'google',
        providerId: 'google-user-1',
        email: linkedUser.email,
        username: linkedUser.username,
      }),
    ).resolves.toEqual({ kind: 'authenticated', user: linkedUser });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('requires confirmation instead of silently linking an email match', async () => {
    const existingPasswordUser = makeUser({ googleId: null, passwordHash: 'password-hash' });
    selectRows = [[], [existingPasswordUser]];

    await expect(
      service.resolveProviderIdentity({
        provider: 'google',
        providerId: 'new-google-user',
        email: existingPasswordUser.email,
        username: 'player',
      }),
    ).resolves.toEqual({ kind: 'linkConfirmationRequired', user: existingPasswordUser });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('creates a pending provider-only account with canonical username', async () => {
    const createdUser = makeUser({ username: 'newplayer', googleId: 'new-google-user' });
    selectRows = [[], []];
    insertValues.mockReturnValue({ returning: jest.fn().mockResolvedValue([createdUser]) });

    await expect(
      service.resolveProviderIdentity({
        provider: 'google',
        providerId: 'new-google-user',
        email: 'new@example.com',
        username: 'NewPlayer',
      }),
    ).resolves.toEqual({ kind: 'created', user: createdUser });
    expect(insertValues).toHaveBeenCalledWith({
      email: 'new@example.com',
      username: 'newplayer',
      passwordHash: null,
      status: 'PENDING',
      googleId: 'new-google-user',
    });
  });

  it('atomically links a Google subject and preserves the unique-constraint race boundary', async () => {
    const linkedUser = makeUser({ googleId: 'google-new' });
    const returning = jest.fn().mockResolvedValue([linkedUser]);
    const update = jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(() => ({ returning })),
      })),
    }));
    const transaction = jest.fn(async (callback) =>
      callback({
        update,
        select: jest.fn(),
      }),
    );
    const db = { transaction };
    const configService = new ConfigService();
    // SAFETY: the transaction mock exposes precisely the atomic update chain exercised here.
    const linkService = new IdentityService(db as never, configService);

    await expect(linkService.linkGoogleIdentity('user-1', 'google-new')).resolves.toEqual(
      linkedUser,
    );
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(users);
  });

  it('rejects a provider subject already claimed by another account', async () => {
    const update = jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(() => ({
          returning: jest.fn().mockRejectedValue({ code: '23505' }),
        })),
      })),
    }));
    const transaction = jest.fn(async (callback) => callback({ update, select: jest.fn() }));
    const configService = new ConfigService();
    // SAFETY: the transaction mock supplies the unique-violation producer from PostgreSQL's update.
    const linkService = new IdentityService({ transaction } as never, configService);

    await expect(linkService.linkGoogleIdentity('user-2', 'google-new')).rejects.toMatchObject({
      response: { message: 'Google account is already linked', statusCode: 409 },
    });
  });
});
