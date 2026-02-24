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
| Field     | Type     | Notes              |
|-----------|----------|--------------------|
| id        | String   | cuid, PK           |
| token     | String   | unique, hashed     |
| userId    | String   | FK -> User         |
| expiresAt | DateTime |                    |
| createdAt | DateTime |                    |

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

### Servers

| Method | Path                | Auth | Description                |
|--------|---------------------|------|----------------------------|
| POST   | /servers            | JWT  | Create MC server           |
| GET    | /servers            | JWT  | List all servers           |
| GET    | /servers/:id        | JWT  | Get single server          |
| POST   | /servers/:id/start  | JWT  | Start server               |
| POST   | /servers/:id/stop   | JWT  | Stop server                |
| DELETE | /servers/:id        | JWT  | Delete server + container  |

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

1. Auth module (register, login, JWT via HttpOnly cookies, refresh, logout, guards) ← IN PROGRESS
2. Setup module (first-run wizard, admin creation) ✅
3. Docker module (socket connection, container CRUD)
4. Server module (create/start/stop/delete MC servers)
5. Dockerize the backend

#### Auth implementation status
- [x] `POST /auth/register`
- [x] `POST /auth/login` (no JWT yet)
- [ ] JWT strategy + guard
- [ ] HttpOnly cookie handling
- [ ] `POST /auth/refresh`
- [ ] `POST /auth/logout`
- [ ] `GET /auth/profile`

### Phase 2 - Frontend

1. Backend URL input + localStorage persistence
2. Setup wizard (check /setup/status, register form)
3. Login page
4. Dashboard (server list, start/stop controls)

### Phase 3 - Advanced Features

1. WebSocket support for real-time server stats/logs
2. Server console (execute commands via Docker exec)
3. File manager (browse/edit server files)
4. Player management (whitelist, bans, ops)
5. Scheduled tasks (backups, restarts)
