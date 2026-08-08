import { UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { PreAuthGuard } from './pre-auth.guard';

const makeContext = (authorization?: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }) as Request,
    }),
  }) as never;

describe('PreAuthGuard', () => {
  let jwtService: Pick<JwtService, 'verifyAsync'>;
  let guard: PreAuthGuard;

  beforeEach(() => {
    jwtService = { verifyAsync: jest.fn() };
    guard = new PreAuthGuard(jwtService as JwtService);
  });

  it('rejects a missing Bearer pre-auth token', async () => {
    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([
    'Bearer',
    'Bearer   ',
    'Bearer token trailing-content',
    'Basic pre-auth-token',
  ])('rejects malformed Authorization header %s', async (authorization) => {
    await expect(guard.canActivate(makeContext(authorization))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(jwtService.verifyAsync).not.toHaveBeenCalled();
  });

  it('rejects an expired pre-auth token', async () => {
    jwtService.verifyAsync = jest.fn().mockRejectedValue(new Error('jwt expired'));

    await expect(guard.canActivate(makeContext('Bearer expired'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a JWT whose type is not pre-auth', async () => {
    jwtService.verifyAsync = jest.fn().mockResolvedValue({ sub: 'user-1', type: 'access' });

    await expect(guard.canActivate(makeContext('Bearer access-token'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a pre-auth JWT with an empty subject', async () => {
    jwtService.verifyAsync = jest.fn().mockResolvedValue({ sub: '   ', type: 'pre-auth' });

    await expect(guard.canActivate(makeContext('Bearer pre-auth-token'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('accepts a case-insensitive Bearer scheme and attaches the subject to the request', async () => {
    const context = makeContext('bearer pre-auth-token');
    jwtService.verifyAsync = jest.fn().mockResolvedValue({ sub: 'user-1', type: 'pre-auth' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(jwtService.verifyAsync).toHaveBeenCalledWith('pre-auth-token');
  });
});
