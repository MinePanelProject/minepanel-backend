import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { PreAuthGuard } from './pre-auth.guard';

// SAFETY: PreAuthGuard only reads request.headers.authorization; the partial request
// and context doubles cover exactly that surface.
const makeContext = (authorization?: string) =>
  ({
    switchToHttp: () => ({
      // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
      getRequest: () => ({ headers: { authorization } }) as Request,
    }),
    // SAFETY: The test-controlled value satisfies the concrete framework contract used by this assertion.
  }) as ExecutionContext;

describe('PreAuthGuard', () => {
  let jwtService: Pick<JwtService, 'verifyAsync'>;
  let guard: PreAuthGuard;

  beforeEach(() => {
    jwtService = { verifyAsync: jest.fn() };
    // SAFETY: this test double provides verifyAsync and adopts JwtService's prototype.
    guard = new PreAuthGuard(Object.setPrototypeOf(jwtService, JwtService.prototype) as JwtService);
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
