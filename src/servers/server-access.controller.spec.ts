import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { ServerAccessController } from './server-access.controller';
import type { ServerAccessService } from './server-access.service';

const makeRequest = (role: string, id = 'user-1'): Request =>
  ({ user: { id, username: 'player', role } }) as unknown as Request;

describe('ServerAccessController', () => {
  let service: Pick<
    ServerAccessService,
    'requestAccess' | 'getMyAccessRequest' | 'listAccessRequests' | 'approveAccess' | 'revokeAccess'
  >;
  let controller: ServerAccessController;

  beforeEach(() => {
    service = {
      requestAccess: jest.fn(),
      getMyAccessRequest: jest.fn(),
      listAccessRequests: jest.fn(),
      approveAccess: jest.fn(),
      revokeAccess: jest.fn(),
    };
    controller = new ServerAccessController(service as ServerAccessService);
  });

  it('delegates request-access with the principal extracted from the request', async () => {
    const projection = {
      status: 'PENDING' as const,
      requestedAt: new Date(),
      approvedAt: null,
    };
    service.requestAccess = jest.fn().mockResolvedValue(projection);

    await expect(
      controller.requestAccess({ id: 'server-1' } as never, makeRequest('USER')),
    ).resolves.toEqual(projection);
    expect(service.requestAccess).toHaveBeenCalledWith('server-1', { id: 'user-1', role: 'USER' });
  });

  it('rejects an unauthenticated request before reaching the service', async () => {
    await expect(
      controller.requestAccess({ id: 'server-1' } as never, {} as Request),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.requestAccess).not.toHaveBeenCalled();
  });

  it('delegates my-access-request with the principal', async () => {
    const projection = {
      status: 'PENDING' as const,
      requestedAt: new Date(),
      approvedAt: null,
    };
    service.getMyAccessRequest = jest.fn().mockResolvedValue(projection);

    await expect(
      controller.getMyAccessRequest({ id: 'server-1' } as never, makeRequest('USER')),
    ).resolves.toEqual(projection);
    expect(service.getMyAccessRequest).toHaveBeenCalledWith('server-1', {
      id: 'user-1',
      role: 'USER',
    });
  });

  it('delegates list-access-requests with only the server id', async () => {
    service.listAccessRequests = jest.fn().mockResolvedValue([]);

    await expect(controller.listAccessRequests({ id: 'server-1' } as never)).resolves.toEqual([]);
    expect(service.listAccessRequests).toHaveBeenCalledWith('server-1');
  });

  it('delegates approve-access with both ids', async () => {
    const projection = {
      userId: 'user-2',
      username: 'player',
      email: 'player@example.com',
      status: 'APPROVED' as const,
      requestedAt: new Date(),
      approvedAt: new Date(),
    };
    service.approveAccess = jest.fn().mockResolvedValue(projection);

    await expect(
      controller.approveAccess({ id: 'server-1', userId: 'user-2' } as never),
    ).resolves.toEqual(projection);
    expect(service.approveAccess).toHaveBeenCalledWith('server-1', 'user-2');
  });

  it('delegates revoke-access with both ids and returns no content', async () => {
    service.revokeAccess = jest.fn().mockResolvedValue(undefined);

    await expect(
      controller.revokeAccess({ id: 'server-1', userId: 'user-2' } as never),
    ).resolves.toBeUndefined();
    expect(service.revokeAccess).toHaveBeenCalledWith('server-1', 'user-2');
  });

  it.each([
    ['requestAccess', 201],
    ['getMyAccessRequest', 200],
    ['listAccessRequests', 200],
    ['approveAccess', 200],
    ['revokeAccess', 204],
  ] as [keyof ServerAccessController, number][])('publishes HTTP %s for %s', (method, status) => {
    expect(Reflect.getMetadata('__httpCode__', ServerAccessController.prototype[method])).toBe(
      status,
    );
  });

  it('marks ADMIN-only routes with the ADMIN role metadata', () => {
    const adminRoutes = ['listAccessRequests', 'approveAccess', 'revokeAccess'];
    for (const method of adminRoutes) {
      expect(Reflect.getMetadata('roles', ServerAccessController.prototype[method])).toContain(
        'ADMIN',
      );
    }
  });
});
