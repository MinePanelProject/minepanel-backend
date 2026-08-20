import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

type RoleContextFixture = {
  getHandler: () => void;
  getClass: () => void;
  switchToHttp: () => { getRequest: () => { user?: { role?: string } } };
};
// SAFETY: The fixture supplies every execution-context member consumed by RolesGuard.
const asExecutionContext = (fixture: RoleContextFixture): ExecutionContext =>
  fixture as ExecutionContext;

const makeContext = (role: string | undefined) => {
  const request = { user: role ? { role } : undefined };
  // SAFETY: RolesGuard only calls getHandler, getClass, and switchToHttp().getRequest(),
  // which this double provides.
  return asExecutionContext({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  });
};

describe('RolesGuard', () => {
  let reflector: Pick<Reflector, 'getAllAndOverride'>;
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    // SAFETY: this test double provides getAllAndOverride and adopts Reflector's prototype.
    guard = new RolesGuard(Object.setPrototypeOf(reflector, Reflector.prototype) as Reflector);
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
