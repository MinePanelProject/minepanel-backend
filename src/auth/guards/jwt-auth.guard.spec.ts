import { type ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type AccessTokenPrincipal, AccessTokenService } from 'src/auth/access-token.service';
import { JwtAuthGuard } from './jwt-auth.guard';

type JwtContextFixture = {
  getHandler: () => void;
  getClass: () => void;
  switchToHttp: () => { getRequest: () => FakeRequest };
  request: FakeRequest;
};
const asExecutionContext = (
  fixture: JwtContextFixture,
): ExecutionContext & { request: FakeRequest } =>
  /* SAFETY: NestJS execution-context parsing produces getHandler, getClass, and
  switchToHttp().getRequest(); this fixture supplies those exact members and request. */
  fixture as ExecutionContext & { request: FakeRequest };

type CookieToken = string | number | readonly string[] | undefined;
type CookieFixture = { access_token?: CookieToken };
type FakeRequest = {
  cookies?: CookieFixture;
  path: string;
  url: string;
  method: string;
  user?: { id: string; username: string; role: string; temporaryAuth?: boolean };
};

const makeContext = (
  path = '/api/info',
  cookies: CookieFixture | undefined = {},
  method = 'GET',
) => {
  const request: FakeRequest = { cookies, path, url: path, method };
  const handler = () => undefined;
  const targetClass = class {};
  // SAFETY: JwtAuthGuard only calls getHandler, getClass, and switchToHttp().getRequest();
  // request is exposed so tests can assert on the attached principal.
  return asExecutionContext({
    getHandler: () => handler,
    getClass: () => targetClass,
    switchToHttp: () => ({ getRequest: () => request }),
    request,
  });
};

const principal = (overrides: Partial<AccessTokenPrincipal> = {}): AccessTokenPrincipal => ({
  id: 'user-1',
  username: 'player',
  role: 'ADMIN',
  mustChangePassword: false,
  temporaryAuth: false,
  exp: Date.now() + 900_000,
  ...overrides,
});

describe('JwtAuthGuard', () => {
  let verify: jest.Mock;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    verify = jest.fn().mockResolvedValue(principal());
    // SAFETY: JwtAuthGuard consumes reflector.getAllAndOverride and
    // accessTokenService.verify; these doubles provide those exact members on concrete
    // Reflector and AccessTokenService prototypes.
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } satisfies Pick<Reflector, 'getAllAndOverride'>;
    // SAFETY: Reflector is the collaborator producer; its contract invariant supplies
    // getAllAndOverride, the exact member consumed by JwtAuthGuard.
    const reflectorDouble = Object.assign(new Reflector(), reflector) as never;
    const rawAccessService = Object.assign(Object.create(AccessTokenService.prototype), { verify });
    // SAFETY: AccessTokenService.prototype is the collaborator producer; its contract invariant
    // supplies verify, the exact member consumed by JwtAuthGuard.
    const accessService = rawAccessService as never;
    guard = new JwtAuthGuard(accessService, reflectorDouble);
  });

  it('bypasses public routes without reading cookies', async () => {
    const context = makeContext('/health');
    // SAFETY: JwtAuthGuard consumes reflector.getAllAndOverride and
    // accessTokenService.verify; these doubles provide those exact members on concrete
    // Reflector and AccessTokenService prototypes, with public metadata enabled.
    // SAFETY: Reflector is the collaborator producer; its contract invariant supplies
    // getAllAndOverride with public metadata enabled for JwtAuthGuard.
    const reflectorDouble = Object.assign(new Reflector(), {
      getAllAndOverride: jest.fn().mockReturnValue(true),
    }) as never;
    const rawAccessService = Object.assign(Object.create(AccessTokenService.prototype), { verify });
    // SAFETY: AccessTokenService.prototype is the collaborator producer; its contract invariant
    // supplies verify, the exact member consumed by JwtAuthGuard.
    const accessService = rawAccessService as never;
    const publicGuard = new JwtAuthGuard(accessService, reflectorDouble);

    await expect(publicGuard.canActivate(context)).resolves.toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects requests without an access cookie', async () => {
    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { access_token: undefined },
    { access_token: ['token'] },
    { access_token: 1 },
  ])('rejects optional or non-string access cookies without verifying', async (cookies) => {
    await expect(guard.canActivate(makeContext('/api/info', cookies))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(verify).not.toHaveBeenCalled();
  });

  it('delegates the cookie token to the shared verifier', async () => {
    const context = makeContext('/api/info', { access_token: 'signed-token' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('signed-token');
    expect(context.request.user).toEqual({
      id: 'user-1',
      username: 'player',
      role: 'ADMIN',
    });
  });

  it('maps unexpected verifier failures to UnauthorizedException', async () => {
    verify.mockRejectedValue(new Error('bad token'));

    await expect(
      guard.canActivate(makeContext('/api/info', { access_token: 'bad' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([
    ['AccountPending', new ForbiddenException({ error: 'AccountPending' })],
    ['AccountBanned', new ForbiddenException({ error: 'AccountBanned' })],
  ] as const)('preserves %s from the verifier', async (_label, error) => {
    verify.mockRejectedValue(error);

    await expect(
      guard.canActivate(makeContext('/api/info', { access_token: 'token' })),
    ).rejects.toBe(error);
  });

  it('rejects an ordinary token during forced recovery', async () => {
    verify.mockResolvedValue(principal({ mustChangePassword: true, temporaryAuth: false }));
    await expect(
      guard.canActivate(makeContext('/api/info', { access_token: 'token' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts temporary auth only on the exact password-change PATCH route', async () => {
    verify.mockResolvedValue(principal({ mustChangePassword: true, temporaryAuth: true }));
    const context = makeContext('/api/auth/password', { access_token: 'token' }, 'PATCH');

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(context.request.user).toEqual({
      id: 'user-1',
      username: 'player',
      role: 'ADMIN',
      temporaryAuth: true,
    });
  });

  it('rejects temporary auth on every other route during recovery', async () => {
    verify.mockResolvedValue(principal({ mustChangePassword: true, temporaryAuth: true }));

    await expect(
      guard.canActivate(makeContext('/api/info', { access_token: 'token' })),
    ).rejects.toMatchObject({ response: { error: 'PasswordChangeRequired' } });
  });

  it('rejects temporary auth after recovery is inactive', async () => {
    verify.mockResolvedValue(principal({ mustChangePassword: false, temporaryAuth: true }));

    await expect(
      guard.canActivate(makeContext('/api/info', { access_token: 'token' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not include temporaryAuth when it is false', async () => {
    const context = makeContext('/api/info', { access_token: 'token' });
    await guard.canActivate(context);

    expect(context.request.user).not.toHaveProperty('temporaryAuth');
  });
});
