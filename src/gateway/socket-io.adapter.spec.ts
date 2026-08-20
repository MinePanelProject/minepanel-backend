import type { IncomingMessage } from 'node:http';
import { createServer } from 'node:http';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';
import { SocketIoAdapter } from './socket-io.adapter';
import { SocketReservationService } from './socket-reservation.service';

type FakeIoServer = {
  opts: Partial<ServerOptions>;
  engine: { on: jest.Mock };
  close: jest.Mock;
};
type RawHeaders = {
  origin?: string | readonly string[];
  cookie?: string | readonly string[];
};
const request = (headers: RawHeaders): Pick<IncomingMessage, 'headers'> => {
  // SAFETY: Node's runtime accepts repeated header values; this fixture preserves
  // them to exercise SocketIoAdapter's rejection of array origins/cookies.
  return {
    headers: {
      origin: headers.origin,
      cookie: headers.cookie,
    },
  } as Pick<IncomingMessage, 'headers'>;
};

describe('SocketIoAdapter', () => {
  let adapter: SocketIoAdapter;
  let createServerSpy: jest.SpyInstance;
  let fakeServer: FakeIoServer;

  beforeEach(() => {
    // SAFETY: The test-controlled value satisfies the concrete framework contract used by this assertion.
    // SAFETY: The ConfigService double exposes only get(), the sole capability SocketIoAdapter reads.
    const config = {
      get: jest.fn().mockReturnValue('http://localhost:5173'),
    } satisfies Pick<ConfigService, 'get'>;
    adapter = new SocketIoAdapter(new SocketReservationService(), config, createServer());
    fakeServer = { opts: {}, engine: { on: jest.fn() }, close: jest.fn() };
    // SAFETY: The private Socket.IO return type is represented by this fixture's reachable members.
    createServerSpy = jest
      .spyOn(IoAdapter.prototype, 'createIOServer')
      .mockReturnValue(fakeServer as never);
  });

  afterEach(() => {
    createServerSpy.mockRestore();
  });

  it('forces the hardened Socket.IO options', () => {
    adapter.createIOServer(0);
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    const options = createServerSpy.mock.calls[0]?.[1] as ServerOptions;

    expect(options.cors).toEqual({ origin: 'http://localhost:5173', credentials: true });
    expect(options.maxHttpBufferSize).toBe(16 * 1024);
    expect(options.perMessageDeflate).toBe(false);
    expect(options.connectTimeout).toBe(5000);
    expect(options.connectionStateRecovery).toBe(false);
    expect(fakeServer.engine.on).toHaveBeenCalledWith('connection', expect.any(Function));
  });

  it.each([
    ['exact origin', { origin: 'http://localhost:5173' }, true],
    ['canonical default port', { origin: 'http://localhost:5173/' }, true],
    ['foreign origin', { origin: 'http://evil.test' }, false],
    ['null origin', { origin: 'null' }, false],
    ['malformed origin', { origin: 'not an origin' }, false],
    ['whitespace origin', { origin: ' http://localhost:5173' }, false],
    ['array origin', { origin: ['http://localhost:5173'] }, false],
  ] as const)('handles %s', (_label, headers, allowed) => {
    const callback = jest.fn();
    adapter.allowRequest(request(headers), callback);

    expect(callback).toHaveBeenCalledWith(null, allowed);
  });

  it.each([
    ['no origin and no cookie', {}, true],
    ['empty cookie header', { cookie: '' }, false],
    ['duplicate cookie header', { cookie: ['a=1', 'b=2'] }, false],
    ['unrelated cookie header', { cookie: 'csrf=abc' }, false],
  ] as const)('handles %s', (_label, headers, allowed) => {
    const callback = jest.fn();
    adapter.allowRequest(request(headers), callback);

    expect(callback).toHaveBeenCalledWith(null, allowed);
  });

  it('merges caller options before forcing security options', () => {
    // SAFETY: Only caller options overridden by SocketIoAdapter are needed for this test.
    adapter.createIOServer(0, {
      cors: { origin: 'http://evil.test', credentials: false },
      maxHttpBufferSize: 1,
      perMessageDeflate: true,
      connectTimeout: 1,
    } as ServerOptions);
    // SAFETY: The spy records the concrete ServerOptions passed to the base adapter.
    const options = createServerSpy.mock.calls[0]?.[1] as ServerOptions;

    expect(options.cors).toEqual({ origin: 'http://localhost:5173', credentials: true });
    expect(options.maxHttpBufferSize).toBe(16 * 1024);
    expect(options.perMessageDeflate).toBe(false);
    expect(options.connectTimeout).toBe(5000);
  });
});
