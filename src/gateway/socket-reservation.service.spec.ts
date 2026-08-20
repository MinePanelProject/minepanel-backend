import { EventEmitter } from 'node:events';
import { SocketReservationService } from './socket-reservation.service';

type Raw = EventEmitter & { id: string | number; close: jest.Mock };

const raw = (id: string | number): Raw => {
  const connection =
    /* SAFETY: raw() is the Engine.IO test producer; reserve() reads id and close and
    subscribes through EventEmitter's on member, all supplied by this concrete double. */
    new EventEmitter() as Raw;
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
    // SAFETY: raw() is the Engine.IO producer; its concrete connection contract provides id,
    // close, and on members consumed by reserve().
    const reservedConnection = connection as never;
    service.reserve(reservedConnection);
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

    service.reserve(
      /* SAFETY: raw() produces the Engine.IO connection id and close/on members consumed by
      reserve(); setTimeout produces the timer whose unref member this test reads. */ connection as never,
    );
    const timer =
      /* SAFETY: setTimeout is the timer producer; this test reads its unref member and advances
      the Jest-controlled deadline to verify close is called. */ unref.mock.results[0]
        ?.value as NodeJS.Timeout;
    expect(timer.unref).toBeDefined();
    jest.advanceTimersByTime(5000);

    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(service.claim('raw-timeout')).toBe(false);
    unref.mockRestore();
  });

  it('releases when the raw connection closes and tolerates duplicate close events', () => {
    const service = new SocketReservationService();
    const connection = raw('raw-close');

    // SAFETY: raw() is the Engine.IO producer; its concrete connection contract supplies id,
    // close, and on members consumed by reserve().
    const reservedConnection = connection as never;
    service.reserve(reservedConnection);
    connection.emit('close');
    connection.emit('close');

    expect(service.claim('raw-close')).toBe(false);
    expect(connection.close).not.toHaveBeenCalled();
  });

  it('closes a newly established connection at the 100-client cap', () => {
    const service = new SocketReservationService();
    const connections = Array.from({ length: 101 }, (_, index) => raw(`raw-${index}`));

    for (const connection of connections) {
      service.reserve(
        /* SAFETY: raw() is the Engine.IO producer; reserve() consumes each double's exact id,
        close, and EventEmitter on members to enforce the admission contract. */ connection as never,
      );
    }

    expect(
      connections.slice(0, 100).every((connection) => connection.close.mock.calls.length === 0),
    ).toBe(true);
    expect(connections[100].close).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate, empty, and non-string raw ids', () => {
    const service = new SocketReservationService();
    const first = raw('duplicate');
    const second = raw('duplicate');
    const empty = raw('');
    const malformed = raw(1);
    service.reserve(
      /* SAFETY: raw() produces the Engine.IO double's exact id, close, and EventEmitter on
      members consumed by reserve() for duplicate-id validation. */ first as never,
    );
    service.reserve(
      /* SAFETY: raw() produces the Engine.IO double's exact id, close, and EventEmitter on
      members consumed by reserve() for duplicate-id rejection. */ second as never,
    );
    service.reserve(
      /* SAFETY: raw() produces the Engine.IO double's exact id, close, and EventEmitter on
      members consumed by reserve() for empty-id rejection. */ empty as never,
    );
    service.reserve(
      /* SAFETY: raw() produces the Engine.IO double's exact id, close, and EventEmitter on
      members consumed by reserve() for non-string-id rejection. */ malformed as never,
    );

    expect(second.close).toHaveBeenCalledTimes(1);
    expect(empty.close).toHaveBeenCalledTimes(1);
    expect(malformed.close).toHaveBeenCalledTimes(1);
    expect(service.claim('duplicate')).toBe(true);
  });

  it('cleans all pending reservations on module destruction', () => {
    const service = new SocketReservationService();
    const connections = [raw('a'), raw('b')];
    connections.forEach((connection) => {
      // SAFETY: raw() is the Engine.IO producer; its concrete connection contract supplies id,
      // close, and on members consumed by reserve().
      const reservedConnection = connection as never;
      service.reserve(reservedConnection);
    });

    service.onModuleDestroy();

    expect(connections[0].close).toHaveBeenCalledTimes(1);
    expect(connections[1].close).toHaveBeenCalledTimes(1);
    expect(service.claim('a')).toBe(false);
    expect(service.claim('b')).toBe(false);
  });
});
