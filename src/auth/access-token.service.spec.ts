import { UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { DrizzleDB } from 'src/db/db.module';
import { AccessTokenService } from './access-token.service';

type UserRow = { status: string; role: string; mustChangePassword: boolean };

const makeDb = (row: UserRow | undefined) => {
  const select = jest.fn(() => ({
    from: jest.fn(() => ({
      where: jest.fn().mockResolvedValue(row ? [row] : []),
    })),
  }));
  return { select };
};
const makeService = (
  payload: unknown,
  row: UserRow | undefined = {
    status: 'ACTIVE',
    role: 'ADMIN',
    mustChangePassword: false,
  },
) => {
  const jwtService = { verifyAsync: jest.fn().mockResolvedValue(payload) } as unknown as JwtService;
  const db = makeDb(row);
  return {
    service: new AccessTokenService(jwtService, db as unknown as DrizzleDB),
    jwtService,
    db,
  };
};

const makeMissingUserService = (payload: unknown) => {
  const jwtService = { verifyAsync: jest.fn().mockResolvedValue(payload) } as unknown as JwtService;
  const db = makeDb(undefined);
  return {
    service: new AccessTokenService(jwtService, db as unknown as DrizzleDB),
    jwtService,
    db,
  };
};

const validPayload = (overrides: Record<string, unknown> = {}) => ({
  sub: 'user-1',
  username: 'player',
  type: 'access',
  exp: Math.floor(Date.now() / 1000) + 900,
  ...overrides,
});

describe('AccessTokenService', () => {
  it.each([
    ['missing sub', { username: 'player', type: 'access', exp: 1 }],
    ['empty sub', validPayload({ sub: '' })],
    ['wrong sub type', validPayload({ sub: 1 })],
    ['missing username', validPayload({ username: undefined })],
    ['wrong username type', validPayload({ username: 1 })],
    ['missing purpose', validPayload({ type: undefined })],
    ['refresh purpose', validPayload({ type: 'refresh' })],
    ['pre-auth purpose', validPayload({ type: 'pre-auth' })],
    ['missing exp', validPayload({ exp: undefined })],
    ['fractional exp', validPayload({ exp: 1.5 })],
    ['non-finite exp', validPayload({ exp: Number.POSITIVE_INFINITY })],
    ['negative exp', validPayload({ exp: -1 })],
    ['unsafe exp', validPayload({ exp: Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1 })],
    ['wrong temporaryAuth type', validPayload({ temporaryAuth: 'true' })],
  ] as const)('rejects %s before querying the database', async (_label, payload) => {
    const { service, db } = makeService(payload);

    await expect(service.verify('token')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects JWT verification failures without exposing the cause', async () => {
    const { service, jwtService, db } = makeService(validPayload());
    (jwtService.verifyAsync as jest.Mock).mockRejectedValue(new Error('bad signature'));

    await expect(service.verify('token')).rejects.toEqual(expect.any(UnauthorizedException));
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects a missing user as UnauthorizedException', async () => {
    const { service } = makeMissingUserService(validPayload());

    await expect(service.verify('token')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps unexpected database failures to UnauthorizedException', async () => {
    const { service, db } = makeService(validPayload());
    const failure = new Error('db down');
    db.select.mockImplementation(() => ({
      from: jest.fn(() => ({ where: jest.fn().mockRejectedValue(failure) })),
    }));

    await expect(service.verify('token')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([
    ['PENDING', 'AccountPending'],
    ['BANNED', 'AccountBanned'],
  ] as const)('preserves the %s forbidden error', async (status, error) => {
    const { service } = makeService(validPayload(), {
      status,
      role: 'USER',
      mustChangePassword: false,
    });

    await expect(service.verify('token')).rejects.toMatchObject({ response: { error } });
  });

  it('returns the database role and recovery flags with expiry in milliseconds', async () => {
    const exp = 2_000_000_000;
    const { service } = makeService(validPayload({ role: 'USER', exp, temporaryAuth: true }), {
      status: 'ACTIVE',
      role: 'ADMIN',
      mustChangePassword: true,
    });

    await expect(service.verify('token')).resolves.toEqual({
      id: 'user-1',
      username: 'player',
      role: 'ADMIN',
      mustChangePassword: true,
      temporaryAuth: true,
      exp: exp * 1000,
    });
  });

  it('defaults absent temporaryAuth to false', async () => {
    const { service } = makeService(validPayload());

    await expect(service.verify('token')).resolves.toMatchObject({ temporaryAuth: false });
  });

  it('does not query the database for every wrong-purpose claim', async () => {
    const { service, db } = makeService(validPayload({ type: 'refresh' }));

    await expect(service.verify('token')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.select).not.toHaveBeenCalled();
  });
});
