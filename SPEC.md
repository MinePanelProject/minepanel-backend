# MinePanel Backend - Architecture Specification

## Overview

MinePanel is a self-hosted Minecraft server management panel. The backend is a NestJS application that runs inside Docker, manages a PostgreSQL database, and spawns/controls Minecraft server containers via the Docker socket.

---

## Container Architecture

```text
User runs: docker-compose up -d

┌─────────────────────────────────────────────────────────┐
│                    Docker Host                          │
│                                                         │
│  ┌───────────────────────────────────────────────┐     │
│  │  minepanel-nestjs (container)                 │     │
│  │  - NestJS backend                             │     │
│  │  - Mounts: /var/run/docker.sock               │     │
│  │  - Network: minepanel_network                 │     │
│  │  - Port: 3000:3000                            │     │
│  └───────────────┬───────────────────────────────┘     │
│                  │                                      │
│                  │ Postgres connection                  │
│                  ↓                                      │
│  ┌───────────────────────────────────────────────┐     │
│  │  minepanel-postgres (container)               │     │
│  │  - PostgreSQL 16                              │     │
│  │  - Volume: postgres-data                      │     │
│  │  - Network: minepanel_network                 │     │
│  └───────────────────────────────────────────────┘     │
│                                                         │
│                  ↓ Docker socket access                │
│                                                         │
│  ┌───────────────────────────────────────────────┐     │
│  │  mc-server-1 (spawned by NestJS)              │     │
│  │  - Minecraft server                           │     │
│  │  - Volume: mc-server-1-data                   │     │
│  │  - Network: minepanel_network                 │     │
│  │  - Port: 25565:25565                          │     │
│  └───────────────────────────────────────────────┘     │
│                                                         │
│  ┌───────────────────────────────────────────────┐     │
│  │  mc-server-2 (spawned by NestJS)              │     │
│  │  - Minecraft server                           │     │
│  │  - Volume: mc-server-2-data                   │     │
│  │  - Network: minepanel_network                 │     │
│  │  - Port: 25566:25565                          │     │
│  └───────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

---

## Tech Stack

### Backend (`minepanel-backend`)

- **Framework:** NestJS
- **Database:** PostgreSQL 16 + Prisma v7
- **Docker management:** Dockerode
- **Auth:** Passport + JWT (HttpOnly cookies)
- **Language:** TypeScript
- **Runtime:** Node.js 20

### Frontend (`minepanel-frontend` - separate repo)

- **Build tool:** Vite
- **Framework:** React/Vue/Svelte (TBD)
- **Styling:** TailwindCSS
- **WebSocket client** (for real-time updates)
- **Deployment:** Vercel

---

## Module Structure

```
src/
├── main.ts
├── app.module.ts
├── prisma/
│   ├── prisma.module.ts
│   └── prisma.service.ts
├── auth/
│   ├── auth.module.ts
│   ├── auth.service.ts
│   ├── auth.controller.ts
│   ├── dto/
│   │   ├── register.dto.ts
│   │   └── login.dto.ts
│   ├── strategies/
│   │   └── jwt.strategy.ts
│   └── guards/
│       ├── jwt-auth.guard.ts
│       └── roles.guard.ts
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
└── common/
    ├── decorators/
    │   ├── public.decorator.ts
    │   └── roles.decorator.ts
    └── filters/
        └── prisma-exception.filter.ts
