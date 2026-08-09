import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import type { DrizzleDB } from 'src/db/db.module';
import { JwtAuthGuard } from './jwt-auth.guard';

const makeContext = (url = '/api/info', cookies: Record<string, string> = {}, method = 'GET') => {
  const request = { cookies, url, path: url.split('?')[0], method };
  const handler = () => undefined;
  const targetClass = class {};
  return {
    getHandler: () => handler,
    getClass: () => targetClass,
    switchToHttp: () => ({ getRequest: () => request }),
    getRequest: () => request,
  } as never;
};

describe('JwtAuthGuard', () => {
  let jwtService: Pick<JwtService, 'verifyAsync'>;
  let db: { select: jest.Mock };
  let userRow: { status: string; role: string; mustChangePassword: boolean };
  let guard: JwtAuthGuard;

  beforeEach(() => {
    userRow = { status: 'ACTIVE', role: 'ADMIN', mustChangePassword: false };
    jwtService = {
      verifyAsync: jest
        .fn()
        .mockResolvedValue({ sub: 'user-1', type: 'access', username: 'admin', role: 'ADMIN' }),
    };
    db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(async () => [userRow]),
        })),
      })),
    };
    guard = new JwtAuthGuard(jwtService as JwtService, new Reflector(), db as unknown as DrizzleDB);
  });

  it('rejects requests without an access token cookie', async () => {
    await expect(guard.canActivate(makeContext('/api/info'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an invalid or expired access token', async () => {
    jwtService.verifyAsync = jest.fn().mockRejectedValue(new Error('jwt expired'));

    await expect(
      guard.canActivate(makeContext('/api/info', { access_token: 'expired' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token whose user no longer exists', async () => {
    db.select = jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(async () => []),
      })),
    }));

    await expect(
      guard.canActivate(makeContext('/api/info', { access_token: 'token' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('uses the database role, not the JWT claim, so role changes take effect immediately', async () => {
    jwtService.verifyAsync = jest
      .fn()
      .mockResolvedValue({ sub: 'user-1', type: 'access', username: 'admin', role: 'USER' });
    userRow = { status: 'ACTIVE', role: 'ADMIN', mustChangePassword: false };
    const context = makeContext('/api/admin/users', { access_token: 'token' });
    const request = context.switchToHttp().getRequest();

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({ id: 'user-1', username: 'admin', role: 'ADMIN' });
  });

  it.each(['PENDING', 'BANNED'] as const)('rejects %s users', async (status) => {
    userRow = { status, role: 'ADMIN', mustChangePassword: false };

    await expect(
      guard.canActivate(makeContext('/api/info', { access_token: 'token' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects ordinary access tokens on every route during forced recovery', async () => {
    userRow = { status: 'ACTIVE', role: 'ADMIN', mustChangePassword: true };

    await expect(
      guard.canActivate(makeContext('/api/auth/profile', { access_token: 'token' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await expect(
      guard.canActivate(makeContext('/api/auth/password', { access_token: 'token' }, 'PATCH')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('allows only a temporary-auth token on the exact password-change route during forced recovery', async () => {
    jwtService.verifyAsync = jest.fn().mockResolvedValue({
      sub: 'user-1',
      type: 'access',
      username: 'admin',
      role: 'ADMIN',
      temporaryAuth: true,
    });
    userRow = { status: 'ACTIVE', role: 'ADMIN', mustChangePassword: true };
    const context = makeContext('/api/auth/password', { access_token: 'temporary' }, 'PATCH');

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(context.switchToHttp().getRequest().user).toEqual({
      id: 'user-1',
      username: 'admin',
      role: 'ADMIN',
      temporaryAuth: true,
    });
  });

  it('keeps a temporary-auth token off every other route during forced recovery', async () => {
    jwtService.verifyAsync = jest.fn().mockResolvedValue({
      sub: 'user-1',
      type: 'access',
      username: 'admin',
      role: 'ADMIN',
      temporaryAuth: true,
    });
    userRow = { status: 'ACTIVE', role: 'ADMIN', mustChangePassword: true };

    await expect(
      guard.canActivate(makeContext('/api/auth/profile', { access_token: 'temporary' })),
    ).rejects.toMatchObject({
      response: { error: 'PasswordChangeRequired' },
    });

    await expect(
      guard.canActivate(makeContext('/api/auth/password', { access_token: 'temporary' })),
    ).rejects.toMatchObject({
      response: { error: 'PasswordChangeRequired' },
    });
  });

  it('rejects a refresh token presented as an access token before consulting the database', async () => {
    jwtService.verifyAsync = jest.fn().mockResolvedValue({ sub: 'user-1', type: 'refresh' });
    db.select = jest.fn();

    await expect(
      guard.canActivate(makeContext('/api/info', { access_token: 'refresh-token' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects a pre-auth token presented as an access token', async () => {
    jwtService.verifyAsync = jest.fn().mockResolvedValue({ sub: 'user-1', type: 'pre-auth' });
    db.select = jest.fn();

    await expect(
      guard.canActivate(makeContext('/api/info', { access_token: 'pre-auth-token' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects a temporary-auth token after another session clears forced change', async () => {
    jwtService.verifyAsync = jest.fn().mockResolvedValue({
      sub: 'user-1',
      type: 'access',
      username: 'admin',
      role: 'ADMIN',
      temporaryAuth: true,
    });
    userRow = { status: 'ACTIVE', role: 'ADMIN', mustChangePassword: false };

    await expect(
      guard.canActivate(makeContext('/api/auth/profile', { access_token: 'temporary' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('allows an active user and attaches the authenticated identity', async () => {
    const context = makeContext('/api/info', { access_token: 'token' });
    const request = context.switchToHttp().getRequest();

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({ id: 'user-1', username: 'admin', role: 'ADMIN' });
  });
});
