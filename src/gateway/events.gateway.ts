import { OnModuleDestroy } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { DefaultEventsMap, Server, Socket } from 'socket.io';
import { type AccessTokenPrincipal, AccessTokenService } from 'src/auth/access-token.service';
import { SocketReservationService } from './socket-reservation.service';
import { SystemMetricsService, type SystemStats } from './system-metrics.service';

type AuthStatus = 'PENDING' | 'VERIFYING' | 'AUTHENTICATED';

type AuthEventValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly AuthEventValue[]
  | { readonly [key: string]: AuthEventValue };

type AuthObject = { readonly [key: string]: AuthEventValue };

const isAuthObject = (value: AuthEventValue): value is AuthObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringValue = (value: AuthEventValue | string[] | undefined): value is string =>
  typeof value === 'string';

type SocketAuthState = {
  status: AuthStatus;
  deadline: NodeJS.Timeout | null;
  listener: ((data: AuthEventValue) => void) | null;
};

type SocketData = {
  authState?: SocketAuthState;
  principal?: AccessTokenPrincipal;
  accessToken?: string;
  engineId?: string;
  expiryTimer?: NodeJS.Timeout;
};

type SocketIoSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;
// SAFETY: Socket.IO creates each namespace socket and populates its `client`
// member with the Engine.IO transport. This boundary exposes the producer's
// string `client.id`, the Engine.IO identity consumed for reservation matching.
type GatewaySocket = Omit<SocketIoSocket, 'client'> & {
  readonly client: { readonly id: string };
};
type GatewayServer = Pick<
  Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>,
  'to'
> & {
  sockets: {
    adapter: { rooms: Map<string, Set<string>> };
    sockets: Map<string, GatewaySocket>;
  };
};

type CookieParseResult =
  | { kind: 'token'; token: string }
  | { kind: 'invalid' }
  | { kind: 'absent' };

const ADMIN_ROOM = 'admin:metrics';
const AUTH_DEADLINE_MS = 5000;
const POLL_INTERVAL_MS = 10000;
const CACHE_TTL_MS = 10000;
const MAX_TIMEOUT_MS = 2_147_483_647; // setTimeout ceiling (~24.8 days)
const COOKIE_HEADER_MAX_BYTES = 16 * 1024;
const TOKEN_MAX_BYTES = 8192;

