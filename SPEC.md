# MinePanel Backend - Architecture Specification

## Overview

MinePanel is a self-hosted Minecraft server management panel. A single `docker-compose up` brings up the entire stack on the user's own host — no external services, no cloud dependencies.

**What it does:** the backend manages PostgreSQL for state, controls Minecraft server containers via the Docker socket, and exposes a REST + WebSocket API consumed by the frontend.

**Ecosystem — three clients, one backend API:**

| Client | Repo | Tech | Audience |
|--------|------|------|----------|
| Web dashboard | `minepanel-frontend` | SvelteKit (planned) | ADMIN, MOD, USER |
| Mobile app | `minepanel-mobile` | KMP + Compose Multiplatform (iOS + Android) | USER, MOD |
| Backend API | `minepanel-backend` (this repo) | NestJS + PostgreSQL | — |

The backend is fully agnostic of the client. Role-based guards (`ADMIN` / `MOD` / `USER`) enforce access at the API level. Each client adapts its UI to the authenticated user's role — same API, different experiences.

**Key design decisions:**
- **Self-hosted first**: the entire stack (backend + database + MC servers) runs on the user's machine. The only external calls are optional (Discord webhooks, Mojang UUID API, Hangar/Modrinth for versions)
- **Multi-backend**: the hosted frontend (`minepanel.xyz`) supports multiple independent self-hosted backends. Each user points the frontend at their own instance URL. Cross-origin cookies work via `SameSite=None; Secure` + strict CORS
- **No external queue or cache**: Postgres is the only stateful dependency. No Redis, no BullMQ, no CDN — cron jobs run in-process via `@nestjs/schedule`, caches are in-memory
- **Role system**: three roles (`ADMIN`, `MOD`, `USER`) with PBAC granular permissions for MODs (per-server capabilities without full admin access)
- **Not admin-only**: unlike most MC panels, regular players have a dedicated portal — server status, access requests, player profile, push notifications (mobile)

**Development phases:**
- **Phase 1** — v1.0 deployable: auth (JWT cookies, sessions, password change, rate limiting), server lifecycle (create/start/stop/delete/list), Docker service, health check, host metrics via WebSocket, security hardening, Docker deployment
- **Phase 1.5** — access control: server visibility (OPEN/REQUEST/PRIVATE), MOD permissions, Google/GitHub OAuth, Minecraft account linking, magic links (SMTP optional), invite tokens
- **Phase 2** — developer platform: audit log, API key authentication, outbound webhooks, historical metrics
- **Phase 3** — operations: WebSocket real-time (logs, players), RCON, backups (local + cloud S3/GCS/SFTP), scheduled tasks, notifications, file manager, player management
- **Phase 4** — marketplace: plugin/mod browser (Modrinth, Hangar, CurseForge), server wizard presets, template clone
- **Phase 5** — networking: Velocity proxy with auto-generated config, Bedrock server support
- **Phase 6** — mobile app: KMP (Kotlin Multiplatform + Compose Multiplatform) app with push notifications, quick server control, player portal

---

## Container Architecture

```text
User runs: docker-compose up -d

┌──────────────────────────────────────────────────────────────┐
│                        Docker Host                           │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  minepanel-nestjs (container)                        │   │
│  │  - NestJS backend                  Port: 3000:3000   │   │
│  │  - Socket: ${DOCKER_SOCKET} (rootless default)       │   │
│  │  - Volume: mc-data/  (shared with MC containers)     │   │
│  │  - Volume: panel-assets/ (logo, static assets)       │   │
│  │  - Network: minepanel_network                        │   │
│  └──────────────────┬───────────────────────────────────┘   │
│                     │ Postgres                               │
│                     ↓                                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  minepanel-postgres (container)                      │   │
│  │  - PostgreSQL 16          Volume: postgres-data/     │   │
│  │  - Network: minepanel_network                        │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│                     ↓ Docker socket — spawns MC containers   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  mc-{id}-1  (itzg/minecraft-server)  Port: 2556x     │   │
│  │  - Volume: mc-data/{serverId}:/data  (shared)        │   │
│  │  - Network: minepanel_network                        │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  mc-{id}-2  (itzg/minecraft-server)  Port: 2556x     │   │
│  │  - Volume: mc-data/{serverId}:/data  (shared)        │   │
│  │  - Network: minepanel_network                        │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┄ Phase 5 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  mc-proxy-1  (Velocity)              Port: 25565     │   │
│  │  - Routes players to backend servers (internal only) │   │
│  │  - velocity.toml auto-generated by NestJS            │   │
│  │  - Network: minepanel_network                        │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

### Backend (`minepanel-backend`)

- **Framework:** NestJS v11
- **Database:** PostgreSQL 16 + Drizzle ORM
- **Docker management:** Dockerode
- **Auth:** JWT (HttpOnly cookies) via `@nestjs/jwt` — no Passport
- **Logging:** `nestjs-pino` (structured JSON via Pino, replaces NestJS default Logger)
- **Language:** TypeScript 5
- **Runtime:** Node.js 20 (dev) / Bun (prod)
- **Package manager:** Bun

---

## Module Structure

```
src/
├── main.ts
├── app.module.ts
├── db/
│   ├── db.module.ts          ← Drizzle connection + DRIZZLE token
│   └── schema.ts             ← all table/enum definitions + inferred types
├── auth/
│   ├── auth.module.ts
│   ├── auth.service.ts
│   ├── auth.controller.ts
│   ├── dto/
│   │   ├── register.dto.ts
│   │   └── login.dto.ts
│   └── guards/
│       ├── jwt-auth.guard.ts       ← pure CanActivate, no Passport
│       ├── roles.guard.ts
│       └── permissions.guard.ts   ← Phase 1.5
├── users/
│   ├── users.module.ts
│   └── users.service.ts
├── setup/
│   ├── setup.module.ts
│   ├── setup.service.ts
│   └── setup.controller.ts
├── docker/
│   ├── docker.module.ts
│   └── docker.service.ts
├── servers/
│   ├── servers.module.ts
│   ├── servers.service.ts
│   └── servers.controller.ts
├── rcon/                          ← Phase 3b
│   ├── rcon.module.ts
│   └── rcon.service.ts
├── plugins/                       ← Phase 3f
│   ├── plugins.module.ts
│   ├── plugins.service.ts
│   └── plugins.controller.ts
├── files/                         ← Phase 3h
│   ├── files.module.ts
│   ├── files.service.ts
│   └── files.controller.ts
├── backup/                        ← Phase 3c
│   ├── backup.module.ts
│   ├── backup.service.ts
│   └── backup.controller.ts
├── tasks/                         ← Phase 3d
│   ├── tasks.module.ts
│   ├── tasks.service.ts
│   └── tasks.controller.ts
├── notifications/                 ← Phase 3e
│   ├── notifications.module.ts
│   ├── notifications.service.ts
│   └── notifications.controller.ts
├── admin/                         ← Phase 3j
│   ├── admin.module.ts
│   ├── admin.service.ts
│   └── admin.controller.ts
├── gateway/                       ← Phase 3a (WebSocket)
│   ├── gateway.module.ts
│   └── events.gateway.ts
└── common/
    ├── decorators/
    │   ├── public.decorator.ts
    │   ├── roles.decorator.ts
    │   └── permissions.decorator.ts ← Phase 1.5
    └── filters/
        └── db-exception.filter.ts   ← catches postgres.js errors (PG error codes)
```

---

## Database Schema

### Enums

- **Role:** `ADMIN`, `MOD`, `USER`
- **UserStatus:** `ACTIVE`, `PENDING`, `BANNED`
- **ServerProvider:** `VANILLA`, `PAPER`, `PURPUR`, `FABRIC`, `FORGE`
- **ServerStatus:** `STOPPED`, `CREATING`, `STARTING`, `RUNNING`, `STOPPING`, `ERROR`
- **AccessType:** `OPEN`, `REQUEST`, `PRIVATE`

### Models

**User**
| Field         | Type     | Notes                                      |
|---------------|----------|--------------------------------------------|
| id            | String   | cuid, PK                                   |
| email         | String   | unique                                     |
| username      | String   | unique                                     |
| passwordHash  | String?  | null for OAuth-only accounts               |
| role          | Role     | default: USER                              |
| googleId           | String?  | unique, set on Google OAuth login          |
| githubId           | String?  | unique, set on GitHub OAuth login          |
| status             | UserStatus | default: ACTIVE                          |
| minecraftUUID      | String?  | unique                                     |
| minecraftName      | String?  |                                            |
| minecraftVerified  | Boolean  | default: false — true = premium (Microsoft OAuth verified) |
| createdAt     | DateTime |                                            |
| updatedAt     | DateTime |                                            |
| servers       | Server[]       | relation                             |
| refreshTokens | RefreshToken[] | relation                             |

**SetupState** (singleton)
| Field               | Type     | Notes              |
|---------------------|----------|--------------------|
| id                  | String   | default: singleton |
| initialAdminCreated | Boolean  | default: false     |
| createdAt           | DateTime |                    |
| updatedAt           | DateTime |                    |

**RefreshToken**
| Field       | Type      | Notes                                             |
|-------------|-----------|---------------------------------------------------|
| id          | String    | cuid, PK                                          |
| token       | String    | unique, hashed                                    |
| userId      | String    | FK -> User                                        |
| userAgent   | String?   | browser/device string from `User-Agent` header    |
| lastUsedAt  | DateTime  | updated on every `/auth/refresh` call             |
| expiresAt   | DateTime  |                                                   |
| createdAt   | DateTime  |                                                   |

**MagicLinkToken** (Phase 1.5 — requires SMTP)
| Field     | Type     | Notes                                          |
|-----------|----------|------------------------------------------------|
| id        | String   | cuid PK                                        |
| email     | String   | target email address                           |
| token     | String   | unique, hashed — sent in URL/email             |
| expiresAt | DateTime | default: now + 15 minutes                      |
| usedAt    | DateTime?| set on successful verification — single use    |
| createdAt | DateTime |                                                |

**ApiKey** (Phase 2)
| Field       | Type      | Notes                                            |
|-------------|-----------|--------------------------------------------------|
| id          | String    | cuid PK                                          |
| name        | String    | friendly label (e.g. "CI deploy script")        |
| key         | String    | unique, hashed — shown plaintext only at creation|
| userId      | String    | FK → User (owner)                               |
| lastUsedAt  | DateTime? |                                                  |
| expiresAt   | DateTime? | null = never expires                             |
| createdAt   | DateTime  |                                                  |

**Webhook** (Phase 2)
| Field     | Type     | Notes                                                    |
|-----------|----------|----------------------------------------------------------|
| id        | String   | cuid PK                                                  |
| name      | String   | friendly label                                           |
| url       | String   | HTTPS endpoint to POST to                               |
| events    | String[] | list of subscribed event names (see Webhooks section)   |
| secret    | String   | used for HMAC-SHA256 signature (`X-MinePanel-Signature`)|
| enabled   | Boolean  | default: true                                           |
| createdAt | DateTime |                                                          |

**Server**
| Field           | Type           | Notes                                         |
|-----------------|----------------|-----------------------------------------------|
| id              | String         | cuid, PK                                      |
| name            | String         |                                               |
| provider        | ServerProvider |                                               |
| version         | String         |                                               |
| port            | Int            | unique                                        |
| containerId     | String?        | unique, set after Docker create               |
| status          | ServerStatus   | default: STOPPED                              |
| accessType      | AccessType     | default: OPEN (Phase 1.5)                     |
| onlineMode      | Boolean        | default: true — false = offline/cracked       |
| maxPlayers      | Int            | default: 20                                   |
| difficulty      | String         | default: normal                               |
| gamemode        | String         | default: survival                             |
| pvp             | Boolean        | default: true                                 |
| memoryLimitMb   | Int            | default: 2048, min: 512                       |
| worldPath       | String?        |                                               |
| rconPassword    | String?        | generated at creation, stored encrypted       |
| discordWebhook  | String?        | optional Discord webhook URL for notifications|
| pendingDeleteAt | DateTime?      | set on delete; volume cleaned up after this   |
| ownerId         | String         | FK → User                                     |
| createdAt       | DateTime       |                                               |
| updatedAt       | DateTime       |                                               |

**Ban**
| Field     | Type      | Notes                                   |
|-----------|-----------|-----------------------------------------|
| id        | String    | cuid PK                                 |
| serverId  | String    | FK → Server                             |
| uuid      | String    | banned player UUID                      |
| username  | String    | last-known username (display only)      |
| reason    | String?   |                                         |
| bannedBy  | String    | FK → User                               |
| expiresAt | DateTime? | null = permanent ban                    |
| createdAt | DateTime  |                                         |

---

## API Endpoints

### Panel info

| Method | Path         | Auth   | Description                                      |
|--------|--------------|--------|--------------------------------------------------|
| GET    | /api/info    | No     | Returns `{ name, version }` for frontend listing |
| GET    | /panel/logo  | Public | Panel instance logo (PNG, cached)                |
| PUT    | /panel/logo  | ADMIN  | Upload custom panel logo                         |
| DELETE | /panel/logo  | ADMIN  | Reset panel logo to default                      |

> Used by the frontend to show a friendly panel name when the user manages multiple backend instances. `name` comes from the `PANEL_NAME` env var (default: `"MinePanel"`).

### Setup

| Method | Path           | Auth | Description                          |
|--------|----------------|------|--------------------------------------|
| GET    | /setup/status  | No   | Check if admin created               |
| POST   | /setup/init    | No   | Create first admin (only works once) |

### Auth

| Method | Path                    | Auth | Description                                    |
|--------|-------------------------|------|------------------------------------------------|
| POST   | /auth/register          | No   | Register user                                  |
| POST   | /auth/login             | No   | Login, sets HttpOnly cookies (JWT)             |
| POST   | /auth/refresh           | No   | Refresh access token via HttpOnly cookie       |
| POST   | /auth/logout            | JWT  | Revoke current refresh token, clear cookies    |
| POST   | /auth/logout-all        | JWT  | Revoke all refresh tokens (all sessions)       |
| GET    | /auth/profile           | JWT  | Get current user                               |
| PATCH  | /auth/profile           | JWT  | Update profile (link Minecraft account)        |
| PATCH  | /auth/password          | JWT  | Change own password (requires current password)|
| GET    | /auth/sessions          | JWT  | List own active sessions (refresh tokens)      |
| DELETE | /auth/sessions/:id      | JWT  | Revoke a specific session by token id          |
| POST   | /auth/magic-link        | No   | Request magic link — sends OTP email (requires SMTP) |
| GET    | /auth/magic-link/verify | No   | Verify magic link token, issue JWT cookies           |
| POST   | /auth/google/token      | No   | Verify Google ID token from frontend, issue JWT      |
| POST   | /auth/github/token      | No   | Verify GitHub token from frontend, issue JWT         |
| GET    | /auth/minecraft         | JWT  | Start Microsoft OAuth for Minecraft linking      |
| GET    | /auth/minecraft/callback| JWT  | Handle Microsoft callback, store verified UUID   |
| PATCH  | /auth/profile/minecraft | JWT  | Manual Minecraft link (offline/non-premium)      |

### Users

| Method | Path               | Auth  | Description                                        |
|--------|--------------------|-------|----------------------------------------------------|
| GET    | /users             | ADMIN | List all panel users                               |
| GET    | /users/:id         | JWT   | Get user profile (ADMIN or self only)              |
| PATCH  | /users/me          | JWT   | Update own profile (username, email)               |
| PATCH  | /users/:id/role    | ADMIN | Change user role (USER ↔ MOD)                      |

### API Keys (Phase 2)

| Method | Path                  | Auth | Description                                          |
|--------|-----------------------|------|------------------------------------------------------|
| GET    | /auth/api-keys        | JWT  | List own API keys (key value not shown after creation)|
| POST   | /auth/api-keys        | JWT  | Create API key — returns plaintext key **once only** |
| DELETE | /auth/api-keys/:id    | JWT  | Revoke API key                                       |

### Servers

| Method | Path                    | Auth         | Description                        |
|--------|-------------------------|--------------|------------------------------------|
| POST   | /servers                | ADMIN        | Create MC server                   |
| GET    | /servers                | JWT          | List servers (filtered by access)  |
| GET    | /servers/:id            | JWT          | Get single server                  |
| PATCH  | /servers/:id            | ADMIN \| MOD | Update server settings             |
| POST   | /servers/:id/start      | ADMIN \| MOD | Start server (409 if not STOPPED)  |
| POST   | /servers/:id/stop       | ADMIN \| MOD | Graceful stop (warn → save → stop) |
| POST   | /servers/:id/restart    | ADMIN \| MOD | Graceful stop → start sequence     |
| DELETE | /servers/:id            | ADMIN        | Delete server (202 Accepted, async)|
| GET    | /versions               | JWT          | List available versions per provider|
| PATCH  | /servers/:id/version    | ADMIN        | Update MC version (auto-backup first)|
| GET    | /servers/:id/icon       | JWT          | Get server icon (PNG, ETag cached)  |
| PUT    | /servers/:id/icon       | ADMIN \| MOD | Upload custom server icon (64×64 PNG)|

### Webhooks (Phase 2)

| Method | Path               | Auth  | Description                                  |
|--------|--------------------|-------|----------------------------------------------|
| GET    | /webhooks          | ADMIN | List configured webhooks                     |
| POST   | /webhooks          | ADMIN | Create webhook (url, events[], secret)       |
| PATCH  | /webhooks/:id      | ADMIN | Update webhook (url, events, enabled)        |
| DELETE | /webhooks/:id      | ADMIN | Delete webhook                               |
| POST   | /webhooks/:id/test | ADMIN | Send a test payload to verify the endpoint  |

### System

| Method | Path          | Auth   | Description                              |
|--------|---------------|--------|------------------------------------------|
| GET    | /health       | Public | Liveness check (db + docker status)      |
| GET    | /system/stats | ADMIN  | Host resource usage overview             |
| GET    | /audit-log    | ADMIN  | Audit log (Phase 2, filter by action/resourceId/userId) |

`GET /health` response:
```json
{ "status": "ok", "db": "ok", "docker": "ok", "version": "0.1.0" }
```
- `db`: executes `SELECT 1` via Drizzle
- `docker`: calls `docker.ping()` (Dockerode)
- If either fails: HTTP 503 with `"status": "degraded"` and the failing service marked `"error"`
- `@Public()` — no auth required; used by Docker healthcheck and monitoring

**Docker daemon unreachable — graceful degradation:**

If the Docker socket is unavailable at startup or becomes unreachable at runtime:
- `GET /health` returns HTTP 503 `{ "status": "degraded", "docker": "error" }`
- All endpoints that call `DockerService` (`start`, `stop`, `create`, etc.) return HTTP 503 `{ "statusCode": 503, "message": "Docker daemon unreachable" }` — **no DB state is mutated** (server status remains unchanged)
- `GET /servers`, `GET /servers/:id`, and read-only endpoints continue to function normally using DB data
- The WebSocket stats stream stops emitting `server.stats` events; the frontend should show stale/unknown stats after a timeout

Docker healthcheck (in `docker-compose.yml`):
```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
  interval: 30s
  timeout: 5s
  retries: 3
