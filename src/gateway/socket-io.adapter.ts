import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Socket as EngineSocket } from 'engine.io';
import type { ServerOptions, Server as SocketIoServer } from 'socket.io';
import { getCanonicalCorsOrigin } from 'src/common/cors-origin';
import { SocketReservationService } from './socket-reservation.service';

const isStringOrigin = (value: string | string[] | undefined): value is string =>
  typeof value === 'string';
@Injectable()
export class SocketIoAdapter extends IoAdapter {
  private readonly canonicalOrigin: string;

  constructor(
    private readonly reservationService: SocketReservationService,
    configService: Pick<ConfigService, 'get'>,
    httpServer: HttpServer,
  ) {
    super(httpServer);
    this.canonicalOrigin = getCanonicalCorsOrigin(configService);
  }

  createIOServer(port: number, options?: ServerOptions): SocketIoServer {
    // SAFETY: The test-controlled value satisfies the concrete framework contract used by this assertion.
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: this.canonicalOrigin, credentials: true },
      allowRequest: (req, callback) => this.allowRequest(req, callback),
      maxHttpBufferSize: 16 * 1024,
      perMessageDeflate: false,
      connectTimeout: 5000,
      connectionStateRecovery: false,
      // SAFETY: IoAdapter.createIOServer returns the Socket.IO server contract used below.
    }) as SocketIoServer;

    server.engine.on('connection', (rawConn: EngineSocket) => {
      this.reservationService.reserve(rawConn);
    });

    return server;
  }

  allowRequest(
    req: Pick<IncomingMessage, 'headers'>,
    callback: (err: Error | null, allow: boolean) => void,
  ): void {
    const origin = req.headers.origin;
    const cookie = req.headers.cookie;

    if (origin === undefined && cookie === undefined) {
      callback(null, true);
      return;
    }

    if (!isStringOrigin(origin)) {
      callback(null, false);
      return;
    }

    if (origin !== origin.trim() || origin.length === 0) {
      callback(null, false);
      return;
    }

    let normalized: string;

    try {
      normalized = new URL(origin).origin;
    } catch {
      callback(null, false);
      return;
    }

    if (normalized !== this.canonicalOrigin) {
      callback(null, false);
      return;
    }

    callback(null, true);
  }
}