@WebSocketGateway()
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer()
  private readonly server!: GatewayServer;

  private readonly sockets = new Map<string, GatewaySocket>();
  private adminCount = 0;
  private pollGeneration = 0;
  private inFlight = false;
  private pendingImmediate = false;
  private live = true;
  private interval: NodeJS.Timeout | null = null;
  private cachedSnapshot: { snapshot: SystemStats; cachedAt: number } | null = null;

  constructor(
    private readonly accessTokenService: AccessTokenService,
    private readonly systemMetricsService: SystemMetricsService,
    private readonly reservationService: SocketReservationService,
  ) {}

  handleConnection(socket: GatewaySocket): void {
    const engineId = socket.client.id;
    const claimed = this.reservationService.claim(engineId);
    const state: SocketAuthState = {
      status: 'PENDING',
      deadline: null,
      listener: null,
    };
    const data = socket.data;
    data.authState = state;
    data.engineId = engineId;
    this.sockets.set(socket.id, socket);

    if (!claimed) {
      this.disconnectSilent(socket);
      return;
    }

    const deadline = setTimeout(() => this.disconnectSilent(socket), AUTH_DEADLINE_MS);
    deadline.unref();
    state.deadline = deadline;

    const cookieResult = this.parseAccessCookie(socket.handshake.headers.cookie);
    if (cookieResult.kind === 'invalid') {
      this.disconnectSilent(socket);
      return;
    }

    if (cookieResult.kind === 'token') {
      state.status = 'VERIFYING';
      this.accessTokenService
        .verify(cookieResult.token)
        .then((principal) => this.onAuthSuccess(socket, principal, state, cookieResult.token))
        .catch(() => this.disconnectSilent(socket));
      return;
    }

    const listener = (payload: AuthEventValue) => {
      if (state.status !== 'PENDING') {
        this.disconnectSilent(socket);
        return;
      }

      state.status = 'VERIFYING';
      const payloadResult = this.parseAuthPayload(payload);
      if (payloadResult.kind !== 'token') {
        this.disconnectSilent(socket);
        return;
      }

      this.accessTokenService
        .verify(payloadResult.token)
        .then((principal) => this.onAuthSuccess(socket, principal, state, payloadResult.token))
        .catch(() => this.disconnectSilent(socket));
    };

    state.listener = listener;
    socket.on('auth', listener);
  }

  handleDisconnect(socket: GatewaySocket): void {
    const data = socket.data;
    const wasAuthenticated = data.principal !== undefined;

    this.cleanupSocket(socket);
    this.sockets.delete(socket.id);

    if (!wasAuthenticated) {
      // An unauthenticated namespace disconnect must not leave the raw
      // Engine.IO transport alive: cleanup released the reservation (and its
      // deadline), so a live raw connection would let the client hold an
      // uncapped connection and bypass the pending limit.
      try {
        socket.conn.close();
      } catch {
        // raw transport already closed
      }
    }
  }

  onModuleDestroy(): void {
    this.live = false;
    this.pollGeneration += 1;
    this.stopPolling();

    for (const socket of this.sockets.values()) {
      this.cleanupSocket(socket);
    }

    this.sockets.clear();
  }

  private async onAuthSuccess(
    socket: GatewaySocket,
    principal: AccessTokenPrincipal,
    state: SocketAuthState,
    token: string,
  ): Promise<void> {
    const data = socket.data;

    if (!this.live) {
      return;
    }

    if (!data.engineId || !this.reservationService.release(data.engineId)) {
      this.disconnectSilent(socket);
      return;
    }

    if (!socket.connected) {
      return;
    }

    if (state.deadline) {
      clearTimeout(state.deadline);
      state.deadline = null;
    }

    if (!this.isEligibleForMetrics(principal)) {
      socket.disconnect(true);
      return;
    }

    state.status = 'AUTHENTICATED';
    data.principal = principal;
    data.accessToken = token;

    socket.join(ADMIN_ROOM);
    this.adminCount += 1;

    if (!this.armExpiry(socket, principal.exp)) {
      return;
    }

    this.emitCacheIfFresh(socket);
    this.startPollingIfNeeded();
  }

  private isEligibleForMetrics(principal: AccessTokenPrincipal): boolean {
    return principal.role === 'ADMIN' && !principal.temporaryAuth && !principal.mustChangePassword;
  }

  private parseAccessCookie(cookieHeader: string | string[] | undefined): CookieParseResult {
    if (cookieHeader === undefined) {
      return { kind: 'absent' };
    }

    if (!isStringValue(cookieHeader)) {
      return { kind: 'invalid' };
    }

    if (Buffer.byteLength(cookieHeader, 'utf8') > COOKIE_HEADER_MAX_BYTES) {
      return { kind: 'invalid' };
    }

    const parts = cookieHeader.split(';');
    let token: string | undefined;

    for (const part of parts) {
      const eqIndex = part.indexOf('=');
      if (eqIndex === -1) {
        continue;
      }

      const name = part.slice(0, eqIndex).trim();
      if (name !== 'access_token') {
        continue;
      }

      const rawValue = part.slice(eqIndex + 1).trim();
      if (rawValue.length === 0) {
        return { kind: 'invalid' };
      }

      let decoded: string;
      try {
        decoded = decodeURIComponent(rawValue);
      } catch {
        return { kind: 'invalid' };
      }

      if (Buffer.byteLength(decoded, 'utf8') > TOKEN_MAX_BYTES) {
        return { kind: 'invalid' };
      }

      if (token !== undefined) {
        return { kind: 'invalid' };
      }

      token = decoded;
    }

    if (token === undefined) {
      return { kind: 'absent' };
    }

    return { kind: 'token', token };
  }

  private parseAuthPayload(data: AuthEventValue): CookieParseResult {
    if (!isAuthObject(data)) {
      return { kind: 'invalid' };
    }

    if (Object.getPrototypeOf(data) !== Object.prototype) {
      return { kind: 'invalid' };
    }

    const keys = Object.keys(data);
    if (keys.length !== 1 || keys[0] !== 'accessToken') {
      return { kind: 'invalid' };
    }

    const value = data.accessToken;
    if (!isStringValue(value) || value.length === 0) {
      return { kind: 'invalid' };
    }

    if (Buffer.byteLength(value, 'utf8') > TOKEN_MAX_BYTES) {
      return { kind: 'invalid' };
    }

    return { kind: 'token', token: value };
  }

  private armExpiry(socket: GatewaySocket, exp: number): boolean {
    const data = socket.data;
    let ms = exp - Date.now();

    if (ms <= 0) {
      this.disconnectSilent(socket);
      return false;
    }

    const arm = () => {
      ms = exp - Date.now();

      if (ms <= 0) {
        this.disconnectSilent(socket);
        return false;
      }

      if (ms > MAX_TIMEOUT_MS) {
        // setTimeout caps near 2^31-1 ms (~24.8 days); re-arm until expiry
        const timer = setTimeout(() => arm(), MAX_TIMEOUT_MS);
        timer.unref();
        data.expiryTimer = timer;
        return true;
      }

      const timer = setTimeout(() => this.disconnectSilent(socket), ms);
      timer.unref();
      data.expiryTimer = timer;
      return true;
    };

    return arm();
  }

  private emitCacheIfFresh(socket: GatewaySocket): void {
    if (!this.cachedSnapshot) {
      return;
    }

    if (performance.now() - this.cachedSnapshot.cachedAt < CACHE_TTL_MS) {
      socket.emit('system.stats', this.cachedSnapshot.snapshot);
    }
  }

  private startPollingIfNeeded(): void {
    if (this.interval !== null) {
      return;
    }

    this.interval = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    this.interval.unref();

    if (this.inFlight) {
      this.pendingImmediate = true;
    } else {
      void this.tick(true);
    }
  }

  private stopPolling(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }

    this.cachedSnapshot = null;
    this.pollGeneration += 1;
    this.pendingImmediate = false;
  }

  private async tick(immediate = false): Promise<void> {
    if (this.inFlight) {
      return;
    }

    const generation = this.pollGeneration;
    this.inFlight = true;

    try {
      if (!(await this.revalidateAdmins(generation))) {
        this.cachedSnapshot = null;
        return;
      }

      const snapshot = await this.systemMetricsService.collectSnapshot();

      if (snapshot === null) {
        this.cachedSnapshot = null;
        return;
      }

      if (generation !== this.pollGeneration || !this.live) {
        return;
      }

      if (!(await this.revalidateAdmins(generation))) {
        this.cachedSnapshot = null;
        return;
      }

      this.cachedSnapshot = { snapshot, cachedAt: performance.now() };

      if (immediate) {
        // Guaranteed first delivery to the admin that just authenticated: a
        // volatile packet is dropped while a fresh polling transport is still
        // establishing, which would delay the first metrics by a full tick.
        this.server.to(ADMIN_ROOM).emit('system.stats', snapshot);
      } else {
        // Periodic cadence: volatile so stale snapshots are dropped, not queued.
        this.server.to(ADMIN_ROOM).volatile.emit('system.stats', snapshot);
      }
    } finally {
      this.inFlight = false;

      if (this.pendingImmediate && this.live) {
        this.pendingImmediate = false;
        setTimeout(() => this.tick(true), 0).unref();
      }
    }
  }

  private async revalidateAdmins(generation: number): Promise<boolean> {
    if (generation !== this.pollGeneration || !this.live) {
      return false;
    }

    const room = this.server.sockets.adapter.rooms.get(ADMIN_ROOM);
    if (!room || room.size === 0) {
      return false;
    }

    const tokenToSockets = new Map<string, GatewaySocket[]>();

    for (const socketId of room) {
      const socket = this.server.sockets.sockets.get(socketId);
      if (!socket) {
        continue;
      }

      const data = socket.data;
      const token = data.accessToken;
      if (!isStringValue(token)) {
        this.disconnectSilent(socket);
        continue;
      }

      const sockets = tokenToSockets.get(token) ?? [];
      sockets.push(socket);
      tokenToSockets.set(token, sockets);
    }

    if (tokenToSockets.size === 0) {
      return false;
    }

    for (const [token, sockets] of tokenToSockets) {
      let principal: AccessTokenPrincipal;
      try {
        principal = await this.accessTokenService.verify(token);
      } catch {
        for (const socket of sockets) {
          this.disconnectSilent(socket);
        }
        continue;
      }

      if (!this.isEligibleForMetrics(principal)) {
        for (const socket of sockets) {
          this.disconnectSilent(socket);
        }
      }
    }

    if (generation !== this.pollGeneration || !this.live) {
      return false;
    }

    const afterRoom = this.server.sockets.adapter.rooms.get(ADMIN_ROOM);
    return afterRoom !== undefined && afterRoom.size > 0;
  }

  private disconnectSilent(socket: GatewaySocket): void {
    this.cleanupSocket(socket);
    socket.disconnect(true);
  }

  private cleanupSocket(socket: GatewaySocket): void {
    const data = socket.data;

    if (data.authState?.deadline) {
      clearTimeout(data.authState.deadline);
      data.authState.deadline = null;
    }

    if (data.authState?.listener) {
      socket.off('auth', data.authState.listener);
      data.authState.listener = null;
    }

    if (data.expiryTimer) {
      clearTimeout(data.expiryTimer);
      data.expiryTimer = undefined;
    }

    if (data.principal) {
      // socket.io clears rooms before the disconnect event, so the room check
      // is unreliable — track the admin population explicitly (idempotent).
      data.principal = undefined;
      this.adminCount = Math.max(0, this.adminCount - 1);
      if (this.adminCount === 0) {
        this.stopPolling();
      }
    }

    try {
      socket.leave(ADMIN_ROOM);
    } catch {
      // best-effort room leave
    }

    if (data.engineId) {
      this.reservationService.release(data.engineId);
    }
  }
}
