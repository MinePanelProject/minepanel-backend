# Deployment Guide

## Requirements

- A Linux server with Docker installed
- A domain name with an A record pointing to the server IP
- Ports 80 and 443 open on the firewall

## Quick Start

```bash
git clone https://github.com/your-org/minepanel-backend
cd minepanel-backend
cp .env.example .env
```

Edit `.env` and set:

| Variable | Description |
|----------|-------------|
| `DOMAIN` | Your domain (e.g. `api.yourdomain.com`) |
| `POSTGRES_PASSWORD` | Strong random password for the database |
| `JWT_SECRET` | Long random string for JWT signing |
| `ENCRYPTION_KEY` | Long random string for RCON password encryption |

Then:

```bash
docker compose up -d
```

Caddy automatically provisions an HTTPS certificate via Let's Encrypt. The backend will be available at `https://your-domain`.

> The domain must already resolve to the server IP before running `docker compose up`, otherwise the Let's Encrypt challenge will fail.

## Environment Variables Reference

See `.env.example` for the full list with descriptions and defaults.

Key variables:

| Variable | Default | Notes |
|----------|---------|-------|
| `DOMAIN` | — | **Required.** Caddy uses this for HTTPS and CORS. |
| `POSTGRES_PASSWORD` | — | **Required.** Never use the default in production. |
| `JWT_SECRET` | — | **Required.** Min 32 chars recommended. |
| `ENCRYPTION_KEY` | — | **Required.** Used for RCON password encryption. |
| `REQUIRE_ADMIN_APPROVAL` | `true` | New users start as PENDING until admin approves. |
| `MC_PORT_MIN` / `MC_PORT_MAX` | `25565` / `25665` | Port range for Minecraft server containers. |
| `MIN_FREE_DISK_MB` | `2048` | Minimum free disk required to create a new server. |
| `MAX_MEMORY_RATIO` | `0.90` | Max fraction of host RAM allocatable to MC servers. |

## Reverse Proxy

Caddy is included in `docker-compose.yml` and handles:
- Automatic HTTPS (Let's Encrypt)
- HTTP → HTTPS redirect
- Proxy to the NestJS backend

No additional configuration is needed for basic HTTPS.

### Custom Caddy Configuration

Edit `Caddyfile` before starting. Example with custom headers:

```
your-domain.com {
    reverse_proxy nestjs:3000
    header X-Frame-Options DENY
}
```

### Using nginx or Traefik instead

See SPEC.md (Production Deployment section) for nginx and Traefik examples.
Remove the `caddy` service from `docker-compose.yml` and expose port 3000 directly, then proxy to it from your existing reverse proxy.

## Docker Socket (rootless Docker)

If running rootless Docker, the socket is at `${XDG_RUNTIME_DIR}/docker.sock`.
The compose file handles this automatically via:

```yaml
${XDG_RUNTIME_DIR:-/var/run}/docker.sock:/var/run/docker.sock
```

No manual configuration needed if `XDG_RUNTIME_DIR` is set in your environment.

## Updating

```bash
git pull
docker compose build nestjs
docker compose up -d
```

Database migrations run automatically on startup.

## Logs

```bash
docker compose logs -f nestjs
docker compose logs -f caddy
```