```

`GET /system/stats` response shape:
```json
{
  "host": {
    "totalRamMb": 16384,
    "usedRamMb": 9000,
    "freeRamMb": 7384,
    "cpuCount": 8,
    "totalDiskMb": 512000,
    "freeDiskMb": 120000
  },
  "servers": {
    "total": 3,
    "running": 2,
    "allocatedRamMb": 8192
  }
}
```

### System Events (Phase 2)

| Method | Path              | Auth  | Description                                                  |
|--------|-------------------|-------|--------------------------------------------------------------|
| GET    | /system/events    | ADMIN | List system events (filter: `?level=&source=&limit=&offset=`) |

`SystemEvent` table:

| Field     | Type     | Notes                                                                 |
|-----------|----------|-----------------------------------------------------------------------|
| id        | String   | cuid PK                                                               |
| level     | Enum     | `INFO`, `WARN`, `ERROR`                                               |
| source    | Enum     | `DOCKER`, `SERVERS`, `HEALTH`, `SCHEDULER`                            |
| message   | String   | Human-readable description                                            |
| metadata  | Json?    | Extra context (e.g. `{ serverId, containerId, errorCode }`)           |
| createdAt | DateTime |                                                                       |

**Who writes events:**

| Source      | Examples                                                                 |
|-------------|--------------------------------------------------------------------------|
| `DOCKER`    | Docker daemon unreachable, container OOM-killed, image pull failed       |
| `SERVERS`   | Startup reconciliation changes, resource check failures, graceful shutdown |
| `HEALTH`    | DB ping failed, Docker ping failed                                       |
| `SCHEDULER` | Scheduled task failed, cron re-registration at boot                     |

Events are written by the relevant service directly (no interceptor needed — these are internal events, not user actions). Retention: last 10 000 rows, older rows auto-deleted by a weekly cron. Surfaced in the Admin dashboard as a filterable event feed, distinct from the audit log (which records user actions) and notifications (which require user acknowledgement).

---

### Server Access (Phase 1.5)

| Method | Path                                         | Auth      | Description                        |
|--------|----------------------------------------------|-----------|------------------------------------|
| POST   | /servers/:id/request-access                  | JWT       | Request access to a server                          |
| GET    | /servers/:id/my-access-request               | JWT       | Get own access request status (PENDING/APPROVED)    |
| GET    | /servers/:id/access-requests                 | ADMIN     | List all pending access requests                    |
| POST   | /servers/:id/access-requests/:userId/approve | ADMIN     | Approve a user's access request                     |
| DELETE | /servers/:id/access-requests/:userId         | ADMIN     | Reject or revoke access                             |

### Admin (Phase 1.5)

| Method | Path                             | Auth  | Description                              |
|--------|----------------------------------|-------|------------------------------------------|
| PATCH  | /admin/users/:id/status               | ADMIN | Ban / unban / set PENDING on a user                       |
| POST   | /admin/users/:id/reset-password       | ADMIN | Reset user password — returns one-time temporary password |
| GET    | /admin/users/:id/permissions          | ADMIN | List MOD permissions for a user                           |
| POST   | /admin/users/:id/permissions          | ADMIN | Assign a permission to a MOD                              |
| DELETE | /admin/users/:id/permissions/:permId  | ADMIN | Revoke a permission from a MOD                            |

### Endpoint behaviors: server lifecycle

#### `POST /servers/:id/stop` and `POST /servers/:id/restart` — graceful shutdown

A graceful shutdown warns online players and flushes world data before stopping the container. This prevents chunk corruption and data loss.

**`ServersService.stopServer()` sequence**:
```
1. set server status = STOPPING in DB
2. if RCON connection available:
   a. sendCommand('say §cServer closing in {STOP_WARN_SECONDS} seconds...')
   b. wait STOP_WARN_SECONDS
   c. sendCommand('save-all')
   d. wait 3s  (allow chunk writes to complete)
   e. sendCommand('stop')
   f. wait up to 15s for container to stop naturally
3. if RCON unavailable (server still starting up) OR 15s timeout exceeded:
   → docker.getContainer(id).stop({ t: 10 })  (SIGTERM + 10s grace, then SIGKILL)
4. set status = STOPPED in DB
5. emit server.status WebSocket event
```

`POST /servers/:id/restart` calls the full stop sequence, then the start sequence — it does **not** use `docker restart` (which would bypass the graceful shutdown).

If the server is in `STARTING` state and RCON is not yet available, the warning step is skipped and the container is stopped directly.

#### `DELETE /servers/:id` — deletion policy

Server must be STOPPED — returns 409 if RUNNING or STARTING.

**`ServersService.deleteServer()` sequence**:
```
1. check status === STOPPED → 409 otherwise
2. set server.pendingDeleteAt = now + 24h in DB
3. create final backup: tar.gz → {MC_DATA_PATH}/{serverId}/final-backup-{timestamp}.tar.gz
   → if backup fails: log warning, continue (do not block deletion)
4. docker.getContainer(containerId).remove({ force: false })
   → if container not found: continue (idempotent)
5. delete DB record (cascades: ScheduledTask, Backup metadata, ServerAccess, ServerPlugin, AuditLog)
6. return 202 Accepted (volume cleanup is async)
7. async job runs after 24h: rm -rf {MC_DATA_PATH}/{serverId}/
```

**Rationale for 24h delay**: gives admin time to recover data if the deletion was accidental. The 24h window is not configurable — it is a safety margin, not a feature. After the volume is removed, recovery is impossible.

**`Server.pendingDeleteAt`**: new nullable `DateTime` field on `Server` model. A scheduled job (`@Cron`) polls every hour for servers where `pendingDeleteAt < now` and performs the volume cleanup.

#### `GET /versions` — available versions per provider

Returns the list of available MC versions for each provider. Used by the frontend to populate version dropdowns during server creation and version updates.

```json
{
  "VANILLA":  ["1.21.1", "1.21", "1.20.4", "1.20.1", "1.19.4"],
  "PAPER":    ["1.21.1", "1.20.6", "1.20.4", "1.19.4"],
  "FORGE":    ["1.20.1-47.3.0", "1.19.2-43.3.0", "1.18.2-40.2.0"],
  "FABRIC":   ["1.21.1", "1.20.4", "1.19.4"],
  "PURPUR":   ["1.21.1", "1.20.4"]
}
```

Source per provider:
- **VANILLA / PAPER / PURPUR**: Hangar API or Modrinth metadata
- **FORGE**: Forge maven (`https://files.minecraftforge.net/maven/net/minecraftforge/forge/maven-metadata.xml`)
- **FABRIC**: Fabric meta API (`https://meta.fabricmc.net/v2/versions/game`)

Response is cached in memory with TTL: 1 hour. Cold cache is populated on first request.

#### `PATCH /servers/:id/version` — update MC version

Server must be STOPPED — returns 409 if running.

```
1. validate new version exists for server.provider (from cached /versions list)
2. create backup snapshot: tar.gz → {MC_DATA_PATH}/{serverId}/pre-update-{timestamp}.tar.gz
   → if backup fails: abort with 500 (do not allow version change without backup)
3. update server.version in DB
4. on next start: itzg image auto-downloads the new JAR based on VERSION env var
   (no manual JAR management needed)
```

> **Phase 2 — Docker image update via panel:**
> The `itzg/minecraft-server` Docker image itself must be updated manually by the self-hoster in v1.0 (`docker pull itzg/minecraft-server:latest` + container recreate). Phase 2 will expose `POST /admin/docker/pull-image` that triggers `docker.pull('itzg/minecraft-server:latest')` via Dockerode, with progress streamed via WebSocket. All server containers are recreated sequentially after the pull completes.

**Provider change** (e.g. Vanilla → Paper): out of scope for 1.0. World format compatibility between providers is not guaranteed and requires user-managed migration.

### Pagination

All list endpoints (`GET /servers`, `GET /users`, `GET /notifications`, `GET /servers/:id/backups`, `GET /servers/:id/plugins`) accept:

```
?limit=20&offset=0
```

- Default: `limit=20`, `offset=0`
- Max: `limit=100`
- Response includes `{ data: [...], total: number }` so the frontend can render pagination controls.

---

## Error Response Format

All errors follow NestJS's default `HttpException` format:

```json
{
  "statusCode": 404,
  "error": "Not Found",
  "message": "Server not found"
}
```

`DbExceptionFilter` must use the same shape (already implemented). This allows the frontend to handle errors consistently regardless of source.

---

## Docker Service

The NestJS container connects to the host Docker daemon via the Docker socket. **Rootless Docker is the default** — no root privileges required. The socket is always mounted to `/var/run/docker.sock` **inside** the container; only the host-side path in `docker-compose.yml` changes.

`DockerService` reads the socket path from `ConfigService` at startup (`DOCKER_SOCKET`, default `/var/run/docker.sock` inside container) — it is never hardcoded.

It uses Dockerode to:

- **Create containers** using `itzg/minecraft-server` image
- **Manage lifecycle** (start, stop, remove)
- **Collect stats** (CPU, memory, network)
- **Stream logs** from MC server containers
- **Execute commands** inside containers (e.g., MC console commands)

Each MC server gets:
- Its own subdirectory under the shared `mc-data` volume
- A unique host port mapped to container port 25565
- Attached to `minepanel_network` for inter-container communication
- A configurable memory limit (default 2048 MB, min 512 MB) — see below
- `unless-stopped` restart policy

**Per-server memory limit:**

`Server.memoryLimitMb` is set at creation time via `POST /servers` DTO (`memoryLimitMb?: number`, default: `2048`) and can be updated via `PATCH /servers/:id` while the server is STOPPED.

- **Minimum:** 512 MB — Minecraft JVM requires at least 512 MB to start; requests below this are rejected with 422
- **Maximum:** bounded by `MAX_MEMORY_RATIO` — the resource check at create/start time ensures the sum of all server limits does not exceed the ratio
- **Docker propagation:** `DockerService.createContainer()` sets `HostConfig.Memory = memoryLimitMb * 1024 * 1024` (bytes). The itzg image also receives `MEMORY=${memoryLimitMb}M` as an env var so the MC JVM heap is sized accordingly
- **Live changes:** `memoryLimitMb` changes take effect on the next container start (restart required)

