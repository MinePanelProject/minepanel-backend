<div align="center">
  <img src="https://minepanel.xyz/og.png" alt="MinePanel" width="100%" />
</div>

<br/>

<div align="center">

**Self-hosted Minecraft server management panel — one `docker compose up` away.**

[minepanel.xyz](https://minepanel.xyz) · [SPEC.md](./SPEC.md) · [Deployment Guide](./docs/deployment.md) · [Real-Time API](./docs/realtime.md)

</div>

---

> **Phase 1 — v1.0 is complete and production-ready.** Auth (JWT cookies, 2FA, admin approval), server lifecycle, host metrics over WebSocket, and the one-command Docker deployment (Caddy auto-HTTPS, Drizzle migrations on boot, multi-arch images on GHCR) are all shipped. Later phases (access control, marketplace, backups) are planned — see the [roadmap](https://minepanel.xyz/#roadmap).

---

## What is MinePanel?

MinePanel is an open-source, self-hosted Minecraft server management panel. It runs entirely on your own hardware via Docker — no cloud lock-in, no external services.

The backend is a **NestJS REST + WebSocket API** that manages user authentication, spawns Minecraft server containers through the Docker socket, and exposes all panel operations to the frontend hosted at [minepanel.xyz](https://minepanel.xyz).

---

## Architecture

```
docker compose pull && docker compose up -d
┌──────────────────────────────────────────────┐
│                  Docker Host                  │
│                                              │
│  Caddy (HTTPS) ──► NestJS ──── PostgreSQL   │
│                      │                       │
│      /var/run/docker.sock (root, local)      │
│                      ▼                       │
│        mc-{id} (itzg/minecraft-server)       │
│        on dedicated managed-MC bridge        │
└──────────────────────────────────────────────┘
```

- **Caddy** handles automatic HTTPS (Let's Encrypt) — just set `DOMAIN` and `CORS_ORIGIN` in `.env`
- **NestJS** mounts the local Docker socket to spawn and control MC containers
- Each Minecraft server runs in its own isolated container on a dedicated bridge network
- MC data lives in `{MC_DATA_PATH_HOST}/{serverId}/`; the backend sees it read-only

---

## Tech Stack

| Layer       | Technology                                                        |
|-------------|-------------------------------------------------------------------|
| Framework   | [NestJS](https://nestjs.com/) v11                                 |
| Language    | TypeScript 5                                                      |
| Runtime     | [Bun](https://bun.sh/) 1.3.14 (production) / Node.js 20 (dev)     |
| Database    | PostgreSQL 16 + [Drizzle ORM](https://orm.drizzle.team/)          |
| Auth        | JWT via HttpOnly cookies (no Passport)                            |
| Docker      | [Dockerode](https://github.com/apocas/dockerode) — local socket   |
| Proxy       | [Caddy](https://caddyserver.com/) — auto HTTPS, included in compose |
| Validation  | `class-validator` + `class-transformer`                           |
| API docs    | Swagger / OpenAPI at `/docs`                                      |
| Linter      | [Biome](https://biomejs.dev/)                                     |

---

## Quick Deploy

**Requirements:** a Linux server with Docker, a domain pointing to it, ports 80 and 443 open.

```bash
git clone https://github.com/MinePanelProject/minepanel-backend
cd minepanel-backend
cp .env.example .env
```

Edit `.env` — the required values are:

```env
DOMAIN=your-domain.com
CORS_ORIGIN=https://minepanel.xyz
POSTGRES_PASSWORD=strong-random-password
JWT_SECRET=long-random-string
# Generate exactly 32 random bytes encoded as 64 hexadecimal characters: openssl rand -hex 32
ENCRYPTION_KEY=64-hex-character-output
# Absolute host directory for Minecraft data (e.g. $HOME/.minepanel/mc-data)
MC_DATA_PATH_HOST=/absolute/path/to/mc-data
```

```bash
docker compose pull && docker compose up -d
```

Caddy automatically provisions an HTTPS certificate. The panel is live at `https://your-domain.com`.

→ Full guide: [docs/deployment.md](./docs/deployment.md)

---

## Development

```bash
# Install dependencies
bun install

# Start PostgreSQL only
docker compose -f docker-compose.dev.yml up -d

# Copy and configure env
cp .env.example .env

# Push DB schema
bun db:push

# Start with hot reload
bun start:dev
```

API: `http://localhost:3000/api`
Swagger: `http://localhost:3000/docs`

---

## Environment Variables

See [`.env.example`](./.env.example) for the full list. Key variables:

| Variable                | Description                                        | Default              |
|-------------------------|----------------------------------------------------|----------------------|
| `DOMAIN`                | Public domain — used by Caddy for HTTPS            | required in prod     |
| `CORS_ORIGIN`           | Allowed frontend origin — never derived from `DOMAIN` | required in prod  |
| `MINEPANEL_IMAGE`       | Backend image used by Compose                      | `ghcr.io/minepanelproject/minepanel-backend:latest` |
| `DATABASE_URL`          | PostgreSQL connection string                       | required             |
| `JWT_SECRET`            | Secret for JWT signing                             | required             |
| `ENCRYPTION_KEY`        | 32 random bytes encoded as 64 hexadecimal characters; generate with `openssl rand -hex 32` | required |
| `REQUIRE_ADMIN_APPROVAL`| New users start as PENDING until admin approves    | `true`               |
| `MC_PORT_MIN/MAX`       | Port range for Minecraft server containers         | `25565` / `25665`    |
| `MC_DATA_PATH_HOST`     | Host data root — **required in Compose** (wizards default `$HOME/.minepanel/mc-data`; mounted read-only at `/mc-data`) | `$HOME/.minepanel/mc-data` |
| `MC_DATA_PATH`          | Base path inside the backend; Compose fixes it to `/mc-data` (direct backend execution only) | `/mc-data` |
| `MIN_FREE_DISK_MB`      | Minimum free disk to allow server creation         | `2048`               |
| `MAX_MEMORY_RATIO`      | Max fraction of host RAM allocatable to MC servers | `0.90`               |

---

## Database

Schema defined in [`src/db/schema.ts`](./src/db/schema.ts).

```bash
bun db:push      # sync schema to DB (dev)
bun db:generate  # generate SQL migrations
bun db:migrate   # apply migrations (prod)
bun db:studio    # open Drizzle Studio GUI
```

In production, migrations run automatically inside the container before the API starts.

---

## API Overview

Full docs at `/docs` (Swagger UI) when the server is running.

| Group      | Endpoints                                                                                     |
|------------|-----------------------------------------------------------------------------------------------|
| Setup      | `GET /setup/status` · `POST /setup/init`                                                      |
| Auth       | `POST /auth/register` · `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `GET /auth/profile` · `GET /auth/sessions` · `PATCH /auth/profile` · `PATCH /auth/password` |
| Admin      | `GET /admin/users` · `PATCH /admin/users/:id/status` · `PATCH /admin/users/:id/role` · `POST /admin/users/:id/reset-password` · `DELETE /admin/users/:id/2fa` |
| Health     | `GET /health`                                                                                 |
| Servers    | `POST /servers` · `GET /servers` · `GET /servers/:id` · `POST /servers/:id/start` · `POST /servers/:id/stop` · `POST /servers/:id/restart` · `DELETE /servers/:id` |
| WebSocket  | `system.stats` — host metrics for ADMIN sockets only ([docs/realtime.md](./docs/realtime.md)) |

---

## Roadmap

Live progress at [minepanel.xyz/#roadmap](https://minepanel.xyz/#roadmap).

See [SPEC.md](./SPEC.md) for the full architecture specification.

---

## License

Not affiliated with Mojang Studios or Microsoft. Minecraft is a trademark of Mojang Synergies AB.
