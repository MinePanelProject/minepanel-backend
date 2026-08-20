import { inspect } from 'node:util';
import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { SQL } from 'drizzle-orm';
import { PermissionsGuard } from './permissions.guard';

type PermissionsContextFixture = {
  getHandler: () => void;
  getClass: () => void;
  switchToHttp: () => { getRequest: () => PermissionsRequest };
  request?: PermissionsRequest;
};
// SAFETY: The fixture supplies every execution-context member consumed by PermissionsGuard.
const asExecutionContext = (fixture: PermissionsContextFixture): ExecutionContext =>
  fixture as ExecutionContext;
type PermissionConfig = { global?: boolean; scopedServerId?: string } | Error | null;
type PermissionsRequest = {
  user?: { id: string; role: string };
  params: Record<string, string>;
};

const isScopedConfig = (
  value: PermissionConfig,
): value is { global?: boolean; scopedServerId: string } =>
  value !== null && !(value instanceof Error) && typeof value.scopedServerId === 'string';
type MockDatabase = {
  select: jest.Mock;
  from: jest.Mock;
  where: jest.Mock;
  limit: jest.Mock;
};
const makeContext = ({
  role,
  params,
}: {
  role?: string;
  params?: Record<string, string>;
}): ExecutionContext => {
  const request: PermissionsRequest = {
    user: role ? { id: 'user-1', role } : undefined,
    params: params ?? {},
  };
  // SAFETY: PermissionsGuard only calls getHandler, getClass, and switchToHttp().getRequest();
  // request is exposed for focused assertions.
  return asExecutionContext({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
    request,
  });
};

const makeDb = (cfg: PermissionConfig): MockDatabase => {
  let matched = false;
  const limit = jest.fn().mockImplementation(async () => {
    if (cfg instanceof Error) throw cfg;
    if (matched === false || cfg === null) return [];
    return [
      {
        id: 'perm-1',
        userId: 'user-1',
        permission: 'SERVER_LIFECYCLE',
        serverId: cfg.scopedServerId ?? null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];
  });
  const where = jest.fn((conditions: SQL) => {
    // behavioral: the mock "holds" either a global grant, a grant scoped to one
    // server, or nothing; match only when the query's conditions cover it
    const text = inspect(conditions, { depth: 30, maxArrayLength: 300 });
    const hasGlobalClause = text.includes('is null');
    const hasRequestedServer = isScopedConfig(cfg)
      ? text.includes(`'${cfg.scopedServerId}'`)
      : false;
    matched =
      cfg === null || cfg instanceof Error
        ? false
        : (cfg.global === true && hasGlobalClause) || (isScopedConfig(cfg) && hasRequestedServer);
    return { limit };
  });
  const from = jest.fn(() => ({ where }));
  const select = jest.fn(() => ({ from }));
  return { select, from, where, limit };
};

describe('PermissionsGuard', () => {
  let reflector: Pick<Reflector, 'getAllAndOverride'>;
  let guard: PermissionsGuard;

  beforeEach(() => {
    // SAFETY: PermissionsGuard only calls reflector.getAllAndOverride, which this double provides.
    reflector = { getAllAndOverride: jest.fn() };
  });

  const makeGuard = (db: MockDatabase): PermissionsGuard => {
    // SAFETY: this test double provides getAllAndOverride and adopts Reflector's prototype.
    return new PermissionsGuard(
      Object.setPrototypeOf(reflector, Reflector.prototype) as Reflector,
      db,
    );
  };

  it('passes through routes with no @RequiresPermission metadata', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue(undefined);
    const db = makeDb(null);
    guard = makeGuard(db);

    await expect(guard.canActivate(makeContext({ role: 'USER' }))).resolves.toBe(true);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects a request with no authenticated principal', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue('SERVER_LIFECYCLE');
    const db = makeDb(null);
    guard = makeGuard(db);

    await expect(guard.canActivate(makeContext({}))).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('allows ADMIN without querying the database', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue('SERVER_LIFECYCLE');
    const db = makeDb(null);
    guard = makeGuard(db);

    await expect(
      guard.canActivate(makeContext({ role: 'ADMIN', params: { id: 'server-1' } })),
    ).resolves.toBe(true);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects a USER role before any database query', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue('SERVER_LIFECYCLE');
    const db = makeDb(null);
    guard = makeGuard(db);

    await expect(
      guard.canActivate(makeContext({ role: 'USER', params: { id: 'server-1' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('allows a MOD with a global permission and no scoped route id', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue('SERVER_LIFECYCLE');
    const db = makeDb({ global: true });
    guard = makeGuard(db);

    await expect(guard.canActivate(makeContext({ role: 'MOD' }))).resolves.toBe(true);
    expect(db.where).toHaveBeenCalled();
  });

  it('allows a MOD with a scoped permission on the matching route id', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue('SERVER_LIFECYCLE');
    const db = makeDb({ scopedServerId: 'server-1' });
    guard = makeGuard(db);

    await expect(
      guard.canActivate(makeContext({ role: 'MOD', params: { id: 'server-1' } })),
    ).resolves.toBe(true);
  });

  it('rejects a MOD whose global permission does not cover a scoped route', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue('SERVER_LIFECYCLE');
    const db = makeDb(null);
    guard = makeGuard(db);

    await expect(
      guard.canActivate(makeContext({ role: 'MOD', params: { id: 'server-1' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a MOD with only a differently-scoped permission', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue('SERVER_LIFECYCLE');
    const db = makeDb({ scopedServerId: 'server-1' });
    guard = makeGuard(db);

    await expect(
      guard.canActivate(makeContext({ role: 'MOD', params: { id: 'server-2' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('treats an empty route id as global-only and rejects a scoped-only grant', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue('SERVER_LIFECYCLE');
    const db = makeDb({ scopedServerId: 'server-1' });
    guard = makeGuard(db);

    await expect(
      guard.canActivate(makeContext({ role: 'MOD', params: { id: '' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fails closed with ServiceUnavailableException on database errors', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue('SERVER_LIFECYCLE');
    const db = makeDb(new Error('connection lost'));
    guard = makeGuard(db);

    await expect(
      guard.canActivate(makeContext({ role: 'MOD', params: { id: 'server-1' } })),
    ).rejects.toMatchObject({
      status: 503,
      response: { message: 'Permission check unavailable' },
    });
  });

  it('rethrows ForbiddenException from the database branch unchanged', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue('SERVER_LIFECYCLE');
    const db = makeDb(null);
    guard = makeGuard(db);

    await expect(
      guard.canActivate(makeContext({ role: 'MOD', params: { id: 'server-1' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