### Socket path reference

The `docker-compose.yml` uses `${XDG_RUNTIME_DIR}/docker.sock` as the host-side socket path — `XDG_RUNTIME_DIR` is automatically set by Linux to `/run/user/<UID>` for the current user. No manual UID configuration needed.

| Setup           | Host-side volume mount in compose                          | `DOCKER_SOCKET` (in container) |
|-----------------|------------------------------------------------------------|--------------------------------|
| Rootless Docker | `${XDG_RUNTIME_DIR}/docker.sock:/var/run/docker.sock`      | `/var/run/docker.sock`         |
| Root Docker     | `/var/run/docker.sock:/var/run/docker.sock`                | `/var/run/docker.sock`         |
| Rootless Podman | `${XDG_RUNTIME_DIR}/podman/podman.sock:/var/run/docker.sock` | `/var/run/docker.sock`       |

> **Default (zero-touch):** rootless Docker. The `docker-compose.yml` ships with `${XDG_RUNTIME_DIR}/docker.sock` — works for any user without knowing their UID. Root Docker users change only the host-side path in the compose volume.

> **Podman compatibility:** Podman's Docker-compatible socket can be mounted to `/var/run/docker.sock` inside the container — no code changes needed.

### Host resource inspection

`DockerService` exposes two methods to read host-level resources. These are called by `ServersService` before any container create/start operation.

```ts
getHostInfo(): Promise<{ totalRamMb: number; cpuCount: number }>
// Uses docker.info() → MemTotal, NCPU — host-level data from the Docker daemon

getHostDiskInfo(): Promise<{ totalDiskMb: number; freeDiskMb: number }>
// Uses fs.statfs(MC_DATA_PATH) — checks free space on the volume where MC data is stored
```

Both methods must be fast (< 100ms) — they are called in the hot path of server create/start.

### Docker socket security guardrails

The Docker socket gives the NestJS app the ability to create arbitrary containers on the host. To limit the blast radius if the app is compromised, `DockerService.createContainer()` must enforce these constraints in code — never allow them to be driven by user input:

| Constraint       | Rule                                                              |
|------------------|-------------------------------------------------------------------|
| Port range       | Only ports in `MC_PORT_RANGE_MIN`–`MC_PORT_RANGE_MAX` (default: 25565–25665) |
| Volume mounts    | Only `{MC_DATA_PATH}/{serverId}:/data` — no user-controlled paths |
| Env vars         | Whitelist of known MC server vars (`EULA`, `TYPE`, `VERSION`, etc.) |
| Network          | Always forced to `DOCKER_NETWORK` — never user-specified          |
| Privileged mode  | Always `false`, hardcoded                                         |
| Capabilities     | `CapAdd: []` — no extra capabilities, hardcoded                   |

These are defense-in-depth measures. The outer layers (input validation, JWT auth) prevent most attacks; these guardrails limit damage if a vulnerability is exploited deeper in the stack.

New env vars:

| Variable         | Description                         | Default |
|------------------|-------------------------------------|---------|
| MC_PORT_MIN      | Minimum allowed MC server port      | 25565   |
| MC_PORT_MAX      | Maximum allowed MC server port      | 25665   |

---

## Environment Variables

| Variable              | Description                        | Default                          |
|-----------------------|------------------------------------|----------------------------------|
| DATABASE_URL          | PostgreSQL connection string       | (required)                       |
| JWT_SECRET            | Secret for JWT signing             | (required)                       |
| JWT_EXPIRES_IN        | Access token TTL                   | 15m                              |
| JWT_REFRESH_EXPIRES_IN| Refresh token TTL                  | 7d                               |
| PORT                  | Backend listen port                | 3000                             |
| DOMAIN                | Public domain (used by Caddy for HTTPS + sets CORS_ORIGIN automatically) | (required in prod) |
| CORS_ORIGIN           | Allowed CORS origin (set automatically from DOMAIN in docker-compose) | http://localhost:5173 |
| DOCKER_SOCKET         | Path to Docker socket (inside container) | /var/run/docker.sock        |
| DOCKER_NETWORK        | Docker network for MC containers   | minepanel_network                |
| MC_DATA_PATH          | Base path for MC server data       | /mc-data                         |
| MC_PORT_MIN           | Minimum allowed MC server port     | 25565                            |
| MC_PORT_MAX           | Maximum allowed MC server port     | 25665                            |
| MIN_FREE_DISK_MB      | Min free disk (MB) on MC_DATA_PATH to allow create/start | 5120     |
| MAX_MEMORY_RATIO      | Max fraction of host RAM to allocate to MC servers (0–1) | 0.90     |
| POSTGRES_PASSWORD      | Postgres password (docker-compose) | changeme                        |
| MICROSOFT_CLIENT_ID    | Azure app client ID (MC linking)   | (optional)                      |
| MICROSOFT_CLIENT_SECRET| Azure app client secret (MC link)  | (optional)                      |
| PANEL_NAME             | Display name shown in frontend listing | MinePanel                   |
| ENCRYPTION_KEY         | 32-byte hex key for RCON password encryption (Phase 3b) | (required Phase 3b) |
| STOP_WARN_SECONDS      | Seconds to warn players before graceful server shutdown | 30              |
| PANEL_ASSETS_PATH        | Directory for panel-level static assets (logo, etc.)      | /panel-assets   |
| REQUIRE_ADMIN_APPROVAL   | If true, new registrations start as PENDING (admin must approve) | true       |
| INSECURE_COOKIES         | Allow HttpOnly cookies over plain HTTP (LAN/local only)         | false      |
| SMTP_HOST                | SMTP server hostname (optional — enables email features)          | (optional) |
| SMTP_PORT                | SMTP port                                                         | 587        |
| SMTP_SECURE              | Use TLS (`true` for port 465, `false` for STARTTLS)               | false      |
| SMTP_USER                | SMTP username                                                     | (optional) |
| SMTP_PASS                | SMTP password                                                     | (optional) |
| SMTP_FROM                | From address for outgoing emails (e.g. `noreply@yourdomain.com`) | (optional) |

> `PANEL_ASSETS_PATH` must be bind-mounted into the NestJS container in `docker-compose.yml`: `- ${PANEL_ASSETS_PATH}:/panel-assets`. The directory is created automatically on first write if it does not exist.

---

## Rate Limiting & Security

### Package

`@nestjs/throttler` — NestJS official rate limiting module. Applied globally via `APP_GUARD`, with per-route overrides using `@Throttle()` and `@SkipThrottle()`.

### Throttle tiers

| Tier       | Limit              | Applied to                                          |
|------------|--------------------|-----------------------------------------------------|
| `strict`   | 5 req / 60s per IP | Login, register, OAuth token endpoints              |
| `standard` | 60 req / 60s per IP| All other authenticated API endpoints               |
| `relaxed`  | 300 req / 60s per IP| WebSocket upgrades, static-like reads              |

> Limits are per IP by default. For authenticated routes, consider switching to per-user-id to avoid penalising users behind shared IPs (e.g. office NAT).

### Per-endpoint config

```
POST /auth/login          → strict   (brute-force protection)
POST /auth/register       → strict   (spam protection)
POST /auth/google/token   → strict
POST /auth/github/token   → strict
POST /auth/refresh        → strict
GET  /setup/status        → @SkipThrottle (called on every frontend load)
POST /setup/init          → strict   (one-time but still protect)
GET  /servers             → standard
WebSocket upgrade         → relaxed
```

### Brute-force protection on login

Plain IP throttling is not enough for login — an attacker can rotate IPs. Add a **per-username attempt counter** in addition to the IP limit:

```
POST /auth/login
  1. check IP throttle (5 req/60s) → 429 if exceeded
  2. check username attempt counter:
     → if attempts >= 10 in last 15min → 429 + lockout message
     → on successful login: reset counter
     → on failed login: increment counter
  3. proceed with password check
```

Counter stored in memory (Map) or in DB (`loginAttempts` on `User`). Memory is fine for single-instance deployment (which is the self-hosted case).

**Key decision:** counter is per-username, not per-email, because an attacker knows/guesses usernames more often than emails.

### Security headers

Use `helmet` (already a NestJS recommended package) in `main.ts`:

```ts
app.use(helmet());
```

Headers it sets automatically:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Strict-Transport-Security` (HTTPS only)
- `Content-Security-Policy` (tighten in prod)
- Removes `X-Powered-By`

### CORS

Already configured via `CORS_ORIGIN` env var. In prod, this should be set to the exact frontend URL (`https://minepanel.xyz`). Never `*` in prod.

**`credentials: true` is required** — it allows the browser to include HttpOnly cookies on cross-origin requests from `minepanel.xyz` to the self-hosted backend.

```ts
app.enableCors({
  origin: configService.get('CORS_ORIGIN'),
  credentials: true,  // ← required for cross-origin cookies
});
```

### Cookie security

| Flag       | Dev   | Prod  | Notes                                |
|------------|-------|-------|--------------------------------------|
| `httpOnly` | ✅    | ✅    | JS cannot read the cookie            |
| `secure`   | ❌    | ✅    | HTTPS only (set when NODE_ENV=production) |
| `sameSite` | `lax` | `none` | Richiesto per cross-origin (vedi nota) |
| `path`     | `/`   | `/`   |                                      |

> **Perché `SameSite=None` e non `Strict`?** Il frontend (`minepanel.xyz`) fa richieste `fetch()` cross-origin al backend self-hosted (`user.domain.com`). Con `SameSite=Strict` o `Lax` il browser non invia i cookie su richieste JavaScript cross-origin — l'autenticazione non funzionerebbe. `SameSite=None; Secure` è l'unica opzione per cookie HttpOnly su richieste cross-origin. La protezione CSRF è garantita da: policy CORS con `origin` specifico + `credentials: true`, e dal fatto che solo `minepanel.xyz` può fare richieste valide.

### Input validation

All DTOs use `class-validator` via NestJS `ValidationPipe` (global). This prevents malformed payloads reaching service layer.

`ValidationPipe` config in `main.ts`:
```ts
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,      // strip unknown fields
  forbidNonWhitelisted: true,  // throw if unknown fields present
  transform: true,      // auto-transform payloads to DTO types
}));
```

`whitelist: true` is important — it prevents unexpected fields from being passed down to the DB layer.

### DTO field constraints

Standard rules applied to all user-facing DTOs and mirrored in the DB schema:

| Field        | DTO validators                                              | DB type        |
|--------------|-------------------------------------------------------------|----------------|
| `email`      | `@IsEmail()`, `@MaxLength(254)`                             | `varchar(254)` |
| `username`   | `@IsString()`, `@MinLength(3)`, `@MaxLength(32)`, `@Matches(/^[a-zA-Z0-9_]+$/)` | `varchar(32)` |
| `password`   | `@IsString()`, `@MinLength(8)`, `@MaxLength(128)`           | hash only — no DB constraint |
| `newPassword`| `@IsString()`, `@MinLength(8)`, `@MaxLength(128)`           | hash only — no DB constraint |
| `oldPassword`| `@IsString()`, `@IsNotEmpty()`                              | — |

**Notes:**
- `email` max 254 = RFC 5321 standard
- `username` regex `^[a-zA-Z0-9_]+$` — alphanumeric + underscore only, no spaces or symbols
- `password` max 128 — bcrypt silently truncates beyond 72 bytes; 128 is a safe upper bound
- DB uses `varchar(N)` instead of `text` for constrained fields — enforces limits at DB level too

### Path traversal (File Manager)

The File Manager (Phase 3h) reads/writes files inside `{MC_DATA_PATH}/{serverId}/`. Every path must be sanitized:

```ts
// Reject any path that resolves outside the server directory
const safePath = path.resolve(serverDir, userPath);
if (!safePath.startsWith(serverDir)) {
  throw new ForbiddenException('Path traversal detected');
}
```

This is the single most important security check in the file manager. A missed check here would allow reading `/etc/passwd` or writing to arbitrary host paths.

### Summary of packages

| Package             | Purpose                                              |
|---------------------|------------------------------------------------------|
| `@nestjs/throttler` | Rate limiting                                        |
| `helmet`            | Security headers                                     |
| `class-validator`   | DTO input validation                                 |
| `class-transformer` | DTO transformation                                   |
| `nestjs-pino`       | Structured JSON logging (Pino)                       |
| `nestjs-paginate`   | Cursor/offset pagination for list endpoints (post-v1.0) |
| `nestjs-cls`        | Request-scoped context propagation — used for audit log interceptor (Phase 2) |

---

## Development Workflow

```bash
# Start Postgres only
docker-compose -f docker-compose.dev.yml up -d

# Install dependencies
bun install

# Push DB schema (first time or after schema changes)
bun db:push

# Run NestJS locally with hot-reload
bun start:dev
```

> **Runtime clarification:** `bun start:dev` runs `nest start --watch` which uses SWC transpiler under Node.js — **not** Bun's transpiler. Bun cannot transpile NestJS TypeScript decorators because of `emitDecoratorMetadata` support gaps. In production, TypeScript is compiled to `dist/` first, then `bun dist/main.js` executes the compiled JavaScript (no transpilation — Bun is just a fast JS runtime here).

## Production Deployment

```bash
cp .env.example .env
# Edit .env with secure passwords/secrets

docker compose up -d
# NestJS + Postgres + Caddy (HTTPS) run in containers
# Or run ./setup.sh (Linux), ./setup-mac.sh (macOS), ./setup.ps1 (Windows)
# for the interactive setup wizard that auto-generates secrets
```

### Multi-architecture support

The NestJS Docker image is built as a multi-platform manifest:
- `linux/amd64` — standard x86 servers and VMs
- `linux/arm64` — Raspberry Pi 4/5, Apple Silicon (via Docker Desktop), AWS Graviton

Build with: `docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/minepanelproject/minepanel-backend .`

The `itzg/minecraft-server` image also supports ARM64 natively — no extra config needed.

### HTTP-only mode (no domain / local network)

When Caddy is not used (`./setup.sh` with empty domain), the panel runs on plain HTTP port 3000. In this mode, cookies must have `Secure=false`, which is already handled by `NODE_ENV=development`.

For LAN/local deployments over HTTP in production, set `INSECURE_COOKIES=true` in `.env`:
```
INSECURE_COOKIES=true   # allows HttpOnly cookies over HTTP (LAN only — never expose to internet)
```
The `JwtAuthService` checks this flag and sets `secure: false` on cookies regardless of `NODE_ENV`.

> Never set `INSECURE_COOKIES=true` on a server exposed to the public internet — cookies will be readable over plain HTTP by network observers.

### Optional: Docker Socket Proxy

