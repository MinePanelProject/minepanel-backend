# Servers Architecture

> Phase 1 — Docker module + Servers module.

---

## Overview

The NestJS backend manages Minecraft server containers via the Docker socket. Each MC server is an independent container spawned and controlled by the backend.

The socket path is configurable via `DOCKER_SOCKET` (default: `/var/run/docker.sock`). **Rootless Docker is the default** — no root privileges required. `DockerService` reads the path from `ConfigService` at startup, never hardcoded.

> **Implemented (Phase 1 slice):** socket connection, ping, hardened container create/start/stop/remove, container inspect, host RAM/CPU via `docker.info`, host disk via `fs.statfs`, server lifecycle endpoints (`ServersService`) with atomic CAS state transitions, resource guardrails, startup reconciliation, managed-container recovery, and RCON-aware graceful stop with player warning.
>
> **Implemented (Phase 1.5 Round 1):** server visibility (`OPEN`/`REQUEST`/`PRIVATE`), `ServerAccess` request/approval/revocation, MOD granular permissions (`PermissionsGuard` + `mod_permissions`), and lifecycle enforcement (`SERVER_LIFECYCLE`).
>
> **Deferred:** container stats, log streaming, external RCON service/pool, console command endpoints, encrypted `rconPassword` persistence.

```
NestJS backend
  └── DockerService (via Dockerode + /var/run/docker.sock)
        ├── creates containers  (itzg/minecraft-server image)
        ├── starts / stops / removes containers
        ├── inspects containers
        └── reads host info / disk space
```

---

## Docker Module

`DockerService` wraps Dockerode and exposes methods used by `ServersService`.

### Container config per server

| Setting          | Value                                                          |
|------------------|----------------------------------------------------------------|
| Image            | `itzg/minecraft-server`                                        |
| Network          | `minepanel_network` (env: `DOCKER_NETWORK`)                    |
| Volume           | `{MC_DATA_PATH}/{serverId}:/data`                              |
| Port mapping     | `{server.port}:25565`                                          |
| Memory limit     | `Server.memoryLimitMb` MB (min 512 MB)                         |
| Restart policy   | `unless-stopped`                                               |
| Container name   | `mc-{serverId}`                                                |
| Labels           | `minepanel.server-id={serverId}`, `minepanel.managed=true`     |
| Privileged       | `false` (hardcoded)                                            |
| Capabilities     | none (`CapAdd: []`, hardcoded)                                 |
| Env vars         | `EULA=TRUE`, `ENABLE_RCON=TRUE`, `TYPE`, `VERSION`, `MEMORY`, `MAX_PLAYERS`, `DIFFICULTY`, `MODE`, `ONLINE_MODE`, `VIEW_DISTANCE`, `ALLOW_FLIGHT`, `PVP`, `MOTD`, `SEED` |

> **`MC_DATA_PATH` is one absolute path, identical on the Docker host and inside the backend container.** Compose mounts `${MC_DATA_PATH_HOST}` at the same absolute path and passes it as `MC_DATA_PATH`; the daemon bind source and backend `statfs` therefore name the same physical root. Relative values and values with surrounding whitespace are rejected (Compose interpolates `MC_DATA_PATH_HOST` verbatim, so the two must normalize identically); the obsolete `mc-data` named volume was removed from compose.
>
> **Operator prerequisites:** the default host root is `$HOME/.minepanel/mc-data` (user-writable; Compose creates it — no privileged prep on rootless Docker). Existing installs on `/srv/...` or the old `minepanel-mc-data` named volume keep their location by setting `MC_DATA_PATH_HOST` to their absolute path (upgrade-only: copy the old volume contents into the chosen host root once, before cutover — fresh installs do nothing). Root-docker operators should pre-create and `chown` the root for the Minecraft container runtime user. On SELinux, label the directory per local policy — never embed `:Z` in `MC_DATA_PATH_HOST`.

### DockerService methods

Implemented:

```ts
createContainer(server: Server): Promise<string>   // returns containerId
startContainer(containerId: string): Promise<void>
stopContainer(containerId: string, stopTimeoutSeconds = 30): Promise<'stopped' | 'already-stopped'>
executeRconCommand(containerId: string, command: readonly string[]): Promise<void>
removeContainer(containerId: string): Promise<void>
inspectContainer(containerId: string): Promise<ContainerInspectState>
getHostInfo(): Promise<{ totalRamMb: number | null; cpuCount: number | null }>
getHostDiskInfo(): Promise<{ totalDiskMb: number | null; freeDiskMb: number | null }>
getHostFreeMemoryMb(): number | null   // node:os.freemem() floor to MiB
ping(): Promise<boolean>
```

