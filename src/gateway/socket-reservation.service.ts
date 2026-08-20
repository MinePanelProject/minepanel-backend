import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Socket as EngineSocket } from 'engine.io';

// SAFETY: Engine.IO emits its `Socket` producer through `Server.engine`'s
// connection event. Reservation tracking consumes only that producer's string
// `rawConn.id`; this boundary exposes the declared-private member without coercion.
export type ReservedEngineSocket = Omit<EngineSocket, 'id'> & {
  readonly id: string;
};

type Reservation = {
  rawConn: ReservedEngineSocket;
  deadline: NodeJS.Timeout;
  claimed: boolean;
};

const PENDING_CAP = 100;
const AUTH_DEADLINE_MS = 5000;

const isNonEmptyConnectionId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

@Injectable()
export class SocketReservationService implements OnModuleDestroy {
  private readonly reservations = new Map<string, Reservation>();

  reserve(rawConn: ReservedEngineSocket): void {
    const id = rawConn.id;

    if (!isNonEmptyConnectionId(id)) {
      try {
        rawConn.close();
      } catch {
        // Engine.IO may already have closed a malformed transport before reservation.
      }
      return;
    }

    if (this.reservations.size >= PENDING_CAP || this.reservations.has(id)) {
      try {
        rawConn.close();
      } catch {
        // Engine.IO can close concurrently while the reservation admission path runs.
      }
      return;
    }

    const deadline = setTimeout(() => {
      this.release(id, true);
    }, AUTH_DEADLINE_MS);
    deadline.unref();

    rawConn.on('close', () => this.release(id, false));
    this.reservations.set(id, { rawConn, deadline, claimed: false });
  }

  claim(id: string): boolean {
    const reservation = this.reservations.get(id);

    if (!reservation || reservation.claimed) {
      return false;
    }

    // The deadline stays armed: the architect requires ONE 5s admission window
    // from Engine.IO connection through verification completion. It is cleared
    // by release() on auth success/disconnect, or fires to close the socket.
    reservation.claimed = true;
    return true;
  }

  release(id: string, closeRaw = false): boolean {
    const reservation = this.reservations.get(id);

    if (!reservation) {
      return false;
    }

    clearTimeout(reservation.deadline);
    this.reservations.delete(id);

    if (closeRaw) {
      try {
        reservation.rawConn.close();
      } catch {
        // already closed
      }
    }

    return true;
  }

  onModuleDestroy(): void {
    for (const [id] of this.reservations) {
      this.release(id, true);
    }
  }
}
