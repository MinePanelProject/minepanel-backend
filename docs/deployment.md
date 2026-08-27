# Deployment Guide

## Requirements

- A Linux or macOS server with Docker installed (Windows uses Docker Desktop)
- A domain name with an A/AAAA record pointing to the server IP
- Ports 80 and 443 open on the firewall
- A GitHub account with access to the image registry (only if you pin a private GHCR image)

## Quick Start

```bash
git clone https://github.com/MinePanelProject/minepanel-backend
cd minepanel-backend
cp .env.example .env
```

Edit `.env` and set the required values:

| Variable | Description |
|----------|-------------|
| `DOMAIN` | Your domain (e.g. `panel.yourdomain.com`) — required for HTTPS |
| `CORS_ORIGIN` | Exact origin of the frontend (e.g. `https://minepanel.xyz`) — never `*` |
| `POSTGRES_PASSWORD` | Strong random password for the database |
| `DATABASE_URL` | `postgresql://minepanel:<url-encoded password>@postgres:5432/minepanel` — use a URL-safe (percent-encoded) password |
| `JWT_SECRET` | Long random string for JWT signing (min 32 chars; not the example placeholder) |
| `ENCRYPTION_KEY` | Exactly 32 random bytes encoded as 64 hexadecimal characters. Generate with `openssl rand -hex 32`. |
| `SETUP_TOKEN` | Required one-time secret for `POST /api/setup/init`; generate a random value and keep it private. If omitted, the backend generates and logs a one-time token once per incomplete process. |
| `MC_DATA_PATH_HOST` | Absolute host directory for Minecraft data (e.g. `$HOME/.minepanel/mc-data`) — required, mounted read-only into the backend |
Then deploy:

```bash
docker compose pull && docker compose up -d
```

> The first-admin endpoint requires `X-Setup-Token: $SETUP_TOKEN`. A configured token is never logged or returned. If `SETUP_TOKEN` is omitted, retrieve the generated token from `docker compose logs nestjs` and use it before setup completes; it changes on restart.

## How it works

- `docker compose pull` fetches the configured `MINEPANEL_IMAGE` (default `latest`; pin a release or `sha-<full-40>` tag for reproducible deploys) before any container is recreated.
- The `nestjs` container runs as `root` (documented runtime) so it can read the local Docker socket.
- Database migrations run inside the container **before** the API starts listening on port 3000.
- The backend only exposes port 3000 internally; Caddy is the only service reachable from the internet on 80/443.
- Minecraft server containers are attached to a dedicated bridge network (`minepanel_network` by default).
- The host MC data directory is mounted **read-only** into the backend; the actual Minecraft containers mount the same host path read/write.

## Environment Variables Reference

See `.env.example` for the full list with descriptions and defaults.

Key variables:

| Variable | Default | Notes |
|----------|---------|-------|
| `DOMAIN` | — | **Required.** Caddy uses this for HTTPS. |
| `CORS_ORIGIN` | — | **Required.** Exact frontend origin; not derived from `DOMAIN`. Never `*` in production. |
| `MINEPANEL_IMAGE` | `ghcr.io/minepanelproject/minepanel-backend:latest` | Image used by the `nestjs` service. Pin to a specific tag for reproducible deploys. |
| `POSTGRES_PASSWORD` | — | **Required.** Used by the Postgres service; embedded in `DATABASE_URL`. |
| `DATABASE_URL` | — | **Required.** PostgreSQL connection string. In Compose this is injected verbatim; never constructed inside `docker-compose.yml`. |
| `JWT_SECRET` | — | **Required.** Min 32 chars recommended. |
| `ENCRYPTION_KEY` | — | **Required.** Exactly 64 hex characters. |
| `SETUP_TOKEN` | — | One-time first-admin bootstrap secret; configure it explicitly and send it as `X-Setup-Token`. |
| `REQUIRE_ADMIN_APPROVAL` | `true` | New users start as PENDING until an admin approves. |
| `MC_PORT_MIN` / `MC_PORT_MAX` | `25565` / `25665` | Port range for Minecraft server containers. |
| `MC_DATA_PATH_HOST` | **Required** (wizards default `$HOME/.minepanel/mc-data`) | Host data root mounted read-only into the backend at `/mc-data`; also the bind source for Minecraft containers. |
| `MC_DATA_PATH` | `/mc-data` | Base path inside the backend container; Compose fixes it to `/mc-data` (direct backend execution only). |
| `DOCKER_NETWORK` | `minepanel_network` | Bridge network used for managed Minecraft containers. |
| `MIN_FREE_DISK_MB` | `2048` | Minimum free disk required to create a new server. |
| `MAX_MEMORY_RATIO` | `0.90` | Max fraction of host RAM allocatable to MC servers. |
| `STOP_WARN_SECONDS` | `30` | Seconds to warn players before a graceful shutdown. Integer `0`-`300`. |
| `POSTGRES_VOLUME_NAME` | `minepanel-postgres-data` | Named volume for Postgres data. |
| `CADDY_DATA_VOLUME_NAME` | `minepanel-caddy-data` | Named volume for Caddy certificates. |
| `CADDY_CONFIG_VOLUME_NAME` | `minepanel-caddy-config` | Named volume for Caddy config. |