Direct Docker socket access (`/var/run/docker.sock`) grants the NestJS container root-equivalent privileges on the host. For hardened deployments, use [Tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) to restrict what API calls are allowed:

```yaml
socket-proxy:
  image: tecnativa/docker-socket-proxy
  environment:
    CONTAINERS: 1
    IMAGES: 1
    NETWORKS: 1
    VOLUMES: 1
    POST: 1
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock:ro
```

Then set `DOCKER_SOCKET=tcp://socket-proxy:2375` in NestJS env. This limits the attack surface if the NestJS container is compromised.

### HTTPS — mandatory in production

`SameSite=None; Secure` cookies (required for multi-backend cross-origin auth) are **only sent by the browser over HTTPS**. Without TLS the browser silently drops every auth cookie → all authenticated requests return 401 with no visible error.

A reverse proxy with TLS termination is not optional. NestJS itself runs plain HTTP on port 3000; the reverse proxy handles HTTPS and forwards to it.

### Default: Caddy (auto-HTTPS, included in docker-compose)

Caddy is **included by default** in `docker-compose.yml` — no extra setup required. It obtains and renews Let's Encrypt certificates automatically, handles HTTP→HTTPS redirect, and proxies WebSocket connections without extra configuration.

Set `DOMAIN` in `.env` and Caddy configures itself:

```
# Caddyfile (shipped with the project)
{$DOMAIN} {
    reverse_proxy nestjs:3000
}
```

The `docker-compose.yml` passes `DOMAIN` as an env var to the Caddy container. `CORS_ORIGIN` is automatically set to `https://${DOMAIN}` in the same compose file — no manual CORS configuration needed.

**Host-based Caddy** (if you prefer Caddy on the host instead of in Docker):

Remove the `caddy` service from `docker-compose.yml`, expose port 3000 on `nestjs`, then use a local Caddyfile:
```
your-domain.com {
    reverse_proxy localhost:3000
}
```

### Alternative: nginx

For users who already have nginx on the host. Requires a TLS certificate (e.g. via `certbot --nginx`).

```nginx
server {
    listen 443 ssl;
    server_name panel.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/panel.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.yourdomain.com/privkey.pem;

    # Required for backup downloads and file uploads (nginx default limit: 1 MB)
    client_max_body_size 50M;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;

        # Required for WebSocket (socket.io)
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name panel.yourdomain.com;
    return 301 https://$host$request_uri;
}
```

> **`client_max_body_size 50M`** — without this, nginx rejects file uploads and backup downloads over 1 MB with a silent 413.

> **`Upgrade` + `Connection` headers** — without these, socket.io falls back to long-polling. Real-time events (logs, stats) still work but with much higher latency.

### Traefik (Docker label-based)

For users already running Traefik. Add labels to the `nestjs` service in `docker-compose.yml`:

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.minepanel.rule=Host(`panel.yourdomain.com`)"
  - "traefik.http.routers.minepanel.entrypoints=websecure"
  - "traefik.http.routers.minepanel.tls.certresolver=letsencrypt"
  - "traefik.http.services.minepanel.loadbalancer.server.port=3000"
```

Traefik handles WebSocket automatically on `websecure` entrypoint.

### Pre-launch checklist

- [ ] Domain DNS points to the host
- [ ] Reverse proxy running with valid TLS certificate
- [ ] `NODE_ENV=production` in `.env` (enables `Secure` cookie flag)
- [ ] `CORS_ORIGIN` set to the **exact** frontend URL (e.g. `https://minepanel.xyz`) — never `*`
- [ ] `JWT_SECRET` is a long random string (not the placeholder)
- [ ] `ENCRYPTION_KEY` is a 32-byte hex string (Phase 3b)
- [ ] `POSTGRES_PASSWORD` changed from `changeme`
- [ ] MC ports (25565–25665) open in firewall if players connect directly

---

## Testing

### Tools

- **Jest** — included in NestJS, runs unit and e2e tests
- **Supertest** — HTTP assertions for e2e tests (included with NestJS e2e setup)
- Separate test database: set `DATABASE_URL` to a test DB in `.env.test`

### Minimum scope — Phase 1

These tests must pass before moving to Phase 1.5:

```
e2e:
  - POST /auth/register → 201, POST /auth/login → 200 + cookies set
  - POST /auth/refresh → new access token returned
  - POST /auth/logout → cookies cleared, refresh token deleted from DB
  - GET /auth/profile (no cookie) → 401
  - GET /auth/profile (valid cookie) → 200 + user data
  - GET /setup/status → 200 (public)
  - POST /setup/init (twice) → second call returns 409 or 403
  - GET /health → 200 { status: 'ok', db: 'ok', docker: 'ok' }
  - POST /servers/:id/start (server already STARTING) → 409 Conflict
  - POST /servers/:id/start (insufficient RAM) → 422 with details.resource = 'memory'
  - DELETE /servers/:id (server RUNNING) → 409 Conflict
  - DELETE /servers/:id (server STOPPED) → 202 Accepted

unit:
  - AuthService.loginUser: wrong password → throws UnauthorizedException
  - AuthService.registerUser: duplicate username → throws ConflictException
  - ServersService.stopServer: RCON unavailable → falls back to docker stop
  - ServersService.createServer: Docker failure → DB record is cleaned up (no orphan)
  - ServersService.onModuleInit: container not running → DB status set to STOPPED
```

### Minimum scope — Phase 1.5

```
e2e:
  - Route with @Roles(ADMIN) accessed by USER → 403
  - Route with @Roles(ADMIN) accessed by ADMIN → 200
  - MOD with SERVER_LIFECYCLE permission → can start/stop server
  - MOD without permission → 403
```

---

## Implementation Phases

### Phase 1 - Foundation (v1.0)

1. Auth module (register, login, JWT via HttpOnly cookies, refresh, logout, guards) ✅
2. Setup module (first-run wizard, admin creation) ✅
3. RolesGuard + `@Roles()` decorator ✅
4. Sessions management (list, revoke single, logout-all) ✅
5. `PATCH /auth/profile` (edit profile) ✅
6. `PATCH /auth/password` (change password) ✅
7. Rate limiting (`@nestjs/throttler` on public endpoints) ✅
8. Security hardening (validation, DTO constraints, helmet config) ✅
9. Health check (`GET /health` — db liveness) ✅
10. Docker module (socket connection, container CRUD + host resource inspection)
11. Server module:
    - create/start/stop/delete/list MC servers + resource checks
    - Graceful shutdown sequence (`stopServer()`)
    - Startup reconciliation (`onModuleInit`)
    - Concurrent operation protection (atomic compare-and-swap via Postgres)
    - Transaction rollback on Docker failure
12. Host metrics WebSocket (CPU, RAM, disk — real-time push to frontend)
13. Unit + integration tests (AuthService, UsersService, guards, critical routes)
14. CI/CD pipeline (GitHub Actions: lint → test → build → push Docker image to GHCR)
15. Dockerize the backend (docker-compose, migrations on startup, env vars)

#### Resource check flows (Phase 1, inside ServersService)

Resource checks are hard guardrails — they return `422 Unprocessable Entity` if insufficient, **before** any DB write or container operation.

**On `POST /servers` (create):**
```
1. check freeDiskMb >= MIN_FREE_DISK_MB
   → 422 { error: 'InsufficientDisk', freeMb: X, requiredMb: MIN_FREE_DISK_MB }
2. check (sum of ALL server memoryLimitMb, regardless of status) + newServer.memoryLimitMb
      <= totalRamMb * MAX_MEMORY_RATIO
   → 422 { error: 'InsufficientMemory', allocatedMb: X, totalMb: Y, maxRatio: 0.9 }
```

Sum of ALL servers (not just running ones) is used for disk/memory planning — even stopped
servers consume disk and will consume RAM when started.

**On `POST /servers/:id/start`:**
```
1. check freeDiskMb >= MIN_FREE_DISK_MB  (in case disk filled up since creation)
2. check (sum of RUNNING server memoryLimitMb) + thisServer.memoryLimitMb
      <= totalRamMb * MAX_MEMORY_RATIO
   → 422 { error: 'InsufficientMemory', ... }
```

Start uses RUNNING servers only — stopped servers don't currently consume RAM.

**Error response shape:**
```json
{
  "statusCode": 422,
  "error": "InsufficientResources",
  "message": "Not enough memory to start this server",
  "details": {
    "resource": "memory",
    "availableMb": 3000,
    "requiredMb": 4096,
    "totalMb": 16384
  }
}
```

The frontend uses `details.resource` to show a specific error ("Not enough RAM", "Low disk space").

**New env vars for resource limits:**

| Variable          | Description                                    | Default |
|-------------------|------------------------------------------------|---------|
| MIN_FREE_DISK_MB  | Min free disk on MC_DATA_PATH to allow ops     | 5120    |
| MAX_MEMORY_RATIO  | Max fraction of host RAM to allocate (0–1)     | 0.90    |

#### Startup reconciliation (Phase 1, inside ServersService)

On NestJS boot, `ServersService.onModuleInit()` must reconcile DB state against actual Docker state. Without this, a NestJS restart leaves servers marked `RUNNING` in the DB even if their containers were stopped while NestJS was down.

```
ServersService.onModuleInit():
  1. fetch all servers from DB where status IN ('RUNNING', 'STARTING', 'STOPPING', 'ERROR')
  2. for each server with a containerId:
     a. docker.getContainer(containerId).inspect()
        → container.State.Running === true → leave status as RUNNING
        → container not running OR container not found → set status = STOPPED in DB
  3. for any status changes: emit server.status WebSocket event (if gateway is already initialized)
```

This runs synchronously in `onModuleInit` before the module is ready — NestJS won't accept requests until it completes. Expected duration: < 1s for < 20 servers (one `inspect` call per container in parallel via `Promise.all`).

#### Concurrent operation protection (Phase 1, inside ServersService)

Prevents race conditions when two admins send conflicting commands to the same server simultaneously (e.g., two simultaneous start calls creating duplicate containers).

**Pattern (Postgres atomic compare-and-swap)**:

```ts
// Example for startServer:
const result = await db
  .update(servers)
  .set({ status: 'STARTING' })
  .where(and(eq(servers.id, id), eq(servers.status, 'STOPPED')))
  .returning();

if (result.length === 0) {
  throw new ConflictException('Server is not in STOPPED state');
}
// proceed with docker.createContainer(...)
```

The `WHERE status = 'STOPPED'` condition is the atomic lock — Postgres row-level locking ensures only one UPDATE wins. The losing request gets 0 rows returned and throws 409.

**Required pre-conditions per operation:**

| Operation | Required status | On mismatch |
|-----------|----------------|-------------|
| `start`   | STOPPED        | 409 Conflict |
| `stop`    | RUNNING        | 409 Conflict |
| `restart` | RUNNING        | 409 Conflict |
| `delete`  | STOPPED        | 409 Conflict |
| `version update` | STOPPED | 409 Conflict |

#### Transaction rollback for Docker failures (Phase 1, inside ServersService)

Docker operations are not transactional. If the DB write succeeds but the Docker call fails, the DB is left with an orphaned record.

**`createServer()` pattern**:
```
try:
  1. resource checks (422 if fail — no DB write yet)
  2. db.insert(servers, { status: 'CREATING', ...fields })  ← provisional record
  3. container = await docker.createContainer(...)
  4. await docker.startContainer(container.id)
  5. db.update(servers, { status: 'RUNNING', containerId: container.id })
catch (dockerError):
  await db.delete(servers).where(eq(servers.id, serverId))  ← manual rollback
  throw new InternalServerErrorException('Container creation failed')
```

The provisional `CREATING` status is never exposed to the frontend — it transitions to `RUNNING` or is deleted within the same request. If NestJS crashes mid-creation, the startup reconciliation step (above) will set any `CREATING` record to `STOPPED` (container inspect will fail).

**`deleteServer()` pattern**: if `docker.remove()` fails, do **not** delete the DB record — return 500 with the server intact. The admin can retry or investigate. Only delete the DB record after the container is confirmed removed.

#### Auth implementation status
- [x] `POST /auth/register`
- [x] `POST /auth/login` — sets HttpOnly cookies (access + refresh tokens)
- [x] JWT strategy — extracts token from cookie, validates payload
- [x] JWT guard — global, `@Public()` decorator skips it
- [x] HttpOnly cookie handling — access token (15min), refresh token (7 days)
- [x] Refresh token is a JWT (signed, contains `sub`) stored hashed in DB
- [x] `POST /auth/refresh` — issues new access token; new refresh token if within 24h of expiry
- [x] `POST /auth/logout` — deletes DB record, clears cookies
- [x] `GET /auth/profile` — returns decoded JWT payload from guard
- [ ] `RolesGuard` — global, registered after `JwtAuthGuard` in `AppModule`
- [ ] `@Roles()` decorator — marks routes with required roles, returns 403 if role doesn't match

#### Key decisions
- JWT payload: `{ sub, username, role }` — minimal, no sensitive data
- Refresh token is a JWT with 7d expiry — allows extracting `userId` without `req.user`
- Refresh tokens stored in DB (not stateless) — allows true logout/revocation
- `NODE_ENV=production` enables `secure` flag on cookies (requires HTTPS)
- Sliding expiry: if refresh token is within 24h of expiry and user calls `/auth/refresh`, a new refresh token is issued automatically
- `RolesGuard` runs after `JwtAuthGuard` (order in `APP_GUARD` matters — JWT sets `req.user.role` first)
- Routes without `@Roles()` pass through the guard freely (no role required)

#### User self-service

**`PATCH /auth/password`** — change own password:
```
body: { currentPassword: string, newPassword: string }
1. verify currentPassword against stored passwordHash → 401 if wrong
2. hash newPassword → update passwordHash in DB
3. optionally revoke all other sessions (security best practice — configurable)
```
OAuth-only users (`passwordHash = null`) cannot use this endpoint — returns 400 with message `"Account uses OAuth login only"`.

**`GET /auth/sessions`** — list own active sessions:
```json
[
  { "id": "clx...", "userAgent": "Mozilla/5.0 (Macintosh...)", "lastUsedAt": "2025-01-15T...", "createdAt": "..." },
  { "id": "clx...", "userAgent": "curl/7.88.0", "lastUsedAt": "...", "createdAt": "..." }
]
```
Returns all non-expired `RefreshToken` rows for the calling user.

**`DELETE /auth/sessions/:id`** — revoke a specific session. The caller can only revoke their own sessions — attempts to revoke another user's session return 403.

**`PATCH /users/me`** — update own profile:
```
body: { username?: string, email?: string }
```
- `username` and `email` must remain unique — 409 if already taken
- `role` and `status` are not self-editable (ADMIN-only via `/admin/users/:id`)