```

---

## Database Schema

### Enums

- **Role:** `ADMIN`, `MOD`, `USER`
- **ServerProvider:** `VANILLA`, `PAPER`, `PURPUR`, `FABRIC`, `FORGE`
- **ServerStatus:** `STOPPED`, `STARTING`, `RUNNING`, `STOPPING`, `ERROR`

### Models

**User**
| Field         | Type     | Notes                |
|---------------|----------|----------------------|
| id            | String   | cuid, PK             |
| email         | String   | unique               |
| username      | String   | unique               |
| passwordHash  | String   |                      |
| role          | Role     | default: USER        |
| minecraftUUID | String?  | unique               |
| minecraftName | String?  |                      |
| createdAt     | DateTime |                      |
| updatedAt     | DateTime |                      |
| servers       | Server[]       | relation         |
| refreshTokens | RefreshToken[] | relation         |

**SetupState** (singleton)
| Field               | Type     | Notes              |
|---------------------|----------|--------------------|
| id                  | String   | default: singleton |
| initialAdminCreated | Boolean  | default: false     |
| createdAt           | DateTime |                    |
| updatedAt           | DateTime |                    |

**RefreshToken**
| Field        | Type     | Notes                                  |
|--------------|----------|----------------------------------------|
| id           | String   | cuid, PK                               |
| token        | String   | unique, hashed                         |
| userId       | String   | FK -> User                             |
| expiresAt    | DateTime |                                        |
| createdAt    | DateTime |                                        |

**Server**
| Field       | Type           | Notes             |
|-------------|----------------|-------------------|
| id          | String         | cuid, PK          |
| name        | String         |                   |
| provider    | ServerProvider |                   |
| version     | String         |                   |
| port        | Int            | unique            |
| containerId | String?        | unique            |
| status      | ServerStatus   | default: STOPPED  |
| maxPlayers  | Int            | default: 20       |
| difficulty  | String         | default: normal   |
| gamemode    | String         | default: survival |
| pvp         | Boolean        | default: true     |
| worldPath   | String?        |                   |
| ownerId     | String         | FK -> User        |
| createdAt   | DateTime       |                   |
| updatedAt   | DateTime       |                   |

---

## API Endpoints

### Setup

| Method | Path           | Auth | Description                          |
|--------|----------------|------|--------------------------------------|
| GET    | /setup/status  | No   | Check if admin created               |
| POST   | /setup/init    | No   | Create first admin (only works once) |

### Auth

| Method | Path            | Auth | Description                              |
|--------|-----------------|------|------------------------------------------|
| POST   | /auth/register  | No   | Register user                            |
| POST   | /auth/login     | No   | Login, sets HttpOnly cookies (JWT)       |
| POST   | /auth/refresh   | No   | Refresh access token via HttpOnly cookie |
| POST   | /auth/logout    | JWT  | Revoke refresh token, clear cookies      |
| GET    | /auth/profile   | JWT  | Get current user                         |

### Auth (complete)

| Method | Path                | Auth | Description                                    |
|--------|---------------------|------|------------------------------------------------|
| POST   | /auth/register      | No   | Register user                                  |
| POST   | /auth/login         | No   | Login, sets HttpOnly cookies (JWT)             |
| POST   | /auth/refresh       | No   | Refresh access token via HttpOnly cookie       |
| POST   | /auth/logout        | JWT  | Revoke refresh token, clear cookies            |
| GET    | /auth/profile       | JWT  | Get current user                               |
| PATCH  | /auth/profile       | JWT  | Update profile (link Minecraft account)        |

### Servers

| Method | Path                    | Auth         | Description                        |
|--------|-------------------------|--------------|------------------------------------|
| POST   | /servers                | ADMIN        | Create MC server                   |
| GET    | /servers                | JWT          | List servers (filtered by access)  |
| GET    | /servers/:id            | JWT          | Get single server                  |
| PATCH  | /servers/:id            | ADMIN \| MOD | Update server settings             |
| POST   | /servers/:id/start      | ADMIN \| MOD | Start server                       |
| POST   | /servers/:id/stop       | ADMIN \| MOD | Stop server                        |
| POST   | /servers/:id/restart    | ADMIN \| MOD | Restart server                     |
| DELETE | /servers/:id            | ADMIN        | Delete server + container          |

---

## Docker Service

The NestJS container connects to the host Docker daemon via the mounted socket at `/var/run/docker.sock`. It uses Dockerode to:

- **Create containers** using `itzg/minecraft-server` image
- **Manage lifecycle** (start, stop, remove)
- **Collect stats** (CPU, memory, network)
- **Stream logs** from MC server containers
- **Execute commands** inside containers (e.g., MC console commands)

Each MC server gets:
- Its own subdirectory under the shared `mc-data` volume
- A unique host port mapped to container port 25565
- Attached to `minepanel_network` for inter-container communication
- A 2GB default memory limit
- `unless-stopped` restart policy

---

## Environment Variables

| Variable              | Description                        | Default                          |
|-----------------------|------------------------------------|----------------------------------|
| DATABASE_URL          | PostgreSQL connection string       | (required)                       |
| JWT_SECRET            | Secret for JWT signing             | (required)                       |
| JWT_EXPIRES_IN        | Access token TTL                   | 15m                              |
| JWT_REFRESH_EXPIRES_IN| Refresh token TTL                  | 7d                               |
| PORT                  | Backend listen port                | 3000                             |
| CORS_ORIGIN           | Allowed CORS origin                | http://localhost:5173            |
| DOCKER_NETWORK        | Docker network for MC containers   | minepanel_network                |
| MC_DATA_PATH          | Base path for MC server data       | /mc-data                         |
| POSTGRES_PASSWORD     | Postgres password (docker-compose) | changeme                         |

---

## Development Workflow

```bash
# Start Postgres only
docker-compose -f docker-compose.dev.yml up -d

