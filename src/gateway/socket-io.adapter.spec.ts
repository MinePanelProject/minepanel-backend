import type { IncomingMessage } from 'node:http';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';
import { SocketIoAdapter } from './socket-io.adapter';
import { SocketReservationService } from './socket-reservation.service';

const request = (headers: IncomingMessage['headers']) => ({ headers }) as IncomingMessage;

describe('SocketIoAdapter', () => {
  let adapter: SocketIoAdapter;
  let createServerSpy: jest.SpyInstance;
  let fakeServer: { opts: ServerOptions; engine: { on: jest.Mock }; close: jest.Mock };

  beforeEach(() => {
    const config = {
      get: jest.fn().mockReturnValue('http://localhost:5173'),
    } as unknown as ConfigService;
    adapter = new SocketIoAdapter(new SocketReservationService(), config, {});
    fakeServer = { opts: {}, engine: { on: jest.fn() }, close: jest.fn() };
    createServerSpy = jest
      .spyOn(IoAdapter.prototype, 'createIOServer')
      .mockReturnValue(fakeServer as never);
  });

  afterEach(() => {
    createServerSpy.mockRestore();
  });

  it('forces the hardened Socket.IO options', () => {
    adapter.createIOServer(0);
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
    (
      adapter as unknown as {
        allowRequest: (req: unknown, cb: (err: Error | null, allow: boolean) => void) => void;
      }
    ).allowRequest(request(headers), callback);

    expect(callback).toHaveBeenCalledWith(null, allowed);
  });

  it.each([
    ['no origin and no cookie', {}, true],
    ['empty cookie header', { cookie: '' }, false],
    ['duplicate cookie header', { cookie: ['a=1', 'b=2'] }, false],
    ['unrelated cookie header', { cookie: 'csrf=abc' }, false],
  ] as const)('handles %s', (_label, headers, allowed) => {
    const callback = jest.fn();
    (
      adapter as unknown as {
        allowRequest: (req: unknown, cb: (err: Error | null, allow: boolean) => void) => void;
      }
    ).allowRequest(request(headers), callback);

    expect(callback).toHaveBeenCalledWith(null, allowed);
  });

  it('merges caller options before forcing security options', () => {
    adapter.createIOServer(0, {
      cors: { origin: 'http://evil.test', credentials: false },
      maxHttpBufferSize: 1,
      perMessageDeflate: true,
      connectTimeout: 1,
    });
    const options = createServerSpy.mock.calls[0]?.[1] as ServerOptions;

    expect(options.cors).toEqual({ origin: 'http://localhost:5173', credentials: true });
    expect(options.maxHttpBufferSize).toBe(16 * 1024);
    expect(options.perMessageDeflate).toBe(false);
    expect(options.connectTimeout).toBe(5000);
  });
});
