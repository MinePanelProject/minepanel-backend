import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Socket as EngineSocket } from 'engine.io';

type EngineSocketHandle = {
  id: string;
  close: () => void;
  on: (event: 'close', listener: () => void) => void;
};

type Reservation = {
  rawConn: EngineSocket;
  deadline: NodeJS.Timeout;
  claimed: boolean;
};

const PENDING_CAP = 100;
const AUTH_DEADLINE_MS = 5000;

@Injectable()
export class SocketReservationService implements OnModuleDestroy {
  private readonly reservations = new Map<string, Reservation>();

  reserve(rawConn: EngineSocket): void {
    const handle = rawConn as unknown as EngineSocketHandle;

    if (this.reservations.size >= PENDING_CAP) {
      try {
        handle.close();
      } catch {
        // best-effort close at capacity
      }
      return;
    }

    const id = handle.id;

    if (!id || this.reservations.has(id)) {
      try {
        handle.close();
      } catch {
        // duplicate or missing id
      }
      return;
    }

    const deadline = setTimeout(() => {
      this.release(id, true);
    }, AUTH_DEADLINE_MS);
    deadline.unref();

    handle.on('close', () => this.release(id, false));
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
