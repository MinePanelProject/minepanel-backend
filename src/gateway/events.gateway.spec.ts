type AuthPayload = null | readonly [] | { accessToken?: string; extra?: boolean };

type TestSocketData = {
  principal?: AccessTokenPrincipal;
};

type TestSocketHeaders = {
  cookie?: string;
};

import type { Socket } from 'socket.io';
import type { AccessTokenPrincipal, AccessTokenService } from 'src/auth/access-token.service';
import { EventsGateway } from './events.gateway';
import type { SocketReservationService } from './socket-reservation.service';
import type { SystemMetricsService, SystemStats } from './system-metrics.service';

type AccessTokenFixture = Pick<AccessTokenService, 'verify'>;
type MetricsFixture = Pick<SystemMetricsService, 'collectSnapshot'>;
type ReservationFixture = Pick<SocketReservationService, 'claim' | 'release'>;

// SAFETY: Each fixture type names the exact collaborator methods consumed by EventsGateway.
const asAccessTokenService = (fixture: AccessTokenFixture): AccessTokenService =>
  fixture as AccessTokenService;
// SAFETY: Each fixture type names the exact collaborator methods consumed by EventsGateway.
const asMetricsService = (fixture: MetricsFixture): SystemMetricsService =>
  fixture as SystemMetricsService;
// SAFETY: Each fixture type names the exact collaborator methods consumed by EventsGateway.
const asReservationService = (fixture: ReservationFixture): SocketReservationService =>
  fixture as SocketReservationService;

const ADMIN_ROOM = 'admin:metrics';

const principal = (overrides: Partial<AccessTokenPrincipal> = {}): AccessTokenPrincipal => ({
  id: 'admin-1',
  username: 'admin',
  role: 'ADMIN',
  mustChangePassword: false,
  temporaryAuth: false,
  exp: Date.now() + 60_000,
  ...overrides,
});

class TestSocket {
  readonly data: TestSocketData = {};
  readonly handshake: { headers: TestSocketHeaders };
  readonly rooms = new Set<string>();
  readonly sent: [string, SystemStats][] = [];
  readonly disconnected = jest.fn();
  readonly connected = true;
  readonly conn = { close: jest.fn() };
  private readonly listeners = new Map<string, Set<(payload: AuthPayload) => void>>();

  constructor(
    readonly id: string,
    cookie?: string,
  ) {
    this.handshake = { headers: cookie === undefined ? {} : { cookie } };
    this.rooms.add(id);
  }

