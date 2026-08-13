import { NotFoundException } from '@nestjs/common';
import { type DrizzleDB } from 'src/db/db.module';
import { serverAccess, servers, users } from 'src/db/schema';
import { ServerAccessService } from './server-access.service';

type ServerRow = typeof servers.$inferSelect;
type ServerAccessRow = typeof serverAccess.$inferSelect;
type UserRow = typeof users.$inferSelect;

const makeServer = (overrides: Partial<ServerRow> = {}): ServerRow => ({
  id: 'server-1',
  name: 'Survival',
  provider: 'PAPER',
  version: '1.21.1',
  port: 25565,
  containerId: 'container-1',
  status: 'STOPPED',
  maxPlayers: 20,
  difficulty: 'NORMAL',
  gamemode: 'SURVIVAL',
  pvp: true,
  memoryLimitMb: 2048,
  motd: null,
  levelSeed: null,
  onlineMode: true,
  viewDistance: 10,
  allowFlight: false,
  worldPath: '/mc-data/server-1',
  rconPassword: 'secret',
  ownerId: 'owner-1',
  accessType: 'REQUEST',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

const makeUser = (overrides: Partial<UserRow> = {}): UserRow => ({
  id: 'user-1',
  email: 'user@example.com',
  username: 'player',
  passwordHash: 'hash',
  role: 'USER',
  status: 'ACTIVE',
  totpSecret: null,
  totpEnabled: false,
  totpBackupCodes: null,
  tempPasswordHash: null,
  tempPasswordExpiresAt: null,
  mustChangePassword: false,
  minecraftUUID: null,
  minecraftName: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

const makeAccess = (overrides: Partial<ServerAccessRow> = {}): ServerAccessRow => ({
  id: 'access-1',
  userId: 'user-1',
  serverId: 'server-1',
  status: 'PENDING',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  approvedAt: null,
  ...overrides,
});

describe('ServerAccessService', () => {
  let service: ServerAccessService;
  let selectRows: unknown[][];
  let insertReturning: (ServerAccessRow | undefined)[];
  let updateReturning: (ServerAccessRow | undefined)[];
  let deleteReturning: { id: string }[][];
  let insertedValues: Record<string, unknown>[];
  let updatedValues: Record<string, unknown>[];
  let db: DrizzleDB;

  const mockSelect = () => {
    const chain = {
      from: jest.fn(() => chain),
      innerJoin: jest.fn(() => chain),
      where: jest.fn(() => chain),
      orderBy: jest.fn(async () => selectRows.shift() ?? []),
      limit: jest.fn(async () => selectRows.shift() ?? []),
    };
    return chain;
  };

  beforeEach(() => {
    selectRows = [];
    insertReturning = [];
    updateReturning = [];
    deleteReturning = [];
    insertedValues = [];
    updatedValues = [];

    db = {
      select: jest.fn(mockSelect),
      insert: jest.fn(() => ({
        values: jest.fn((values: Record<string, unknown>) => {
          insertedValues.push(values);
          const row = insertReturning.shift();
          return {
            onConflictDoNothing: jest.fn(() => ({
              returning: jest.fn().mockResolvedValue(row ? [row] : []),
            })),
          };
        }),
      })),
      update: jest.fn(() => ({
        set: jest.fn((values: Record<string, unknown>) => {
          updatedValues.push(values);
          return {
            where: jest.fn(() => ({
              returning: jest.fn(async () => {
                const row = updateReturning.shift();
                return row ? [row] : [];
              }),
            })),
          };
        }),
      })),
      delete: jest.fn(() => ({
        where: jest.fn(() => ({
          returning: jest.fn(async () => deleteReturning.shift() ?? []),
        })),
      })),
    } as unknown as DrizzleDB;

    service = new ServerAccessService(db);
  });

  describe('requestAccess', () => {
    it('creates a PENDING row on a REQUEST server for a non-admin principal', async () => {
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);
      insertReturning.push(makeAccess({ status: 'PENDING', approvedAt: null }));

      const result = await service.requestAccess('server-1', { id: 'user-1', role: 'USER' });

      expect(result.status).toBe('PENDING');
      expect(result.approvedAt).toBeNull();
      expect(insertedValues[0]).toEqual(
        expect.objectContaining({ serverId: 'server-1', userId: 'user-1', status: 'PENDING' }),
      );
    });

    it('rejects ADMIN principals with a 409', async () => {
      await expect(
        service.requestAccess('server-1', { id: 'admin-1', role: 'ADMIN' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { message: 'Admins already have access to all servers' },
      });
    });

    it('rejects OPEN servers with a 409', async () => {
      selectRows.push([makeServer({ accessType: 'OPEN' })]);

      await expect(
        service.requestAccess('server-1', { id: 'user-1', role: 'USER' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { message: 'Server access is already open' },
      });
    });

    it('hides PRIVATE servers with a 404 non-disclosure response', async () => {
      selectRows.push([makeServer({ accessType: 'PRIVATE' })]);

      await expect(
        service.requestAccess('server-1', { id: 'user-1', role: 'USER' }),
      ).rejects.toMatchObject({
        status: 404,
        response: { message: 'Server not found' },
      });
    });

    it('reports an existing PENDING request as a 409', async () => {
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);
      insertReturning.push(undefined);
      selectRows.push([makeAccess({ status: 'PENDING', approvedAt: null })]);

      await expect(
        service.requestAccess('server-1', { id: 'user-1', role: 'USER' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { message: 'Access request already pending' },
      });
    });

    it('reports an existing APPROVED request as a 409', async () => {
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);
      insertReturning.push(undefined);
      selectRows.push([makeAccess({ status: 'APPROVED', approvedAt: new Date() })]);

      await expect(
        service.requestAccess('server-1', { id: 'user-1', role: 'USER' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { message: 'Server access already approved' },
      });
    });

    it('retries once when a concurrent revoke removes the conflicting row', async () => {
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);
      insertReturning.push(undefined);
      selectRows.push([]); // re-read finds no row
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);
      insertReturning.push(makeAccess({ status: 'PENDING', approvedAt: null }));

      const result = await service.requestAccess('server-1', { id: 'user-1', role: 'USER' });

      expect(result.status).toBe('PENDING');
      expect(insertedValues).toHaveLength(2);
    });

    it('falls back to 404 when the retry sees a non-REQUEST server', async () => {
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);
      insertReturning.push(undefined);
      selectRows.push([]);
      selectRows.push([makeServer({ accessType: 'PRIVATE' })]);

      await expect(
        service.requestAccess('server-1', { id: 'user-1', role: 'USER' }),
      ).rejects.toMatchObject({
        status: 404,
        response: { message: 'Server not found' },
      });
    });

    it('returns a retryable 409 when the terminal race leaves the server live REQUEST', async () => {
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);
      insertReturning.push(undefined);
      selectRows.push([]);
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);
      insertReturning.push(undefined);
      selectRows.push([]);
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);

      await expect(
        service.requestAccess('server-1', { id: 'user-1', role: 'USER' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { message: 'Access request state changed, please retry' },
      });
    });

    it('hides CREATING servers with a 404', async () => {
      selectRows.push([]);

      await expect(
        service.requestAccess('server-1', { id: 'user-1', role: 'USER' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getMyAccessRequest', () => {
    it('returns the current request projection for a REQUEST server', async () => {
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);
      selectRows.push([makeAccess({ status: 'PENDING', approvedAt: null })]);

      const result = await service.getMyAccessRequest('server-1', { id: 'user-1', role: 'USER' });

      expect(result.status).toBe('PENDING');
      expect(result.approvedAt).toBeNull();
    });

    it('returns APPROVED rows with a set approvedAt', async () => {
      const approvedAt = new Date('2026-01-02T00:00:00Z');
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);
      selectRows.push([makeAccess({ status: 'APPROVED', approvedAt })]);

      const result = await service.getMyAccessRequest('server-1', { id: 'user-1', role: 'USER' });

      expect(result.status).toBe('APPROVED');
      expect(result.approvedAt).toEqual(approvedAt);
    });

    it('reports no row on an OPEN server as 404', async () => {
      selectRows.push([makeServer({ accessType: 'OPEN' })]);

      await expect(
        service.getMyAccessRequest('server-1', { id: 'user-1', role: 'USER' }),
      ).rejects.toMatchObject({
        status: 404,
        response: { message: 'Access request not found' },
      });
    });

    it('hides PRIVATE servers with a 404', async () => {
      selectRows.push([makeServer({ accessType: 'PRIVATE' })]);

      await expect(
        service.getMyAccessRequest('server-1', { id: 'user-1', role: 'USER' }),
      ).rejects.toMatchObject({
        status: 404,
        response: { message: 'Server not found' },
      });
    });

    it('reports a missing row on a REQUEST server as 404', async () => {
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);
      selectRows.push([]);

      await expect(
        service.getMyAccessRequest('server-1', { id: 'user-1', role: 'USER' }),
      ).rejects.toMatchObject({
        status: 404,
        response: { message: 'Access request not found' },
      });
    });
  });

  describe('listAccessRequests', () => {
    it('returns sanitized PENDING rows joined to user details', async () => {
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);
      selectRows.push([
        {
          userId: 'user-1',
          username: 'player',
          email: 'player@example.com',
          status: 'PENDING',
          requestedAt: new Date('2026-01-01T00:00:00Z'),
          approvedAt: null,
        },
      ]);

      const result = await service.listAccessRequests('server-1');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        userId: 'user-1',
        username: 'player',
        email: 'player@example.com',
        status: 'PENDING',
        requestedAt: expect.any(Date),
        approvedAt: null,
      });
    });

    it('rejects OPEN servers with a 409', async () => {
      selectRows.push([makeServer({ accessType: 'OPEN' })]);

      await expect(service.listAccessRequests('server-1')).rejects.toMatchObject({
        status: 409,
        response: { message: 'Server does not use request-based access' },
      });
    });

    it('rejects PRIVATE servers with a 409', async () => {
      selectRows.push([makeServer({ accessType: 'PRIVATE' })]);

      await expect(service.listAccessRequests('server-1')).rejects.toMatchObject({
        status: 409,
        response: { message: 'Server does not use request-based access' },
      });
    });

    it('hides CREATING servers with a 404', async () => {
      selectRows.push([]);

      await expect(service.listAccessRequests('server-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('approveAccess', () => {
    it('approves an existing PENDING request atomically', async () => {
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);
      selectRows.push([makeUser({ role: 'USER' })]);
      updateReturning.push(makeAccess({ status: 'APPROVED', approvedAt: new Date() }));

      const result = await service.approveAccess('server-1', 'user-1');

      expect(result.status).toBe('APPROVED');
      expect(result.approvedAt).toBeInstanceOf(Date);
      expect(updatedValues[0]).toEqual(
        expect.objectContaining({ status: 'APPROVED', approvedAt: expect.any(Object) }),
      );
    });

    it('inserts an APPROVED row for PRIVATE assignment when no request exists', async () => {
      selectRows.push([makeServer({ accessType: 'PRIVATE' })]);
      selectRows.push([makeUser({ role: 'USER' })]);
      updateReturning.push(undefined);
      insertReturning.push(makeAccess({ status: 'APPROVED', approvedAt: new Date() }));

      const result = await service.approveAccess('server-1', 'user-1');

      expect(result.status).toBe('APPROVED');
      expect(insertedValues[0]).toEqual(
        expect.objectContaining({ status: 'APPROVED', approvedAt: expect.any(Object) }),
      );
    });

    it('rejects approval of an ADMIN target', async () => {
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);
      selectRows.push([makeUser({ role: 'ADMIN' })]);

      await expect(service.approveAccess('server-1', 'user-1')).rejects.toMatchObject({
        status: 400,
        response: { message: 'Cannot assign access to an admin' },
      });
    });

    it('rejects approval on an OPEN server', async () => {
      selectRows.push([makeServer({ accessType: 'OPEN' })]);
      selectRows.push([makeUser({ role: 'USER' })]);

      await expect(service.approveAccess('server-1', 'user-1')).rejects.toMatchObject({
        status: 409,
        response: { message: 'Server access is already open' },
      });
    });

    it('reports an already APPROVED row as a 409', async () => {
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);
      selectRows.push([makeUser({ role: 'USER' })]);
      updateReturning.push(undefined);
      selectRows.push([makeAccess({ status: 'APPROVED', approvedAt: new Date() })]);

      await expect(service.approveAccess('server-1', 'user-1')).rejects.toMatchObject({
        status: 409,
        response: { message: 'Server access already approved' },
      });
    });

    it('reports the observed PENDING state when approval retries exhaust', async () => {
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);
      selectRows.push([makeUser({ role: 'USER' })]);
      updateReturning.push(undefined);
      selectRows.push([makeAccess({ status: 'PENDING', approvedAt: null })]);
      updateReturning.push(undefined);
      selectRows.push([makeAccess({ status: 'PENDING', approvedAt: null })]);

      await expect(service.approveAccess('server-1', 'user-1')).rejects.toMatchObject({
        status: 409,
        response: { message: 'Access request still pending' },
      });
    });

    it('reports 404 when the insert-exhausted PRIVATE assignment lands on an absent row', async () => {
      selectRows.push([makeServer({ accessType: 'PRIVATE' })]);
      selectRows.push([makeUser({ role: 'USER' })]);
      updateReturning.push(undefined);
      selectRows.push([]);
      insertReturning.push(undefined);
      updateReturning.push(undefined);
      selectRows.push([]);
      insertReturning.push(undefined);
      selectRows.push([]);

      await expect(service.approveAccess('server-1', 'user-1')).rejects.toMatchObject({
        status: 404,
        response: { message: 'Access request not found' },
      });
    });

    it('returns 404 when a REQUEST server has no pending row to approve', async () => {
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);
      selectRows.push([makeUser({ role: 'USER' })]);
      updateReturning.push(undefined);
      selectRows.push([]);

      await expect(service.approveAccess('server-1', 'user-1')).rejects.toMatchObject({
        status: 404,
        response: { message: 'Access request not found' },
      });
    });

    it('retries approval when a concurrent insert wins', async () => {
      selectRows.push([makeServer({ accessType: 'PRIVATE' })]);
      selectRows.push([makeUser({ role: 'USER' })]);
      updateReturning.push(undefined);
      insertReturning.push(undefined);
      selectRows.push([makeAccess({ status: 'APPROVED', approvedAt: new Date() })]);

      await expect(service.approveAccess('server-1', 'user-1')).rejects.toMatchObject({
        status: 409,
        response: { message: 'Server access already approved' },
      });
    });

    it('hides a missing server with a 404', async () => {
      selectRows.push([]);

      await expect(service.approveAccess('server-1', 'user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('reports a missing target user with a 404', async () => {
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);
      selectRows.push([]);

      await expect(service.approveAccess('server-1', 'user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('revokeAccess', () => {
    it('deletes an existing access row and returns no content', async () => {
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);
      deleteReturning.push([{ id: 'access-1' }]);

      await expect(service.revokeAccess('server-1', 'user-1')).resolves.toBeUndefined();
    });

    it('reports a missing row with a 404', async () => {
      selectRows.push([makeServer({ accessType: 'REQUEST' })]);
      deleteReturning.push([]);

      await expect(service.revokeAccess('server-1', 'user-1')).rejects.toMatchObject({
        status: 404,
        response: { message: 'Access request not found' },
      });
    });

    it('hides a missing server with a 404', async () => {
      selectRows.push([]);

      await expect(service.revokeAccess('server-1', 'user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