**`GET /servers/:id/my-access-request`** — returns the caller's own `ServerAccess` row for a REQUEST/PRIVATE server:
```json
{ "status": "PENDING" | "APPROVED", "requestedAt": "...", "approvedAt": "..." | null }
```
Returns 404 if no request has been submitted, or if the server is OPEN.

#### SMTP and email features (optional, Phase 1.5)

SMTP is an **optional** dependency. If `SMTP_HOST` is not configured, the panel runs in closed mode — no emails are sent, invite tokens and admin-side password reset cover all recovery scenarios. If SMTP is configured, the following features are enabled:

**Magic link login (passwordless):**
```
POST /auth/magic-link  { email }
  1. if SMTP not configured → 501 Not Implemented
  2. look up User by email — if not found: return 200 anyway (don't leak existence)
  3. create MagicLinkToken { token: randomBytes(32), expiresAt: now+15min }
  4. send email: "Click to login: {FRONTEND_URL}/auth/verify?token={plaintext}"
  5. return 200

GET /auth/magic-link/verify?token={value}
  1. hash token, look up MagicLinkToken — 401 if not found or expired or usedAt set
  2. mark usedAt = now
  3. look up user by email → issue JWT cookies (same flow as /auth/login)
  4. redirect to frontend dashboard
```

Magic links work alongside passwords — users with `passwordHash` can still login either way. OAuth-only users can also use magic links if their email is on record.

**Default registration mode (v1.0 — no SMTP):**
`REQUIRE_ADMIN_APPROVAL=true` is the default. All new registrations start as `PENDING`. Admin approves manually via `PATCH /admin/users/:id/status`. `JwtAuthGuard` blocks `PENDING` users with 403. This is the only supported mode in v1.0 since there is no email sender.

**Open registration with email verification (Phase 1.5 — requires SMTP):**
When SMTP is configured and `REQUIRE_ADMIN_APPROVAL=false`, new registrations send a verification email (magic link to the registered address). Account starts as `PENDING` until the link is clicked.

**Password recovery fallback (no SMTP):**
Admin uses `POST /admin/users/:id/reset-password` → returns a one-time temporary password (plaintext, shown once). User logs in with it and immediately changes via `PATCH /auth/password`. Temporary password expires after 24h if unused.

#### API key authentication (Phase 2)

API keys allow programmatic access without cookies — useful for CLI tools, CI/CD, external dashboards.

**Authentication:** `Authorization: Bearer mpk_<plaintext_key>` header. The `JwtAuthGuard` detects the `mpk_` prefix and validates against the hashed `ApiKey` table instead of JWT. API key requests are not subject to CSRF concerns (no cookies involved).

**Key format:** `mpk_` prefix + 32 random bytes (hex-encoded) — clearly distinguishable from JWT tokens.

**Security:** key is shown plaintext **once** at creation, then stored hashed. If lost, user must revoke and create a new key. `lastUsedAt` is updated on every authenticated request.

**Scope:** API keys inherit the full permissions of the owning user. Scoped keys (read-only, per-server) are a future enhancement.

#### Outbound webhooks (Phase 2)

Generic HTTP callbacks that fire on panel events — enables external integrations (Discord bots, monitoring dashboards, CI/CD triggers, custom automation).

**Subscribable events:**

```
server.created    server.deleted    server.started    server.stopped
server.crashed    server.restarting
player.joined     player.left       player.banned     player.unbanned
backup.completed  backup.failed
system.low_disk   system.memory_pressure
```

**Delivery:**
```
POST {webhook.url}
Headers:
  Content-Type: application/json
  X-MinePanel-Event: server.crashed
  X-MinePanel-Signature: sha256={HMAC-SHA256(secret, body)}
  X-MinePanel-Delivery: {uuid}

Body: { event, timestamp, data: { ...event-specific fields } }
```

**Reliability:** same retry policy as Discord webhooks — 1 retry after 5s, then log warning. Non-blocking: the triggering operation is not affected by webhook failures.

**Signature verification:** consumers validate `X-MinePanel-Signature` against the shared secret to confirm the payload is genuine. This is the same pattern used by GitHub and Stripe webhooks.
- Role mismatch returns `403 Forbidden`, not `401 Unauthorized`

#### Known implementation deltas (to fix)

- **`auth.controller.ts` imports `User` from `@prisma/client`** — bug, should import from `src/db/schema`. Prisma is not used in this project.
- **`schema.ts` is missing Phase 1.5 fields** — `users.googleId`, `users.githubId`, `users.status` (UserStatus enum), `users.minecraftVerified`; `servers.accessType`, `servers.onlineMode`, `servers.rconPassword`, `servers.discordWebhook`. These will be added as Drizzle migrations when Phase 1.5 starts.
- **`users.passwordHash` is `notNull()` in schema** but spec requires `nullable` (OAuth-only users have no password). Fix before Phase 1.5 OAuth work.
- **`ValidationPipe` missing `forbidNonWhitelisted: true`** in current `main.ts`. Add to reject requests with unknown fields entirely.
- **`main.ts` CORS missing `credentials: true`** — required for cross-origin cookie sending. Fix before any frontend integration.
- **`main.ts` missing `helmet()`** — add security headers. Fix before production deployment.

### Phase 1.5 - Access Control + OAuth (post-core)

Features deferred from Phase 1 to avoid scope creep. Implement after Docker + Servers are working.

#### OAuth (Google + GitHub)

Social login via Google and GitHub using a **frontend-initiated token flow**. This is the only approach compatible with self-hosting: since the backend can run at any URL, it cannot register redirect URIs with Google/GitHub. Instead, the centrally hosted frontend (minepanel.xyz) owns the OAuth app registration and handles the browser-side flow, then passes the resulting token to the user's backend for verification.

**Why not server-side redirect flow:**
Google/GitHub require pre-registering exact redirect URIs in their developer console. A self-hosted backend at an arbitrary URL cannot be registered. The frontend is hosted at a fixed URL (`minepanel.xyz`), so it can hold the OAuth credentials on behalf of all users.

**Google flow:**
```
Frontend (minepanel.xyz):
  1. opens Google popup / redirect using Google Identity SDK
  2. Google returns an ID token (signed JWT) to the frontend

Frontend → user's backend:
  POST /auth/google/token  { idToken: "eyJ..." }

Backend:
  1. GET https://oauth2.googleapis.com/tokeninfo?id_token={idToken}
     → Google validates the token and returns { sub, email, name, picture }
  2. verify audience matches our Google client_id (stored in backend env — optional check)
  3. find user by googleId (sub) in DB
     → found: issue JWT
     → not found by googleId, email exists: link googleId to existing account
     → not found at all: create new user (passwordHash = null, username from name)
  4. set HttpOnly cookies, return user
```

**GitHub flow:**
```
Frontend (minepanel.xyz):
  1. initiates GitHub OAuth via PKCE (or device flow)
  2. GitHub returns an access token to the frontend

Frontend → user's backend:
  POST /auth/github/token  { accessToken: "gho_..." }

Backend:
  1. GET https://api.github.com/user  (Authorization: Bearer {accessToken})
     → returns { id, login, email, avatar_url }
  2. find/create user by githubId
  3. set HttpOnly cookies, return user
```

**Key decisions:**
- No server-side redirect, no OAuth app config needed on the self-hosted backend
- Frontend holds Google/GitHub client credentials (registered once by us for minepanel.xyz)
- Backend only makes token verification calls (simple HTTPS GET/POST, no redirect)
- `passwordHash` is `null` for OAuth-only users — they cannot use email/password login
- `googleId` / `githubId` are nullable unique fields on `User`
- Email collision → link provider to existing account silently (user gets both login methods)
- Username generated from provider profile name if not already taken (append random suffix on collision)
- No extra env vars needed on the backend for Google/GitHub

**Auth implementation status:**
- [ ] `POST /auth/google/token` — verify Google ID token, create/find user, issue JWT
- [ ] `POST /auth/github/token` — verify GitHub access token, create/find user, issue JWT

#### Minecraft account linking

Optional step after panel registration. Supports both premium and non-premium (offline) players.

**Endpoints:**
| Method | Path                         | Auth | Description                                  |
|--------|------------------------------|------|----------------------------------------------|
| GET    | /auth/minecraft              | JWT  | Start Microsoft OAuth for Minecraft linking  |
| GET    | /auth/minecraft/callback     | JWT  | Handle callback, store verified UUID         |
| PATCH  | /auth/profile/minecraft      | JWT  | Manual link for offline/non-premium players  |

**Premium flow (Microsoft OAuth → Mojang):**
```
GET /auth/minecraft  (user must already be logged in to the panel)
  → redirect to Microsoft OAuth consent screen

GET /auth/minecraft/callback?code=...
  1. exchange code for Microsoft access token
  2. POST to Xbox Live auth endpoint → XBL token
  3. POST to XSTS endpoint → XSTS token
  4. POST to Minecraft Services API → Minecraft access token
  5. GET https://api.minecraftservices.com/minecraft/profile
     → { id: uuid, name: username }
  6. check uuid not already linked to another panel account
  7. update User: minecraftUUID, minecraftName, minecraftVerified = true
  8. redirect to frontend profile page
```

**Non-premium flow (offline):**
```
PATCH /auth/profile/minecraft  { username: "PlayerName", premium: false }
  1. call GET https://api.mojang.com/users/profiles/minecraft/{username}
     → if found: store real UUID + name, minecraftVerified = true (account exists, just not owned by this panel user)
     → if not found: compute offline UUID from username, minecraftVerified = false
  2. update User: minecraftUUID, minecraftName, minecraftVerified
```

**Key decisions:**
- `minecraftVerified = true` only when UUID comes from Microsoft OAuth (confirmed ownership)
- Mojang public API lookup (no auth) can confirm a username exists but does NOT prove ownership
- `minecraftVerified` field used by whitelist automation in Phase 3:
  - Online mode servers → only add players with `minecraftVerified = true`
  - Offline mode servers → add all players regardless of `minecraftVerified`