Host metrics (`totalRamMb`, `usedRamMb`, `freeDiskMb`, `cpuCount`) are delivered to ADMIN WebSocket clients as the `system.stats` event every 10 seconds. See [docs/realtime.md](./realtime.md).

Deferred (future slices):

```ts
getContainerStats(containerId: string): Promise<ContainerStats>
streamLogs(containerId: string): Promise<Readable>
execCommand(containerId: string, cmd: string): Promise<string>
```

---

## Graceful degradation

If the Docker socket is unavailable at startup or becomes unreachable at runtime:

- `DockerModule` no longer exits the process; it logs a warning and continues.
- `GET /health` returns HTTP 503 with `{ status: 'degraded', docker: 'error' }`.
- Operational `DockerService` methods (create/start/stop/remove/inspect, host info) throw `ServiceUnavailableException('Docker daemon unreachable')`, which the global exception filter renders as HTTP 503 `{ statusCode: 503, message: 'Docker daemon unreachable' }`. `ping()` is the exception: it catches daemon failures and returns `false`, which drives `/health` to 503.
- Read-only DB endpoints (`GET /servers`, `GET /servers/:id`) continue to function normally.
- `getHostInfo` and `getHostDiskInfo` return `null` fields when the daemon or filesystem returns malformed/unreadable data instead of fabricating numbers.

---

## Servers Module (Phase 1 delivered)

`ServersService` owns the lifecycle state machine and resource guardrails. `ServersController` is a thin delegation layer.

### Endpoints

| Method | Path                                  | Auth         | Description                                  |
|--------|---------------------------------------|--------------|----------------------------------------------|
| POST   | /servers                              | ADMIN        | Create and start a new server                |
| GET    | /servers                              | JWT          | List visible servers                         |
| GET    | /servers/:id                          | JWT          | Get single server details                    |
| POST   | /servers/:id/start                    | ADMIN \| MOD | Start a stopped server (needs `SERVER_LIFECYCLE`) |
| POST   | /servers/:id/stop                     | ADMIN \| MOD | Stop a running server (needs `SERVER_LIFECYCLE`)  |
| POST   | /servers/:id/restart                  | ADMIN \| MOD | Restart a running server (needs `SERVER_LIFECYCLE`) |
| DELETE | /servers/:id                          | ADMIN        | Delete server + remove container             |
| POST   | /servers/:id/request-access           | JWT          | Request access to a REQUEST server           |
| GET    | /servers/:id/my-access-request        | JWT          | Get own access request status                |
| GET    | /servers/:id/access-requests          | ADMIN        | List pending access requests                 |
| POST   | /servers/:id/access-requests/:userId/approve | ADMIN | Approve/assign access for a user    |
| DELETE | /servers/:id/access-requests/:userId  | ADMIN        | Reject pending request or revoke access      |

> MODs require the `SERVER_LIFECYCLE` permission (global or scoped to the server) for start/stop/restart. ADMIN bypasses PBAC and visibility checks.

### State machine

All transitions are conditional `UPDATE ... WHERE id AND expected_status RETURNING` (atomic CAS). A zero-row update means the claim was lost and the call returns the relevant 409 conflict without touching Docker.

```
STOPPED  ──start──► STARTING ──► RUNNING
RUNNING  ──stop──► STOPPING ──► STOPPED
RUNNING  ──restart──► STOPPING ──► STARTING ──► RUNNING
[CREATING / STARTING / STOPPING] ──Docker command with unknown outcome──► ERROR
ERROR    ──startup reconciliation──► RUNNING or STOPPED
```

- `CREATING` rows are not externally visible and are reconciled on startup.
- `ERROR` is a recoverable state: it records that a command may have changed reality and requires the next startup reconciliation to settle the truth by inspecting the container.

### Resource guardrails

Before any create/start/restart claim or Docker mutation:

