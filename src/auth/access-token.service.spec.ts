import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { DrizzleDB } from 'src/db/db.module';
import { AccessTokenService } from './access-token.service';

type UserRow = { status: string; role: string; mustChangePassword: boolean };
type ValidPayload = {
  sub: string | number;
  username: string | number | undefined;
  type: string | undefined;
  exp: number | undefined;
  temporaryAuth?: boolean | string;
  role?: string;
};
type VerifyPayload = Partial<ValidPayload> | null | boolean | number | string | readonly never[];
type AccessDbFixture = Pick<DrizzleDB, 'select'> & { select: jest.Mock };
const makeDb = (row: UserRow | undefined): AccessDbFixture => {
  const selectMock = jest.fn();
  selectMock.mockImplementation(() => ({
    from: jest.fn(() => ({
      where: jest.fn().mockResolvedValue(row ? [row] : []),
    })),
  }));
  // SAFETY: The mock implements the select method surface required by AccessTokenService.
  return { select: selectMock } as AccessDbFixture;
};
const makeService = (payload: VerifyPayload, ...rows: [UserRow?]) => {
  const verifyAsync = jest.fn().mockResolvedValue(payload);
  const row =
    rows.length === 0
      ? {
          status: 'ACTIVE',
          role: 'ADMIN',
          mustChangePassword: false,
        }
      : rows[0];
  const db = makeDb(row);
  // SAFETY: the spec exercises only AccessTokenService.verify, which calls
  // JwtService.verifyAsync and DrizzleDB.select; these doubles implement exactly that surface.
  return {
    // SAFETY: this test double is attached to JwtService's prototype and implements verifyAsync.
    service: new AccessTokenService(Object.assign(new JwtService(), { verifyAsync }), db),
    verifyAsync,
    db,
  };
};
const validPayload = (overrides: Partial<ValidPayload> = {}): ValidPayload => ({
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

  it.each([
    ['null', null],
    ['a boolean', true],
    ['a number', 1],
    ['a string', 'access'],
    ['an array', []],
  ] as const)('rejects verifier output that is %s before querying the database', async (_label, payload) => {
    const { service, db } = makeService(payload);

    await expect(service.verify('token')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects JWT verification failures without exposing the cause', async () => {
    const { service, verifyAsync, db } = makeService(validPayload());
    verifyAsync.mockRejectedValue(new Error('bad signature'));

    await expect(service.verify('token')).rejects.toEqual(expect.any(UnauthorizedException));
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects a missing user as UnauthorizedException', async () => {
    const { service } = makeService(validPayload(), undefined);

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
