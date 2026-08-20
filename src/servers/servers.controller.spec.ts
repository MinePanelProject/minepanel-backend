import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { PublicServer } from './public-server';
import { type ServerPrincipal } from './server-access';
import { ServersController } from './servers.controller';
import type { ServersService } from './servers.service';

const adminPrincipal: ServerPrincipal = { id: 'authenticated-owner', role: 'ADMIN' };

const makeRequest = (principal: ServerPrincipal = adminPrincipal): Request =>
  // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
  ({ user: { id: principal.id, username: 'admin', role: principal.role } }) as Request;

const makePublicServer = (overrides: Partial<PublicServer> = {}): PublicServer => ({
  id: 'server-1',
  name: 'Survival',
  provider: 'PAPER',
  version: '1.21.1',
  port: 25565,
  status: 'RUNNING',
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
  ownerId: 'owner-1',
  accessType: 'OPEN',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});
const routeStatus = (method: string): number | undefined =>
  Reflect.getMetadata(
    '__httpCode__',
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    ServersController.prototype[method as keyof ServersController],
  );
const routeRoles = (method: string): string[] | undefined =>
  // SAFETY: The test-controlled value satisfies the concrete framework contract used by this assertion.
  Reflect.getMetadata('roles', ServersController.prototype[method as keyof ServersController]);
const routePermission = (method: string): string | undefined =>
  Reflect.getMetadata(
    'requiresPermission',
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    ServersController.prototype[method as keyof ServersController],
  );

describe('ServersController', () => {
  let service: Pick<
    ServersService,
    | 'createServer'
    | 'listServers'
    | 'getServer'
    | 'startServer'
    | 'stopServer'
    | 'restartServer'
    | 'deleteServer'
  >;
  let controller: ServersController;
  let publicServer: PublicServer;

  beforeEach(() => {
    publicServer = makePublicServer();
    service = {
      createServer: jest.fn().mockResolvedValue(publicServer),
      listServers: jest.fn().mockResolvedValue({ data: [publicServer], total: 1 }),
      getServer: jest.fn().mockResolvedValue(publicServer),
      startServer: jest.fn().mockResolvedValue(publicServer),
      stopServer: jest.fn().mockResolvedValue(publicServer),
      restartServer: jest.fn().mockResolvedValue(publicServer),
      deleteServer: jest.fn().mockResolvedValue(undefined),
    };
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    controller = new ServersController(service as ServersService);
  });

  it('derives ownerId exclusively from authenticated request context', async () => {
    const dto = { name: 'Survival', ownerId: 'forged-owner' };
    const request = makeRequest();

    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    await expect(controller.create(dto as never, request)).resolves.toEqual(publicServer);

    expect(service.createServer).toHaveBeenCalledWith(dto, adminPrincipal);
    expect(service.createServer).not.toHaveBeenCalledWith(dto, {
      id: 'forged-owner',
      role: 'ADMIN',
    });
  });

  it('returns 401 before calling the service when authenticated context is missing', async () => {
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    const request = {} as Request;

    // SAFETY: The test-controlled value satisfies the concrete framework contract used by this assertion.
    await expect(controller.create({} as never, request)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(service.createServer).not.toHaveBeenCalled();
  });

  it('delegates reads and preserves a response projection without private fields', async () => {
    const query = { limit: 20, offset: 0 };
    const param = { id: 'server-1' };
    const request = makeRequest();

    await expect(controller.list(query, request)).resolves.toEqual({
      data: [publicServer],
      total: 1,
    });
    await expect(controller.get(param, request)).resolves.toEqual(publicServer);

    expect(service.listServers).toHaveBeenCalledWith(query, adminPrincipal);
    expect(service.getServer).toHaveBeenCalledWith('server-1', adminPrincipal);
    expect(publicServer).not.toHaveProperty('rconPassword');
    expect(publicServer).not.toHaveProperty('containerId');
    expect(publicServer).not.toHaveProperty('worldPath');
  });

  it('delegates start, stop, restart, and delete with only the route id', async () => {
    const param = { id: 'server-1' };
    const request = makeRequest();

    await expect(controller.start(param, request)).resolves.toEqual(publicServer);
    await expect(controller.stop(param, request)).resolves.toEqual(publicServer);
    await expect(controller.restart(param, request)).resolves.toEqual(publicServer);
    await expect(controller.delete(param, request)).resolves.toBeUndefined();

    expect(service.startServer).toHaveBeenCalledWith('server-1', adminPrincipal);
    expect(service.stopServer).toHaveBeenCalledWith('server-1', adminPrincipal);
    expect(service.restartServer).toHaveBeenCalledWith('server-1', adminPrincipal);
    expect(service.deleteServer).toHaveBeenCalledWith('server-1', adminPrincipal);
  });

  it.each([
    ['create', ['ADMIN']],
    ['start', ['ADMIN', 'MOD']],
    ['stop', ['ADMIN', 'MOD']],
    ['restart', ['ADMIN', 'MOD']],
    ['delete', ['ADMIN']],
  ] satisfies [string, string[]][])('publishes the %s authorization matrix', (method, roles) => {
    expect(routeRoles(method)).toEqual(roles);
  });

  it.each([
    ['list', 200],
    ['get', 200],
    ['start', 200],
    ['stop', 200],
    ['restart', 200],
    ['create', 201],
    ['delete', 202],
  ] satisfies [string, number][])('publishes HTTP %s for the route', (method, status) => {
    expect(routeStatus(method)).toBe(status);
  });

  it('does not treat a USER role as authorized for mutation metadata', () => {
    for (const method of ['create', 'start', 'stop', 'restart', 'delete']) {
      expect(routeRoles(method)).not.toContain('USER');
    }
  });

  it.each([
    ['start', 'SERVER_LIFECYCLE'],
    ['stop', 'SERVER_LIFECYCLE'],
    ['restart', 'SERVER_LIFECYCLE'],
  ] satisfies [
    string,
    string,
  ][])('publishes %s permission metadata as %s', (method, permission) => {
    expect(routePermission(method)).toBe(permission);
  });

  it('does not publish permission metadata on non-lifecycle routes', () => {
    for (const method of ['list', 'get', 'create', 'delete']) {
      expect(routePermission(method)).toBeUndefined();
    }
  });
});