- Offline UUID formula: `UUID.v3("OfflinePlayer:" + username)` — deterministic, matches what Minecraft generates server-side
- Microsoft OAuth env vars: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` (optional, same pattern as Google/GitHub)

**Key difference vs Google/GitHub OAuth:**
Microsoft/Minecraft linking is inherently server-side (4-step token chain, no browser SDK available). The self-hoster must register their own Azure app and configure `MICROSOFT_CLIENT_ID` + `MICROSOFT_CLIENT_SECRET`. If not configured, `/auth/minecraft` returns `501 Not Implemented` and the frontend hides the "Link premium account" button.

**Required env vars (self-hoster configures if they want Minecraft linking):**
| Variable                | Description                          | Default    |
|-------------------------|--------------------------------------|------------|
| MICROSOFT_CLIENT_ID     | Azure app client ID (Minecraft link) | (optional) |
| MICROSOFT_CLIENT_SECRET | Azure app client secret              | (optional) |

#### Server access model
Panel registration access is controlled by `REQUIRE_ADMIN_APPROVAL` (default `true` — admin must approve new users). Server access is controlled per-server independently.

Each server has an `accessType`:
- `OPEN` — all panel users can see and access it, no approval needed
- `REQUEST` — user submits a request, admin approves before access is granted
- `PRIVATE` — only users explicitly assigned by admin can see or access it

A `ServerAccess` join table links users to servers:

| Field     | Notes                            |
|-----------|----------------------------------|
| id        | cuid PK                          |
| userId    | FK → User                        |
| serverId  | FK → Server                      |
| status    | PENDING \| APPROVED              |
| createdAt |                                  |

For `OPEN` servers no row is needed — the server is visible to all authenticated users.
For `REQUEST`/`PRIVATE` servers, a row with `status: APPROVED` is required to see/access the server.

#### MOD granular permissions (PBAC)
Simple RBAC (role check) is not enough for MODs — an admin should be able to assign specific capabilities per MOD.

Permission groups:
```
SERVER_LIFECYCLE      // start, stop, restart servers
SERVER_CONFIG         // modify server settings (port, difficulty, gamemode, etc.)
PLUGIN_MANAGEMENT     // install/remove plugins
WHITELIST_MANAGEMENT  // add/remove players from whitelist
USER_MANAGEMENT       // view/manage users assigned to a server
FILE_MANAGER          // read and write files in the server volume
```

A `ModPermission` table links a MOD user to their allowed permissions:

| Field      | Notes                                          |
|------------|------------------------------------------------|
| id         | cuid PK                                        |
| userId     | FK → User (role must be MOD)                   |
| permission | enum (see above)                               |
| serverId   | FK → Server (optional — null = all servers)    |
| createdAt  |                                                |

Guard logic order:
1. `JwtAuthGuard` — validates JWT, sets `req.user`
2. `RolesGuard` — checks `@Roles()`: ADMIN bypasses everything, USER gets 403 on admin routes
3. `PermissionsGuard` (Phase 1.5) — for MOD: checks `ModPermission` table against `@RequiresPermission()`

#### User account status

`status: ACTIVE | PENDING | BANNED` is already in the `User` schema. The `JwtAuthGuard` checks it on every authenticated request after token validation.

| Status    | Meaning                                                              |
|-----------|----------------------------------------------------------------------|
| `ACTIVE`  | Default. Full access to the panel.                                   |
| `PENDING` | Registered but not yet approved by admin (optional approval mode).   |
| `BANNED`  | Blocked at the guard level — JWT is valid but access is rejected.    |

**Guard behaviour:**
- `JwtAuthGuard` rejects with `403 Forbidden` if `status !== ACTIVE`, even if the JWT is valid
- This means banned users cannot use their existing tokens (instant effect, no need to wait for JWT expiry)

**Key decisions:**
- Default (v1.0): `REQUIRE_ADMIN_APPROVAL=true` — all new users start as `PENDING`, admin must approve
- Open registration (`REQUIRE_ADMIN_APPROVAL=false`) is opt-in and requires SMTP configured for email verification (Phase 1.5)
- Admin can ban/unban via `PATCH /admin/users/:id/status`
- Banned user's refresh tokens are NOT deleted — they simply can't be used while banned. On unban, access is restored immediately without re-login.

**Future registration modes (post-Phase 1.5):**
- **Captcha** — hCaptcha or Cloudflare Turnstile on the register endpoint to prevent automated spam. Backend verifies the challenge token server-side. Configurable via `CAPTCHA_SECRET` env var; if absent, captcha is skipped.
- **Nostr login** — user signs a NIP-98 HTTP auth event with their private key; backend verifies the signature and maps the pubkey to a panel account. No password required. Opt-in alongside password auth.
- **Admin-managed registration modes** — the admin can configure via panel UI which registration method is active:
  - `ADMIN_APPROVAL` (default) — every new registration requires manual approval
  - `OPEN` — users are immediately active (requires SMTP for email verification)
  - `BOT_VERIFIED` — user must pass verification via a configurable bot (Discord role check, Telegram bot, email OTP, or custom webhook). The admin configures which bot and what criteria.
  The default deployment ships with `ADMIN_APPROVAL` so that a fresh install is never accidentally open to the public.

### Phase 2 - Audit Log + Frontend

#### 2a — Audit Log

Records who did what and when — essential for multi-admin environments. Implemented as a NestJS interceptor that decorates sensitive routes.

**`AuditLog` table:**

| Field        | Type     | Notes                                                         |
|--------------|----------|---------------------------------------------------------------|
| id           | String   | cuid PK                                                       |
| userId       | String   | FK → User (who performed the action)                          |
| action       | Enum     | see `AuditAction` list below                                  |
| resourceType | Enum     | SERVER \| USER \| PROXY \| BACKUP \| PLUGIN \| FILE          |
| resourceId   | String?  | ID of the affected resource                                   |
| metadata     | Json?    | extra context (e.g., `{ field: 'version', from: '1.20', to: '1.21' }`) |
| ip           | String?  | client IP (from `X-Forwarded-For` or socket remoteAddress)   |
| createdAt    | DateTime |                                                               |

**`AuditAction` enum:**

```
SERVER_CREATE  SERVER_DELETE  SERVER_START  SERVER_STOP  SERVER_UPDATE  SERVER_VERSION_UPDATE
USER_ROLE_CHANGE  USER_BAN  USER_UNBAN
PERMISSION_GRANT  PERMISSION_REVOKE
BACKUP_CREATE  BACKUP_RESTORE  BACKUP_DELETE
PLUGIN_INSTALL  PLUGIN_REMOVE
FILE_WRITE
PROXY_CREATE  PROXY_DELETE
```

**Implementation via interceptor:**

Routes are annotated with `@Audit(AuditAction.SERVER_START, 'SERVER')`. The `AuditInterceptor` writes to the `auditLog` table after the handler completes successfully (not on error — failed actions are not logged).

```ts
@Post(':id/start')
@Audit(AuditAction.SERVER_START, 'SERVER')
async startServer(@Param('id') id: string) { ... }
```

**API endpoint:**

| Method | Path        | Auth  | Description                                           |
|--------|-------------|-------|-------------------------------------------------------|
| GET    | /audit-log  | ADMIN | List audit events (filter: `?action=&resourceId=&userId=&limit=&offset=`) |

Audit log entries are never deleted — they are append-only. Pagination applies (`?limit=50&offset=0`).

#### 2b — Frontend

> Separate repo (`minepanel-frontend`). Spec details managed there. Summary only.

- Backend URL input on first visit + localStorage persistence (connects to any self-hosted backend)
- Setup wizard → login → dashboard
- Pages: Home overview, Server list, Server detail (tabbed), User profile
- Server detail tabs: Overview, Console, Plugins, File Manager, Players, Settings, Backups, Scheduled Tasks
- Real-time updates via WebSocket (Phase 3a)
- Google/GitHub login via frontend-initiated OAuth (holds credentials, passes token to backend)
- Minecraft account linking UI (Microsoft OAuth + manual offline flow)

### Phase 3 - Advanced Features

1. WebSocket real-time events (stats, logs, status)
2. Server console (execute commands via RCON / docker exec)
3. File manager
4. Plugin marketplace (Paper / Purpur)
5. Player management (whitelist, bans, ops, kick)
6. Backup system (manual + scheduled)
7. Scheduled tasks (auto-restart, auto-backup)
8. Notifications (in-panel + Discord webhook)
9. Admin permissions dashboard

---

#### 3a — WebSocket Real-Time Events

The frontend subscribes to a WebSocket gateway to receive live updates without polling.

**Events emitted by server:**

| Event                  | Payload                                      | Description                          |
|------------------------|----------------------------------------------|--------------------------------------|
| `server.status`        | `{ serverId, status }`                       | Server started, stopped, crashed     |
| `server.stats`         | `{ serverId, cpu, memoryMb, memoryLimitMb }` | Per-container resource usage, every ~2s |
| `server.log`           | `{ serverId, line }`                         | New log line from container          |
| `server.playerJoined`  | `{ serverId, player }`                       | Player connected                     |
| `server.playerLeft`    | `{ serverId, player }`                       | Player disconnected                  |
| `system.stats`         | `{ totalRamMb, usedRamMb, freeDiskMb, cpuCount }` | Host resource snapshot, every ~10s |
| `notification`         | `{ type, message, serverId? }`               | In-panel alert (crash, high RAM etc.)|

**Client→server messages:**

| Message              | Description                                |
|----------------------|--------------------------------------------|
| `subscribe.server`   | Start receiving events for a given server  |
| `unsubscribe.server` | Stop receiving events for a given server   |
| `console.command`    | Send a command to the server console       |

**Rate limiting — `console.command`:**

Without throttling, a faulty or malicious client could flood the server console. The gateway enforces a per-socket rate limit:

- **Limit:** 5 commands per second per socket connection
- **On exceed:** the message is silently dropped; the gateway emits `rateLimit.exceeded` back to the offending socket (no disconnect)
- **Implementation:** in-memory token bucket per `socket.id` — no external store needed for single-instance deployment

The `server.log` read-only stream is not rate-limited.

**Authentication over WebSocket:**

HttpOnly cookies are included in the socket.io HTTP upgrade handshake by the browser, but cross-origin cookie sending with `SameSite=None` is inconsistently supported in some environments. The auth strategy uses a two-step approach:

```
1. Client connects → socket.io handshake HTTP request (browser includes cookie)
   → Gateway validates cookie JWT on connection event
   → If valid: associate socket.id with userId and role

2. Fallback (cookie not present): client emits 'auth' event within 5 seconds:
   { accessToken: "eyJ..." }
   → Gateway validates token and associates socket

3. If neither succeeds within 5s → gateway disconnects the socket
```

This handles both browser (cookie) and potential non-browser clients.

**Backend approach:**
- NestJS `@WebSocketGateway` with `socket.io`
- Stats polling loop per running container via `DockerService.getContainerStats()`
- Log streaming via `DockerService.streamLogs()`, each line emitted as `server.log`
- Player events parsed from log lines (e.g. `"UUID of player"`, `"left the game"`)

---

#### 3b — RCON Service

RCON (Remote Console) is the Minecraft protocol for sending commands to a running server. Used by player management, console, and scheduled tasks.

**Setup:**
- Backend injects `enable-rcon=true`, `rcon.port=25575`, `rcon.password={generated}` into `server.properties` at container creation time
- RCON password stored in DB on the `Server` model encrypted with **AES-256-GCM** using `ENCRYPTION_KEY` env var (32-byte hex-encoded key). This is symmetric encryption (not hashing) so the plaintext can be recovered to connect via RCON. Never stored in plaintext.
- RCON port mapped internally within `minepanel_network` (not exposed to host)

**RconService methods:**
```ts
connect(serverId: string): Promise<void>
sendCommand(serverId: string, command: string): Promise<string>
disconnect(serverId: string): void
```

- Maintains a connection pool (one connection per running server)
- Falls back to `docker exec` if RCON is unavailable (server still starting)

---

#### 3c — Backup System

No external services needed — NestJS reads and writes directly to `{MC_DATA_PATH}/{serverId}/` (shared volume).

**Features:**
- Manual backup — triggered by admin/mod via API
- Scheduled backup — cron per server via `@nestjs/schedule`
- Restore — stop server → extract backup → start server
- Download — secure endpoint to download a backup archive
- Retention policy — keep last N backups, auto-delete older ones (configurable per server, default: 5)

**Cloud backup destinations (Phase 3c extension):**
Configurable per server. Local storage is always the default. Remote destinations are optional and additive (local backup is always kept):
- `LOCAL` — default, `{MC_DATA_PATH}/{serverId}/backups/`
- `S3` — any S3-compatible endpoint (AWS, Cloudflare R2, MinIO). Requires `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_BUCKET`, `AWS_ENDPOINT` (optional for non-AWS).
- `GCS` — Google Cloud Storage bucket. Requires `GCS_BUCKET`, `GCS_CREDENTIALS_JSON`.
- `SFTP` — remote server via SSH. Requires `SFTP_HOST`, `SFTP_USER`, `SFTP_KEY` or `SFTP_PASSWORD`, `SFTP_PATH`.

Cloud destination config is stored per-server in a `BackupDestination` table. Upload happens after local tar.gz is created. If upload fails, the local backup is still kept and a warning notification is emitted.

**Backup flow:**
```
POST /servers/:id/backups
  1. check server is STOPPED or RUNNING (backup allowed in both states)
  2. create tar.gz of {MC_DATA_PATH}/{serverId}/ (excluding /backups subfolder)
  3. save to {MC_DATA_PATH}/{serverId}/backups/{timestamp}.tar.gz
  4. create Backup record in DB
  5. apply retention: delete oldest records + files if count > retentionLimit
  6. return backup metadata
```

**Restore flow:**
```
POST /servers/:id/backups/:backupId/restore
  1. stop server if running
  2. extract backup tar.gz into {MC_DATA_PATH}/{serverId}/ (overwrite)
  3. start server
```

**`Backup` table:**

| Field          | Type     | Notes                                       |
|----------------|----------|---------------------------------------------|
| id             | String   | cuid PK                                     |
| serverId       | String   | FK → Server                                 |
| filename       | String   | e.g. `2025-01-15T03:00:00.tar.gz`           |
| sizeMb         | Float    |                                             |
| createdAt      | DateTime |                                             |
| createdBy      | String?  | FK → User (null = scheduled/automatic)      |

**Backup download — streaming:**

`GET /servers/:id/backups/:backupId/download` must **stream** the file to the client rather than buffering the entire archive in NestJS memory (backups can be several GB).

Implementation:
```ts
// Use Node.js fs.createReadStream() piped to the Response
const filePath = path.join(MC_DATA_PATH, serverId, 'backups', backup.filename);
res.set({
  'Content-Type': 'application/x-tar',
  'Content-Disposition': `attachment; filename="${backup.filename}"`,
  'Content-Length': fileSizeBytes,
  'Cache-Control': 'no-store',
});
fs.createReadStream(filePath).pipe(res);
```

If the file does not exist on disk (DB record orphaned): return 404 and clean up the DB record.

**MOD download access:** MOD with `SERVER_LIFECYCLE` permission can download backups for servers they have access to. `DELETE` (backup removal) and `restore` remain ADMIN-only.

**Backup API endpoints:**

| Method | Path                                    | Auth                        | Description                        |
|--------|-----------------------------------------|-----------------------------|------------------------------------|
| GET    | /servers/:id/backups                    | JWT                         | List backups                       |
| POST   | /servers/:id/backups                    | ADMIN \| MOD (SERVER_LIFECYCLE) | Create manual backup           |
| GET    | /servers/:id/backups/:backupId/download | ADMIN \| MOD (SERVER_LIFECYCLE) | Download backup (streamed)     |
| POST   | /servers/:id/backups/:backupId/restore  | ADMIN                       | Restore from backup                |
| DELETE | /servers/:id/backups/:backupId          | ADMIN                       | Delete backup                      |

---

#### 3d — Scheduled Tasks

Per-server cron jobs managed via `@nestjs/schedule`. Configured through the panel, stored in DB.

**Supported task types:**
- `AUTO_BACKUP` — create a backup on schedule
- `AUTO_RESTART` — restart server on schedule (useful for daily restarts)

**`ScheduledTask` table:**

| Field      | Type      | Notes                                       |
|------------|-----------|---------------------------------------------|
| id         | String    | cuid PK                                     |
| serverId   | String    | FK → Server                                 |
| type       | Enum      | AUTO_BACKUP \| AUTO_RESTART                 |
| cronExpr   | String    | standard cron expression (e.g. `0 3 * * *`) |
| enabled    | Boolean   | default: true                               |
| lastRunAt  | DateTime? | timestamp of last successful execution      |
| nextRunAt  | DateTime? | computed from cronExpr at registration      |
| createdAt  | DateTime  |                                             |

**Reliability — re-scheduling at boot:**

`@nestjs/schedule` stores cron registrations in-memory only. When NestJS restarts, all jobs must be re-registered. `ScheduledTaskService` implements `OnModuleInit`:

```
onModuleInit():
  1. fetch all ScheduledTask records where enabled = true
  2. for each: register a CronJob via SchedulerRegistry using stored cronExpr
  3. update nextRunAt = next occurrence of cronExpr from now
```

On create/update/delete via API: dynamically register / update / deregister the cron via `SchedulerRegistry` — no restart needed. This ensures tasks survive NestJS restarts without any external job queue (Redis, BullMQ, etc.).

**Scheduled tasks API endpoints:**

| Method | Path                           | Auth  | Description               |
|--------|--------------------------------|-------|---------------------------|
| GET    | /servers/:id/tasks             | JWT   | List scheduled tasks      |
| POST   | /servers/:id/tasks             | ADMIN | Create scheduled task     |
| PATCH  | /servers/:id/tasks/:taskId     | ADMIN | Update task (cron, enable)|
| DELETE | /servers/:id/tasks/:taskId     | ADMIN | Delete task               |

---

#### 3e — Notifications

**In-panel alerts** — stored in DB, shown in a notification feed in the dashboard.

**Triggers:**
- Server crashed (status → ERROR)
- Server went offline unexpectedly (not via stop command)
- Per-container RAM usage > 90% of its limit for more than 1 minute
- Host free disk < `MIN_FREE_DISK_MB` threshold (`LOW_DISK` notification)
- Host total allocated RAM > `MAX_MEMORY_RATIO` of total RAM (`MEMORY_PRESSURE` notification — new servers/starts will be blocked)
- Backup completed / failed
- Player banned

**`Notification` table:**

| Field      | Type     | Notes                                           |
|------------|----------|-------------------------------------------------|
| id         | String   | cuid PK                                         |
| userId     | String?  | FK → User (null = broadcast to all admins)      |
| serverId   | String?  | FK → Server                                     |
| type       | Enum     | SERVER_CRASH \| HIGH_RAM \| LOW_DISK \| MEMORY_PRESSURE \| BACKUP_DONE \| BACKUP_FAILED \| PLAYER_BANNED |
| message    | String   |                                                 |
| read       | Boolean  | default: false                                  |
| createdAt  | DateTime |                                                 |

**Discord webhook (optional):**
- Admin can configure a Discord webhook URL per server (or globally)
- On trigger events, backend POSTs an embed to the webhook
- Stored as `discordWebhook` field on `Server` model (optional)

**Discord webhook failure handling:**

The webhook call is fire-and-forget and must never block the triggering operation (e.g. a crash notification must still be created in DB even if the webhook fails):

```
1. POST embed to discordWebhook URL
2. if request fails (network error or non-2xx): wait 5s, retry once
3. if retry also fails: log warning (level: warn), continue silently
   → the in-panel Notification record is already created — no data loss
