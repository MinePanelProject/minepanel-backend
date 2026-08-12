import type { IncomingMessage } from 'node:http';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Socket as EngineSocket } from 'engine.io';
import type { ServerOptions, Server as SocketIoServer } from 'socket.io';
import { getCanonicalCorsOrigin } from 'src/common/cors-origin';
import { SocketReservationService } from './socket-reservation.service';

@Injectable()
export class SocketIoAdapter extends IoAdapter {
  private readonly canonicalOrigin: string;

  constructor(
    private readonly reservationService: SocketReservationService,
    configService: ConfigService,
    httpServer: object,
  ) {
    super(httpServer);
    this.canonicalOrigin = getCanonicalCorsOrigin(configService);
  }

  createIOServer(port: number, options?: ServerOptions): SocketIoServer {
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: this.canonicalOrigin, credentials: true },
      allowRequest: (req, callback) => this.allowRequest(req, callback),
      maxHttpBufferSize: 16 * 1024,
      perMessageDeflate: false,
      connectTimeout: 5000,
      connectionStateRecovery: false,
    }) as SocketIoServer;

    server.engine.on('connection', (rawConn: EngineSocket) => {
      this.reservationService.reserve(rawConn);
    });

    return server;
  }

  private allowRequest(
    req: IncomingMessage,
    callback: (err: Error | null, allow: boolean) => void,
  ): void {
    const origin = req.headers.origin;
    const cookie = req.headers.cookie;

    if (origin === undefined && cookie === undefined) {
      callback(null, true);
      return;
    }

    if (typeof origin !== 'string') {
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
