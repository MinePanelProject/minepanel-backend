# MinePanel — Project Specification

## 1. Document purpose, authority and status legend

This document is the authoritative, internally consistent source of truth for the MinePanel project: product vision, implemented behavior, accepted architecture, accepted implementation backlog, future proposals and open decisions. When this specification disagrees with any other repository document, this specification wins; when it disagrees with the code, the code is the immediate truth and the discrepancy is recorded here as a correction or backlog item.

Every feature statement below carries one of these status markers:

| Marker | Meaning |
|--------|---------|
| `[IMPLEMENTED]` | Verified in the current code, schema, migrations and tests at the commit named in §2. |
| `[ACCEPTED]` | Approved target behavior or architecture that is not yet implemented; tracked in the backlog (§16). |
| `[PROPOSED]` | Future design that still requires validation or a product/architecture decision; phase-marked (§17). |
| `[CONTRADICTED]` | A previous specification or configuration claim disproved by current code; the observed current behavior is documented with its correction/backlog item. |
| `[DECISION REQUIRED]` | An unresolved choice that materially affects security, compatibility, product behavior or deployment. Silently picking one is forbidden; see the decision register (§19). |

Normative language, defined once and used consistently:

- **MUST** — a required invariant or contract; violating it is a defect or a security hole.
- **SHOULD** — a strong recommendation; a valid exception must be justified in the code or docs.
- **MAY** — optional behavior; no default obligation either way.

## 2. Current release status and last verified implementation commit

- **Status: release candidate, not "production-ready".** The Phase 1 scope is implemented and CI-green, but the open decisions in §19 and the P0/P1 backlog in §16 must be resolved before the project can honestly be called production-ready.
- **Last verified implementation commit:** `7b542f3` — `feat: add per-server authorization spine` (master, 2026-08-13). All behavior claims in this document were verified against this HEAD by code inspection and the CI runs listed in §14.
- **Version truth:** `package.json` says `1.0.0`; `PANEL_VERSION` defaults to `"1.0"`; the Swagger fallback is `"N/A"`; CI pins `1.0.0`. This inconsistency is tracked as backlog item B-P2-6.
- **License:** `package.json` declares `"license": "UNLICENSED"` and `"private": true`; there is **no** LICENSE file and the project must not be described as open-source. Picking a license is owner decision D-11.

## 3. Product scope and supported clients

MinePanel is a self-hosted Minecraft server management panel. A single `docker compose up` on the operator's own host brings up the backend, PostgreSQL, Caddy (HTTPS) and the Minecraft container runtime. The backend manages PostgreSQL for state, controls Minecraft server containers through the Docker socket, and exposes a REST + WebSocket API.

**Clients — implemented vs planned:**

| Client | Repo | Tech | Status |
|--------|------|------|--------|
| Web dashboard (hosted PWA) | `minepanel-pwa` | React 19 + Vite 7 + TypeScript + Tailwind 4 | `[ACCEPTED]` — separate repository planned; repository not created yet; hosted at `app.minepanel.xyz`; not part of this backend's compose file |
| Mobile app | `minepanel-mobile` | KMP + Compose Multiplatform (iOS + Android) | `[PROPOSED]` — Phase 6 |
| Backend API | `minepanel-backend` (this repo) | NestJS 11 + PostgreSQL | `[IMPLEMENTED]` |

The backend is client-agnostic. Role-based guards (`ADMIN` / `MOD` / `USER`) plus per-server access rules and MOD granular permissions enforce access at the API level.

**Hosted multi-backend dashboard (`app.minepanel.xyz`)** — `[PROPOSED]` and `[DECISION REQUIRED]`: the current product vision is a centrally hosted web dashboard (`minepanel-pwa` — a static React SPA / installable PWA, distinct from the `minepanel-site` marketing website at `minepanel.xyz`) that connects to arbitrary self-hosted backends using cross-origin HttpOnly cookies. Section 8.5 analyses why `SameSite=None; Secure` alone cannot deliver this across the modern browser matrix and requires owner decision D-1. Until then the supported deployment model is same-origin (frontend served from the same domain as the backend, or a dev frontend on `localhost:5173` with `CORS_ORIGIN` set).

Direct browser access from `https://app.minepanel.xyz` to LAN/private-network instances (RFC1918 addresses, `.local` hostnames, or other browser-untrusted origins) is **not automatically guaranteed** by the generic HTTPS multi-backend architecture: browsers apply stricter mixed-content and certificate rules to such origins. The intended hosted path is browser-trusted public HTTPS backend origins; private-network endpoints are a separate compatibility concern requiring validation.

**Key design decisions (accepted):**

- **Self-hosted first**: backend + database + MC servers run on the operator's machine. External calls are optional (Discord webhooks, Mojang UUID API, Hangar/Modrinth metadata in future phases).
- **No external queue or cache**: PostgreSQL is the only stateful dependency. No Redis, no BullMQ, no CDN.
- **Not admin-only**: regular players have a dedicated portal surface in the roadmap (access requests, player profile, notifications — Phase 6).
- **`[ACCEPTED]`** the backend data mount is **read-only**; every future write feature (backups, file manager, plugins) must route through the write architecture decided in §10.4 (owner decision D-8).

**Development phases (canonical numbering — used consistently everywhere):**

- **Phase 1 — Foundation (v1.0 RC):** auth (JWT cookies, sessions, password change, 2FA, temp-password recovery), rate limiting, server lifecycle, Docker service, health, host metrics over WebSocket, admin user management, server access control (per-server authorization spine), Docker deployment. `[IMPLEMENTED]`.
- **Phase 1.5 — Access Control + OAuth:** Google/GitHub OAuth, magic links (SMTP optional), invitation flows, MOD permission dashboard refinement. `[PROPOSED]`.
- **Phase 2 — Developer platform:** audit log, API keys, outbound webhooks, system events, historical metrics. `[PROPOSED]`.
- **Phase 3 — Operations:** WebSocket real-time server events, console, backups, scheduled tasks, notifications, file manager, player management, plugin management. `[PROPOSED]`.
- **Phase 4 — Creation wizard & presets:** preset-driven server creation, mod picker, template clone. `[PROPOSED]`.
- **Phase 5 — Networking:** Velocity proxy, Bedrock support. `[PROPOSED]`.
- **Phase 6 — Mobile app & player portal.** `[PROPOSED]`.

## 4. Deployment topology and trust boundaries

### 4.1 Compose topology `[IMPLEMENTED]`

```text
Operator runs: docker compose up -d

┌──────────────────────────────────────────────────────────────┐
│                       Docker Host                            │
│                                                              │
│  ┌───────────────┐    app network (minepanel-app-network)    │
│  │ caddy         │──80/443 (only published ports)──► Internet│
│  │ (TLS, HTTPS)  │                                           │
│  └───────┬───────┘                                           │
│          │ reverse_proxy nestjs:3000                         │
│  ┌───────▼───────┐                                           │
│  │ minepanel-    │ expose 3000 (no host port); user: root;   │
│  │ nestjs        │ no-new-privileges; :ro data mount;        │
│  │ (Bun runtime) │ docker socket mounted; NOT on mc network  │
│  └──┬──────┬─────┘                                           │
│     │      │                                                 │
│     │      └── Docker socket: DOCKER_SOCKET → /var/run/      │
│     │          docker.sock (rootful default; rootless via    │
│     │          DOCKER_SOCKET override — see §10.2)           │
│     ▼                                                        │
│  ┌───────────────┐   app network                             │
│  │ postgres:16   │   (no published ports)                    │
│  └───────────────┘                                           │
│                                                              │
│  ┌───────────────────────────────────────────────────────────┐│
│  │ mc network (minepanel_network / DOCKER_NETWORK)           ││
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐           ││
│  │  │ mc-{id}-1  │  │ mc-{id}-2  │  │ mc-{id}-N  │           ││
│  │  │ itzg image │  │ port 2556x │  │ :/data bind│           ││
│  │  └────────────┘  └────────────┘  └────────────┘           ││
│  └───────────────────────────────────────────────────────────┘│
│  (created by the backend via the Docker socket — the backend  │
│   itself has no mc-network membership; RCON uses docker exec)  │
└──────────────────────────────────────────────────────────────┘
```

Compose services (`docker-compose.yml`):

| Service | Image | Notes |
|---------|-------|-------|
| `nestjs` | `$MINEPANEL_IMAGE` (default `ghcr.io/minepanelproject/minepanel-backend:latest`) | `expose: 3000` only; `user: root`; `security_opt: no-new-privileges`; healthcheck `curl /health`; depends on healthy postgres and completed `minecraft-image` prefetch |
| `postgres` | `postgres:16-alpine` | volume `postgres-data`; healthcheck `pg_isready`; no published ports |
| `caddy` | `caddy:2-alpine` | publishes 80/443 (+443/udp); auto-HTTPS from `$DOMAIN`; proxies to `nestjs:3000`; serves `./Caddyfile` |
| `minecraft-image` | `itzg/minecraft-server:latest` | one-shot prefetch (`entrypoint: ["/bin/true"]`) so the first server create does not stall on a pull |

### 4.2 Trust boundaries `[IMPLEMENTED]` — MUST be preserved

1. **Internet ↔ Caddy.** TLS termination and the only published ports (80/443). The backend is never published; `postgres` publishes nothing. Publishing backend port 3000 directly breaks the `trust proxy = 1` assumption (`main.ts`) — `X-Forwarded-For` becomes spoofable, which defeats per-IP throttling and the CSRF same-origin check. Deployment docs MUST forbid it (§13).
2. **Caddy ↔ backend.** Plaintext HTTP on the `app` bridge; single-host assumption; backend sets `trust proxy = 1` (`main.ts`).
3. **Backend ↔ postgres.** Password auth, no TLS, app-network only — acceptable single-host.
4. **Backend ↔ Docker daemon (crown jewels).** The mounted socket gives the backend root-equivalent capability on the host. The container-creation guardrails (§10.3) are normative defense-in-depth. `DOCKER_SOCKET` is a local Unix socket path only — `tcp://` endpoints are rejected at production preflight (`main.ts`).
5. **MC containers.** Untrusted, modded game code. They run unprivileged, memory-capped, with no added Linux capabilities, on a bridge network. Known gap (backlog B-P2-4): the `mc` bridge allows unrestricted container-to-container traffic; per-server networks are `[PROPOSED]`.
6. **Data volume.** Host directory owned via daemon binds; itzg entrypoint chowns to its runtime user at container start; the backend reads it `:ro`.