```

**Notification visibility scope:**

`GET /notifications` filters by the caller's role:

| Role | Sees |
|------|------|
| ADMIN | All notifications (including `LOW_DISK`, `MEMORY_PRESSURE`, and broadcasts with `userId = null`) |
| MOD | Only notifications where `serverId` is a server they have access to, plus their own personal notifications (`userId = callerId`) |
| USER | Only their own personal notifications |

`userId = null` means "broadcast to all ADMINs" — created for system-level alerts not tied to a specific user. MODs do not receive these broadcast notifications.

**Notification API endpoints:**

| Method | Path                          | Auth  | Description                        |
|--------|-------------------------------|-------|------------------------------------|
| GET    | /notifications                | JWT   | Get own notifications              |
| PATCH  | /notifications/:id/read       | JWT   | Mark notification as read          |
| DELETE | /notifications/:id            | JWT   | Dismiss notification               |

---

#### 3f — Plugin Marketplace (Paper / Purpur / Spigot)

A full in-panel plugin manager for servers running a plugin-compatible provider (Paper, Purpur, Spigot). Vanilla and Forge/Fabric servers do not have this section.

**Plugin sources (APIs):**
- **Modrinth** (`https://api.modrinth.com/v2`) — open API, no key required, growing catalog, supports plugins + mods + datapacks
- **Hangar** (`https://hangar.papermc.io/api/v1`) — official PaperMC plugin registry, Paper/Waterfall/Velocity focused
- **SpigotMC** — no public API (scraping only, avoid for now)

**Marketplace UI features:**
- Search by name, category (admin tools, economy, chat, protection, etc.)
- Filter by MC version compatibility
- Plugin detail page: description, version history, download count, author
- One-click install — backend downloads JAR into `plugins/` folder of the container
- Installed plugins list — shows version, status (enabled/disabled), update available badge
- One-click update — replaces JAR with latest compatible version
- Enable/disable plugin (rename `.jar` → `.jar.disabled` and restart or reload via RCON/console)

**Backend responsibilities:**
- Download JAR from Modrinth/Hangar CDN into `{MC_DATA_PATH}/{serverId}/plugins/`
- Track installed plugins in DB (`ServerPlugin` table)
- Check for updates by comparing stored version with latest API version
- Validate provider compatibility before allowing install (no Paper plugins on Vanilla)

**`ServerPlugin` table:**

| Field       | Type     | Notes                                  |
|-------------|----------|----------------------------------------|
| id          | String   | cuid PK                                |
| serverId    | String   | FK → Server                            |
| pluginId    | String   | Modrinth/Hangar plugin ID              |
| pluginName  | String   | display name                           |
| version     | String   | installed version                      |
| source      | Enum     | MODRINTH \| HANGAR                     |
| downloadUrl | String   | CDN URL for the JAR                    |
| enabled     | Boolean  | default: true                          |
| createdAt   | DateTime |                                        |
| updatedAt   | DateTime |                                        |

**Plugin API endpoints:**

| Method | Path                              | Auth         | Description                              |
|--------|-----------------------------------|--------------|------------------------------------------|
| GET    | /plugins/search                   | JWT          | Search plugins via Modrinth/Hangar       |
| GET    | /plugins/:pluginId                | JWT          | Get plugin details + version list        |
| GET    | /servers/:id/plugins              | JWT          | List installed plugins                   |
| POST   | /servers/:id/plugins              | ADMIN \| MOD | Install a plugin (download + track in DB)|
| PATCH  | /servers/:id/plugins/:pluginId    | ADMIN \| MOD | Update plugin to latest version          |
| DELETE | /servers/:id/plugins/:pluginId    | ADMIN \| MOD | Remove plugin (delete JAR + DB record)   |
| PATCH  | /servers/:id/plugins/:pluginId/toggle | ADMIN \| MOD | Enable/disable plugin                |

> MOD access to plugin endpoints requires `PLUGIN_MANAGEMENT` permission.

---

#### 3g — Plugin Config Editor

Many plugins generate config files (usually YAML) inside `plugins/{PluginName}/config.yml`. Where possible, expose these for editing directly in the panel.

**Approach:**
- Read file via Docker exec (`cat plugins/PluginName/config.yml`) or file manager
- Display in a code editor (Monaco / CodeMirror on frontend)
- Write back via Docker exec or file write
- No structured form UI for now (too plugin-specific) — plain file editor is sufficient

> This shares infrastructure with the file manager (Phase 3c).

---

#### 3h — File Manager

Browse and edit any file inside the MC server container volume.

**Features:**
- Directory tree navigation
- File viewer (plain text, YAML, JSON, properties)
- Inline file editor (Monaco editor on frontend)
- Upload files (drag & drop)
- Download files
- Create / rename / delete files and folders

**Backend approach:**
- All operations via Docker exec (`ls`, `cat`, `mkdir`, `rm`, etc.) or by reading the bind-mounted volume directly from the NestJS container (simpler, since `{MC_DATA_PATH}/{serverId}` is a shared volume)
- Prefer direct volume read/write over Docker exec where possible (faster, no shell injection risk)
- Sanitize all paths (prevent directory traversal: `../../etc/passwd`)

**Auth granularity:**
- Read operations (`GET /files`, `GET /files/content`) — ADMIN or MOD with `FILE_MANAGER` permission
- Write operations (`PUT`, `POST upload`, `mkdir`) — ADMIN or MOD with `FILE_MANAGER` permission
- Delete — ADMIN only (destructive; not delegated to MOD)

**Protected files (view-only, no write via file manager):**

The following paths are managed by dedicated API endpoints and cannot be written via `PUT /servers/:id/files/content`:

| Path | Managed by |
|------|------------|
| `ops.json` | `POST/DELETE /servers/:id/ops` |
| `whitelist.json` | `POST/DELETE /servers/:id/whitelist` |
| `banned-players.json`, `banned-ips.json` | `POST/DELETE /servers/:id/bans` |
| `world/level.dat`, `world_nether/level.dat`, `world_the_end/level.dat` | Read-only (binary NBT — not safely editable as text) |

The endpoint returns `403 Forbidden` when the target path matches any of these entries.

**File size limits:**

| Operation         | Limit | Behavior on exceed              |
|-------------------|-------|--------------------------------|
| Read file content | 5 MB  | 422 `{ error: 'FileTooLarge' }` |
| Upload file       | 50 MB | 413 Payload Too Large           |

These limits prevent large files (world saves, multi-GB logs) from being buffered in NestJS memory.

**Concurrency — last-write-wins:**

No file locking is implemented. If two sessions `PUT` the same file simultaneously, the last write wins silently. This is acceptable for typical single-admin deployments. A future enhancement could use optimistic locking via `If-Match` / ETag headers.

**File Manager API endpoints:**

| Method | Path                              | Auth                        | Description                      |
|--------|-----------------------------------|-----------------------------|----------------------------------|
| GET    | /servers/:id/files                | ADMIN \| MOD (FILE_MANAGER) | List directory contents          |
| GET    | /servers/:id/files/content        | ADMIN \| MOD (FILE_MANAGER) | Read file content                |
| PUT    | /servers/:id/files/content        | ADMIN \| MOD (FILE_MANAGER) | Write file content               |
| POST   | /servers/:id/files/upload         | ADMIN \| MOD (FILE_MANAGER) | Upload file                      |
| DELETE | /servers/:id/files                | ADMIN                       | Delete file or folder            |
| POST   | /servers/:id/files/mkdir          | ADMIN \| MOD (FILE_MANAGER) | Create directory                 |

---

#### 3i — Player Management

Manage players on a running server without needing console access.

**Features:**
- Whitelist: add/remove players by username or UUID
- Banlist: ban/unban players (with optional reason + expiry)
- Ops: grant/revoke operator status
- Online players list (via server query or RCON)
- Kick player (via RCON or console command)

**Backend approach:**
- RCON protocol for commands on running servers (requires `enable-rcon=true` in `server.properties`)
- Or: execute commands via `docker exec` into the container's stdin
- Read whitelist/banlist JSON files directly from the volume for listing

**UUID resolution:**

Minecraft identifies players by UUID, not username. The resolution strategy depends on `server.onlineMode`:

| Mode | Strategy | Detail |
|------|----------|--------|
| Online (`onlineMode: true`) | Mojang API lookup | `GET https://api.mojang.com/users/profiles/minecraft/{username}` → returns `{ id, name }`. Rate limit: 600 req/10min. Cache result per username (TTL: 24h). |
| Offline (`onlineMode: false`) | Deterministic UUID.v3 | `UUID.v3('OfflinePlayer:' + username, UUID.DNS)` — same algorithm the vanilla server uses. No external request. |

All endpoints that accept `player` as a path param accept both a username (resolved to UUID) and a raw UUID (used directly). The response always includes both the UUID and the last-known username.

**Op levels:**

Minecraft operators have 4 permission levels:

| Level | Name | Capabilities |
|-------|------|--------------|
| 1 | Moderator | Bypass spawn protection |
| 2 | Gamemaster | Use most cheat commands (gamemode, tp, etc.) |
| 3 | Admin | Kick, ban, whitelist management |
| 4 | Owner | All permissions, including stop/op others |

`POST /servers/:id/ops` accepts an optional `level` param (1–4). Default level when not specified: **2** (Gamemaster). The panel sends `op {player} {level}` via RCON or writes directly to `ops.json`.

**`Ban` entity and expiry:**

Minecraft's `banned-players.json` is the authoritative store. The panel also tracks bans in the DB for querying, filtering, and automated expiry.

**`Ban` table:**

| Field     | Type      | Notes                                   |
|-----------|-----------|-----------------------------------------|
| id        | String    | cuid PK                                 |
| serverId  | String    | FK → Server                             |
| uuid      | String    | banned player UUID                      |
| username  | String    | last-known username (display only)      |
| reason    | String?   |                                         |
| bannedBy  | String    | FK → User (who issued the ban)          |
| expiresAt | DateTime? | null = permanent ban                    |
| createdAt | DateTime  |                                         |

**Auto-expiry:** A `@Cron` job runs every 5 minutes. For each ban where `expiresAt < now` and the server is RUNNING: send `pardon {uuid}` via RCON, remove the entry from `banned-players.json`, delete the `Ban` DB record. If the server is STOPPED, the pardon is applied at next start (`onModuleInit` runs expiry check before reconciling status).

**Player API endpoints:**

| Method | Path                              | Auth         | Description                     |
|--------|-----------------------------------|--------------|---------------------------------|
| GET    | /servers/:id/players              | JWT          | List online players             |
| GET    | /servers/:id/whitelist            | JWT          | Get whitelist                   |
| POST   | /servers/:id/whitelist            | ADMIN \| MOD | Add player to whitelist         |
| DELETE | /servers/:id/whitelist/:player    | ADMIN \| MOD | Remove player from whitelist    |
| GET    | /servers/:id/bans                 | JWT          | Get banlist (active + expired)  |
| POST   | /servers/:id/bans                 | ADMIN \| MOD | Ban player (body: `{ reason?, expiresAt? }`) |
| DELETE | /servers/:id/bans/:player         | ADMIN \| MOD | Unban player (pardon)           |
| GET    | /servers/:id/ops                  | JWT          | Get ops list                    |
| POST   | /servers/:id/ops                  | ADMIN        | Op player (body: `{ level?: 1-4 }`, default: 2) |
| DELETE | /servers/:id/ops/:player          | ADMIN        | De-op player                    |
| POST   | /servers/:id/players/:player/kick | ADMIN \| MOD | Kick player                     |

> MOD access to whitelist/ban endpoints requires `WHITELIST_MANAGEMENT` permission.

---

#### 3j — Admin Permissions Dashboard

UI and API for the admin to manage MOD granular permissions (the PBAC system from Phase 1.5).

**Features:**
- List all MOD users
- View/edit permissions per MOD user (checkboxes per permission, optionally scoped to a specific server)
- Grant/revoke permissions without role changes
- Panel user management: list all users, change role (USER ↔ MOD), ban/unban from panel

**Admin API endpoints:**

| Method | Path                                          | Auth  | Description                            |
|--------|-----------------------------------------------|-------|----------------------------------------|
| GET    | /admin/users                                  | ADMIN | List all panel users                   |
| PATCH  | /admin/users/:id/role                         | ADMIN | Change user role                       |
| PATCH  | /admin/users/:id/status                       | ADMIN | Ban/unban user from panel              |
| GET    | /admin/users/:id/permissions                  | ADMIN | List MOD permissions for a user        |
| POST   | /admin/users/:id/permissions                  | ADMIN | Grant permission (optionally per server)|
| DELETE | /admin/users/:id/permissions/:permissionId    | ADMIN | Revoke permission                      |

### Phase 4 - Server Creation Wizard & Presets

The goal is to make MinePanel feel like a **polished product**, not just a tool. The server creation flow should be fast and friendly for beginners but not limiting for power users. Think of it like the **race/class selection screen in an RPG** — you pick a preset and everything is configured for you, or you go "advanced" and tune every setting manually.

#### Product vision

MinePanel aims to be the **modern open-source alternative** to:
- **Pterodactyl** — powerful but notoriously complex to self-host (Wings daemon, 2 separate apps, Nginx config)
- **Crafty Controller** — simpler but limited feature set
- **Multicraft / McMyAdmin** — commercial, dated UI

Our differentiator: dead-simple self-hosting (single `docker-compose up`) + great UX + modern stack.

#### Server creation modes

**Quick Start** — preset-driven, minimal inputs required:

| Preset              | Provider | Gamemode   | PvP   | Difficulty | Notes                              |
|---------------------|----------|------------|-------|------------|------------------------------------|
| Survival SMP        | Paper    | survival   | on    | hard       | Optimized for multiplayer survival |
| Creative Build      | Paper    | creative   | off   | peaceful   | Building-focused server            |
| Minigame Server     | Paper    | adventure  | on    | normal     | Good base for mini-game plugins    |
| Vanilla Hardcore    | Vanilla  | survival   | on    | hard       | Pure vanilla, hardcore rules       |
| Modded Survival     | Forge    | survival   | on    | normal     | Opens mod picker (see below)       |
| Tech/Magic Modpack  | Forge    | survival   | on    | normal     | Preset modpack suggestion          |

User only picks: server name, version, port. Everything else is filled in by the preset.

**Advanced** — full manual config:
- All fields exposed: provider, version, port, gamemode, difficulty, pvp, maxPlayers, memory limit, JVM flags, etc.

