import { EventEmitter } from 'node:events';
import { SocketReservationService } from './socket-reservation.service';

type Raw = EventEmitter & { id: string; close: jest.Mock };

const raw = (id: string): Raw => {
  const connection = new EventEmitter() as Raw;
  connection.id = id;
  connection.close = jest.fn();
  return connection;
};

describe('SocketReservationService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reserves, claims, and releases a raw Engine.IO connection idempotently', () => {
    const service = new SocketReservationService();
    const connection = raw('raw-1');

    service.reserve(connection as never);
    expect(service.claim('raw-1')).toBe(true);
    expect(service.claim('raw-1')).toBe(false);
    expect(service.release('raw-1')).toBe(true);
    expect(service.release('raw-1')).toBe(false);
    expect(connection.close).not.toHaveBeenCalled();
  });

  it('arms an unrefd five-second deadline and closes timed-out connections', () => {
    const service = new SocketReservationService();
    const connection = raw('raw-timeout');
    const unref = jest.spyOn(global, 'setTimeout');

    service.reserve(connection as never);
    const timer = unref.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.unref).toBeDefined();
    jest.advanceTimersByTime(5000);

    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(service.claim('raw-timeout')).toBe(false);
    unref.mockRestore();
  });

  it('releases when the raw connection closes and tolerates duplicate close events', () => {
    const service = new SocketReservationService();
    const connection = raw('raw-close');

    service.reserve(connection as never);
    connection.emit('close');
    connection.emit('close');

    expect(service.claim('raw-close')).toBe(false);
    expect(connection.close).not.toHaveBeenCalled();
  });

  it('closes a newly established connection at the 100-client cap', () => {
    const service = new SocketReservationService();
    const connections = Array.from({ length: 101 }, (_, index) => raw(`raw-${index}`));

    for (const connection of connections) service.reserve(connection as never);

    expect(
      connections.slice(0, 100).every((connection) => connection.close.mock.calls.length === 0),
    ).toBe(true);
    expect(connections[100].close).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate and missing raw ids', () => {
    const service = new SocketReservationService();
    const first = raw('duplicate');
    const second = raw('duplicate');
    const missing = raw('');

    service.reserve(first as never);
    service.reserve(second as never);
    service.reserve(missing as never);

    expect(second.close).toHaveBeenCalledTimes(1);
    expect(missing.close).toHaveBeenCalledTimes(1);
    expect(service.claim('duplicate')).toBe(true);
  });

  it('cleans all pending reservations on module destruction', () => {
    const service = new SocketReservationService();
    const connections = [raw('a'), raw('b')];
    connections.forEach((connection) => {
      service.reserve(connection as never);
    });

    service.onModuleDestroy();

    expect(connections[0].close).toHaveBeenCalledTimes(1);
    expect(connections[1].close).toHaveBeenCalledTimes(1);
    expect(service.claim('a')).toBe(false);
    expect(service.claim('b')).toBe(false);
  });
});