- `MIN_FREE_DISK_MB` (default 2048) vs `getHostDiskInfo().freeDiskMb`.
- `MAX_MEMORY_RATIO` (default 0.90) vs `floor(getHostInfo().totalRamMb * ratio)`; the running aggregate of `memoryLimitMb` is recomputed under a Postgres advisory transaction lock (`pg_advisory_xact_lock(7332)`, distinct from the admin lock `7331`).
- Malformed config or null host measurements fail closed with 503 `Host resource information unavailable`.
- Genuine shortages return 422 `{ statusCode: 422, error: 'InsufficientResources', message, details: { resource, availableMb, requiredMb, totalMb } }`.

### Create server flow

```
POST /servers (ADMIN only)
  1. validate DTO and parse resource config
  2. preflight disk + memory checks
  3. under advisory lock: recompute allocation, insert CREATING row with ownerId from the auth context
  4. DockerService.createContainer(server) → containerId
  5. persist containerId conditionally (id + CREATING + containerId null)
  6. DockerService.startContainer(containerId)
  7. conditional CREATING → RUNNING
```

Compensation: if create returns an ambiguous result, a deterministic managed-container lookup (`mc-{serverId}` + `minepanel.managed`/`minepanel.server-id` labels) is used. Confirmed absent → delete the provisional row; confirmed present → attach the containerId and leave the row in `ERROR` for reconciliation; unconfirmable (daemon unreachable) → retain the `CREATING` row.

### Start server flow

```
POST /servers/:id/start
  1. fetch visible Server for the requester, 404 if absent/hidden/CreaTING
  2. 409 if not STOPPED; 409 'Server container is not provisioned' if containerId is null
  3. preflight disk + memory checks (excluding target server)
  4. under advisory lock: recompute allocation, CAS STOPPED → STARTING
  5. DockerService.startContainer(containerId)
  6. CAS STARTING → RUNNING
  7. ambiguous Docker failure → CAS STARTING → ERROR
```

Visibility and PBAC are enforced before any Docker call. A MOD without `SERVER_LIFECYCLE` on the server gets `403` from `PermissionsGuard`; a non-owner USER without visibility gets `404`.

### Stop server flow

```
POST /servers/:id/stop
  1. fetch visible Server for the requester, 404 if absent/hidden/CreaTING, 409 if not RUNNING
  2. parse STOP_WARN_SECONDS (default 30, range 0-300); malformed → 503, no mutation
  3. CAS RUNNING → STOPPING
  4. graceful stop helper:
       a. RCON exec rcon-cli say '§cServer closing in {warnSeconds} seconds...'
       b. if warning succeeded and warnSeconds > 0: wait warnSeconds
       c. RCON exec rcon-cli save-all
       d. wait 3s (bounded grace period, not a guaranteed durability flush)
       e. DockerService.stopContainer(containerId, 15)   // SIGTERM
     any RCON step fails → skip remaining RCON delays/commands → DockerService.stopContainer(containerId, 10)
  5. CAS STOPPING → STOPPED
  6. ambiguous Docker failure → CAS STOPPING → ERROR; known Docker rejection → restore RUNNING
```

Visibility and PBAC are enforced before any Docker call.

The explicit `DockerService.stopContainer` is mandatory even though the itzg image's `mc-server-runner` PID1 traps `SIGTERM` and sends `stop` over RCON: Docker marks `HasBeenManuallyStopped` **before** delivering the signal, so the `unless-stopped` restart policy cannot relaunch the container behind a `STOPPED` DB row. `stopContainer` distinguishes `204` (`stopped`) from `304` (`already-stopped`); both finalize to `STOPPED` because the container is exited. RCON is provided by the bundled `rcon-cli` inside the container over a non-interactive `docker exec`; the image manages its own random RCON password in `/data/.rcon-cli.*` and no password is stored in the backend.

### Restart server flow

```
POST /servers/:id/restart
  1. fetch visible Server for the requester, 404 if absent/hidden/CreaTING, 409 if not RUNNING
  2. parse STOP_WARN_SECONDS (default 30, range 0-300); malformed → 503, no mutation
  3. CAS RUNNING → STOPPING
  4. graceful stop helper (same sequence as stop)
  5. re-run disk + memory admission (excluding target server)
  6. CAS STOPPING → STARTING
  7. DockerService.startContainer(containerId)
  8. CAS STARTING → RUNNING
  9. stop-phase ambiguous failure → ERROR; post-stop admission/start failure → STOPPED
```

Visibility and PBAC are enforced before any Docker call.

Restart never uses the Docker restart primitive; it always stops the container first and only admits the start phase after `stopContainer` confirms the container is stopped.

### Delete server flow