#### Provider-specific presets

Each `ServerProvider` unlocks specific options:

- **VANILLA / PAPER / PURPUR** — standard settings only
- **FORGE** — mod picker UI (see below)
- **FABRIC** — mod picker UI (Fabric-compatible mods only)
- **PURPUR** — exposes extra Purpur-specific settings (mob AI, etc.)

#### Mod picker (Phase 4 / Forge + Fabric)

When creating a Forge or Fabric server, the user can search and select mods to pre-install.

Integration options:
- **Modrinth API** (preferred — open, free, modern): `https://api.modrinth.com/v2/search`
- **CurseForge API** (wider catalog but requires API key): `https://api.curseforge.com`

Flow:
```
user picks Forge preset
→ mod picker opens (search box + category filters)
→ user searches "Create" → sees Create mod + dependencies
→ user adds mods to list
→ on server create: backend downloads mod JARs into container volume before first start
```

Backend responsibilities:
- Download mod JARs from Modrinth/CurseForge CDN into `{MC_DATA_PATH}/{serverId}/mods/`
- Validate mod-loader compatibility (Forge vs Fabric, MC version)
- Store selected mods in DB (new `ServerMod` table)

#### ServerMod table (Phase 4)

| Field       | Type     | Notes                                  |
|-------------|----------|----------------------------------------|
| id          | String   | cuid PK                                |
| serverId    | String   | FK → Server                            |
| modId       | String   | Modrinth/CurseForge mod ID             |
| modName     | String   | display name                           |
| version     | String   | installed version                      |
| source      | Enum     | MODRINTH \| CURSEFORGE                 |
| downloadUrl | String   | CDN URL for the JAR                    |
| createdAt   | DateTime |                                        |

#### New API endpoints (Phase 4)

| Method | Path                          | Auth  | Description                         |
|--------|-------------------------------|-------|-------------------------------------|
| GET    | /mods/search                  | JWT   | Search mods via Modrinth/CurseForge |
| GET    | /servers/:id/mods             | JWT   | List installed mods                 |
| POST   | /servers/:id/mods             | ADMIN | Install a mod                       |
| DELETE | /servers/:id/mods/:modId      | ADMIN | Remove a mod                        |

---

## Phase 5 — Proxy Servers & Bedrock

### 5a — Velocity Proxy

Velocity is the modern Minecraft proxy (BungeeCord is deprecated). It connects multiple Java backend servers in a network, handling routing and session forwarding.

`itzg/minecraft-server` already supports `TYPE=VELOCITY` natively — no custom image needed. The Velocity container exposes the public port; backend servers only listen on the internal Docker network.

#### Architecture

```text
Internet → Port 25565 → [mc-proxy-1 (Velocity)]
                              ↓ minepanel_network (internal)
                    [mc-backend-1] [mc-backend-2] [mc-backend-N]
                    (no public port exposed)
```

When a server is added to a proxy, its public port binding is removed — it becomes reachable only through the proxy.

#### New DB entity: `ServerProxy`

| Field            | Type     | Notes                                                                  |
|------------------|----------|------------------------------------------------------------------------|
| id               | String   | cuid PK                                                                |
| name             | String   | friendly name                                                          |
| port             | Int      | public port                                                            |
| containerId      | String?  | Docker container ID                                                    |
| status           | Enum     | STOPPED \| STARTING \| RUNNING \| ERROR                               |
| forwardingMode   | Enum     | MODERN \| LEGACY \| NONE — default: MODERN                            |
| forwardingSecret | String   | Velocity modern forwarding secret (AES-256-GCM encrypted)             |
| defaultServerId  | String?  | FK → Server — lobby / first join destination                          |
| createdAt        | DateTime |                                                                        |

**Relation**: `Server` gets an optional `proxyId FK → ServerProxy`. One proxy → N backend servers.

#### `velocity.toml` config generation

Velocity requires a `velocity.toml` config file listing backend servers by name. MinePanel auto-generates this from the DB whenever the proxy's backend list changes — this is the key differentiator vs Pterodactyl (which leaves config management entirely to the admin).

Generated config template:
```toml
[servers]
# {server.name} = "{containerName}:25565" for each backend in DB
lobby    = "minepanel-mc-{serverId1}:25565"
survival = "minepanel-mc-{serverId2}:25565"

[routing]
default-server = "{defaultServer.name}"
fallback-servers = ["{defaultServer.name}"]

[advanced]
player-info-forwarding-mode = "{forwardingMode}"   # MODERN | LEGACY | NONE
forwarding-secret = "{decrypted forwardingSecret}"
```

The container name on `minepanel_network` is always `minepanel-mc-{serverId}` — deterministic, no lookup needed.

After any backend list change: write config to `{MC_DATA_PATH}/{proxyId}/velocity.toml` → if proxy is RUNNING, exec `velocity reload` via `docker exec`.

#### Modern forwarding auto-patch

When `forwardingMode = MODERN` and a Paper/Purpur server is added to the proxy, the backend must patch the server's `paper-global.yml` automatically:

```yaml
proxies:
  velocity:
    enabled: true
    secret: <decrypted forwardingSecret>
```

Path: `{MC_DATA_PATH}/{serverId}/config/paper-global.yml`

This patch is applied on `POST /proxies/:id/servers/:serverId` and reverted on `DELETE /proxies/:id/servers/:serverId`. Without this, players cannot connect through the proxy even if Velocity is configured correctly.

**Applies only to**: Paper, Purpur, Spigot providers. Vanilla/Forge/Fabric do not use this file.

#### New API endpoints (Phase 5a)

| Method | Path                                  | Auth  | Description                                    |
|--------|---------------------------------------|-------|------------------------------------------------|
| GET    | /proxies                              | JWT   | List proxies                                   |
| POST   | /proxies                              | ADMIN | Create Velocity proxy (generates forwardingSecret) |
| GET    | /proxies/:id                          | JWT   | Proxy details + backend server list            |
| PATCH  | /proxies/:id                          | ADMIN | Update name, port, forwardingMode, defaultServerId |
| DELETE | /proxies/:id                          | ADMIN | Delete proxy (must be stopped, no backends)    |
| POST   | /proxies/:id/start                    | ADMIN | Start proxy container                          |
| POST   | /proxies/:id/stop                     | ADMIN | Stop proxy container                           |
| POST   | /proxies/:id/servers/:serverId        | ADMIN | Add backend server: removes public port, regenerates velocity.toml, patches paper-global.yml |
| DELETE | /proxies/:id/servers/:serverId        | ADMIN | Remove backend server: restores public port, regenerates velocity.toml, reverts paper-global.yml |

#### WebSocket events for proxies

The proxy container is a first-class entity — it gets the same live monitoring as regular servers:

| Event               | Payload                          | Description                        |
|---------------------|----------------------------------|------------------------------------|
| `proxy.status`      | `{ proxyId, status }`            | Proxy started, stopped, crashed    |
| `proxy.log`         | `{ proxyId, line }`              | Log line from Velocity container   |
| `proxy.playerCount` | `{ proxyId, count }`             | Total players across all backends  |

**Client→server messages:**

| Message             | Description                                |
|---------------------|--------------------------------------------|
| `subscribe.proxy`   | Start receiving events for a given proxy   |
| `unsubscribe.proxy` | Stop receiving events for a given proxy    |
| `proxy.command`     | Send command to Velocity console via `docker exec` |

**Notes**:
- `POST /proxies` generates the `forwardingSecret` automatically, stored encrypted
- Adding a server to a proxy removes its public port binding; removing restores it
- Deleting a proxy requires all backends to be removed first
- Changing `defaultServerId` triggers a `velocity.toml` regeneration + reload
- `forwardingMode` changes require proxy restart (reload is not sufficient for this setting)

---

### 5b — Bedrock Support

Two supported approaches, in order of implementation complexity:

#### Approach 1 — GeyserMC plugin (Phase 1.5+, minimal backend changes)

GeyserMC translates the Bedrock protocol to Java in-process. Installed as a plugin on Paper/Purpur servers — the existing plugin marketplace handles the JAR download.

Backend change: `POST /servers` DTO gets an optional `bedrockPort?: number` field. If present, the Docker container also exposes `{bedrockPort}:19132/udp`.

No new DB entities. No new server types.

#### Approach 2 — Bedrock standalone server (Phase 5b)

A fully independent Bedrock Edition server using `itzg/minecraft-bedrock-server`.

`ServerProvider` enum gets `BEDROCK`. `DockerService` branches on `provider === 'BEDROCK'` to select the correct image and port protocol.

| Aspect           | Java (itzg/minecraft-server)       | Bedrock (itzg/minecraft-bedrock-server) |
|------------------|------------------------------------|-----------------------------------------|
| Image            | itzg/minecraft-server              | itzg/minecraft-bedrock-server           |
| Default port     | 25565 TCP                          | 19132 UDP                               |
| Protocol         | Java Edition                       | Bedrock Edition                         |
| Mod support      | Forge / Fabric                     | Add-ons only (no plugin marketplace)    |
| Online mode      | Mojang auth or offline UUID        | Xbox Live auth                          |
| RCON             | Yes                                | No — `rconPassword` is NULL             |
| Proxy support    | Velocity (Phase 5a)                | Not applicable                          |

No new DB tables — `ServerProvider.BEDROCK` reuses the existing `Server` schema. The `rconPassword` field remains NULL for Bedrock servers.

---

## Phase 6 — Mobile App & Player Portal

### Key differentiator

Unlike existing MC panels (admin-only tools), MinePanel targets both **operators** (admins/mods who run servers) and **players** (users who play on those servers). The mobile app and player portal make this explicit.

### Mobile app (KMP (Kotlin Multiplatform + Compose Multiplatform))

A single cross-platform app (iOS + Android) that connects to any MinePanel backend instance — same multi-backend model as the web frontend.

**Player features:**
- Browse servers they have access to — live status, player count, TPS
- Push notifications: server online/offline, crash alerts, whitelist approved
- Request access to `REQUEST`-visibility servers
- View own player profile: playtime, linked Minecraft account, ban history

**Mod features:**
- Quick server start/stop/restart
- Live console with RCON command input
- Player list with kick/ban actions
- Notification when server RAM > threshold

**Admin features:**
- Full server lifecycle management
- Resource overview (host CPU, RAM, disk)
- User management (approve pending registrations)

### Player Portal (web, Phase 6)

A user-facing section of the frontend distinct from the admin dashboard:

- **My Servers** — servers the user has access to, with status cards
- **Player Profile** — Minecraft skin (via Crafatar API), linked UUID, playtime stats (requires event tracking from Phase 3a WebSocket), sessions history
- **Access Requests** — track pending/approved/denied requests to `REQUEST` servers
- **Notifications** — in-panel notification feed

### Historical metrics (Phase 2 extension, feeds Phase 6)

Currently metrics are real-time only (WebSocket push). Historical tracking adds:
- `MetricSnapshot` table: `serverId`, `timestamp`, `cpuPct`, `ramMb`, `playerCount`, `tps`
- Snapshots written every 60s by a background task while server is `RUNNING`
- Retention: keep last 30 days by default
- API: `GET /servers/:id/metrics?from=&to=&resolution=5m` for frontend charts
- Mobile app shows sparklines per server

### Template clone (Phase 4 extension)

Admin can clone an existing server config (all settings, installed plugins, world seed) into a new server. The world data is NOT cloned by default (optional). Useful for staging → production promotions or quick SMP → creative variants.

`POST /servers/:id/clone` — creates a new `STOPPED` server with identical config. Returns the new server object.

---

## Static Assets

Panel and server assets served directly by NestJS with appropriate cache headers. No CDN required — assets are small and infrequently updated.

### Server icon

Each Minecraft server automatically generates a `server-icon.png` (64×64 PNG) in the root of its data directory. This icon is shown to players in the Minecraft multiplayer server list. The panel exposes it for display in the frontend dashboard.

**`GET /servers/:id/icon`**
- Serves `{MC_DATA_PATH}/{serverId}/server-icon.png` directly from the volume
- Response headers: `Content-Type: image/png`, `Cache-Control: public, max-age=3600`, `ETag: {hash of file}`
- If the file does not exist: returns the default MinePanel server icon (embedded in the NestJS binary or from `PANEL_ASSETS_PATH/default-server-icon.png`)
- Auth: JWT (any authenticated user with server access — server icons are not sensitive)

**`PUT /servers/:id/icon`**
- Uploads a custom server icon (replaces `server-icon.png` in the server volume)
- Validation: must be exactly 64×64 pixels, PNG format — returns 422 if dimensions or format are wrong
- Auth: ADMIN or MOD with `FILE_MANAGER` permission
- Takes effect on the running server immediately (itzg image re-reads `server-icon.png` without restart)

### Panel instance logo

A custom logo displayed in the frontend when the user views the list of backend instances. Stored in `PANEL_ASSETS_PATH`.

**`GET /panel/logo`**
- Serves `{PANEL_ASSETS_PATH}/logo.png`
- Response headers: `Content-Type: image/png`, `Cache-Control: public, max-age=86400`, `ETag: {hash}`
- If no custom logo is set: returns default MinePanel logo (embedded fallback)
- Auth: Public (no auth required — logo is shown before login in the multi-backend selection screen)

**`PUT /panel/logo`**
- Uploads a new panel logo (replaces `{PANEL_ASSETS_PATH}/logo.png`)
- Validation: PNG or JPEG, max 2 MB
- Auth: ADMIN only
- ETag is invalidated on upload so clients re-fetch immediately

**`DELETE /panel/logo`**
- Removes `{PANEL_ASSETS_PATH}/logo.png`, reverting to the default embedded logo
- Auth: ADMIN only

**Static assets API endpoints:**

| Method | Path                 | Auth                        | Description                              |
|--------|----------------------|-----------------------------|------------------------------------------|
| GET    | /servers/:id/icon    | JWT                         | Get server icon (PNG, with ETag cache)   |
| PUT    | /servers/:id/icon    | ADMIN \| MOD (FILE_MANAGER) | Upload custom server icon (64×64 PNG)    |
| GET    | /panel/logo          | Public                      | Get panel logo (PNG, with ETag cache)    |
| PUT    | /panel/logo          | ADMIN                       | Upload custom panel logo                 |
| DELETE | /panel/logo          | ADMIN                       | Reset panel logo to default              |

---

## Technical Debt / Future Improvements

### Database indexes
- Add index on `refresh_tokens.user_id` — queried in every auth operation (logout, getSessions, refreshTokens). Low priority for self-hosted with few users, but correct practice for FK columns used in WHERE clauses.
- Add index on `servers.user_id` when the servers module is implemented — same rationale.
