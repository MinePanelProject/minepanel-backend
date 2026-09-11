<div align="center">
  <img src="https://minepanel.xyz/og.png" alt="MinePanel" width="100%" />
</div>

<br/>

<div align="center">

**Self-hosted Minecraft server management panel - one `docker compose up` away.**

[minepanel.xyz](https://minepanel.xyz) · [Deployment Guide](./docs/deployment.md)

</div>

---

MinePanel is a self-hosted Minecraft server management panel. It runs entirely on your own hardware via
Docker - no cloud lock-in, no external services. This repository is the backend: a **NestJS REST +
WebSocket API** that manages authentication, spawns Minecraft server containers through the Docker
socket, and serves the hosted protocol-1 dashboard ([`minepanel-pwa`](https://github.com/MinePanelProject/minepanel-pwa)).

> **Status: v1.0 release candidate, no stable release published.** Authentication (JWT HttpOnly
> cookies, TOTP, admin approval, Google sign-in), the transactional first-admin bootstrap, protocol-1
> capability discovery, server lifecycle, per-server access control with MOD granular permissions, host
> metrics over WebSocket, and the one-command Docker deployment (Caddy auto-HTTPS, boot migrations,
> multi-arch GHCR images) are shipped. There is no stable semver release yet; the `edge` image built
> from `master` is the current channel. Planning state and gates: [`ROADMAP.md`](./ROADMAP.md).

---

## Engineering documentation

| Document | Read it for |
|----------|-------------|
| [`SPEC.md`](./SPEC.md) | The contract: supported clients, deployment topology, data model, HTTP/WS API, auth and authorization semantics, lifecycle state machine, error and configuration contracts, invariants, decision register, security requirements |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | How the current system is built: module structure, request pipeline, persistence and advisory locks, Docker boundary, realtime, capability negotiation, deployment |
| [`ROADMAP.md`](./ROADMAP.md) | What is completed, next, committed, conditional or exploratory - with dependencies, gates and acceptance conditions |
| [`DEVELOPMENT.md`](./DEVELOPMENT.md) | Local setup, commands, migrations, test suites, and the validation expected before claiming a change is done |
| [`AGENTS.md`](./AGENTS.md) | Coding-agent working rules, style conventions and red lines |
| [`docs/`](./docs) | Domain detail: [deployment](./docs/deployment.md) · [servers](./docs/servers.md) · [auth](./docs/auth-architecture.md) · [access control](./docs/access-control.md) · [realtime](./docs/realtime.md) |

`SPEC.md` wins over any other document in this repository: it defines what the system is *required* to
do. The code, migrations, tests and deployment configuration define what it *currently* does; when
they disagree, the discrepancy is investigated and classified in `SPEC.md` §1 rather than silently
reconciled in either direction.

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
        mc-{id} (itzg/minecraft-server pinned image)        │
        on managed bridge (memory/CPU/PIDs capped)          │
└──────────────────────────────────────────────┘
```

- **Caddy** handles automatic HTTPS - set `DOMAIN` and `CORS_ORIGIN` in `.env`
- **NestJS** mounts the local Docker socket to create and control MC containers
- Each Minecraft server runs in its own container on a dedicated bridge network
- MC data lives in `{MC_DATA_PATH_HOST}/{serverId}/`; the backend sees it **read-only**

Only Caddy publishes ports (80/443). The backend is never published: publishing port 3000 would break
the `trust proxy = 1` assumption and defeat both per-IP throttling and the CSRF origin check
([`SPEC.md`](./SPEC.md) §4.2).

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Framework | [NestJS](https://nestjs.com/) v11 |
| Language | TypeScript 5 |
| Runtime | [Bun](https://bun.sh/) 1.3.14 (production and package manager) |
| Database | PostgreSQL 16 + [Drizzle ORM](https://orm.drizzle.team/) |
| Auth | JWT via HttpOnly cookies, TOTP, Google Identity Services (no Passport) |
| Docker | [Dockerode](https://github.com/apocas/dockerode) over a local Unix socket |
| Realtime | Socket.IO 4 |
| Proxy | [Caddy](https://caddyserver.com/) - automatic HTTPS, included in Compose |
| Validation | `class-validator` + `class-transformer` |
| API docs | Swagger / OpenAPI at `/docs` |
| Lint/format | Biome 2.4 + oxlint |

---

## Quick deploy

**Requirements:** a Linux or macOS host with Docker Engine and the Compose plugin, a domain pointing
to it, and ports 80/443 reachable.

There is no published stable semver release yet, so the current channel is `edge`, built from
`master`. Download the deployment assets without cloning the source:

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

The Compose service uses `pull_policy: missing`, so an ordinary `up` reuses a locally cached image;
the explicit `docker compose pull` refreshes it. Caddy provisions the HTTPS certificate
automatically and the panel is live at `https://your-domain.com`.

**Stable is not published yet.** When a `vX.Y.Z` release exists, download the assets from that exact
raw GitHub ref and set `MINEPANEL_IMAGE` to the matching `X.Y.Z` image tag, so the Compose file,
`.env.example`, `Caddyfile` and image all carry the same version. See the
[deployment guide](./docs/deployment.md) for pinning, updating, proxy alternatives, troubleshooting,
socket configuration and retained-data cleanup.

---

## Development

```bash
git clone https://github.com/MinePanelProject/minepanel-backend
cd minepanel-backend
bun install
docker compose -f docker-compose.dev.yml up -d   # local PostgreSQL only
cp .env.example .env
bun db:push
bun start:dev
```

API: `http://localhost:3000/api` · Swagger: `http://localhost:3000/docs`

Full command reference, environment setup, migration workflow and validation gates:
[`DEVELOPMENT.md`](./DEVELOPMENT.md).

---

## Configuration

See [`.env.example`](./.env.example) for the complete list, with descriptions and defaults. The
variables an operator must set are in **Quick deploy** above; the ones that most often need tuning:

| Variable | Purpose | Default |
|----------|---------|---------|
| `MINECRAFT_IMAGE` | Image identity shared by the Compose prefetch and every managed Minecraft container; a pinned multi-arch digest in `.env.example`, `:latest` rejected | pinned digest |
| `MINEPANEL_IMAGE` | Backend image used by Compose | `ghcr.io/minepanelproject/minepanel-backend:latest` |
| `REQUIRE_ADMIN_APPROVAL` | New registrations start as PENDING until an admin approves | `true` |
| `MC_DATA_PATH_HOST` | Host data root; mounted read-only at `/mc-data` and used as the container bind source | required in Compose |
| `MC_PORT_MIN` / `MC_PORT_MAX` | Host port range for Minecraft containers | `25565` / `25665` |
| `MC_CPU_NANO_CPUS` / `MC_PIDS_LIMIT` | Per-container CPU quota and process limit | `2000000000` / `512` |
| `MIN_FREE_DISK_MB` / `MAX_MEMORY_RATIO` | Admission thresholds for create and start | `2048` / `0.90` |
| `STOP_WARN_SECONDS` | Player warning before a graceful shutdown (`0`-`300`) | `30` |
| `GOOGLE_CLIENT_ID` | Enables Google sign-in and the `googleOAuth` capability | unset |

The distinction between variables the application consumes and variables that exist only for Compose
interpolation is documented in [`SPEC.md`](./SPEC.md) §13.2.

---

## Database

Schema: [`src/db/schema.ts`](./src/db/schema.ts) (the single authoritative schema). Migrations:
`drizzle/`.

```bash
bun db:push      # sync schema to the database (development)
bun db:generate  # generate SQL migrations from schema changes
bun db:migrate   # apply migrations (production)
bun db:studio    # Drizzle Studio
```

In production the container applies the whole migration chain before the API starts listening.

---

## API

Exhaustive, always-current reference: **Swagger UI at `/docs`** while the server runs. Architecturally
important semantics (global prefix, status codes, error envelope, capability discovery, auth flows)
are in [`SPEC.md`](./SPEC.md) §7, §8 and §12; the endpoint groups are setup, auth (including 2FA and
Google), admin, servers, server access, plus `GET /health` and `GET /api/info`.

`GET /api/info` returns protocol 1 and explicit capability flags and is the compatibility contract
for hosted clients - they must branch on those flags, never on `PANEL_VERSION`. Production session
cookies are `HttpOnly; Secure; SameSite=None; Partitioned; Path=/` (CHIPS), coordinated with Web Locks
by the hosted dashboard where required. See [`docs/realtime.md`](./docs/realtime.md) for the WebSocket
surface.

---

## Roadmap

Live progress is rendered at [minepanel.xyz/#roadmap](https://minepanel.xyz/#roadmap) from this
repository's [`roadmap.json`](./roadmap.json), which the site fetches server-side - a roadmap update
needs no site deployment. The rationale, dependencies and gates behind those progress items live in
[`ROADMAP.md`](./ROADMAP.md); the two files are updated together.

The current NestJS backend remains the implementation target through feature completion. Backend 2.0
(Elysia 2) is a future, parity-first milestone that starts only after every gate in
[`ROADMAP.md`](./ROADMAP.md) §6.1 is satisfied, and the MCP Server / Agent Interface is a further
conditional track (§6.2) that may start only after that port; neither is in preparation and no MCP
server exists today.

---

## License

MIT - see [LICENSE](./LICENSE).

Not affiliated with Mojang Studios or Microsoft. Minecraft is a trademark of Mojang Synergies AB.