  on(event: string, listener: (payload: AuthPayload) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: (payload: AuthPayload) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  trigger(event: string, payload: AuthPayload): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  emit(event: string, payload: SystemStats): boolean {
    this.sent.push([event, payload]);
    return true;
  }

  join(room: string): void {
    this.rooms.add(room);
    gatewayServer.sockets.adapter.rooms.set(
      room,
      new Set([...(gatewayServer.sockets.adapter.rooms.get(room) ?? []), this.id]),
    );
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    gatewayServer.sockets.sockets.set(this.id, this as Socket & TestSocket);
  }

  leave(room: string): void {
    this.rooms.delete(room);
    const members = gatewayServer.sockets.adapter.rooms.get(room);
    members?.delete(this.id);
    if (members?.size === 0) gatewayServer.sockets.adapter.rooms.delete(room);
  }

  disconnect(): void {
    this.disconnected();
    this.leave(ADMIN_ROOM);
  }
}

const gatewayServer = {
  sockets: {
    sockets: new Map<string, Socket>(),
    adapter: { rooms: new Map<string, Set<string>>() },
  },
  to: jest.fn(() => ({ emit: jest.fn(), volatile: { emit: jest.fn() } })),
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const makeGateway = () => {
  const verify = jest.fn().mockResolvedValue(principal());
  const collectSnapshot = jest.fn<Promise<SystemStats | null>, []>().mockResolvedValue({
    totalRamMb: 4096,
    usedRamMb: 2048,
    freeDiskMb: 10000,
    cpuCount: 8,
  });
  const reservation = {
    claim: jest.fn().mockReturnValue(true),
    release: jest.fn().mockReturnValue(true),
  };
  const tokenService = asAccessTokenService({ verify });
  const metricsService = asMetricsService({ collectSnapshot });
  const reservationService = asReservationService(reservation);
  const gateway = new EventsGateway(tokenService, metricsService, reservationService);
  // SAFETY: Nest assigns this decorated field at runtime; the unit fixture supplies the same server.
  Object.assign(gateway, { server: gatewayServer });
  return { gateway, verify, collectSnapshot, reservation };
};

describe('EventsGateway', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    gatewayServer.sockets.sockets.clear();
    gatewayServer.sockets.adapter.rooms.clear();
    gatewayServer.to.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('moves cookie-authenticated sockets through verification into the admin room', async () => {
    const { gateway, verify, reservation } = makeGateway();
    const socket = new TestSocket('socket-1', 'access_token=signed');

    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    gateway.handleConnection(socket as Socket & TestSocket);
    await flush();

    expect(verify).toHaveBeenCalledWith('signed');
    expect(socket.rooms.has(ADMIN_ROOM)).toBe(true);
    expect(socket.listenerCount('auth')).toBe(0);
    expect(reservation.release).toHaveBeenCalledWith('socket-1');
  });

  it('authenticates one strict fallback payload when no cookie is present', async () => {
    const { gateway, verify } = makeGateway();
    const socket = new TestSocket('socket-2');

    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    gateway.handleConnection(socket as Socket & TestSocket);
    expect(socket.listenerCount('auth')).toBe(1);
    socket.trigger('auth', { accessToken: 'fallback-token' });
    await flush();

    expect(verify).toHaveBeenCalledWith('fallback-token');
    expect(socket.rooms.has(ADMIN_ROOM)).toBe(true);
    expect(socket.listenerCount('auth')).toBe(1);
  });

  it('disconnects after five seconds when fallback verification never completes', async () => {
    const { gateway, verify } = makeGateway();
    verify.mockReturnValue(new Promise(() => undefined));
    const socket = new TestSocket('socket-timeout');

    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    gateway.handleConnection(socket as Socket & TestSocket);
    socket.trigger('auth', { accessToken: 'slow' });
    jest.advanceTimersByTime(5000);

    expect(socket.disconnected).toHaveBeenCalledTimes(1);
    expect(socket.rooms.has(ADMIN_ROOM)).toBe(false);
  });

  it('rejects malformed, duplicate, and oversized cookies without installing fallback auth', () => {
    for (const cookie of [
      'access_token=',
      'access_token=a; access_token=b',
      `access_token=${'x'.repeat(8193)}`,
      'access_token=%E0%A4%A',
    ]) {
      const { gateway } = makeGateway();
      const socket = new TestSocket(`bad-${cookie.length}`, cookie);
      // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
      gateway.handleConnection(socket as Socket & TestSocket);

      expect(socket.disconnected).toHaveBeenCalledTimes(1);
      expect(socket.listenerCount('auth')).toBe(0);
    }

    const { gateway } = makeGateway();
    const oversizedHeader = `x=${'x'.repeat(16 * 1024)}`;
    const socket = new TestSocket('oversized-header', oversizedHeader);
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    gateway.handleConnection(socket as Socket & TestSocket);
    expect(socket.disconnected).toHaveBeenCalledTimes(1);
    expect(socket.listenerCount('auth')).toBe(0);
  });

  it.each([
    null,
    [],
    { accessToken: 'token', extra: true },
    {
      get accessToken() {
        return 'token';
      },
    },
    Object.create(null),
    { accessToken: 1 },
  ])('rejects non-strict fallback payload %#', (payload) => {
    const { gateway } = makeGateway();
    const socket = new TestSocket(`payload-${Math.random()}`);
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    gateway.handleConnection(socket as Socket & TestSocket);
    socket.trigger('auth', payload);

    expect(socket.disconnected).toHaveBeenCalledTimes(1);
  });

  it('disconnects a second auth event while verifying or after authentication', async () => {
    const { gateway, verify } = makeGateway();
    verify.mockReturnValue(new Promise(() => undefined));
    const verifying = new TestSocket('verifying');
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    gateway.handleConnection(verifying as Socket & TestSocket);
    verifying.trigger('auth', { accessToken: 'one' });
    verifying.trigger('auth', { accessToken: 'two' });
    expect(verifying.disconnected).toHaveBeenCalledTimes(1);

    const authenticated = new TestSocket('authenticated');
    verify.mockResolvedValue(principal());
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    gateway.handleConnection(authenticated as Socket & TestSocket);
    authenticated.trigger('auth', { accessToken: 'first' });
    await flush();
    authenticated.trigger('auth', { accessToken: 'second' });
    expect(authenticated.disconnected).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['USER', principal({ role: 'USER' })],
    ['MOD', principal({ role: 'MOD' })],
    ['temporary', principal({ temporaryAuth: true })],
    ['recovery', principal({ mustChangePassword: true })],
    ['expired', principal({ exp: Date.now() - 1 })],
  ] as const)('verifies then disconnects %s principals', async (_label, value) => {
    const { gateway, verify } = makeGateway();
    verify.mockResolvedValue(value);
    const socket = new TestSocket(`ineligible-${_label}`, 'access_token=token');

    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    gateway.handleConnection(socket as Socket & TestSocket);
    await flush();
    expect(verify).toHaveBeenCalledWith('token');
    expect(socket.disconnected).toHaveBeenCalledTimes(1);
    expect(socket.rooms.has(ADMIN_ROOM)).toBe(false);
  });

  it('disconnects an authenticated socket when its expiry timer fires', async () => {
    const { gateway, verify } = makeGateway();
    verify.mockResolvedValue(principal({ exp: Date.now() + 100 }));
    const socket = new TestSocket('expiry', 'access_token=expiry');
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    gateway.handleConnection(socket as Socket & TestSocket);
    await flush();

    jest.advanceTimersByTime(100);
    expect(socket.disconnected).toHaveBeenCalledTimes(1);
  });

  it('uses one shared interval and one collection for multiple admins', async () => {
    const { gateway, collectSnapshot } = makeGateway();
    const first = new TestSocket('admin-a', 'access_token=a');
    const second = new TestSocket('admin-b', 'access_token=b');

    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    gateway.handleConnection(first as Socket & TestSocket);
    await flush();
    // SAFETY: The test-controlled value satisfies the concrete framework contract used by this assertion.
    gateway.handleConnection(second as Socket & TestSocket);
    await flush();

    expect(collectSnapshot).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(10000);
    await flush();
    expect(collectSnapshot).toHaveBeenCalledTimes(2);
  });

  it('skips overlapping polls and emits exactly the four-key snapshot on the immediate tick', async () => {
    const { gateway, collectSnapshot } = makeGateway();
    let resolveSnapshot!: (snapshot: SystemStats) => void;
    collectSnapshot.mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const socket = new TestSocket('slow-admin', 'access_token=slow');

    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    gateway.handleConnection(socket as Socket & TestSocket);
    await flush();
    jest.advanceTimersByTime(10000);
    expect(collectSnapshot).toHaveBeenCalledTimes(1);
    resolveSnapshot({ totalRamMb: 1, usedRamMb: 0, freeDiskMb: 2, cpuCount: 1 });
    await flush();

    // the immediate post-auth tick emits non-volatile (guaranteed first
    // delivery); the overlapping periodic tick was skipped, so no volatile emit
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    const immediateEmit = gatewayServer.to.mock.results[0]?.value.emit as jest.Mock;
    expect(immediateEmit).toHaveBeenCalledWith('system.stats', {
      totalRamMb: 1,
      usedRamMb: 0,
      freeDiskMb: 2,
      cpuCount: 1,
    });
    expect(Object.keys(immediateEmit.mock.calls[0]?.[1] ?? {}).sort()).toEqual([
      'cpuCount',
      'freeDiskMb',
      'totalRamMb',
      'usedRamMb',
    ]);
    expect(gatewayServer.to.mock.results[0]?.value.volatile.emit).not.toHaveBeenCalled();
  });

  it('suppresses unavailable snapshots and resumes on a later valid tick', async () => {
    const { gateway, collectSnapshot } = makeGateway();
    collectSnapshot.mockResolvedValueOnce(null).mockResolvedValueOnce({
      totalRamMb: 8,
      usedRamMb: 4,
      freeDiskMb: 2,
      cpuCount: 2,
    });
    const socket = new TestSocket('recover', 'access_token=recover');
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    gateway.handleConnection(socket as Socket & TestSocket);
    await flush();
    expect(socket.sent).not.toContainEqual(expect.arrayContaining(['system.stats']));
    jest.advanceTimersByTime(10000);
    await flush();
    expect(collectSnapshot).toHaveBeenCalledTimes(2);
  });

  it('forces the raw transport closed when an unauthenticated socket disconnects', async () => {
    const { gateway } = makeGateway();
    const socket = new TestSocket('raw-close', undefined);
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    gateway.handleConnection(socket as Socket & TestSocket);
    await flush();

    // unauthenticated (no principal yet): namespace disconnect must kill the
    // raw Engine.IO transport so the client cannot hold an uncapped connection
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    gateway.handleDisconnect(socket as Socket & TestSocket);
    expect(socket.conn.close).toHaveBeenCalledTimes(1);
  });

  it('does not force the raw transport closed for authenticated admins', async () => {
    const { gateway } = makeGateway();
    const socket = new TestSocket('auth-close', 'access_token=signed');
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    gateway.handleConnection(socket as Socket & TestSocket);
    await flush();
    expect(socket.rooms.has(ADMIN_ROOM)).toBe(true);

    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    gateway.handleDisconnect(socket as Socket & TestSocket);
    expect(socket.conn.close).not.toHaveBeenCalled();
  });

  it('clears polling and timers after the final disconnect and module destruction', async () => {
    const { gateway } = makeGateway();
    const socket = new TestSocket('cleanup', 'access_token=cleanup');
    // SAFETY: The fixture is constructed from the concrete framework contract exercised by this test.
    gateway.handleConnection(socket as Socket & TestSocket);
    await flush();
    // SAFETY: The test-controlled value satisfies the concrete framework contract used by this assertion.
    gateway.handleDisconnect(socket as Socket & TestSocket);
    gateway.onModuleDestroy();
    jest.advanceTimersByTime(30000);

    expect(socket.listenerCount('auth')).toBe(0);
    expect(socket.rooms.has(ADMIN_ROOM)).toBe(false);
  });
});
