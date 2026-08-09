# Servers Architecture

> Phase 1 — Docker module + Servers module.

---

## Overview

The NestJS backend manages Minecraft server containers via the Docker socket. Each MC server is an independent container spawned and controlled by the backend.

The socket path is configurable via `DOCKER_SOCKET` (default: `/var/run/docker.sock`). **Rootless Docker is the default** — no root privileges required. `DockerService` reads the path from `ConfigService` at startup, never hardcoded.

> **Implemented (Phase 1 slice):** socket connection, ping, hardened container create/start/stop/remove, container inspect, host RAM/CPU via `docker.info`, host disk via `fs.statfs`.
>
> **Deferred:** container stats, log streaming, exec/RCON console, server lifecycle endpoints (`ServersService`), WebSocket metrics.

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
| Env vars         | `EULA=TRUE`, `TYPE`, `VERSION`, `MEMORY`, `MAX_PLAYERS`, `DIFFICULTY`, `MODE`, `ONLINE_MODE`, `VIEW_DISTANCE`, `ALLOW_FLIGHT`, `PVP`, `MOTD`, `SEED` |

> **`MC_DATA_PATH` is one absolute path, identical on the Docker host and inside the backend container.** Compose mounts `${MC_DATA_PATH_HOST}` at the same absolute path and passes it as `MC_DATA_PATH`; the daemon bind source and backend `statfs` therefore name the same physical root. Relative values and values with surrounding whitespace are rejected (Compose interpolates `MC_DATA_PATH_HOST` verbatim, so the two must normalize identically); the obsolete `mc-data` named volume was removed from compose.
>
> **Operator prerequisites:** the default host root is `$HOME/.minepanel/mc-data` (user-writable; Compose creates it — no privileged prep on rootless Docker). Existing installs on `/srv/...` or the old `minepanel-mc-data` named volume keep their location by setting `MC_DATA_PATH_HOST` to their absolute path (upgrade-only: copy the old volume contents into the chosen host root once, before cutover — fresh installs do nothing). Root-docker operators should pre-create and `chown` the root for the Minecraft container runtime user. On SELinux, label the directory per local policy — never embed `:Z` in `MC_DATA_PATH_HOST`.

### DockerService methods

Implemented:

```ts
createContainer(server: Server): Promise<string>   // returns containerId
startContainer(containerId: string): Promise<void>
stopContainer(containerId: string, stopTimeoutSeconds = 30): Promise<void>
removeContainer(containerId: string): Promise<void>
inspectContainer(containerId: string): Promise<ContainerInspectState>
getHostInfo(): Promise<{ totalRamMb: number | null; cpuCount: number | null }>
getHostDiskInfo(): Promise<{ totalDiskMb: number | null; freeDiskMb: number | null }>
ping(): Promise<boolean>
```

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

## Servers Module (planned future work)

`ServersService` will own all business logic. `ServersController` will be thin.

### Endpoints

| Method | Path                | Auth         | Description                        |
|--------|---------------------|--------------|------------------------------------|
| POST   | /servers            | ADMIN        | Create and register a new server   |
| GET    | /servers            | JWT          | List servers (filtered by access)  |
| GET    | /servers/:id        | JWT          | Get single server details          |
| POST   | /servers/:id/start  | ADMIN \| MOD | Start server container             |
| POST   | /servers/:id/stop   | ADMIN \| MOD | Stop server container              |
| DELETE | /servers/:id        | ADMIN        | Delete server + remove container   |

> MOD access to start/stop requires `SERVER_LIFECYCLE` permission (Phase 1.5).

### Create server flow

```
POST /servers  (ADMIN only)
  1. validate DTO (name, provider, version, port, maxPlayers, etc.)
  2. check port not already in use (unique in DB)
  3. create Server record in DB (status: STOPPED)
  4. call DockerService.createContainer(server) → get containerId
  5. update Server record with containerId
  6. return server data
```

### Start server flow

```
POST /servers/:id/start
  1. fetch Server from DB, check status is STOPPED or ERROR
  2. update status to STARTING
  3. call DockerService.startContainer(server.containerId)
  4. update status to RUNNING
  5. return updated server
```

### Stop server flow

```
POST /servers/:id/stop
  1. fetch Server from DB, check status is RUNNING or STARTING
  2. update status to STOPPING
  3. call DockerService.stopContainer(server.containerId)
  4. update status to STOPPED
  5. return updated server
```

### Delete server flow

```
DELETE /servers/:id  (ADMIN only)
  1. fetch Server from DB
  2. if status is RUNNING → stop first
  3. call DockerService.removeContainer(server.containerId)
  4. delete Server record from DB
  5. optionally: remove volume data (configurable)
```

---

## Server Model (Drizzle schema)

| Field       | Type           | Notes                          |
|-------------|----------------|--------------------------------|
| id          | String         | cuid PK                        |
| name        | String         |                                |
| provider    | ServerProvider | VANILLA \| PAPER \| PURPUR \| FABRIC \| FORGE |
| version     | String         | e.g. "1.21.1"                  |
| port        | Int            | unique, host port              |
| containerId | String?        | set after Docker create        |
| status      | ServerStatus   | STOPPED \| STARTING \| RUNNING \| STOPPING \| ERROR |
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

The list endpoint must filter results based on the requesting user's access:

- **ADMIN** → sees all servers
- **MOD / USER** → sees only:
  - servers with `accessType: OPEN`
  - servers where they have an approved `ServerAccess` record (Phase 1.5)

For Phase 1 (before ServerAccess table exists): all authenticated users see all servers. Filtering added in Phase 1.5.

---

## Environment Variables

| Variable       | Description                          | Default                      |
|----------------|--------------------------------------|------------------------------|
| DOCKER_SOCKET  | Path to Docker socket                | /var/run/docker.sock         |
| DOCKER_NETWORK | Docker network for MC containers     | minepanel_network            |
| MC_DATA_PATH_HOST | Host data root (compose only) | $HOME/.minepanel/mc-data |
| MC_DATA_PATH   | Base path for MC server data volumes (absolute; must be identical on host and inside backend container) | /mc-data |
| MC_PORT_MIN    | Minimum allowed MC server port       | 25565                        |
| MC_PORT_MAX    | Maximum allowed MC server port       | 25665                        |