### 4.3 Hardening backlog `[ACCEPTED]`

- B-P1-10: add `NanoCpus` CPU quota and `PidsLimit` to MC container `HostConfig` (one MC server can currently starve the backend/postgres; fork-bomb surface).
- B-P2-4: document/restrict inter-container traffic on the `mc` network; per-server networks `[PROPOSED]`.
- B-P2-5: run the backend as a non-root user with `group_add` for the docker group instead of `user: root`.
- B-P2-6: `cap_drop: [ALL]` + `read_only: true` + `tmpfs: /tmp` for the backend container.
- B-P2-7: pin the itzg image (digest or explicit tag) in compose and record the resolved digest per server.

## 5. Accepted architectural invariants

These invariants are non-negotiable; future work MUST preserve them.

1. **Single authoritative schema.** All tables and enums live in `src/db/schema.ts`; migrations are generated from it and MUST stay in sync (§6).
2. **Access and refresh session tokens only in HttpOnly cookies for web clients.** `PublicUser` responses carry no session tokens. The 2FA `pre-auth` challenge is the narrow exception: it is a five-minute response-body Bearer credential that MUST authorize only `POST /api/auth/2fa/verify`. Any future bearer/ticket mechanism (§8.5, §8.6) MUST preserve the cookie-only session-token path.
3. **Refresh tokens are server-revocable and rotated.** Rotation MUST become atomic (see §8.3); replay of a consumed token MUST yield 401.
4. **Lifecycle transitions are compare-and-swap on status.** Every server state change runs through a CAS update; concurrent conflicting operations fail with 409 (§11.2).
5. **Resource admission has operation-specific ordering.** Create and start admission occurs before their state mutation. Restart performs its graceful stop first, then admission; a 422 admission failure leaves the target STOPPED (§11.4).
6. **Docker unavailability degrades without silent state claims.** Read paths keep working; initial daemon failures return 503. A lifecycle operation whose daemon outcome is uncertain MAY settle its own row as `ERROR` (§10.5, §11.1).
7. **Setup creates exactly one administrator** — the secure bootstrap invariant (§8.1) — under any concurrency and failure pattern.
8. **The backend data mount stays read-only** until the write architecture decision (D-8) lands (§10.4).
9. **At least one active ADMIN always exists** (advisory-lock serialized last-admin guard, §8.7).
10. **Fail closed** on authorization/DB uncertainty: guards reject when the database cannot confirm status/role/permission (§8.4).

---

## 6. Current data model

### 6.1 Tables `[IMPLEMENTED]`

Six tables, all defined in `src/db/schema.ts`; migrations `0000`–`0003` in `drizzle/` cumulatively match the schema exactly (no drift). Primary keys are `text` UUIDs generated by `crypto.randomUUID()` — not cuid.

**`users`**

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | text | PK, UUID |
| `email` | varchar(254) | not null, unique (case-sensitive) |
| `username` | varchar(32) | not null, unique (case-sensitive) |
| `passwordHash` | text | **not null** (OAuth-only accounts are a Phase 1.5 schema change; see §17.1) |
| `role` | enum `ADMIN`\|`MOD`\|`USER` | default `USER` |
| `status` | enum `ACTIVE`\|`PENDING`\|`BANNED` | default `ACTIVE` |
| `totpSecret` | text | null; AES-256-GCM encrypted |
| `totpEnabled` | boolean | default false |
| `totpBackupCodes` | text | null; JSON array of bcrypt-hashed backup codes |
| `tempPasswordHash` | text | null; admin-generated recovery credential |
| `tempPasswordExpiresAt` | timestamptz | null |
| `mustChangePassword` | boolean | default false |
| `minecraftUUID` | text | unique, null — column exists, **no code path writes it today** |
| `minecraftName` | text | null — column exists, no code path writes it today |
| `createdAt` / `updatedAt` | timestamptz | default now; updatedAt auto-updates |

**`refresh_tokens`**

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | text | PK, UUID |
| `token` | text | not null, unique — the **bcrypt hash** of the refresh JWT |
| `userId` | text | not null, FK → users, `onDelete: cascade` |
| `expiresAt` | timestamptz | not null |
| `createdAt` | timestamptz | default now |

> There are **no** `userAgent` / `lastUsedAt` columns; the old SPEC claimed both. Session metadata is an accepted backlog item (§8.3). No index exists on `userId` or `expiresAt` (backlog B-P1-3).

**`setup_state`** — singleton row (`id = 'singleton'`): `initialAdminCreated` boolean, `createdAt`, `updatedAt`.

**`servers`**

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | text | PK, UUID |
| `name` | text | not null |
| `provider` | enum `VANILLA`\|`PAPER`\|`PURPUR`\|`FABRIC`\|`FORGE` | not null |
| `version` | text | not null |
| `port` | integer | not null, unique |
| `containerId` | text | unique, null until provisioned |
| `status` | enum `STOPPED`\|`CREATING`\|`STARTING`\|`RUNNING`\|`STOPPING`\|`ERROR` | default `STOPPED` |
| `maxPlayers` | integer | default 20 |
| `difficulty` | enum `PEACEFUL`\|`EASY`\|`NORMAL`\|`HARD` | default `NORMAL` |
| `gamemode` | enum `SURVIVAL`\|`CREATIVE`\|`ADVENTURE`\|`SPECTATOR` | default `SURVIVAL` |
| `pvp` | boolean | default true |
| `memoryLimitMb` | integer | default 2048 |
| `motd` | text | null |
| `levelSeed` | text | null |
| `onlineMode` | boolean | default true |
| `viewDistance` | integer | default 10 |
| `allowFlight` | boolean | default false |
| `worldPath` | text | null — unused by code |
| `rconPassword` | text | null — **column exists but is not written** (backlog B-P1-11) |
| `ownerId` | text | not null, FK → users (creator) |
| `accessType` | enum `OPEN`\|`REQUEST`\|`PRIVATE` | default `OPEN` |
| `createdAt` / `updatedAt` | timestamptz | |

