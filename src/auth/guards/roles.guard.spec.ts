import { ForbiddenException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

const makeContext = (role: string | undefined) => {
  const request = { user: role ? { role } : undefined };
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
};

describe('RolesGuard', () => {
  let reflector: Pick<Reflector, 'getAllAndOverride'>;
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    guard = new RolesGuard(reflector as Reflector);
  });

  it('allows the request when no roles are required', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue(undefined);

    await expect(guard.canActivate(makeContext('USER'))).resolves.toBe(true);
  });

  it('allows a request whose role is in the required roles', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue(['ADMIN']);

    await expect(guard.canActivate(makeContext('ADMIN'))).resolves.toBe(true);
  });

  it('rejects a request whose role is not in the required roles', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue(['ADMIN']);

    await expect(guard.canActivate(makeContext('USER'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects an anonymous request when roles are required', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue(['ADMIN']);

    await expect(guard.canActivate(makeContext(undefined))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows ADMIN to bypass any explicit role list', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue(['MOD']);

    await expect(guard.canActivate(makeContext('ADMIN'))).resolves.toBe(true);
  });

  it('allows ADMIN to bypass even when no listed role matches', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue(['USER']);

    await expect(guard.canActivate(makeContext('ADMIN'))).resolves.toBe(true);
  });

  it('still requires literal membership for non-ADMIN principals', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue(['MOD']);

    await expect(guard.canActivate(makeContext('USER'))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
