<div align="center">
  <img src="https://minepanel.xyz/og.png" alt="MinePanel" width="100%" />
</div>

<br/>

<div align="center">

**Self-hosted Minecraft server management panel - one `docker compose up` away.**

[minepanel.xyz](https://minepanel.xyz) · [SPEC.md](./SPEC.md) · [Deployment Guide](./docs/deployment.md) · [Real-Time API](./docs/realtime.md)

</div>

---

> **Phase 1 - v1.0 release candidate.** Auth (JWT cookies, 2FA, admin approval), transactional first-admin bootstrap, protocol-1 capability discovery, server lifecycle, host metrics over WebSocket, and the one-command Docker deployment (Caddy auto-HTTPS, Drizzle migrations on boot, multi-arch images on GHCR) are shipped. Open decisions and the hardening backlog are tracked in [SPEC.md](./SPEC.md) §16/§19.
>
> **Phase 1 - authorization spine shipped.** Per-server visibility (`OPEN`/`REQUEST`/`PRIVATE`), request/approval workflows, requestable-server discovery, and MOD granular permissions (`PermissionsGuard` + `mod_permissions`) are live.
>
> **Phase 1.5 - Identity / onboarding core scope complete.** Challenge-bound Google login and account linking, server visibility and access requests, requestable-server discovery, and MOD granular permissions are live. GitHub OAuth, Minecraft linking, magic links, and invites remain optional or deferred follow-ons and do not gate backend feature completion - see the [roadmap](https://minepanel.xyz/#roadmap).

---

## What is MinePanel?

MinePanel is a self-hosted Minecraft server management panel. It runs entirely on your own hardware via Docker - no cloud lock-in, no external services.

The backend is a **NestJS REST + WebSocket API** that manages user authentication, spawns Minecraft server containers through the Docker socket, and exposes all panel operations to the hosted protocol-1 management dashboard (`minepanel-pwa`; hosted-browser PKCE fallback is reserved and not implemented).

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

- **Caddy** handles automatic HTTPS (Let's Encrypt) - just set `DOMAIN` and `CORS_ORIGIN` in `.env`
- **NestJS** mounts the local Docker socket to spawn and control MC containers
- Each Minecraft server runs in its own isolated container on a dedicated bridge network
- MC data lives in `{MC_DATA_PATH_HOST}/{serverId}/`; the backend sees it read-only

---

## Tech Stack

| Layer       | Technology                                                        |
|-------------|-------------------------------------------------------------------|
| Framework   | [NestJS](https://nestjs.com/) v11                                 |
| Language    | TypeScript 5                                                      |
| Runtime     | [Bun](https://bun.sh/) 1.3.14 (production) / Node.js 20 (dev, unpinned)  |
| Database    | PostgreSQL 16 + [Drizzle ORM](https://orm.drizzle.team/)          |
| Auth        | JWT via HttpOnly cookies (no Passport)                            |
| Docker      | [Dockerode](https://github.com/apocas/dockerode) - local socket   |
| Proxy       | [Caddy](https://caddyserver.com/) - auto HTTPS, included in compose |
| Validation  | `class-validator` + `class-transformer`                           |
| API docs    | Swagger / OpenAPI at `/docs`                                      |
| Linter      | [Biome](https://biomejs.dev/)                                     |

---

## Quick Deploy

**Requirements:** a Linux server with Docker Engine and the Compose plugin, a domain pointing to it, and ports 80 and 443 open.

MinePanel has no published stable semver release yet. The current pre-stable
channel is `edge`, built from `master`. Download the deployment assets without
cloning the source repository:

```bash
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/MinePanelProject/minepanel-backend/master/docker-compose.yml
curl -fsSLo .env.example https://raw.githubusercontent.com/MinePanelProject/minepanel-backend/master/.env.example
curl -fsSLo Caddyfile https://raw.githubusercontent.com/MinePanelProject/minepanel-backend/master/Caddyfile
cp .env.example .env
sed -i 's|^MINEPANEL_IMAGE=.*|MINEPANEL_IMAGE=ghcr.io/minepanelproject/minepanel-backend:edge|' .env
```

Edit `.env` - the required values are:

```env
DOMAIN=your-domain.com
CORS_ORIGIN=https://your-domain.com
POSTGRES_PASSWORD=strong-random-password
JWT_SECRET=long-random-string
# Generate exactly 32 random bytes encoded as 64 hexadecimal characters: openssl rand -hex 32
ENCRYPTION_KEY=64-hex-character-output
# One-time first-admin secret; send as X-Setup-Token to POST /api/setup/init
SETUP_TOKEN=random-secret
# Absolute host directory for Minecraft data (e.g. $HOME/.minepanel/mc-data)
MC_DATA_PATH_HOST=/absolute/path/to/mc-data
```

```bash
docker compose pull && docker compose up -d
```

The Compose service keeps `pull_policy: missing`: it reuses a locally cached
image during `up`; the explicit `docker compose pull` above refreshes it.

Caddy automatically provisions an HTTPS certificate. The panel is live at `https://your-domain.com`.
Stable is not published yet. When a `vX.Y.Z` release exists, download the
assets from that exact raw GitHub ref and set `MINEPANEL_IMAGE` to the matching
`X.Y.Z` image tag. See the [full deployment guide](./docs/deployment.md) for
pinning and updates.

---

## Development

```bash
# Clone the source repository for development
git clone https://github.com/MinePanelProject/minepanel-backend
cd minepanel-backend

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
| `DOMAIN`                | Public domain - used by Caddy for HTTPS            | required in prod     |
| `CORS_ORIGIN`           | Allowed frontend origin - never derived from `DOMAIN` | required in prod  |
| `MINEPANEL_IMAGE`       | Backend image used by Compose                      | `ghcr.io/minepanelproject/minepanel-backend:latest` |
| `DATABASE_URL`          | PostgreSQL connection string                       | required             |
| `JWT_SECRET`            | Secret for JWT signing                             | required             |
| `ENCRYPTION_KEY`        | 32 random bytes encoded as 64 hexadecimal characters; generate with `openssl rand -hex 32` | required |
| `SETUP_TOKEN`           | One-time first-admin secret sent as `X-Setup-Token`; if omitted, a token is generated/logged once per incomplete process | optional fallback |
| `REQUIRE_ADMIN_APPROVAL`| New users start as PENDING until admin approves    | `true`               |
| `MC_PORT_MIN/MAX`       | Port range for Minecraft server containers         | `25565` / `25665`    |
| `MC_DATA_PATH_HOST`     | Host data root - **required in Compose** (wizards default `$HOME/.minepanel/mc-data`; mounted read-only at `/mc-data`) | `$HOME/.minepanel/mc-data` |
| `MC_DATA_PATH`          | Base path inside the backend; Compose fixes it to `/mc-data` (direct backend execution only) | `/mc-data` |
| `MIN_FREE_DISK_MB`      | Minimum free disk to allow server creation         | `2048`               |
| `MAX_MEMORY_RATIO`       | Max fraction of host RAM allocatable to MC servers | `0.90`               |

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

`GET /api/info` returns protocol 1 and explicit capability flags. Production session cookies use `HttpOnly; Secure; SameSite=None; Partitioned; Path=/` (CHIPS). The PKCE authorization-code fallback and WebSocket tickets are reserved, not implemented, and advertised as unsupported; clients must not infer compatibility from `PANEL_VERSION`.

| Group      | Endpoints                                                                                     |
|------------|-----------------------------------------------------------------------------------------------|
| Setup      | `GET /setup/status` · `POST /setup/init` (requires `X-Setup-Token`, throttled 5/10 min/IP) |
| Auth       | `POST /auth/register` · `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `POST /auth/logout-all` · `GET /auth/profile` · `GET /auth/sessions` · `PATCH /auth/profile` · `PATCH /auth/password` · `POST /auth/oauth/challenge` · `POST /auth/oauth/google/login` · `POST /auth/oauth/google/link` · `POST /auth/2fa/setup` · `POST /auth/2fa/confirm` · `POST /auth/2fa/verify` · `DELETE /auth/2fa/disable` |
| Admin      | `GET /admin/users` · `PATCH /admin/users/:id/status` · `PATCH /admin/users/:id/role` · `POST /admin/users/:id/reset-password` · `DELETE /admin/users/:id/2fa` · `GET/POST /admin/users/:id/permissions` · `DELETE /admin/users/:id/permissions/:permId` |
| Health     | `GET /health`                                                                                 |
| Info       | `GET /api/info` - protocol-1 capability discovery (`Cache-Control: no-store`) |
| Servers    | `POST /servers` · `GET /servers` · `GET /servers/requestable` · `GET /servers/:id` · `POST /servers/:id/start` · `POST /servers/:id/stop` · `POST /servers/:id/restart` · `DELETE /servers/:id` · `POST /servers/:id/request-access` · `GET /servers/:id/my-access-request` · `GET /servers/:id/access-requests` · `POST /servers/:id/access-requests/:userId/approve` · `DELETE /servers/:id/access-requests/:userId` |
| WebSocket  | `system.stats` - host metrics for ADMIN sockets only ([docs/realtime.md](./docs/realtime.md)) |

---

## Roadmap

Live progress at [minepanel.xyz/#roadmap](https://minepanel.xyz/#roadmap). This repository owns
[`roadmap.json`](./roadmap.json), which contains backend implementation progress only. It does not
own website presentation content. The site fetches this file server-side, so roadmap updates do not
require a minepanel-site deployment.

The current NestJS backend remains the implementation target through feature completion. Backend 2.0
— Elysia 2 is a future, parity-first milestone only after the gates listed in [SPEC.md](./SPEC.md)
§17.6; no migration preparation is underway.

See [SPEC.md](./SPEC.md) for the canonical architecture and roadmap.

---

## License

MIT — see [LICENSE](./LICENSE).

Not affiliated with Mojang Studios or Microsoft. Minecraft is a trademark of Mojang Synergies AB.