> No `pendingDeleteAt` column exists (the old SPEC's deletion design was never built; §11.6) and no `discordWebhook` column exists (Phase 3 notification feature).

**`server_access`** — join table: `userId` FK cascade, `serverId` FK cascade, `status` enum `PENDING`\|`APPROVED`, `createdAt`, `approvedAt`. Constraints: unique `(userId, serverId)`; CHECK `(status = 'PENDING' AND approvedAt IS NULL) OR (status = 'APPROVED' AND approvedAt IS NOT NULL)`; indexes on `(serverId, status, createdAt, id)` and `(userId, serverId)`. There is no `DENIED` status — rejection is represented by deleting the row.

**`mod_permissions`** — `userId` FK cascade, `permission` enum (`SERVER_LIFECYCLE`, `SERVER_CONFIG`, `PLUGIN_MANAGEMENT`, `WHITELIST_MANAGEMENT`, `USER_MANAGEMENT`, `FILE_MANAGER`), `serverId` nullable FK cascade, `createdAt`. Partial unique index on `(userId, permission)` where `serverId IS NULL`; unique on `(userId, permission, serverId)`; index on `(userId, permission, serverId)`.

### 6.2 Tables that do NOT exist yet `[ACCEPTED]/[PROPOSED]`

The old SPEC listed these as current models. They are future work, defined in §17: `Ban`, `MagicLinkToken`, `ApiKey`, `Webhook`, `SystemEvent`, `AuditLog`, `MetricSnapshot`, `Backup`, `ScheduledTask`, `Notification`, `ServerPlugin`, `ServerMod`, `ServerProxy`. `users.googleId`, `users.githubId`, `users.minecraftVerified`, `servers.discordWebhook` are future columns. `users.passwordHash` MUST become nullable for Phase 1.5 OAuth (§17.1).

### 6.3 Enums

`role`, `user_status`, `server_provider`, `server_status`, `server_difficulty`, `server_gamemode`, `access_type`, `server_access_status`, `mod_permission` — exact values in §6.1.

---

## 7. Current HTTP and WebSocket API

Global prefix `api` (except `/health`); Swagger UI at `/docs` (public — backlog B-P3-3 to gate it). All routes below are `[IMPLEMENTED]`; `[PROPOSED]` endpoints live in §17 and are never mixed into these tables.

### 7.1 Public

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness: `{ status: 'ok'\|'degraded', db, docker, version }`; 503 when degraded. Uses `SELECT 1` + `docker.ping()`. |
| GET | `/api/info` | `{ name, version }` from `PANEL_NAME` / `PANEL_VERSION` (frontend instance listing) |
| GET | `/docs` | Swagger UI (public in current builds) |

**Capability discovery `[ACCEPTED]` — backlog B-P2-11:** the hosted `minepanel-pwa` must determine backend capabilities without relying on arbitrary version comparisons. `GET /api/info` (or its future replacement) SHOULD eventually expose explicit protocol/capability information — API compatibility, partitioned-cookie (CHIPS) auth support, PKCE authorization-code fallback support, and WebSocket-ticket support. The response shape is not defined yet and nothing is implemented today.

### 7.2 Setup

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/setup/status` | Public | `{ initialAdminCreated, nextStep: 'register_admin'\|'complete' }` |
| POST | `/api/setup/init` | Public | Create first admin; 403 `First admin already created` once complete. **Race-unsafe today — see §8.1 (P0)**. No route throttle today (backlog with §8.1). |

### 7.3 Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | Public, throttle 5/10s | 201 `{ message }`; PENDING if `REQUIRE_ADMIN_APPROVAL=true`, else ACTIVE; 409 `User already exists` |
| POST | `/api/auth/login` | Public, throttle 5/10s | 200 `PublicUser` + cookies, or `{ requiresTwoFactor, preAuthToken }`; 401 `Wrong credentials` (timing-equalized); 403 `AccountPending`/`AccountBanned` |
| POST | `/api/auth/refresh` | Public, throttle 5/10s | Rotates refresh token, sets new cookies. **Missing/malformed/expired refresh currently → 500 (bug, B-P1-2)** |
| POST | `/api/auth/logout` | JWT | Revokes the presented refresh row, clears cookies |
| POST | `/api/auth/logout-all` | JWT | Revokes all refresh rows, clears cookies |
| GET | `/api/auth/profile` | JWT | Current user (`req.user` shape) |
| PATCH | `/api/auth/profile` | JWT | Update **username only** (email is not editable through any endpoint today); 400 `No changes` when identical |
| PATCH | `/api/auth/password` | JWT | Change password; requires `currentPassword`; keeps current session, revokes others (normal flow) or all (forced recovery flow) |
| GET | `/api/auth/sessions` | JWT | List refresh-token rows (id, userId, expiresAt, createdAt) — currently **includes expired rows** (B-P1-3) |
| DELETE | `/api/auth/sessions/:id` | JWT | Revoke own session; silently succeeds for missing rows |
| POST | `/api/auth/2fa/setup` | JWT | Returns `{ secret, uri }`; secret encrypted at rest |
| POST | `/api/auth/2fa/confirm` | JWT | Verifies first code, enables 2FA, returns 8 single-use backup codes |
| POST | `/api/auth/2fa/verify` | Pre-auth Bearer, throttle 5/600s | Completes 2FA login, sets cookies |
| DELETE | `/api/auth/2fa/disable` | JWT | Requires valid TOTP or backup code |

### 7.4 Admin (user management lives here — there is no `/users` controller)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/admin/users` | ADMIN | List, filter by `status`/`role` |
| PATCH | `/api/admin/users/:id/status` | ADMIN | Approve/ban/unban; last-active-admin guard; **ban deletes all refresh sessions** |
| PATCH | `/api/admin/users/:id/role` | ADMIN | Change role; last-active-admin guard; clears mod permissions |
| POST | `/api/admin/users/:id/reset-password` | ADMIN | Returns one-time `{ tempPassword }` (16 chars base64url, 24h TTL, forces change, revokes all sessions) |
| DELETE | `/api/admin/users/:id/2fa` | ADMIN | Emergency 2FA removal |
| GET | `/api/admin/users/:id/permissions` | ADMIN | List MOD permission grants |
| POST | `/api/admin/users/:id/permissions` | ADMIN | Grant (global or per-server); 409 on duplicate |
| DELETE | `/api/admin/users/:id/permissions/:permId` | ADMIN | Revoke; 404 if missing |

### 7.5 Servers

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/servers` | ADMIN | **Create and start** in one operation; 201; resource checks 422; rolls back on Docker failure |
| GET | `/api/servers` | JWT | List visible servers; `?limit&offset` (default 20, max 100); `{ data, total }` |
| GET | `/api/servers/:id` | JWT | Get visible server; 404 for non-visible |
| POST | `/api/servers/:id/start` | ADMIN \| MOD + `SERVER_LIFECYCLE` | 409 unless STOPPED; container must exist |
| POST | `/api/servers/:id/stop` | ADMIN \| MOD + `SERVER_LIFECYCLE` | Graceful stop (RCON warn → save-all → docker stop) |
| POST | `/api/servers/:id/restart` | ADMIN \| MOD + `SERVER_LIFECYCLE` | Stop sequence then start sequence |
| DELETE | `/api/servers/:id` | ADMIN | Returns **202 but is fully synchronous**: removes container and DB row; **data directory is retained on the host** (§11.6) |

### 7.6 Server access

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/servers/:id/request-access` | JWT | REQUEST servers: create PENDING row (201); OPEN → 409; PRIVATE → 404 (non-disclosure); ADMIN → 409 |
| GET | `/api/servers/:id/my-access-request` | JWT | Own row (`{ status, requestedAt, approvedAt }`); 404 for OPEN/PRIVATE/none |
| GET | `/api/servers/:id/access-requests` | ADMIN | Pending requests for REQUEST servers |
| POST | `/api/servers/:id/access-requests/:userId/approve` | ADMIN | PENDING → APPROVED, or direct APPROVED insert (PRIVATE/REQUEST); ADMIN target → 400 |
| DELETE | `/api/servers/:id/access-requests/:userId` | ADMIN | Reject or revoke (row deleted; no DENIED status) |

### 7.7 WebSocket `[IMPLEMENTED — minimal]`

- Default namespace (`/`), socket.io v4, CORS locked to the canonical origin (adapter `allowRequest`: handshakes carrying an Origin must match exactly; header size limits).
- **Auth:** `access_token` cookie in the handshake, or one `auth` event `{ accessToken }` within 5 seconds; otherwise silent disconnect. Reservation cap 100 pending connections.
- **Eligibility:** ADMIN only, excluding temporary-auth sessions (`mustChangePassword`).
- **Events:** one event today — `system.stats` `{ totalRamMb, usedRamMb, freeDiskMb, cpuCount }` every 10s (volatile, cached ≤10s), token re-validated each tick. `usedRamMb = hostTotal − containerFree` (container cgroup free memory; documented caveat, B-P2-8).
- **Contradiction to fix:** JS cannot read the HttpOnly access token, so the `auth`-event fallback is unusable by browsers; and the adapter rejects cookie-carrying handshakes without an Origin (mobile clients). Accepted fix: one-time WS ticket (B-P1-4, §8.6). The richer event set in the old SPEC (server.status/log/console, subscribe) is `[PROPOSED]` Phase 3 (§17.3).

---

## 8. Authentication and session security

### 8.1 First-run setup invariant `[DECISION REQUIRED: D-2]` — P0

Current `POST /api/setup/init` (`setup.service.ts`) is read-then-write: check `initialAdminCreated` → hash → insert admin → mark created. There is **no transaction, no advisory lock, no compare-and-swap, no setup secret, no route throttle**. Two provable failure modes:

1. Concurrent requests both pass the check → **two administrators created**.
2. User insert succeeds but the mark step fails → setup reports incomplete while an admin exists; anyone can create another.

Between Caddy certificate issuance and the operator's first visit, the endpoint is Internet-reachable — a scanner can claim a fresh instance.

**Accepted design (pending owner confirmation of the token UX):**

- `[ACCEPTED]` One transaction under `pg_advisory_xact_lock(7330)`: re-read `setup_state` → if `initialAdminCreated` → 409 `SetupAlreadyComplete` → insert admin → set flag → commit.
- `[ACCEPTED]` A one-time setup secret: `SETUP_TOKEN` env if set; otherwise 24 random bytes (base64url) generated per boot **until setup completes** and printed once to the container log (`docker compose logs nestjs`). Compared timing-safe (SHA-256).
- `[ACCEPTED]` Throttle `/api/setup/init` 5/10 min per IP.
- **D-2:** token mandatory vs optional — recommendation: **mandatory**. Without it, first-boot claim remains possible; with it, only someone who can read the operator's logs can bootstrap.

The old SPEC text ("only works once") MUST be read as "once, sequentially, today" — not a secure invariant.

### 8.2 Cookies and tokens `[IMPLEMENTED]`

- Cookie names: `access_token` (15 min TTL), `refresh_token` (7 days). Both `HttpOnly`; `secure` only when `NODE_ENV=production`; `sameSite: 'none'` in production, `'lax'` in development. The controller omits `path`, but Express emits `Path=/` by default; B-P2-6 makes that intent explicit and evaluates the `__Host-` prefix in production.
- Access JWT: `{ sub, type: 'access', username, role, temporaryAuth? }` — TTL from `JWT_EXPIRES_IN` via `JwtModule` `signOptions`.
- Refresh JWT: `{ sub, type: 'refresh', temporaryAuth? }` — **hardcoded `7d`**; `JWT_REFRESH_EXPIRES_IN` is declared but never read (B-P1-5: consume it or delete it). Stored **bcrypt-hashed** in `refresh_tokens`.
- `type` claims pin token purpose: only `type: 'refresh'` may rotate; only `type: 'access'` passes the JWT guard; `pre-auth` is a five-minute response-body Bearer token restricted to `POST /api/auth/2fa/verify`.
- Login and refresh return `PublicUser` plus session cookies. A 2FA-required login instead returns `{ requiresTwoFactor: true, preAuthToken }` without setting session cookies; the browser-visible pre-auth exception is scoped in §5.2. This is why the WS `auth`-event fallback remains dead for browsers (§7.7).

### 8.3 Refresh rotation contract `[ACCEPTED]` — P1

Current implementation rotates on **every** refresh (no 24h sliding rule — the old SPEC and `docs/auth-architecture.md` are wrong on this), but consumption is **delete-then-insert without a transaction**: two concurrent refreshes with the same token can both mint successors → two live sessions from one token. Replay of an already-rotated token does 401. Missing/malformed/expired refresh → **500** `Internal server error` (JWT errors fall through the exception filter catch-all; B-P1-2).

**Accepted contract (backlog B-P1-1):**

- Atomic rotation in one transaction: `SELECT … FOR UPDATE` → bcrypt-compare → `DELETE` → `INSERT` successor → commit; the losing concurrent request sees no row and gets 401.
- Add the refresh row id as `jti` so lookup is O(1) instead of the current O(n) bcrypt fan-out over all the user's tokens (a self-DoS amplifier under the 5/10s throttle).
- All refresh failures → **401** with a stable machine code: `RefreshTokenMissing` (no cookie), `RefreshTokenMalformed`, `RefreshTokenExpired`, `TokenWrongPurpose`, `RefreshTokenInvalid`. Never 500.
- Expiry synchronization: consume `JWT_REFRESH_EXPIRES_IN` once at boot and derive JWT `expiresIn`, DB `expiresAt` and cookie `maxAge` from it; remove the hardcoded `7d` literals.
- Cleanup: lazy per-user sweep inside the rotation transaction + a daily in-process sweep of expired rows (no scheduler dependency exists yet — see §16 B-P1-6 for the `@nestjs/schedule` decision).
- `GET /sessions` MUST filter `expiresAt > now()`. `lastUsedAt`/`userAgent` columns are `[ACCEPTED]`.
- Indexes: `refresh_tokens(user_id)` and `refresh_tokens(expires_at)` (B-P1-3).
- Frontend MUST single-flight `/auth/refresh` (two racing tabs ⇒ one tab's cookie is dead by design under strict rotation).
- Theft detection (revoke a whole token family on reuse) is `[PROPOSED]`, not built.

### 8.4 Guard pipeline `[IMPLEMENTED]`

Global order in `app.module.ts`:

1. `CsrfOriginGuard` — mutating requests carrying an `Origin` header must match the canonical `CORS_ORIGIN` (or the API's own origin, e.g. Swagger); mismatch/`null`/repeated → 403 `{ error: 'CsrfOriginForbidden' }`. No-Origin requests (curl/CI) pass. Socket.IO is intercepted by the adapter before Nest routing.
2. `JwtAuthGuard` — reads `access_token` cookie; `@Public()` bypasses. Verifies via `AccessTokenService` (JWT verify + DB-fresh `status`/`role`/`mustChangePassword`; **fails closed** on DB error; PENDING → 403 `AccountPending`, BANNED → 403 `AccountBanned`). Forced-recovery sessions are allowed only on `PATCH /api/auth/password`, else 403 `PasswordChangeRequired`.
3. `RolesGuard` — `@Roles('ADMIN', …)`; ADMIN always passes; route without roles passes.
4. `PermissionsGuard` — `@RequiresPermission('SERVER_LIFECYCLE')`; ADMIN passes; MOD must have a `mod_permissions` row (global `serverId IS NULL` or scoped to `:id`); fails closed 503 `Permission check unavailable` on DB error.
5. `ThrottlerGuard` — see §13.

Known nuance (B-P3-4): a MOD with a global `SERVER_LIFECYCLE` grant can pass the guard but still get 404 on a PRIVATE server without an approved `server_access` row (visibility is separate from action permission).

### 8.5 Hosted-frontend cross-origin authentication `[DECISION REQUIRED: D-1]` — blocker for the hosted frontend

The current vision: the hosted dashboard (`minepanel-pwa`) at `app.minepanel.xyz` connects to arbitrary self-hosted backends using cross-origin HttpOnly cookies with `SameSite=None; Secure` + strict CORS.

**Primary-source reality (2026):** `SameSite=None; Secure` is *necessary but not sufficient*. Safari's ITP blocks third-party cookies by default; Chrome retains user-choice blocking (no blanket removal, but availability is not guaranteed); Firefox Strict ETP blocks them. The cross-browser migration path is **CHIPS** (`Partitioned`): Baseline since December 2025 — Chrome 114+, Firefox 131+, Safari 18.4+ — set as `SameSite=None; Secure; Partitioned`. Partitioned cookies are scoped per top-level site, which is acceptable in this model (the only embedder is `app.minepanel.xyz`), but pre-CHIPS browsers (e.g. Safari < 18.4) simply cannot store the cookie.

**Options:**

| Option | Trade-offs |
|--------|------------|
| (a) Serve the frontend from each backend's own origin | Same-origin cookies — simplest and most robust; kills the hosted multi-backend `app.minepanel.xyz` model |
| (b) CHIPS `Partitioned` HttpOnly cookies | Works under third-party-cookie blocking on Baseline browsers; explicit support matrix; pre-CHIPS Safari broken |
| (c) PKCE authorization-code fallback with memory-only bearer access token | Top-level redirect to the backend makes it first-party for issuance (PKCE + one-time code, ≤60s) → short-lived bearer token in JS memory (never localStorage). Works everywhere; moves a credential into JS reach (XSS) — mitigated with 15m access tokens, rotation-on-exchange, strict CSP |
| (d) Same-origin auth bridge/proxy | Proxy hop per backend; no security gain over (c) |

**Recommendation (D-1): (b) as primary with (c) as documented fallback.** The old SPEC's claim that `SameSite=None; Secure` "is the only option for HttpOnly cookies cross-origin" (Italian CSRF note included) MUST be removed. This decision is a **release blocker for the hosted frontend**; the same-origin deployment remains fully supported meanwhile. References: §20.

### 8.6 WebSocket authentication `[ACCEPTED]` — P1

Accepted design: `POST /api/realtime/ticket` (authenticated, throttled) → single-use ticket, 60s TTL, server-bound to `{userId, role, exp}`, consumed atomically on connect; the gateway keeps its per-tick user re-validation. The cookie handshake remains the fast path. This resolves the current contradiction (§7.7) for browsers (which cannot read the HttpOnly access token) and for mobile clients (which send no Origin). Whether cookie or ticket is *primary* follows D-1.

### 8.7 Admin safety `[IMPLEMENTED]`

`pg_advisory_xact_lock(7331)` serializes role/status transitions; deactivating or demoting the last active ADMIN → 409 `Cannot deactivate the last active admin`. Banning deletes all refresh sessions (the old SPEC claimed tokens are kept on ban — **false**; unban requires re-login). Role change clears all `mod_permissions` rows. Admin password reset: 16-char base64url temp password, 24h TTL, `mustChangePassword=true`, revokes all sessions, returned plaintext once.

### 8.8 Identity normalization `[IMPLEMENTED]` — known defect B-P1-7

- Registration: email is trimmed+lowercased; **username is trimmed but case-preserved**; uniqueness is case-sensitive (Postgres default) — `Bob` and `bob` are two accounts.
- Login: the identifier is trimmed+**lowercased** and matched exactly against email OR username.
- Consequence: a username containing any uppercase letter **cannot be used to log in by username** (the lowercased identifier never matches the stored casing); email login still works. Documented defect; accepted fix = normalize at registration (lowercase) or case-insensitive lookup — owner decision folded into D-10.

### 8.9 Two-factor authentication `[IMPLEMENTED]`

TOTP (RFC 6238, `otplib`), ±30s window; secret AES-256-GCM encrypted with `ENCRYPTION_KEY`. Login with 2FA returns a 5-minute `pre-auth` Bearer token (`{ type: 'pre-auth', sub }`; temporary-recovery variants carry a SHA-256 fingerprint of the temp hash); `2fa/verify` consumes it. In-memory per-user lockout: 5 failures per 10 min → 15 min 429 (lost on restart — accepted, single-instance; B-P3-5). Backup codes: 8 × `8hex-8hex`, bcrypt-hashed, JSON-array stored, single-use via atomic CAS on the stored array. Admin emergency disable clears secret+enabled+backup codes in one update.

---

## 9. Authorization and server access

### 9.1 Roles `[IMPLEMENTED]`

`ADMIN` bypasses role and permission checks. `MOD` needs explicit `mod_permissions` grants for privileged actions. `USER` is a panel account without moderation powers. Roles are read from the DB on every request (never trusted from the token alone).

### 9.2 Server visibility `[IMPLEMENTED]`

A server row is visible to a caller when: caller is ADMIN (any non-`CREATING` row), or `accessType = 'OPEN'`, or an `APPROVED` `server_access` row exists for the caller. Non-visible servers are indistinguishable from missing (404 — no disclosure). `ownerId` records the creator but confers **no** special visibility; there is no owner concept in the access model.

### 9.3 Access flows `[IMPLEMENTED]`

- `OPEN`: visible to all authenticated users; no row needed.
- `REQUEST`: user POSTs `request-access` → `PENDING` row; ADMIN approves → `APPROVED`. Duplicate PENDING/APPROVED → 409; race-safe via unique constraint + on-conflict + bounded retry.
- `PRIVATE`: no request flow; ADMIN assigns directly (approve endpoint inserts an `APPROVED` row). Users see 404.
- Revocation deletes the row (no `DENIED` status).

### 9.4 MOD granular permissions (PBAC) `[IMPLEMENTED]`

Six permission values (`SERVER_LIFECYCLE`, `SERVER_CONFIG`, `PLUGIN_MANAGEMENT`, `WHITELIST_MANAGEMENT`, `USER_MANAGEMENT`, `FILE_MANAGER`). Grants are global (`serverId IS NULL`, partial-unique) or per-server. Enforcement: `PermissionsGuard` on `@RequiresPermission` routes — today `SERVER_LIFECYCLE` on start/stop/restart. `SERVER_CONFIG`/`PLUGIN_MANAGEMENT`/etc. become live as their Phase 3 endpoints land (§17).

---

## 10. Docker and filesystem architecture

### 10.1 Docker module `[IMPLEMENTED]`

`DockerModule` builds a Dockerode client over a **local Unix socket only**: `DOCKER_SOCKET` (default `/var/run/docker.sock` inside the container), with the ambient `DOCKER_HOST` env suppressed. If the daemon is unreachable at startup the module logs and continues in degraded mode (health reports 503, Docker operations throw 503) — startup never fails because Docker is down.

### 10.2 Data-path contract `[ACCEPTED]` — "one physical data root, two views"

| Variable | View | Read by | Purpose |
|----------|------|---------|---------|
| `MC_DATA_PATH_HOST` | Host filesystem | compose | The real host directory (wizards default `$HOME/.minepanel/mc-data`). Compose passes it to `MC_DATA_BIND_SOURCE` and binds it into the backend at `/mc-data` **read-only** |
| `MC_DATA_BIND_SOURCE` | Host filesystem | Docker daemon | Bind source for every MC container: `{MC_DATA_BIND_SOURCE}/{serverId}:/data` — passed **verbatim, never normalized** (a Windows path like `C:\…` must reach the daemon unchanged; the daemon resolves it) |
| `MC_DATA_PATH` | Backend container | backend | Fixed `/mc-data` in compose; validated absolute, no `.`/`..` segments; used exclusively for `statfs` disk admission and reads |

Because a bind mount exposes the same filesystem, `statfs(/mc-data)` measures the physical data root the MC containers actually write to — this is the correct physical root for disk admission. On Docker Desktop it measures the VM's mount of the host drive (acceptable approximation, documented).

**Invariants (testable):** (1) after `POST /servers`, `$MC_DATA_PATH_HOST/{serverId}` exists on the host; (2) `MIN_FREE_DISK_MB` above actual free space ⇒ create/start fails 422; (3) writes via the container view always appear in the host view.

**Socket default truth:** the shipped compose default is **rootful** Docker (`${DOCKER_SOCKET:-/var/run/docker.sock}`). Rootless Docker requires setting host `DOCKER_SOCKET=/run/user/$UID/docker.sock` (or Podman: `/run/user/$UID/podman/podman.sock`). The old SPEC's "rootless is the default, zero-touch, `${XDG_RUNTIME_DIR}`" claims are false against the compose file. Keeping the rootful default is owner decision D-4 (recommendation: keep — NAS/VPS compatibility); rootless remains a documented override. `tcp://` endpoints are rejected (local-socket-only contract).

### 10.3 Managed container specification `[IMPLEMENTED]` — normative guardrails

`DockerService.createContainer()` builds exactly (never user-driven):

- Image `itzg/minecraft-server`; name `mc-{serverId}`; labels `minepanel.server-id`, `minepanel.managed=true`.
- Env **whitelist** (nothing else): `EULA=TRUE`, `ENABLE_RCON=TRUE`, `TYPE=<provider>`, `VERSION`, `MEMORY={n}M`, `MAX_PLAYERS`, `DIFFICULTY`, `MODE` (itzg uses MODE, not GAMEMODE), `ONLINE_MODE`, `VIEW_DISTANCE`, `ALLOW_FLIGHT`, `PVP`, `MOTD` (CR/LF stripped), `SEED`.
- Binds `{MC_DATA_BIND_SOURCE}/{serverId}:/data`; port mapping `25565/tcp` → `server.port` within `MC_PORT_MIN`–`MC_PORT_MAX`; `Memory` = `memoryLimitMb` bytes (min 512); `Privileged: false`; `CapAdd: []`; `NetworkMode` = `DOCKER_NETWORK` (must be a named network — `host`/`none`/`container:` rejected); `RestartPolicy: unless-stopped`.
- Missing CPU/pids limits: backlog B-P1-10. Untagged image: backlog B-P2-7.

**RCON today = `docker exec rcon-cli`** (validated argv: no NUL/CR/LF, ≤2 args, ≤total bytes, hard timeout), used by the graceful-stop sequence. There is no TCP RCON service and `rconPassword` is never written (B-P1-11: generate a per-server password at create, store it AES-GCM-encrypted, and pass it as `RCON_PASSWORD`).

### 10.4 Read-only mount vs future write features `[DECISION REQUIRED: D-8]`

The backend mount is `:ro` today; future features (backups, restore, plugins, file manager, icons, config generation) need writes. Options: (a) read-write mount (simplest; any traversal/logic bug rewrites world data); (b) docker exec/cp per op (needs running containers; daemon-side root writes; fragile as primary); (c) **recommended** — narrow filesystem-helper sidecar: data root mounted rw, fixed UID 1000:1000, no docker socket, no published ports, own bearer credential, and the §18.2 path-safety module implemented once inside it; (d) per-operation temporary containers — recommended for restore/extract only. Until D-8 lands, the backend MUST stay read-only for data paths.

### 10.5 Degraded mode `[IMPLEMENTED]`

Daemon-unreachable transport and 502/503/504 responses surface as `503 { message: 'Docker daemon unreachable' }` at the Docker boundary. Read paths (`GET /servers`, `GET /servers/:id`) keep working; WS `system.stats` stops emitting; startup reconciliation leaves lifecycle rows untouched when the daemon is unavailable. A lifecycle operation that already claimed a transition before the daemon becomes unreachable settles that row as `ERROR`, rather than asserting an unverified prior state (§11.1).

---

## 11. Server lifecycle state machine

### 11.1 States and transitions `[IMPLEMENTED]`

```
         create+start (ADMIN)
 STOPPED ───────────────► CREATING ──► RUNNING   (create failure → rollback/ERROR)
 STOPPED ── start ──► STARTING ──► RUNNING
 RUNNING ── stop ──► STOPPING ──► STOPPED
 RUNNING ── restart ──► STOPPING ──► STARTING ──► RUNNING
 any ── reconcile ──► STOPPED/RUNNING (truth from Docker inspect)
 STOPPED ── delete ──► STOPPING ──► (container removed, DB row deleted)
```

Every transition is a CAS `UPDATE … WHERE status = <expected>` (plus containerId when set) — the losing request gets 0 rows → 409 `Server is not in X state`. `pg_advisory_xact_lock(7332)` serializes admission checks and create/start/restart claims. Error classification after a Docker failure is truthful: an in-flight lifecycle operation with a daemon-unreachable outcome → `ERROR`; container not found → `STOPPED`; known daemon rejection → prior state restored.

### 11.2 Operation preconditions

| Operation | Required status | On mismatch |
|-----------|-----------------|-------------|
| start | STOPPED (and container provisioned) | 409 |
| stop | RUNNING | 409 |
| restart | RUNNING | 409 |
| delete | STOPPED | 409 |

### 11.3 Create flow `[IMPLEMENTED]`

Disk check → transaction (advisory lock; memory admission summing **all** servers incl. stopped) → insert `CREATING` → `docker createContainer` → CAS-claim containerId → `docker start` → `CREATING → RUNNING`. Failures: create fails → compensation (delete row, or mark `ERROR` if a managed container was found); start fails → `ERROR`. No orphan DB rows; a crash mid-create is settled by startup reconciliation.

### 11.4 Resource admission `[IMPLEMENTED]`

- Create: `freeDiskMb ≥ MIN_FREE_DISK_MB` (statfs on `/mc-data`) and `sum(all memoryLimitMb) + requested ≤ totalRamMb × MAX_MEMORY_RATIO` (docker.info). Sum of ALL servers (stopped servers consume disk and will consume RAM).
- Start: same disk check; memory sums non-`STOPPED` servers, excluding the target.
- Restart: graceful stop occurs first, then the same disk and memory admission runs. A 422 admission failure after that stop leaves the target STOPPED.
- Failure envelope: `422 { statusCode, error: 'InsufficientResources', message, details: { resource: 'disk'|'memory', availableMb, requiredMb, totalMb } }`. Unavailable host info → 503.

### 11.5 Graceful stop `[IMPLEMENTED]`

`RUNNING → STOPPING` → `rcon-cli say '§cServer closing in N seconds…'` → wait `STOP_WARN_SECONDS` (0–300) → `rcon-cli save-all` → 3s → `docker stop` (`t: 15`; `t: 10` if RCON failed). RCON failure degrades to direct stop. Restart runs the full stop then the start sequence — never `docker restart`.

### 11.6 Deletion `[DECISION REQUIRED: D-3]` — P1 documentation

**Current v1 behavior (`[IMPLEMENTED]`):** requires STOPPED → CAS to STOPPING → `docker remove(force:false)` → delete DB row (with truthful reconciliation on failure) → **HTTP 202 returned for a fully synchronous operation**. The host data directory `{MC_DATA_PATH_HOST}/{serverId}` is **never removed** — no backup, no `pendingDeleteAt`, no cleanup job, no recovery window. The old SPEC's 24h tombstone + final backup + hourly cron block is fiction and MUST NOT be described as implemented.

**Accepted v1 contract:** "removes the container and the panel registration; world data remains on the host at `<MC_DATA_PATH_HOST>/<serverId>` and can be deleted manually." Deployment docs MUST give the manual cleanup command; GET/list never expose orphans (no discovery — accepted). Recommendation: change the status code to 204 (it is synchronous).

**Deferred (Phase 3, `[PROPOSED]`):** `servers.pendingDeleteAt` column → delete sets tombstone + optional final backup → `@nestjs/schedule` hourly sweeper removes expired data dirs (§18.2 path-safety applied) → `POST /servers/:id/restore` within the window → audit entries (Phase 2 dependency). D-3 decides whether/when to fund this.

### 11.7 Startup reconciliation `[IMPLEMENTED]`

`onModuleInit` inspects every non-`STOPPED` row: container inspect → `RUNNING` if running else `STOPPED`; container missing → managed-label lookup → `STOPPED` with containerId cleared; writes are CAS-guarded (status + containerId + `updatedAt` microsecond equality). Daemon unavailable → rows left untouched.

---

## 12. Error contract

### 12.1 Reality today `[IMPLEMENTED]` — not uniform

Four shapes coexist: NestJS default for `HttpException`; `{ message }` only for PG errors via `DbExceptionFilter` (23505 → 409 `Resource already exists`, 23503 → 400, 42P01/42703 → 500, other → 500); structured `{ error: '…' }` payloads on some 403s (`AccountPending`, `AccountBanned`, `PasswordChangeRequired`, `CsrfOriginForbidden`); `{ statusCode, error, message, details }` for 422 resource errors. Non-HTTP errors (e.g. JWT library errors in refresh) → **500 `Internal server error`**. No request-id anywhere.

### 12.2 Accepted envelope `[ACCEPTED]` — P1 (B-P1-8)

```json
{ "statusCode": 403, "error": "AccountPending", "message": "human text", "details": {}, "requestId": "uuid" }
```

- `error` = stable SCREAMING-case machine code; the frontend MUST switch on `error`, never `message`.
- `details` optional structured context; `requestId` echoed as `X-Request-Id` and logged with every line.
- Mapping: 400 validation (class-validator array normalized into `details`), 401/403 authN/Z, 404, 409 conflict, 413/422 domain, 503 docker/db unavailable, 500 generic (never leak internals).
- Implementation: widen the filter into a global `AppExceptionFilter`; fix the JWT-error→500 fall-through (with B-P1-2).

---

## 13. Configuration contract

### 13.1 Production preflight `[IMPLEMENTED]`

`NODE_ENV=production` boot fails fast unless: `DATABASE_URL` is a valid postgres URL; `JWT_SECRET` ≥ 32 chars and not the placeholder; `JWT_EXPIRES_IN` non-empty; `ENCRYPTION_KEY` is exactly 64 hex chars; `DOCKER_SOCKET` is an absolute socket path (no `tcp://`); `CORS_ORIGIN` is a single absolute origin (https, or loopback) with no path/query/credentials. Migrations run before the app listens (advisory-locked). There is **no** declarative config validation schema in `ConfigModule` — preflight is manual code (B-P2-10: consider a Joi/Zod schema).

### 13.2 Environment variables — consumed vs declared

Consumed `[IMPLEMENTED]`: `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `ENCRYPTION_KEY`, `DOCKER_SOCKET`, `DOCKER_NETWORK`, `MC_DATA_PATH`, `MC_DATA_BIND_SOURCE`, `MC_PORT_MIN`, `MC_PORT_MAX`, `MIN_FREE_DISK_MB`, `MAX_MEMORY_RATIO`, `STOP_WARN_SECONDS`, `REQUIRE_ADMIN_APPROVAL`, `CORS_ORIGIN`, `PORT`, `PANEL_NAME`, `PANEL_DESCRIPTION`, `PANEL_VERSION`, `NODE_ENV` (cookie/preflight behavior).

Declared but **never read** `[CONTRADICTED]`: `JWT_REFRESH_EXPIRES_IN` (refresh hardcoded 7d — B-P1-5), `LOGIN_THROTTLE_LIMIT`, `LOGIN_THROTTLE_TTL_MS` (dead — B-P1-9: wire or delete), `SMTP_*` (Phase 1.5), `MICROSOFT_*` (Phase 1.5). `DOMAIN` is consumed by Caddy only. `PANEL_ASSETS_PATH` is planned but unmounted — no `/panel/logo` endpoints exist; the old SPEC's static-assets section (server icons, panel logo) is `[PROPOSED]` with the Phase 3 write architecture (D-8). `MC_DATA_PATH_HOST` is compose-only (required by `${MC_DATA_PATH_HOST:?}`).

### 13.3 Reverse-proxy contract `[IMPLEMENTED]`

The only inbound path is Caddy on the `app` network; `trust proxy = 1` is set (`main.ts`). Publishing the backend port directly breaks throttling and the CSRF same-origin check — **MUST NOT** happen (§4.2). Caddyfile forces `https://{$DOMAIN}`; `CORS_ORIGIN` is never derived from `DOMAIN` and must be set explicitly.

---

## 14. Testing and release gates

### 14.1 Unit tests `[IMPLEMENTED]`

~250 Jest specs colocated as `*.spec.ts`; `DRIZZLE` and `DOCKERODE` tokens always mocked; no unit test touches a live Postgres or Docker daemon; no live secrets are read. Coverage spans auth (login timing, refresh, 2FA, temp password), guards (jwt/roles/permissions/pre-auth/csrf), setup, servers (CAS transitions, reconciliation, admission), docker (container config, RCON validation, degraded mode), gateway (adapter, reservation, system metrics), admin (last-admin, grants), DTO validation.

### 14.2 e2e `[IMPLEMENTED]` — real boundary

`test/` suites run against a **live loopback Postgres** (`TEST_DATABASE_URL`; CI spins a `postgres:16` service) with env (`JWT_SECRET`, `JWT_EXPIRES_IN`, `ENCRYPTION_KEY`, `CORS_ORIGIN`, `REQUIRE_ADMIN_APPROVAL=false`). **No e2e suite has Docker daemon access and none creates a real Minecraft container** — the Docker service is always mocked. CI `e2e` job: migrations → `test:e2e`. The only daemon-touching smoke is the **release-only** `publish` job (health-200 with the runner's socket; PR builds never see a daemon — explicitly a trust boundary).

### 14.3 CI pipeline `[IMPLEMENTED]` (`.github/workflows/ci.yml`)

| Job | Runs | Gate |
|-----|------|------|
| `test` | biome lint:ci, build, jest in-band | PR + master |
| `migration` | full `db:migrate` chain on a fresh Postgres | PR + master |
| `e2e` | migrations + e2e on live PG (no daemon) | PR + master |
| `image` | build amd64, degraded-mode smoke (no socket), migration-before-listen check, image-content assertions, bcrypt load, Trivy CRITICAL + fixed-HIGH | PR + master |
| `publish` | trusted daemon smoke, multi-arch (amd64/arm64) GHCR push with SBOM/provenance; `latest`+sha+semver tags | master push / `v*` tags |

Release gate status: all jobs green at HEAD `7b542f3`.

### 14.4 Missing coverage `[ACCEPTED]` — backlog

- No test covers the setup-init race, refresh rotation concurrency, ThrottlerGuard, or retained-data delete semantics. B-P1-15 adds focused regression coverage alongside B-P0-1, B-P1-1, B-P1-14 and the configured throttles.
- No **real Docker lifecycle integration test** (container create → run → graceful stop → delete → data retention). `[PROPOSED]`: release-only job (mirrors the trusted `publish` smoke) that runs the full lifecycle against a real daemon before tagging. This is the behavior gap addressed by B-P1-13.

---

## 15. Implemented feature matrix

Verified at `7b542f3`. `✓` = implemented and tested as noted; `(✓)` = implemented, partial/indirect test coverage.

| Domain | Feature | Status | Evidence |
|--------|---------|--------|----------|
| Auth | register / login (timing-equalized, dummy hash) | ✓ | `auth.service.ts`, unit+e2e |
| Auth | HttpOnly cookie sessions (access 15m / refresh 7d) | ✓ | `auth.controller.ts`, e2e |
| Auth | refresh rotation (per-use; non-atomic — B-P1-1) | ✓ (defect) | `auth.service.ts:278-286` |
| Auth | logout / logout-all / sessions list / revoke one | ✓ | unit+e2e |
| Auth | password change (keep current session) | ✓ | `users.service.ts`, unit |
| Auth | forced recovery (admin temp password, mustChangePassword) | ✓ | `auth.service.ts`, `jwt-auth.guard.ts`, unit |
| Auth | TOTP 2FA: setup/confirm/verify/disable, backup codes, lockout | ✓ | unit+e2e |
| Auth | account status enforcement (PENDING/BANNED, DB-fresh) | ✓ | `access-token.service.ts`, unit |
| Setup | status + first-admin (sequential-safe only — P0) | ✓ (defect) | `setup.service.ts`, unit |
| Admin | user list/filter, role/status changes, last-admin guard | ✓ | `admin.service.ts`, unit+e2e |
| Admin | temp-password reset, emergency 2FA removal | ✓ | `admin.service.ts`, unit |
| Admin | MOD permission grant/list/revoke (global + per-server) | ✓ | `admin.service.ts`, unit |
| Servers | create+start, list, get (visibility-filtered) | ✓ | `servers.service.ts`, unit+e2e |
| Servers | start/stop/restart with CAS + advisory lock | ✓ | unit+e2e |
| Servers | graceful stop (RCON warn → save-all → docker stop) | ✓ | `docker.service.ts` RCON exec, e2e (mocked) |
| Servers | resource admission (disk statfs, memory ratio) | ✓ | unit |
| Servers | startup reconciliation | ✓ | unit |
| Servers | delete: container+row, data retained (202 sync) | ✓ (semantics open) | `servers.service.ts:465-494` |
| Access | request/approve/revoke, OPEN/REQUEST/PRIVATE, non-disclosure | ✓ | `server-access.service.ts`, unit |
| Docker | socket-only client, degraded mode, guardrail container spec | ✓ | unit |
| Docker | host info, statfs disk, free mem | ✓ | unit |
| Gateway | WS auth (cookie/event), ADMIN metrics room, `system.stats` 10s | ✓ | `events.gateway.ts`, e2e |
| Common | CSRF origin guard, exact-origin CORS, helmet, ValidationPipe | ✓ | unit |
| Errors | PG-code filter (23505/23503/42P01/42703) | ✓ | unit |
| Deploy | compose (nestjs/postgres/caddy/prefetch), preflight, boot migrations | ✓ | image+smoke jobs |
| CI | lint/build/unit/migration/e2e/image/publish, Trivy, multi-arch | ✓ | green at HEAD |

**Not implemented at all** (old SPEC claimed or implied them as current): `@nestjs/schedule` cron (any), `nestjs-pino` logging, `/users` controller, `/versions`, `PATCH /servers/:id` (config), `PATCH /servers/:id/version`, server/panel icons, `/panel/logo`, `/system/stats` REST, magic links, OAuth endpoints, Minecraft linking endpoints, API keys, webhooks, audit log, system events, backups, scheduled tasks, notifications, plugins, file manager, player management, proxies, Bedrock, Ban table, pagination beyond `GET /servers`.

---

## 16. Prioritized implementation backlog

Generated from spec/implementation gaps (this pass; runtime code unchanged). Priorities: **P0** release blockers, **P1** important before stable v1, **P2** later improvements, **P3** hygiene/acceptance.

### P0 — release blockers (security invariants)

- **B-P0-1 Setup bootstrap invariant (§8.1):** atomic transaction + advisory lock 7330 + one-time setup token (`SETUP_TOKEN` or logged random) + throttle on `/setup/init`. Fixes multi-admin race and first-boot claim.
- **B-P0-2 Hosted-frontend auth decision (D-1) must be resolved and implemented before any hosted `app.minepanel.xyz` work (§8.5).** Same-origin deployment is unaffected.

### P1 — important before stable v1

- **B-P1-1 Atomic refresh rotation (§8.3):** tx + `FOR UPDATE` + `jti` O(1) lookup + per-class 401 codes + replay semantics + frontend single-flight contract.
- **B-P1-2 Refresh/logout error contract:** missing/malformed/expired refresh and missing-cookie logout MUST return 401, never 500 (`db-exception.filter.ts` fall-through).
- **B-P1-3 Session hygiene:** `GET /sessions` filters `expiresAt > now()`; indexes on `refresh_tokens(user_id)` and `(expires_at)`; lazy + daily expired-row cleanup.
- **B-P1-4 WebSocket ticket (§8.6):** single-use 60s ticket endpoint; keep cookie fast path; fixes the HttpOnly-token contradiction and Origin-less mobile handshakes.
- **B-P1-5 Refresh TTL sync:** consume `JWT_REFRESH_EXPIRES_IN` (JWT exp, DB `expiresAt`, cookie `maxAge`); remove hardcoded `7d`.
- **B-P1-6 Scheduler dependency decision:** add `@nestjs/schedule` (in-process, single-instance) for cleanup sweeps when the first cron feature lands; there is no scheduler today.
- **B-P1-7 Identity normalization (§8.8):** fix username case mismatch (normalize at registration or case-insensitive lookup); decide canonical identity policy (D-10).
- **B-P1-8 Stable error envelope + request-id (§12.2):** global `AppExceptionFilter`, machine codes, `X-Request-Id`.
- **B-P1-9 Dead envs:** wire or delete `LOGIN_THROTTLE_LIMIT`/`LOGIN_THROTTLE_TTL_MS`; declare dead config a release blocker.
- **B-P1-10 MC container CPU/pids limits:** `NanoCpus` + `PidsLimit` in `HostConfig`.
- **B-P1-11 RCON credential management:** per-server random `RCON_PASSWORD` at create, AES-GCM-encrypted in the existing `rcon_password` column, passed as env; unpins the current itzg-generated-password behavior.
- **B-P1-12 Per-account login brute-force counter:** per-username in-memory counter (≥5 fails → 15 min lock, distinct 429 code), admin unlock; complements IP throttling.
- **B-P1-13 Real Docker lifecycle e2e (release-only, §14.4):** container create → run → graceful stop → delete → data-retention assertions against a real daemon before tagging.
- **B-P1-14 Delete semantics documentation (D-3):** v1 = retain-data contract with manual cleanup command; consider 204 instead of 202 (§11.6).
- **B-P1-15 Concurrency, throttling and delete-contract coverage (§14.4):** add deterministic regressions for setup initialization, refresh rotation, `ThrottlerGuard`, and retained-data deletion semantics.

### P2 — later improvements

- **B-P2-1** Version/icon/panel-logo endpoints and `/versions` (Phase 3/4, §17) once the write architecture (D-8) lands.
- **B-P2-2** Session metadata columns (`userAgent`, `lastUsedAt`); touch on rotation.
- **B-P2-3** WebSocket per-user socket cap + per-IP handshake rate (authenticated sockets are currently uncapped).
- **B-P2-4** Restrict inter-container traffic on the `mc` network; per-server networks (proposed).
- **B-P2-5** Non-root backend user (`group_add` docker group instead of `user: root`).
- **B-P2-6** Backend `cap_drop: [ALL]` + `read_only: true` + `tmpfs: /tmp`; `__Host-` cookie prefix + explicit `path`; version-string consistency (1.0.0 vs 1.0 vs N/A).
- **B-P2-7** Pin itzg image (digest/tag) in compose; record resolved digest per server (proposed column).
- **B-P2-8** Fix `system.stats` free-RAM semantics (container cgroup vs host); or document.
- **B-P2-9** Password hashing upgrade (D-9): HMAC-SHA384 pepper pre-hash (or Argon2id later) + UTF-8 byte measurement, no silent truncation (§18.1).
- **B-P2-10** Declarative env validation (Joi/Zod) instead of manual preflight.
- **B-P2-11** Capability discovery in `/api/info` (§7.1): expose explicit protocol/capability flags (API compatibility, CHIPS auth support, PKCE fallback support, WebSocket-ticket support) so the hosted `minepanel-pwa` never infers behavior from version strings.

### P3 — hygiene / accept-and-document

- **B-P3-1** JWT `algorithms: ['HS256']` explicit pin.
- **B-P3-2** Register enumeration oracle (409 + fast-fail) — accept + document.
- **B-P3-3** Gate Swagger behind `SWAGGER_ENABLED` (default off in prod).
- **B-P3-4** Document MOD global-grant vs visibility 404 nuance.
- **B-P3-5** Accept in-memory 2FA lockout loss on restart (single-instance).
- **B-P3-6** Log only PG code + requestId (not raw constraint messages).
- **B-P3-7** `decrypt()` input validation → distinct error code.
- **B-P3-8** `/setup/status` write-on-read upsert — accept or lazy-init.
- **B-P3-9** Dead double-throw in `grantModPermission`; stale `username` claim note.
- **B-P3-10** License selection (D-11) and README "open-source" wording.

---

## 17. Future architecture by phase

All subsections are `[PROPOSED]` unless marked. Dependencies are explicit; nothing here exists in code today. Current endpoint tables are §7; these proposals stay separate.

### 17.1 Phase 1.5 — OAuth, magic links, identity `[PROPOSED]`

**Schema changes (accepted requirements):** `users.passwordHash` MUST become nullable; add `googleId` (unique), `githubId` (unique), `minecraftVerified`; password login MUST reject null-hash accounts with a distinct code.

**Google OAuth — security requirements (MUST):**
- Local JWKS validation only (`https://www.googleapis.com/oauth2/v3/certs`, RS256, cache by `kid` with rotation; `google-auth-library` `verifyIdToken` or `jose`). **`tokeninfo` is a debugging endpoint — forbidden in production** (latency, throttling, availability coupling).
- Mandatory claims: `iss ∈ {accounts.google.com, https://accounts.google.com}`, `aud` ∈ configured allowlist, `exp`/`iat` freshness, `email_verified === true` before any email-based logic; store `sub` as `googleId` (stable; never key on email).

**GitHub OAuth — security requirements (MUST):**
- `GET /user` for the numeric `id` → `githubId` (never key on `login`, which is renameable), plus `GET /user/emails` with the `user:email` scope selecting `primary && verified`; reject when no verified primary email exists.

**Token binding (DECISION D-5):** one OAuth client_id shared by all backends means `aud` cannot distinguish backends — any token obtained by the frontend is replayable to *any* MinePanel backend (confused deputy). Recommended: `POST /auth/oauth/challenge` issues a single-use 5-min random challenge stored hashed; the frontend carries it through the provider flow (Google `nonce`, GitHub `state`) and presents it with the token; the backend consumes it atomically. PKCE MUST be used on the frontend leg regardless.

**Identity linking (MUST):** silent email-match linking is **forbidden** (account-takeover risk from recycled/attacker-controlled provider emails). Provider login matching an existing password account returns a `LinkConfirmationRequired` state; linking completes only after password re-authentication (or an existing session). Auto-link only when the account was created by the same provider id.

**GitHub token exposure (accepted risk, mitigations MUST):** a raw `gho_…` token (read-only scopes) reaches an arbitrary self-hosted backend; the spec requires verify-then-discard (never persist), redaction in all logs, TLS end-to-end (already enforced), and documentation of residual scope.

**Username collisions:** sanitize provider display names to `^[a-zA-Z0-9_]{3,32}$`; on unique violation retry with a random 4-digit suffix (≤3 attempts) then 409 `UsernameUnavailable`.

**Magic links (SMTP optional, Phase 1.5):** unchanged product shape from the original design (one-time 15-min tokens, no user-enumeration, 501 when SMTP unconfigured) — `[PROPOSED]`, requires the `MagicLinkToken` table.

### 17.2 Phase 2 — developer platform `[PROPOSED]`

Audit log (append-only, interceptor-based, `AuditLog` table), API keys (`mpk_` prefix, hashed at rest, full owner permissions), outbound webhooks (HMAC-SHA256 signatures, retry 1×/5s, non-blocking), system events (retention 10k rows), historical metrics (`MetricSnapshot` 60s cadence, 30d retention). All gated ADMIN where specified in the original design. Depends on: error envelope (B-P1-8), scheduler (B-P1-6).

### 17.3 Phase 3 — operations `[PROPOSED]`

**WebSocket real-time (3a):** server.status/log/stats events, subscribe/unsubscribe, console.command — all require the WS ticket (B-P1-4) and per-user/console rate limits. Currently only `system.stats` exists (§7.7).

**Backups (3c) — accepted contract (§18.4):** consistency via `save-off` → `save-all flush` → copy → `save-on` (MUST re-enable in `finally`); staged+fsync+atomic-rename archives with SHA-256 manifest; verify-before-stop restore with rollback dir and atomic swap; disk preflight; archive safety (§18.3); exclusion rules; retention default 5; create/download = ADMIN or MOD `SERVER_LIFECYCLE`, restore/delete = ADMIN. Depends on write architecture (D-8), scheduler (B-P1-6), audit (Phase 2).

**File manager (3h) — accepted path-safety algorithm (§18.2):** containment by `path.relative` (never string `startsWith`), realpath re-check, no-follow (`O_NOFOLLOW`), fd-based ops, archive pre-validation, staged uploads (50 MB), read cap 5 MB, protected-files list (ops/whitelist/bans/level.dat) enforced on resolved paths, DELETE admin-only.

**Plugins (3f/3g):** Modrinth/Hangar sources, `ServerPlugin` table, install/update/toggle; `PLUGIN_MANAGEMENT` permission. **Player management (3i):** whitelist/bans/ops/kick via RCON or JSON files; UUID resolution (Mojang API cached 24h / offline UUIDv3); `Ban` table with auto-expiry cron. **Scheduled tasks (3d)** and **notifications (3e)**: `ScheduledTask`/`Notification` tables; Discord webhook per-server; fire-and-forget with 1×/5s retry. **Admin permissions dashboard (3j):** exists as API already (§7.4); UI only.

### 17.4 Phase 4 — creation wizard & presets `[PROPOSED]`

Preset-driven creation (Survival SMP, Creative, Vanilla Hardcore, Modded…), advanced mode, mod picker (Modrinth preferred, CurseForge optional), `ServerMod` table, template clone (`POST /servers/:id/clone`). Depends on: write architecture (D-8), `/versions` metadata (B-P2-1), plugin/backup subsystems.

### 17.5 Phase 5 — networking `[PROPOSED]`

Velocity proxy (`ServerProxy` table, `velocity.toml` auto-generation, modern-forwarding secret encrypted, paper-global.yml patch on add/remove), proxy WebSocket events; Bedrock via GeyserMC plugin (minimal) or standalone `itzg/minecraft-bedrock-server` (`BEDROCK` provider, UDP 19132, no RCON). Note: the old SPEC's container-name convention `minepanel-mc-{id}` differs from the implemented `mc-{id}` — the proxy design MUST use the implemented convention.

### 17.6 Phase 6 — mobile app & player portal `[PROPOSED]`

KMP/Compose app + web player portal: server status cards, access requests, player profile, push notifications, quick lifecycle (mod), admin resource overview. Depends on: WS ticket + real-time events (B-P1-4/§17.3), historical metrics (Phase 2), notifications (Phase 3).

---

## 18. Security requirements for future features

### 18.1 Password hashing `[DECISION REQUIRED: D-9]` — P2

- Reality: `bcrypt` cost 10; DTO caps at 128 **JS characters**; bcrypt silently truncates input beyond **72 UTF-8 bytes** (two passwords sharing a 72-byte prefix collide).
- MUST: measure passwords in UTF-8 bytes (`Buffer.byteLength`), never JS `.length`; never feed >72-byte passwords to bcrypt; no silent truncation, ever.
- Recommended (pre-1.0, zero migration): `storedHash = bcrypt(base64url(HMAC-SHA384(pepper, utf8(password))), rounds)` with `PASSWORD_PEPPER` (32 B hex, preflight-required, distinct from `JWT_SECRET`/`ENCRYPTION_KEY`) and centralized `BCRYPT_ROUNDS` (default 12, min 10). OWASP-endorsed construction; defeats hash-shucking; removes the length problem entirely. Fallback if pepper rejected: reject >64-byte passwords with 400 `PasswordTooLong`. Argon2id is the `[PROPOSED]` long-term alternative. References: §20.
- D-9 decides: pepper pre-hash vs byte-limit vs Argon2id migration.

### 18.2 File-manager path safety — normative algorithm (accepted, applies to any data-tree file op incl. deletion)

1. `root = await fs.realpath(serverDir)` once per request.
2. Reject NUL; `candidate = path.resolve(root, userPath)` (never string-concat).
3. Containment: `rel = path.relative(root, candidate)`; reject iff `rel === '..'`, starts with `..` + sep, or `path.isAbsolute(rel)`. (String `startsWith(root)` is wrong: `/data/srv1-evil` passes `startsWith('/data/srv1')`.)
4. Symlinks: for existing targets re-realpath and re-check containment; for creation, realpath the parent + `O_NOFOLLOW` on the final component; default no-follow; internal symlinks read-only allowed.
5. TOCTOU: operate on opened fds; residual race bounded by privilege separation (§10.4).
6. Archives: enumerate before writing; reject absolute paths, `..`, device/fifo entries; resolve-or-reject link entries; per-file + total decompressed + count caps (zip-bomb); stream, never buffer.
7. Uploads: staged under `.minepanel-tmp/<uuid>` on the same fs with a counting stream (never trust `Content-Length`), atomic `rename`; disk preflight before extraction.
8. Authorization re-checked per op (ADMIN or MOD `FILE_MANAGER` scoped/global; DELETE admin-only); protected-files enforced on resolved paths.

### 18.3 Archive/restore safety (MUST, for backups + plugin/mod installs)

SHA-256 integrity verification against the manifest before restore; pre-validation per §18.2.6; max compressed and expanded sizes (SHOULD defaults 10 GB / 30 GB with env overrides); insufficient-disk → 422 `InsufficientResources` before starting; rollback directory retained until the server reaches RUNNING; audit entries (Phase 2) on every create/restore/delete.

### 18.4 Backup consistency (MUST)

Running server: `save-off` → `save-all flush` → snapshot copy → `save-on` (MUST re-enable in `finally`; failure to re-enable = ERROR state). Stopped server: trivially consistent. Staging + fsync + atomic rename; manifest (`serverId`, `version`, `createdAt`, sha256, uncompressed bytes). Exclusions (normative): `backups/`, `.minepanel-tmp/`, `session.lock`, `cache/`.

---

## 19. Decision-required register

| # | Decision | Options (recommendation) | Blocking |
|---|----------|--------------------------|----------|
| D-1 | Hosted-frontend cross-origin auth (§8.5) | (a) same-origin frontend per backend · (b) CHIPS `Partitioned` cookies · (c) PKCE authorization-code fallback with memory-only bearer access token · (d) bridge — **(b) primary + (c) fallback** | Hosted dashboard at `app.minepanel.xyz` |
| D-2 | Setup token mandatory? (§8.1) — **(mandatory)** | mandatory vs optional | Stable v1 |
| D-3 | Deletion semantics (§11.6) — **v1 retain-data; tombstone deferred** | v1 retain-data vs tombstone+24h now | Stable v1 documentation |
| D-4 | Shipped socket default (§10.2) — **keep rootful default** | rootful vs rootless default | Compose config |
| D-5 | OAuth token binding (§17.1) — **backend-issued challenge** | challenge binding vs per-backend client vs assertion broker | Phase 1.5 |
| D-6 | WS auth primary path (§8.6) — **cookie under D-1(b); ticket under D-1(c) or when cookies are unavailable** | cookie vs ticket primary | Phase 3 real-time |
| D-7 | Identity linking policy (§17.1) — **confirmation required** | explicit confirmation vs silent email-match | Phase 1.5 |
| D-8 | Write architecture (§10.4) — **filesystem-helper sidecar** | sidecar vs rw mount w/ path module vs per-op exec | Phase 3 write features |
| D-9 | Password hashing (§18.1) — **pepper pre-hash** | pepper pre-hash vs byte-limit vs Argon2id | Stable v1 hardening |
| D-10 | Identity normalization (§8.8) — **normalize username at registration** | normalize vs case-insensitive lookup | Stable v1 |
| D-11 | License (B-P3-10) — **pick one before public release** | e.g. MIT / Apache-2.0 / AGPL-3.0 | Any public release |

---

## 20. References — external primary sources (verified 2026-08-15)

Browser/cookie behavior:

- MDN — Third-party cookies / `Partitioned` (CHIPS): https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies/Partitioned_cookies
- Privacy Sandbox — next steps (Chrome user-choice): https://privacysandbox.google.com/blog/privacy-sandbox-next-steps
- Privacy Sandbox — CHIPS: https://privacysandbox.google.com/cookies/chips
- WebKit — Full Third-Party Cookie Blocking (ITP): https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- WebKit — Features in Safari 18.4 (CHIPS): https://webkit.org/blog/16574/webkit-features-in-safari-18-4/
- MDN — Firefox 131 release notes (CHIPS enabled): https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/131

OAuth / identity:

- Google — Authenticate with a backend server (tokeninfo is debugging; local validation for production): https://developers.google.com/identity/sign-in/web/backend-auth
- Google — OpenID Connect API reference (`iss`/`aud`/`sub` requirements): https://developers.google.com/identity/openid-connect/reference
- Google — Verify the ID token on the server side: https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
- GitHub — REST API emails (`user:email` scope, primary/verified): https://docs.github.com/en/rest/users/emails
- GitHub — Authorizing OAuth apps (scopes): https://docs.github.com/en/apps/oauth-apps/using-oauth-apps/authorizing-oauth-apps

Password storage:

- OWASP Password Storage Cheat Sheet (72-byte bcrypt limit; HMAC-SHA384 pepper pre-hash; Argon2id): https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html

---

## Appendix A — Corrections to the previous specification

The previous SPEC.md (pre-rewrite) was an ambitious design document that conflated three things. This revision separates them (§1 legend). Notable corrections:

1. **Never existed** (claimed as current): `nestjs-pino` logging (actual: `ConsoleLogger`), `@nestjs/schedule` cron (absent), `pendingDeleteAt` + deletion cleanup, `discordWebhook`, `googleId`/`githubId`/`minecraftVerified`, `Ban`/`MagicLinkToken`/`ApiKey`/`Webhook`/`SystemEvent`/`AuditLog`/`Backup`/`ScheduledTask`/`Notification`/`ServerPlugin`/`ServerMod`/`ServerProxy` tables, `/users` endpoints, `/versions`, version-update and icon endpoints, `/panel/logo`, `/system/stats` REST, magic links, OAuth and Minecraft-linking endpoints, strict/standard/relaxed rate-limit tiers, per-username brute-force counter, `refresh_tokens.userAgent`/`lastUsedAt`, 24h sliding refresh renewal, rootless-Docker default, `${XDG_RUNTIME_DIR}` compose default, SvelteKit frontend.
2. **Implemented differently than described**: refresh rotates on every use (not within 24h of expiry); production `sameSite` is `none` (docs claimed `lax`); PKs are `randomUUID` (not cuid); ban deletes sessions (spec claimed it does not); 422 error code is `InsufficientResources` (not per-resource codes); `DbExceptionFilter` emits `{message}` only (spec claimed NestJS default shape); delete returns 202 for a synchronous op; RCON is `docker exec rcon-cli`, not TCP RCON; the `mc-{id}` container name (not `minepanel-mc-{id}`).
3. **Unsafe examples removed**: `startsWith(serverDir)` path check (§18.2), "128 chars is safe with bcrypt" (§18.1), `SameSite=None; Secure` described as sufficient (§8.5), `tokeninfo` + "optional audience check" OAuth flow (§17.1), silent email-match linking (§17.1), "production-ready"/"100% complete" claims (§2).
4. **Product truth**: "open-source" claim removed (UNLICENSED, private, no LICENSE); frontend stack corrected to React 19 + Vite 7 + Tailwind 4; version strings reconciled as inconsistent (B-P2-6).

## Appendix B — Validation note

This specification was validated against HEAD `7b542f3` by: full SPEC read, git state inspection (CI green), three independent read-only code scouts (implementation truth; schema/migrations/config; docs/claims/tests), first-hand verification of `schema.ts`, `main.ts`, `app.module.ts`, `auth.service.ts`, `setup.service.ts`, `docker.service.ts`, `servers.service.ts`, gateway files, controllers, guards, DTOs, compose, Dockerfile, CI workflow, and a Kimi K3 architecture/security decision record (15 items, 16 findings). Endpoint/schema/env inventories were re-run against the finalized text (§7–§13 and §15) during the review pass. A post-rewrite adversarial audit found ten documentation defects; each was reconciled before final validation. No runtime code, schema, migration, test, compose or dependency was changed in this pass.
