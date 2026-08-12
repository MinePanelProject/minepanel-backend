import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { PublicServer } from './public-server';
import { ServersController } from './servers.controller';
import type { ServersService } from './servers.service';

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
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});
const routeStatus = (method: string): number | undefined =>
  Reflect.getMetadata(
    '__httpCode__',
    ServersController.prototype[method as keyof ServersController],
  );
const routeRoles = (method: string): string[] | undefined =>
  Reflect.getMetadata('roles', ServersController.prototype[method as keyof ServersController]);

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
    controller = new ServersController(service as ServersService);
  });

  it('derives ownerId exclusively from authenticated request context', async () => {
    const dto = { name: 'Survival', ownerId: 'forged-owner' };
    const request = { user: { id: 'authenticated-owner', role: 'ADMIN' } } as unknown as Request;

    await expect(controller.create(dto as never, request)).resolves.toEqual(publicServer);

    expect(service.createServer).toHaveBeenCalledWith(dto, 'authenticated-owner');
    expect(service.createServer).not.toHaveBeenCalledWith(dto, 'forged-owner');
  });

  it('returns 401 before calling the service when authenticated context is missing', async () => {
    const request = {} as Request;

    await expect(controller.create({} as never, request)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(service.createServer).not.toHaveBeenCalled();
  });

  it('delegates reads and preserves a response projection without private fields', async () => {
    const query = { limit: 20, offset: 0 };
    const param = { id: 'server-1' };

    await expect(controller.list(query)).resolves.toEqual({ data: [publicServer], total: 1 });
    await expect(controller.get(param)).resolves.toEqual(publicServer);

    expect(service.listServers).toHaveBeenCalledWith(query);
    expect(service.getServer).toHaveBeenCalledWith('server-1');
    expect(publicServer).not.toHaveProperty('rconPassword');
    expect(publicServer).not.toHaveProperty('containerId');
    expect(publicServer).not.toHaveProperty('worldPath');
  });

  it('delegates start, stop, restart, and delete with only the route id', async () => {
    const param = { id: 'server-1' };

    await expect(controller.start(param)).resolves.toEqual(publicServer);
    await expect(controller.stop(param)).resolves.toEqual(publicServer);
    await expect(controller.restart(param)).resolves.toEqual(publicServer);
    await expect(controller.delete(param)).resolves.toBeUndefined();

    expect(service.startServer).toHaveBeenCalledWith('server-1');
    expect(service.stopServer).toHaveBeenCalledWith('server-1');
    expect(service.restartServer).toHaveBeenCalledWith('server-1');
    expect(service.deleteServer).toHaveBeenCalledWith('server-1');
  });

  it.each([
    ['create', ['ADMIN']],
    ['start', ['ADMIN', 'MOD']],
    ['stop', ['ADMIN', 'MOD']],
    ['restart', ['ADMIN', 'MOD']],
    ['delete', ['ADMIN']],
  ] as [string, string[]][])('publishes the %s authorization matrix', (method, roles) => {
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
  ] as [string, number][])('publishes HTTP %s for the route', (method, status) => {
    expect(routeStatus(method)).toBe(status);
  });

  it('does not treat a USER role as authorized for mutation metadata', () => {
    for (const method of ['create', 'start', 'stop', 'restart', 'delete']) {
      expect(routeRoles(method)).not.toContain('USER');
    }
  });
});
