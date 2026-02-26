# minepanel-backend

> ⚠️ Work in progress

NestJS backend for **MinePanel** — a self-hosted, open-source Minecraft server management panel. Designed as a modern alternative to Pterodactyl and Crafty Controller, with a focus on simple self-hosting (`docker-compose up`) and a polished UX.

The backend manages user authentication, spawns and controls Minecraft server containers via the Docker socket, and exposes a REST + WebSocket API consumed by the frontend.

See [SPEC.md](./SPEC.md) for the full architecture specification and implementation roadmap.

---

## Tech Stack

| Layer         | Technology                                      |
|---------------|-------------------------------------------------|
| Framework     | [NestJS](https://nestjs.com/) v11               |
| Language      | TypeScript 5                                    |
| Runtime       | Node.js 20 / [Bun](https://bun.sh/) (prod)     |
| Database      | PostgreSQL 16                                   |
| ORM           | [Drizzle ORM](https://orm.drizzle.team/) v0.45  |
| Auth          | JWT (HttpOnly cookies) via `@nestjs/jwt`        |
| Docker        | [Dockerode](https://github.com/apocas/dockerode) via Docker socket (rootless default) |
| Validation    | `class-validator` + `class-transformer`         |
| API docs      | Swagger / OpenAPI (`@nestjs/swagger`)           |
| Linter        | [Biome](https://biomejs.dev/)                   |
| Package mgr   | Bun                                             |

---

## Architecture

```
docker-compose up -d
┌────────────────────────────────────────┐
│              Docker Host               │
│                                        │
│  minepanel-nestjs  ──── PostgreSQL     │
│       │                                │
│       │ ${DOCKER_SOCKET} (rootless)    │
│       ▼                                │
│  mc-server-1 (itzg/minecraft-server)  │
│  mc-server-2 (itzg/minecraft-server)  │
└────────────────────────────────────────┘
```

- NestJS runs inside Docker, mounts the Docker socket to manage MC containers
- Each Minecraft server is an isolated container spawned on demand
- MC server data lives in a shared volume at `{MC_DATA_PATH}/{serverId}/`

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) — package manager and prod runtime
- [Docker](https://www.docker.com/) + Docker Compose
- PostgreSQL 16 (or use the provided `docker-compose.dev.yml`)

### Development

```bash
# 1. Clone and install dependencies
git clone https://github.com/your-org/minepanel-backend
cd minepanel-backend
bun install

# 2. Start PostgreSQL only
docker-compose -f docker-compose.dev.yml up -d

# 3. Copy env and configure
cp .env.example .env

# 4. Push DB schema
bun db:push

# 5. Start with hot reload
bun start:dev
```

API available at `http://localhost:3000`
Swagger docs at `http://localhost:3000/api`

### Production

```bash
cp .env.example .env
# Edit .env with secure values

docker-compose up -d
```

---

## Environment Variables

| Variable               | Description                          | Default                    |
|------------------------|--------------------------------------|----------------------------|
| `DATABASE_URL`         | PostgreSQL connection string         | required                   |
| `JWT_SECRET`           | Secret for signing JWTs              | required                   |
| `JWT_EXPIRES_IN`       | Access token TTL                     | `15m`                      |
| `JWT_REFRESH_EXPIRES_IN` | Refresh token TTL                  | `7d`                       |
| `PORT`                 | Backend listen port                  | `3000`                     |
| `CORS_ORIGIN`          | Allowed CORS origin                  | `http://localhost:5173`    |
| `DOCKER_NETWORK`       | Docker network for MC containers     | `minepanel_network`        |
| `MC_DATA_PATH`         | Base path for MC server data volumes | `/mc-data`                 |
| `POSTGRES_PASSWORD`    | Postgres password (docker-compose)   | `changeme`                 |

---

## Database

Schema defined in [`src/db/schema.ts`](./src/db/schema.ts) using Drizzle ORM.

```bash
bun db:push      # sync schema to DB (dev)
bun db:generate  # generate SQL migrations
bun db:migrate   # apply migrations (prod)
bun db:studio    # open Drizzle Studio GUI
```

---

## API Overview

| Group   | Endpoints                                                       |
|---------|-----------------------------------------------------------------|
| Setup   | `GET /setup/status` · `POST /setup/init`                        |
| Auth    | `POST /auth/register` · `POST /auth/login` · `POST /auth/logout` · `POST /auth/refresh` · `GET /auth/profile` |
| Servers | `POST /servers` · `GET /servers` · `GET /servers/:id` · `POST /servers/:id/start` · `POST /servers/:id/stop` · `DELETE /servers/:id` |

Full endpoint documentation available at `/api` (Swagger UI).