```
DELETE /servers/:id (ADMIN only)
  1. fetch visible Server for the requester, 404 if absent/hidden/CreaTING, 409 if not STOPPED
  2. CAS STOPPED → STOPPING
  3. if containerId is set, DockerService.removeContainer(containerId)
  4. DELETE FROM servers WHERE id AND status = STOPPING
  5. remove failure: inspect container — confirmed absent → delete row;
     confirmed running → ERROR (reconciliation heals); unconfirmable → ERROR, keep row
```

Visibility is enforced before any Docker call. ADMIN-only route; no PBAC permission applies.

### Startup reconciliation

On module init the backend queries every non-STOPPED row (`CREATING`, `STARTING`, `RUNNING`, `STOPPING`, `ERROR`), inspects all known containers in parallel, and falls back to the managed-container lookup for rows with a null/stale `containerId`. If any inspection reports daemon unavailability, a single degraded-startup warning is logged and **no** reconciliation writes are made in that pass.

Every reconciliation write compares the full observed snapshot (`status`, `containerId`, `updatedAt` as read) and sets `updatedAt = now()` in the database, so a later lifecycle transition cannot be overwritten.

> **Phase 1 single-process invariant:** exactly one backend process performs startup reconciliation before serving requests. This is what allows the enum-only forward migration (`ALTER TYPE ... ADD VALUE 'CREATING'`) to be safe during rollout.

### Deferred to later slices

- Per-container stats, log streaming, and real-time container events (host `system.stats` is delivered — see [docs/realtime.md](./realtime.md)).
- External RCON service, connection pool, console command endpoints, and encrypted `rconPassword` persistence.
- Backups, world/version management, and delayed volume cleanup.

---

## Server Model (Drizzle schema)

| Field       | Type           | Notes                          |
|-------------|----------------|--------------------------------|
| id          | String         | UUID PK                        |
| name        | String         |                                |
| provider    | ServerProvider | VANILLA \| PAPER \| PURPUR \| FABRIC \| FORGE |
| version     | String         | e.g. "1.21.1"                  |
| port        | Int            | unique, host port              |
| containerId | String?        | set after Docker create        |
| status      | ServerStatus   | STOPPED \| CREATING \| STARTING \| RUNNING \| STOPPING \| ERROR |
| maxPlayers  | Int            | default: 20                    |
| difficulty  | String         | default: "normal"              |
| gamemode    | String         | default: "survival"            |
| pvp         | Boolean        | default: true                  |
| worldPath   | String?        |                                |
| ownerId     | String         | FK → User                      |
| accessType  | Enum           | OPEN \| REQUEST \| PRIVATE (Phase 1.5) |
| createdAt   | DateTime       |                                |
| updatedAt   | DateTime       |                                |

---

## GET /servers — Filtering by access

The list endpoint applies the same visibility predicate to both the row query and the count:

```sql
status != 'CREATING'
AND (
  role = 'ADMIN'
  OR accessType = 'OPEN'
  OR EXISTS (
    SELECT 1 FROM server_access
    WHERE userId = :principalId
      AND serverId = servers.id
      AND status = 'APPROVED'
  )
)
```

- **ADMIN** → sees all non-CREATING servers.
- **MOD / USER** → sees only:
  - servers with `accessType: OPEN`
  - servers where they have an approved `ServerAccess` record

`CREATING` rows are never visible. Hidden, absent, or provisional targets always return `404 'Server not found'` — never `403` — so access type and existence are not disclosed.

The total returned matches the filtered row set. Pagination (`limit`/`offset`) is applied after filtering and ordering by `createdAt, id`.

---

## Environment Variables

| Variable       | Description                          | Default                      |
|----------------|--------------------------------------|------------------------------|
| DOCKER_SOCKET  | Path to Docker socket                | /var/run/docker.sock         |
| DOCKER_NETWORK | Docker network for MC containers     | minepanel_network            |
| MC_DATA_PATH_HOST | Host data root (compose only) | $HOME/.minepanel/mc-data |
| MC_DATA_PATH   | Base path for MC server data volumes (absolute; must be identical on host and inside backend container) | /mc-data |
| `MC_PORT_MIN`    | Minimum allowed MC server port       | 25565                        |
| `MC_PORT_MAX`    | Maximum allowed MC server port       | 25665                        |
| `STOP_WARN_SECONDS` | Graceful shutdown warning seconds (0-300) | 30                     |
