<div align="center">
  <img src="https://minepanel.xyz/og.png" alt="MinePanel" width="100%" />
</div>

<br/>

<div align="center">

**Self-hosted Minecraft server management panel — one `docker compose up` away.**

[minepanel.xyz](https://minepanel.xyz) · [SPEC.md](./SPEC.md) · [Deployment Guide](./docs/deployment.md)

</div>

---

> [!WARNING]
> **Phase 1 — Work in Progress.** Core features are under active development. The backend is not production-ready yet. See the [roadmap](https://minepanel.xyz/#roadmap) for current status.

---

## What is MinePanel?

MinePanel is an open-source, self-hosted Minecraft server management panel. It runs entirely on your own hardware via Docker — no cloud lock-in, no external services.

The backend is a **NestJS REST + WebSocket API** that manages user authentication, spawns Minecraft server containers via the Docker socket, and exposes all panel operations to the frontend hosted at [minepanel.xyz](https://minepanel.xyz).

---

## Architecture

```
docker compose up -d
┌──────────────────────────────────────────────┐
│                  Docker Host                  │
│                                              │
│  Caddy (HTTPS) ──► NestJS ──── PostgreSQL   │
│                      │                       │
│          ${DOCKER_SOCKET} (rootless)         │
│                      ▼                       │
│        mc-server-1 (itzg/minecraft-server)   │
│        mc-server-2 (itzg/minecraft-server)   │
└──────────────────────────────────────────────┘
```

- **Caddy** handles automatic HTTPS (Let's Encrypt) — just set `DOMAIN` in `.env`
- **NestJS** mounts the Docker socket to spawn and control MC containers
- Each Minecraft server runs in its own isolated container
- MC data lives in `{MC_DATA_PATH}/{serverId}/`

---

## Tech Stack

| Layer       | Technology                                                        |
|-------------|-------------------------------------------------------------------|
| Framework   | [NestJS](https://nestjs.com/) v11                                 |
| Language    | TypeScript 5                                                      |
| Runtime     | Node.js 20 / [Bun](https://bun.sh/) (prod)                       |
| Database    | PostgreSQL 16 + [Drizzle ORM](https://orm.drizzle.team/)          |
| Auth        | JWT via HttpOnly cookies (no Passport)                            |
| Docker      | [Dockerode](https://github.com/apocas/dockerode) — rootless-first |
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

Edit `.env` — only 4 values required:

```env
DOMAIN=your-domain.com
POSTGRES_PASSWORD=strong-random-password
JWT_SECRET=long-random-string
ENCRYPTION_KEY=long-random-string
```

```bash
docker compose up -d
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
| `DOMAIN`                | Public domain — used by Caddy for HTTPS + CORS     | required in prod     |
| `DATABASE_URL`          | PostgreSQL connection string                       | required             |
| `JWT_SECRET`            | Secret for JWT signing                             | required             |
| `ENCRYPTION_KEY`        | Key for RCON password encryption (AES-256-GCM)     | required             |
| `REQUIRE_ADMIN_APPROVAL`| New users start as PENDING until admin approves    | `true`               |
| `MC_PORT_MIN/MAX`       | Port range for Minecraft server containers         | `25565` / `25665`    |
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

---

## API Overview

Full docs at `/docs` (Swagger UI) when the server is running.

| Group   | Endpoints                                                                                     |
|---------|-----------------------------------------------------------------------------------------------|
| Setup   | `GET /setup/status` · `POST /setup/init`                                                      |
| Auth    | `POST /auth/register` · `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `GET /auth/profile` · `GET /auth/sessions` · `PATCH /auth/profile` · `PATCH /auth/password` |
| Health  | `GET /health`                                                                                 |
| Servers | `POST /servers` · `GET /servers` · `GET /servers/:id` · `POST /servers/:id/start` · `POST /servers/:id/stop` · `DELETE /servers/:id` |

---

## Roadmap

Live progress at [minepanel.xyz/#roadmap](https://minepanel.xyz/#roadmap).

See [SPEC.md](./SPEC.md) for the full architecture specification.

---

## License

Not affiliated with Mojang Studios or Microsoft. Minecraft is a trademark of Mojang Synergies AB.
