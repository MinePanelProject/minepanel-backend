import { inspect } from 'node:util';
import { ExecutionContext, ForbiddenException, Reflector } from '@nestjs/common';
import { PermissionsGuard } from './permissions.guard';

const makeContext = ({
  role,
  params,
}: {
  role?: string;
  params?: Record<string, string>;
}): ExecutionContext => {
  const request = {
    user: role ? { id: 'user-1', role } : undefined,
    params: params ?? {},
  };
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
};

const makeDb = (cfg: { global?: boolean; scopedServerId?: string } | Error | null) => {
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
  const where = jest.fn((conditions: unknown) => {
    // behavioral: the mock "holds" either a global grant, a grant scoped to one
    // server, or nothing; match only when the query's conditions cover it
    const text = inspect(conditions, { depth: 30, maxArrayLength: 300 });
    const hasGlobalClause = text.includes('is null');
    const hasRequestedServer =
      cfg === null || cfg instanceof Error ? false : text.includes(`'${cfg.scopedServerId}'`);
    matched =
      cfg === null || cfg instanceof Error
        ? false
        : (cfg.global === true && hasGlobalClause) ||
          (typeof cfg.scopedServerId === 'string' && hasRequestedServer);
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
    reflector = { getAllAndOverride: jest.fn() };
  });

  it('passes through routes with no @RequiresPermission metadata', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue(undefined);
    const db = makeDb(null);
    guard = new PermissionsGuard(reflector as Reflector, db as never);

    await expect(guard.canActivate(makeContext({ role: 'USER' }))).resolves.toBe(true);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects a request with no authenticated principal', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue('SERVER_LIFECYCLE');
    const db = makeDb(null);
    guard = new PermissionsGuard(reflector as Reflector, db as never);

    await expect(guard.canActivate(makeContext({}))).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('allows ADMIN without querying the database', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue('SERVER_LIFECYCLE');
    const db = makeDb(null);
    guard = new PermissionsGuard(reflector as Reflector, db as never);

    await expect(
      guard.canActivate(makeContext({ role: 'ADMIN', params: { id: 'server-1' } })),
    ).resolves.toBe(true);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects a USER role before any database query', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue('SERVER_LIFECYCLE');
    const db = makeDb(null);
    guard = new PermissionsGuard(reflector as Reflector, db as never);

    await expect(
      guard.canActivate(makeContext({ role: 'USER', params: { id: 'server-1' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('allows a MOD with a global permission and no scoped route id', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue('SERVER_LIFECYCLE');
    const db = makeDb({ global: true });
    guard = new PermissionsGuard(reflector as Reflector, db as never);

    await expect(guard.canActivate(makeContext({ role: 'MOD' }))).resolves.toBe(true);
    expect(db.where).toHaveBeenCalled();
  });

  it('allows a MOD with a scoped permission on the matching route id', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue('SERVER_LIFECYCLE');
    const db = makeDb({ scopedServerId: 'server-1' });
    guard = new PermissionsGuard(reflector as Reflector, db as never);

    await expect(
      guard.canActivate(makeContext({ role: 'MOD', params: { id: 'server-1' } })),
    ).resolves.toBe(true);
  });

  it('rejects a MOD whose global permission does not cover a scoped route', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue('SERVER_LIFECYCLE');
    const db = makeDb(null);
    guard = new PermissionsGuard(reflector as Reflector, db as never);

    await expect(
      guard.canActivate(makeContext({ role: 'MOD', params: { id: 'server-1' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a MOD with only a differently-scoped permission', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue('SERVER_LIFECYCLE');
    const db = makeDb({ scopedServerId: 'server-1' });
    guard = new PermissionsGuard(reflector as Reflector, db as never);

    await expect(
      guard.canActivate(makeContext({ role: 'MOD', params: { id: 'server-2' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('treats an empty route id as global-only and rejects a scoped-only grant', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue('SERVER_LIFECYCLE');
    const db = makeDb({ scopedServerId: 'server-1' });
    guard = new PermissionsGuard(reflector as Reflector, db as never);

    await expect(
      guard.canActivate(makeContext({ role: 'MOD', params: { id: '' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fails closed with ServiceUnavailableException on database errors', async () => {
    reflector.getAllAndOverride = jest.fn().mockReturnValue('SERVER_LIFECYCLE');
    const db = makeDb(new Error('connection lost'));
    guard = new PermissionsGuard(reflector as Reflector, db as never);

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
    guard = new PermissionsGuard(reflector as Reflector, db as never);

    await expect(
      guard.canActivate(makeContext({ role: 'MOD', params: { id: 'server-1' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