### Minecraft data directory

The default host data root is `$HOME/.minepanel/mc-data`. Compose passes this host path as the daemon bind source and mounts it read-only at `/mc-data` in the backend. Rootful Docker is the shipped default; rootless Docker remains an optional socket override. Root-docker operators should pre-create and `chown` the root for the Minecraft container runtime user. On SELinux, label the directory per local policy — do NOT put `:Z` inside `MC_DATA_PATH_HOST`.

## Reverse Proxy

Caddy is included by default in `docker-compose.yml` and handles:
- Automatic HTTPS (Let's Encrypt)
- HTTP → HTTPS redirect
- Proxy to the NestJS backend, including WebSocket upgrades

No additional configuration is needed for basic HTTPS.

### Custom Caddy Configuration

Edit `Caddyfile` before starting. Example with custom headers:

```
your-domain.com {
    reverse_proxy nestjs:3000
    header X-Frame-Options DENY
}
```

Do not add `tls internal`; Caddy uses public ACME by default.

### Using nginx or Traefik instead

Keep the backend private to the Docker app network. A containerized nginx/Traefik proxy may join that network and proxy to `nestjs:3000`; do not publish the backend port. A host-level proxy requires a deliberately designed host-to-container ingress boundary and must not expose an unauthenticated or host-wide plaintext backend port. The shipped Compose topology supports Caddy; alternative proxy wiring is outside the current release contract.

## Docker Socket

The backend requires access to a **local Unix Docker socket**. The Compose mount binds the host socket at the fixed container path `/var/run/docker.sock`:

```yaml
${DOCKER_SOCKET:-/var/run/docker.sock}:/var/run/docker.sock
```

`DOCKER_SOCKET` in `.env` names the **host** socket path (the bind source). Inside the container the socket is always at `/var/run/docker.sock` (the compose file sets the backend env accordingly). Mounting the Docker socket grants the container host-level Docker authority. The backend rejects `tcp://` or remote endpoints at startup. On rootless Docker, set `DOCKER_SOCKET` to your user socket path (usually under `$XDG_RUNTIME_DIR`), e.g. `/run/user/1000/docker.sock`.

On Windows, Docker Desktop exposes the engine socket at `/var/run/docker.sock` inside containers by default, and translates Windows host paths in bind mounts (`C:\Users\...` for `MC_DATA_PATH_HOST`) to the WSL2/VM filesystem — the shipped defaults in `setup.ps1` work without changes.

## Updating

```bash
docker compose pull
docker compose up -d
```

Database migrations run automatically before the API starts. Migrations are forward-only; to roll back an image, restore a database backup taken before the migration, then deploy the previous image tag.

## Pinning the image

The default `MINEPANEL_IMAGE` uses the `latest` tag. For reproducible deploys, pin a SHA-based or semver tag:

```env
MINEPANEL_IMAGE=ghcr.io/minepanelproject/minepanel-backend:sha-<full-40>
```

Published images are multi-platform (`linux/amd64`, `linux/arm64`) and include SBOM + provenance attestations.

## Source-build override

To build the image locally instead of pulling from GHCR:

```bash
docker build -t minepanel .
MINEPANEL_IMAGE=minepanel docker compose up -d
```

## Logs

```bash
docker compose logs -f nestjs
docker compose logs -f caddy
```

## Troubleshooting

### DNS / ACME challenge fails

Ensure the DNS A/AAAA record for `DOMAIN` resolves to the host **before** starting Caddy. Caddy retries, but the initial certificate request will fail without a resolvable name.

### Private GHCR image / pull errors

If you pin a private GHCR image, log in first:

```bash
docker login ghcr.io
```

### Migration failure

If the `nestjs` container exits during startup, migrations failed before the API opened port 3000. Inspect logs with `docker compose logs nestjs`. Do not edit `drizzle/` SQL or the journal by hand; fix the generation inputs and regenerate.

### Socket permission errors

If you see Docker daemon unreachable errors, verify the socket path and permissions. Rootless Docker sockets live under `$XDG_RUNTIME_DIR`; set `DOCKER_SOCKET` accordingly.

### Prefetch service

The `minecraft-image` service pulls the `itzg/minecraft-server` image and creates the managed-MC bridge, then exits cleanly. It has `restart: "no"`. If it fails, the `nestjs` service will not start because of the `service_completed_successfully` dependency.

### CORS, secure cookies, and CSRF

Authenticated browser requests use HttpOnly cookies. In production the backend emits `Secure; SameSite=None; Partitioned; Path=/` (CHIPS) for both session cookies; development omits `Secure` and `Partitioned` and uses `SameSite=Lax`. CHIPS is the primary hosted cross-origin mechanism where supported. The PKCE authorization-code fallback is reserved and not implemented, so complete hosted-browser compatibility is not claimed.

`CORS_ORIGIN` must be the one exact frontend origin (for example `https://minepanel.xyz`), must use `https://` in production, and must never be `*`. CORS permits that frontend to read credentialed API responses; it does **not** prevent a malicious site from submitting a cookie-bearing HTML form.

The API therefore rejects every HTTP `POST`, `PUT`, `PATCH`, or `DELETE` request that supplies an `Origin` header other than the canonical `CORS_ORIGIN` (or the API's own origin — same-origin callers such as the Swagger UI at `/docs`), returning `403 {"error":"CsrfOriginForbidden"}`. This protects bodyless form-targetable actions such as session invalidation and server lifecycle operations. Browser requests from the configured frontend must preserve their exact `Origin` header. Origin-less mutating requests remain supported for non-browser automation and CLI clients; do not expose a browser client through a different origin. `OPTIONS` preflights and read-only methods are not subject to this check. Socket.IO/Engine.IO enforces its own matching Origin admission.

### Retained Minecraft data cleanup

Deleting a server is synchronous at the API layer but deliberately retains world data at `$MC_DATA_PATH_HOST/$SERVER_UUID`. Runtime deletion does not remove files. If cleanup is required, use an exact root and UUID; display and verify the target first. This guarded command has no wildcard and warns that deletion is irreversible:

```bash
: "${MC_DATA_PATH_HOST:?Set MC_DATA_PATH_HOST to an absolute host data root}"
: "${SERVER_UUID:?Set SERVER_UUID to the exact server UUID}"
case "$MC_DATA_PATH_HOST" in /*) ;; *) echo "MC_DATA_PATH_HOST must be absolute" >&2; exit 1 ;; esac
if [[ ! "$SERVER_UUID" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-5][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$ ]]; then
  echo "SERVER_UUID must be a UUID" >&2
  exit 1
fi
target="$MC_DATA_PATH_HOST/$SERVER_UUID"
printf 'Deletion target: %s\n' "$target"
printf '%s\n' 'WARNING: this permanently deletes retained Minecraft data and cannot be undone.'
read -r -p 'Type DELETE to continue: ' confirmation
[ "$confirmation" = DELETE ] || { echo "Aborted."; exit 1; }
rm -rf -- "$target"
```

> Never share `docker compose config` output: Compose interpolation renders `DATABASE_URL`, `POSTGRES_PASSWORD`, `JWT_SECRET`, and `ENCRYPTION_KEY` values into the expanded configuration. Redact secrets before posting any config output.
