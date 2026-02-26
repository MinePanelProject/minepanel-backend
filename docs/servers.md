# Servers Architecture

> Phase 1 — Docker module + Servers module.

---

## Overview

The NestJS backend manages Minecraft server containers via the Docker socket. Each MC server is an independent container spawned and controlled by the backend.

The socket path is configurable via `DOCKER_SOCKET` (default: `/run/user/1000/docker.sock`). **Rootless Docker is the default** — no root privileges required. `DockerService` reads the path from `ConfigService` at startup, never hardcoded.

```
NestJS backend
  └── DockerService (via Dockerode + /var/run/docker.sock)
        ├── creates containers  (itzg/minecraft-server image)
        ├── starts / stops / removes containers
        ├── streams logs
        └── executes commands inside containers (MC console)
```

---

## Docker Module

`DockerService` wraps Dockerode and exposes methods used by `ServersService`.

### Container config per server

| Setting          | Value                                  |
|------------------|----------------------------------------|
| Image            | `itzg/minecraft-server`               |
| Network          | `minepanel_network` (env: DOCKER_NETWORK) |
| Volume           | `{MC_DATA_PATH}/{serverId}`            |
| Port mapping     | `{server.port}:25565`                  |
| Memory limit     | 2GB default                            |
| Restart policy   | `unless-stopped`                       |
| Env vars         | `EULA=TRUE`, `TYPE`, `VERSION`, etc.   |

### DockerService methods

```ts
createContainer(server: Server): Promise<string>   // returns containerId
startContainer(containerId: string): Promise<void>
stopContainer(containerId: string): Promise<void>
removeContainer(containerId: string): Promise<void>
getContainerStats(containerId: string): Promise<ContainerStats>
streamLogs(containerId: string): Promise<Readable>
execCommand(containerId: string, cmd: string): Promise<string>
```

---

## Servers Module

`ServersService` owns all business logic. `ServersController` is thin.

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
| DOCKER_SOCKET  | Path to Docker socket                | /run/user/1000/docker.sock   |
| DOCKER_NETWORK | Docker network for MC containers     | minepanel_network            |
| MC_DATA_PATH   | Base path for MC server data volumes | /mc-data                     |
