# Real-Time WebSocket API

## Endpoint

- **URL:** `/socket.io` (Socket.IO v4)
- **Transport:** WebSocket with Engine.IO polling fallback
- **Credentials:** required (`withCredentials: true`)
- **Origin:** exactly one configured browser Origin (`CORS_ORIGIN`); foreign, null, malformed, or missing-Origin-with-cookie requests are rejected

## Phase 1 scope

The only real-time event in Phase 1 is `system.stats`, a host-metrics broadcast sent to authenticated ADMIN sockets.

## Authentication

Two paths are accepted:

1. **Cookie-first:** connect with a valid `access_token` HttpOnly cookie from the allowed Origin.
2. **Fallback:** if no cookie is present, the socket may emit exactly one `auth` event within 5 seconds with `{ accessToken: string }`.

- Invalid/expired/wrong-purpose/malformed cookie → immediate silent disconnect, no fallback.
- Second `auth` event, timeout, malformed payload, or verification failure → silent disconnect.
- No `auth.success`, `auth.error`, status, or token-bearing response is ever emitted.

## Authorization

Only ACTIVE ADMIN principals with an ordinary (non-temporary) access token and no pending forced password change receive `system.stats`. USER, MOD, PENDING, BANNED, temporary-recovery, and must-change-password sessions are disconnected silently after verification.

Tokens are revalidated before every collection and again immediately before each volatile room emission. Demotion, ban, or expiry disconnects the socket before the next broadcast.

## Event: `system.stats`

```json
{
  "totalRamMb": 32768,
  "usedRamMb": 8192,
  "freeDiskMb": 512000,
  "cpuCount": 8
}
```

- `totalRamMb` — host total RAM from Docker `info.MemTotal`.
- `usedRamMb` — `totalRamMb - freeRamMb`.
- `freeDiskMb` — free space on the Docker data volume (`fs.statfs`).
- `cpuCount` — host CPU count from Docker `info.NCPU`.

No timestamp, user, token, Docker ID, path, total disk, free RAM, or server data is included.

## Cadence

- First authenticated ADMIN triggers an immediate collection.
- One shared 10-second interval broadcasts while at least one eligible ADMIN is connected.
- All ADMIN sockets share the same poll; adding sockets adds no extra Docker calls.
- A cached snapshot (< 10 seconds old) is sent directly to a newly authenticated ADMIN.
- The immediate post-auth delivery is non-volatile (guaranteed first packet — a volatile event is dropped while a fresh polling transport is still establishing). Periodic ticks use volatile emission so stale snapshots are dropped rather than queued for disconnected clients.

## Degradation

If Docker or the host filesystem returns malformed/unavailable data, that tick is suppressed (no fabricated/partial/stale payload). Collection resumes automatically on the next valid tick.

## Local-host invariant

`totalRamMb`, `usedRamMb`, and `freeDiskMb` are valid only because the backend and Docker daemon run on the same host while the backend's `/mc-data` mount and the daemon's `MC_DATA_BIND_SOURCE` expose two views of the same physical data root. Compose enforces that relationship through a read-only backend mount and a host-side bind source; the runtime does not independently prove path identity.

## Deferred to later phases

- Server status/stats, log streaming, console commands, player join/leave events.
- `subscribe.server`, notifications, Redis/multi-instance fan-out, history.
- `GET /system/stats` REST endpoint.
