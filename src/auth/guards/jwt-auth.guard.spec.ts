import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AccessTokenPrincipal, AccessTokenService } from 'src/auth/access-token.service';
import { JwtAuthGuard } from './jwt-auth.guard';

const makeContext = (path = '/api/info', cookies: Record<string, string> = {}, method = 'GET') => {
  const request = { cookies, path, url: path, method };
  const handler = () => undefined;
  const targetClass = class {};
  return {
    getHandler: () => handler,
    getClass: () => targetClass,
    switchToHttp: () => ({ getRequest: () => request }),
    request,
  } as never;
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
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;
    guard = new JwtAuthGuard({ verify } as unknown as AccessTokenService, reflector);
  });

  it('bypasses public routes without reading cookies', async () => {
    const context = makeContext('/health');
    (guard as unknown as { reflector: Reflector }).reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(true),
    } as unknown as Reflector;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects requests without an access cookie', async () => {
    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(verify).not.toHaveBeenCalled();
  });

  it('delegates the cookie token to the shared verifier', async () => {
    const context = makeContext('/api/info', { access_token: 'signed-token' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('signed-token');
    expect((context as unknown as { request: Record<string, unknown> }).request.user).toEqual({
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
    expect((context as unknown as { request: Record<string, unknown> }).request.user).toEqual({
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

    expect(
      (context as unknown as { request: Record<string, unknown> }).request.user,
    ).not.toHaveProperty('temporaryAuth');
  });
});