# Run NestJS locally with hot-reload
bun install
bunx prisma migrate dev
bunx prisma generate
bun start:dev
```

## Production Deployment

```bash
cp .env.example .env
# Edit .env with secure passwords/secrets

docker-compose up -d
# NestJS + Postgres both run in containers
```

---

## Implementation Phases

### Phase 1 - Foundation

1. Auth module (register, login, JWT via HttpOnly cookies, refresh, logout, guards) ✅
2. Setup module (first-run wizard, admin creation) ✅
3. RolesGuard + `@Roles()` decorator ← NEXT
4. Docker module (socket connection, container CRUD)
5. Server module (create/start/stop/delete MC servers)
6. Dockerize the backend

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
- Role mismatch returns `403 Forbidden`, not `401 Unauthorized`

### Phase 1.5 - Access Control (post-core)

Features deferred from Phase 1 to avoid scope creep. Implement after Docker + Servers are working.

#### Minecraft account linking
- Users can link their Minecraft account via `minecraftUUID` + `minecraftName` on their profile
- Already present in the `User` schema, just needs a `PATCH /auth/profile` endpoint
- Required for whitelist automation (Phase 3)

#### Server access model
Panel registration is always global and open. Server access is controlled per-server independently.

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
- Add `status: PENDING | ACTIVE | BANNED` to `User` model if global registration approval is needed
- A guard checks `status === ACTIVE` on every authenticated request
- For now registration is open and all new users are `ACTIVE` by default

### Phase 2 - Frontend

1. Backend URL input + localStorage persistence
2. Setup wizard (check /setup/status, register form)
3. Login page
4. **Home / global overview** — running servers count, total online players, aggregated CPU/RAM usage
5. **Server list** — start/stop/restart controls, status badge, quick stats
6. **Server detail page** — tabbed layout per server: Overview, Console, Plugins, File Manager, Players, Settings, Backups
7. **Server settings form** — edit gamemode, difficulty, MOTD, max players, pvp, memory limit without touching files
8. **Scheduled tasks UI** — cron-style interface to configure auto-restart and auto-backup per server
9. **Notifications panel** — in-panel alert feed (server crashed, high RAM, player events)
10. **User profile page** — change password, link Minecraft account (minecraftUUID + minecraftName)

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
| `server.stats`         | `{ serverId, cpu, memoryMb, memoryLimitMb }` | Resource usage, emitted every ~2s    |
| `server.log`           | `{ serverId, line }`                         | New log line from container          |
| `server.playerJoined`  | `{ serverId, player }`                       | Player connected                     |
| `server.playerLeft`    | `{ serverId, player }`                       | Player disconnected                  |
| `notification`         | `{ type, message, serverId? }`               | In-panel alert (crash, high RAM etc.)|

**Client→server messages:**

| Message              | Description                                |
|----------------------|--------------------------------------------|
| `subscribe.server`   | Start receiving events for a given server  |
| `unsubscribe.server` | Stop receiving events for a given server   |
| `console.command`    | Send a command to the server console       |

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
- RCON password stored in DB on the `Server` model (hashed or encrypted at rest)
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

**Backup API endpoints:**

| Method | Path                                    | Auth         | Description                        |
|--------|-----------------------------------------|--------------|------------------------------------|
| GET    | /servers/:id/backups                    | JWT          | List backups                       |
| POST   | /servers/:id/backups                    | ADMIN \| MOD | Create manual backup               |
| GET    | /servers/:id/backups/:backupId/download | ADMIN        | Download backup archive            |
| POST   | /servers/:id/backups/:backupId/restore  | ADMIN        | Restore from backup                |
| DELETE | /servers/:id/backups/:backupId          | ADMIN        | Delete backup                      |

---

#### 3d — Scheduled Tasks

Per-server cron jobs managed via `@nestjs/schedule`. Configured through the panel, stored in DB.

**Supported task types:**
- `AUTO_BACKUP` — create a backup on schedule
- `AUTO_RESTART` — restart server on schedule (useful for daily restarts)

**`ScheduledTask` table:**

| Field      | Type     | Notes                                      |
|------------|----------|--------------------------------------------|
| id         | String   | cuid PK                                    |
| serverId   | String   | FK → Server                                |
| type       | Enum     | AUTO_BACKUP \| AUTO_RESTART                |
| cronExpr   | String   | standard cron expression (e.g. `0 3 * * *`)|
| enabled    | Boolean  | default: true                              |
| createdAt  | DateTime |                                            |

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
- RAM usage > 90% for more than 1 minute
- Backup completed / failed
- Player banned

**`Notification` table:**

| Field      | Type     | Notes                                           |
|------------|----------|-------------------------------------------------|
| id         | String   | cuid PK                                         |
| userId     | String?  | FK → User (null = broadcast to all admins)      |
| serverId   | String?  | FK → Server                                     |
| type       | Enum     | SERVER_CRASH \| HIGH_RAM \| BACKUP_DONE \| etc. |
| message    | String   |                                                 |
| read       | Boolean  | default: false                                  |
| createdAt  | DateTime |                                                 |

**Discord webhook (optional):**
- Admin can configure a Discord webhook URL per server (or globally)
- On trigger events, backend POSTs an embed to the webhook
- Stored as `discordWebhook` field on `Server` model (optional)

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

**File Manager API endpoints:**

| Method | Path                              | Auth  | Description                      |
|--------|-----------------------------------|-------|----------------------------------|
| GET    | /servers/:id/files                | JWT   | List directory contents          |
| GET    | /servers/:id/files/content        | JWT   | Read file content                |
| PUT    | /servers/:id/files/content        | ADMIN | Write file content               |
| POST   | /servers/:id/files/upload         | ADMIN | Upload file                      |
| DELETE | /servers/:id/files                | ADMIN | Delete file or folder            |
| POST   | /servers/:id/files/mkdir          | ADMIN | Create directory                 |

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

**Player API endpoints:**

| Method | Path                              | Auth         | Description                     |
|--------|-----------------------------------|--------------|---------------------------------|
| GET    | /servers/:id/players              | JWT          | List online players             |
| GET    | /servers/:id/whitelist            | JWT          | Get whitelist                   |
| POST   | /servers/:id/whitelist            | ADMIN \| MOD | Add player to whitelist         |
| DELETE | /servers/:id/whitelist/:player    | ADMIN \| MOD | Remove player from whitelist    |
| GET    | /servers/:id/bans                 | JWT          | Get banlist                     |
| POST   | /servers/:id/bans                 | ADMIN \| MOD | Ban player                      |
| DELETE | /servers/:id/bans/:player         | ADMIN \| MOD | Unban player                    |
| GET    | /servers/:id/ops                  | JWT          | Get ops list                    |
| POST   | /servers/:id/ops                  | ADMIN        | Op player                       |
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
