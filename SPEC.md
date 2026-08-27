# MinePanel — Project Specification

## 1. Document purpose, authority and status legend

This document is the authoritative, internally consistent source of truth for the MinePanel project: product vision, implemented behavior, accepted architecture, accepted implementation backlog, future proposals and open decisions. When this specification disagrees with any other repository document, this specification wins; when it disagrees with the code, the code is the immediate truth and the discrepancy is recorded here as a correction or backlog item.

Every feature statement below carries one of these status markers:

| Marker | Meaning |
|--------|---------|
| `[IMPLEMENTED]` | Verified in the code, schema, migrations and tests at the explicitly named audit revision/date at the top of this document and in Appendix B. |
| `[ACCEPTED]` | Approved target behavior or architecture that is not yet implemented; tracked in the backlog (§16). |
| `[PROPOSED]` | Future design that still requires validation or a product/architecture decision; phase-marked (§17). |
| `[CONTRADICTED]` | A previous specification or configuration claim disproved by current code; the observed current behavior is documented with its correction/backlog item. |
| `[DECISION REQUIRED]` | An unresolved choice that materially affects security, compatibility, product behavior or deployment. Silently picking one is forbidden; see the decision register (§19). |

Normative language, defined once and used consistently:

- **MUST** — a required invariant or contract; violating it is a defect or a security hole.
- **SHOULD** — a strong recommendation; a valid exception must be justified in the code or docs.
- **MAY** — optional behavior; no default obligation either way.

- **Status: release candidate, not "production-ready".** Phase 1, the per-server authorization spine, requestable-server discovery, transactional setup bootstrap, protocol-1 capability discovery, and challenge-bound Google OAuth are implemented. Hosted-auth compatibility still requires the reserved PKCE fallback, and the remaining release gates in §16 must be resolved before production-ready status.
- **Last verified implementation state:** commit `f638031e737117264455132de0668c0cbb9528c4`, audited 2026-08-27. The audit baseline was clean before this documentation reconciliation.
- **Version truth:** `package.json` says `1.0.0`; `PANEL_VERSION` defaults to `"1.0"`; the Swagger fallback is `"N/A"`; CI sets `PANEL_VERSION` to `1.0.0` in e2e. This inconsistency is tracked as backlog item B-P2-6.
- **License:** the repository is MIT-licensed. `package.json` declares `"license": "MIT"` and `LICENSE` is present. `private: true` controls package publication and does not change the license.

## 3. Product scope and supported clients

MinePanel is a self-hosted Minecraft server management panel. A single `docker compose up` on the operator's own host brings up the backend, PostgreSQL, Caddy (HTTPS) and the Minecraft container runtime. The backend manages PostgreSQL for state, controls Minecraft server containers through the Docker socket, and exposes a REST + WebSocket API.

**Clients — implemented vs planned:**

| Client | Repo | Tech | Status |
|--------|------|------|--------|
| Web dashboard (hosted PWA) | `minepanel-pwa` | React 19 + Vite 7 + TypeScript + Tailwind 4 | `[ACCEPTED]` — separate repository exists as a discovery shell; hosted at `app.minepanel.xyz`; not part of this backend's compose file |
| Mobile app | `minepanel-mobile` | KMP + Compose Multiplatform (iOS + Android) | `[PROPOSED]` — Phase 6 |
| Backend API | `minepanel-backend` (this repo) | NestJS 11 + PostgreSQL | `[IMPLEMENTED]` |

The backend is client-agnostic. Role-based guards (`ADMIN` / `MOD` / `USER`) plus per-server access rules and MOD granular permissions enforce access at the API level.

**Hosted multi-backend dashboard (`app.minepanel.xyz`)** — `[ACCEPTED]` discovery shell with a protocol-1 backend contract. The hosted PWA connects to self-hosted backends using cross-origin HttpOnly CHIPS cookies where supported; PKCE authorization-code fallback remains reserved and is not implemented. Until that fallback ships, complete hosted-browser compatibility is not claimed. The supported deployment model remains same-origin (frontend served from the same domain as the backend, or a dev frontend on `localhost:5173` with `CORS_ORIGIN` set).

Direct browser access from `https://app.minepanel.xyz` to LAN/private-network instances (RFC1918 addresses, `.local` hostnames, or other browser-untrusted origins) is **not automatically guaranteed** by the generic HTTPS multi-backend architecture: browsers apply stricter mixed-content and certificate rules to such origins. The intended hosted path is browser-trusted public HTTPS backend origins; private-network endpoints are a separate compatibility concern requiring validation.

**Key design decisions (accepted):**

- **Self-hosted first**: backend + database + MC servers run on the operator's machine. External calls are optional (Discord webhooks, Mojang UUID API, Hangar/Modrinth metadata in future phases).
- **No external queue or cache**: PostgreSQL is the only stateful dependency. No Redis, no BullMQ, no CDN.
- **Not admin-only**: regular players have a dedicated portal surface in the roadmap (access requests, player profile, notifications — Phase 6).
- **`[ACCEPTED]`** the backend data mount is **read-only**; every future write feature (backups, file manager, plugins) must route through the write architecture decided in §10.4 (owner decision D-8).

**Development phases (canonical numbering — used consistently everywhere):**

- **Foundation / Next:** reconcile SPEC and docs authority; stable API error envelope and request IDs; resolve password semantics; remove dead environment configuration; add Minecraft CPU/PID isolation; make the Minecraft image reproducible; add trusted real-Docker lifecycle CI. `[ACCEPTED]`.
- **Phase 1.5 — Identity / Onboarding:** Google OAuth, server visibility/access requests, requestable discovery, and MOD PBAC are `[IMPLEMENTED]`. Remaining GitHub OAuth, Minecraft/Microsoft linking, offline UUID linking, invitation/registration modes, and magic links are explicitly classified in §17.1; none is assumed mandatory for backend feature completion.
- **Phase 2A — Platform foundations:** audit log, framework-neutral system-event model, and a scheduler only when first required by a real feature. `[PROPOSED]`.
- **Phase 3 — Core operations:** RCON/console broker, real-time server events, backup/restore, scheduled tasks, controlled filesystem writes, file manager, player management, plugins/mods, and notifications. `[PROPOSED]`.
- **Phase 2B — Integrations:** API keys, outbound webhooks, external integrations, and system-event consumers after the foundations. `[PROPOSED]`.
- **Later product surfaces:** creation presets/wizard, mod-loader selection, Velocity/networking, Geyser/Bedrock, and other deferred surfaces. `[PROPOSED]`.
- **Backend 2.0 — Elysia 2:** a future parity-first port after the Nest feature set and migration gates are complete; see §17.6. `[PROPOSED]`.

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
| `nestjs` | `$MINEPANEL_IMAGE` (default `ghcr.io/minepanelproject/minepanel-backend:latest`) | `pull_policy: missing`; `expose: 3000` only; `user: root`; `security_opt: no-new-privileges`; healthcheck `curl /health`; depends on healthy postgres and completed `minecraft-image` prefetch |
| `postgres` | `postgres:16-alpine` | volume `postgres-data`; healthcheck `pg_isready`; no published ports |
| `caddy` | `caddy:2-alpine` | publishes 80/443 (+443/udp); auto-HTTPS from `$DOMAIN`; proxies to `nestjs:3000`; serves `./Caddyfile` |
| `minecraft-image` | `itzg/minecraft-server:latest` | one-shot prefetch (`entrypoint: ["/bin/true"]`) so the first server create does not stall on a pull |

The backend image release contract is explicit: pushes to `master` publish
`edge` and an immutable `sha-<full-40-character-commit-sha>` tag, never
`latest`. A `vX.Y.Z` tag publishes `X.Y.Z`, `X.Y`, `X`, `latest`, and the
matching immutable SHA tag. Deployment assets are fetched from versioned raw
GitHub refs; a stable image and its `docker-compose.yml`, `.env.example`, and
`Caddyfile` MUST use the same semver tag. There is no stable release at the
current revision, so `edge` is the supported pre-stable channel.

### 4.2 Trust boundaries `[IMPLEMENTED]` — MUST be preserved

1. **Internet ↔ Caddy.** TLS termination and the only published ports (80/443). The backend is never published; `postgres` publishes nothing. Publishing backend port 3000 directly breaks the `trust proxy = 1` assumption (`main.ts`) — `X-Forwarded-For` becomes spoofable, which defeats per-IP throttling and the CSRF same-origin check. Deployment docs MUST forbid it (§13).
2. **Caddy ↔ backend.** Plaintext HTTP on the `app` bridge; single-host assumption; backend sets `trust proxy = 1` (`main.ts`).
3. **Backend ↔ postgres.** Password auth, no TLS, app-network only — acceptable single-host.
4. **Backend ↔ Docker daemon (crown jewels).** The mounted socket gives the backend root-equivalent capability on the host. The container-creation guardrails (§10.3) are normative defense-in-depth. `DOCKER_SOCKET` is a local Unix socket path only — `tcp://` endpoints are rejected at production preflight (`main.ts`).
5. **MC containers.** Untrusted, modded game code. They run unprivileged, memory-capped, with no added Linux capabilities, on a bridge network. Known gap (backlog B-P2-4): the `mc` bridge allows unrestricted container-to-container traffic; per-server networks are `[PROPOSED]`.
6. **Data volume.** Host directory owned via daemon binds; itzg entrypoint chowns to its runtime user at container start; the backend reads it `:ro`.

### 4.3 Hardening backlog `[ACCEPTED]`

- **B-NEXT-4:** add `NanoCpus` CPU quota and `PidsLimit` to MC container `HostConfig` (one MC server can currently starve backend/postgres; fork-bomb surface).
- **B-NEXT-6:** pin the itzg image with an explicit tag or digest strategy and record resolved identity where needed.
- **B-P2-4:** document/restrict inter-container traffic on the `mc` network; per-server networks remain `[PROPOSED]`.
- **B-P2-5:** run the backend as a non-root user with `group_add` for the Docker group instead of `user: root`.
- **B-P2-6:** consider `cap_drop: [ALL]` + `read_only: true` + `tmpfs: /tmp` for the backend container.

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

Seven tables, all defined in `src/db/schema.ts`; migrations `0000`–`0006` in `drizzle/` cumulatively match the schema exactly (no drift). Primary keys are `text` UUIDs generated by `crypto.randomUUID()` — not cuid.

**`users`**

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | text | PK, UUID |
| `email` | varchar(254) | not null, unique (case-sensitive) |
| `username` | varchar(32) | not null, unique (case-sensitive) |
| `passwordHash` | text | **nullable** — null on provider-only accounts; password login on null-hash fails generically |
| `googleId` | text | unique, null — verified Google `sub` (D-5 challenge-bound) |
| `githubId` | text | unique, null — reserved; GitHub login not implemented |
| `minecraftVerified` | boolean | not null, default false |
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
| `tokenIdHash` | text | not null, unique — SHA-256 of the random `jti`; the raw refresh token is never stored |
| `userId` | text | not null, FK → users, `onDelete: cascade` |
| `expiresAt` | timestamptz | not null |
| `createdAt` | timestamptz | default now |

> There are **no** `userAgent` / `lastUsedAt` columns; session metadata remains future work (§8.3). Indexes exist on `userId` and `expiresAt`.

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
| `rconPassword` | text | null — **column exists but is not written**; future credential ownership is undecided |
| `ownerId` | text | not null, FK → users (creator) |
| `accessType` | enum `OPEN`\|`REQUEST`\|`PRIVATE` | default `OPEN` |
| `createdAt` / `updatedAt` | timestamptz | |

> No `pendingDeleteAt` column exists (the old SPEC's deletion design was never built; §11.6) and no `discordWebhook` column exists (Phase 3 notification feature).

**`server_access`** — join table: `userId` FK cascade, `serverId` FK cascade, `status` enum `PENDING`\|`APPROVED`, `createdAt`, `approvedAt`. Constraints: unique `(userId, serverId)`; CHECK `(status = 'PENDING' AND approvedAt IS NULL) OR (status = 'APPROVED' AND approvedAt IS NOT NULL)`; indexes on `(serverId, status, createdAt, id)` and `(userId, serverId)`. There is no `DENIED` status — rejection is represented by deleting the row.

**`mod_permissions`** — `userId` FK cascade, `permission` enum (`SERVER_LIFECYCLE`, `SERVER_CONFIG`, `PLUGIN_MANAGEMENT`, `WHITELIST_MANAGEMENT`, `USER_MANAGEMENT`, `FILE_MANAGER`), `serverId` nullable FK cascade, `createdAt`. Partial unique index on `(userId, permission)` where `serverId IS NULL`; unique on `(userId, permission, serverId)`; index on `(userId, permission, serverId)`.

**`oauth_challenges`** — single-use Google-OAuth challenge binding (D-5): `id` PK (UUID), `provider` (constrained to `google`), `challengeHash` (unique — SHA-256 of the raw challenge; the raw value is returned once and never stored), `expiresAt` (5-minute TTL), `createdAt`. Consumption is an atomic `DELETE … RETURNING` keyed by provider + hash + unexpired timestamp; concurrent attempts yield exactly one success. Indexes: unique challenge hash + expiry.

### 6.2 Tables that do NOT exist yet `[ACCEPTED]/[PROPOSED]`

The old SPEC listed these as current models. They are future work, defined in §17: `Ban`, `MagicLinkToken`, `ApiKey`, `Webhook`, `SystemEvent`, `AuditLog`, `MetricSnapshot`, `Backup`, `ScheduledTask`, `Notification`, `ServerPlugin`, `ServerMod`, `ServerProxy`. `servers.discordWebhook` remains a future column. Google identity columns (`users.googleId`, `users.githubId`, `users.minecraftVerified`) and nullable `users.passwordHash` are delivered in Phase 1.5 (§6.1, §17.1).

### 6.3 Enums

`role`, `user_status`, `server_provider`, `server_status`, `server_difficulty`, `server_gamemode`, `access_type`, `server_access_status`, `mod_permission` — exact values in §6.1.

---

## 7. Current HTTP and WebSocket API

Global prefix `api` (except `/health`); Swagger UI at `/docs` (public — backlog B-P3-3 to gate it). All routes below are `[IMPLEMENTED]`; `[PROPOSED]` endpoints live in §17 and are never mixed into these tables.

### 7.1 Public

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness: `{ status: 'ok'\|'degraded', db, docker, version }`; 503 when degraded. Uses `SELECT 1` + `docker.ping()`. |
| GET | `/api/info` | Protocol-1 capability discovery: `{ name, version, api: { protocolVersion: 1 }, capabilities: { auth: { partitionedCookies: true, pkceAuthorizationCode: false, googleOAuth }, realtime: { websocketTicket: false }, servers: { requestableDiscovery: true } } }`; `googleOAuth` is true only when `GOOGLE_CLIENT_ID` is configured; sends `Cache-Control: no-store`. |
| GET | `/docs` | Swagger UI (public in current builds) |

**Capability discovery `[IMPLEMENTED]`** — `GET /api/info` is the version-independent protocol contract for hosted clients. `partitionedCookies: true` means the production auth cookie paths emit CHIPS `Partitioned`; `googleOAuth` truthfully reports whether the trusted `GOOGLE_CLIENT_ID` configuration enables Google ID-token login; `servers.requestableDiscovery` advertises `GET /api/servers/requestable`. PKCE authorization-code fallback and WebSocket tickets remain `false` until their future implementations ship. Clients MUST use these flags rather than infer compatibility from `version`.

### 7.2 Setup

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/setup/status` | Public | `{ initialAdminCreated, nextStep: 'register_admin'\|'complete' }` |
| POST | `/api/setup/init` | Public, `X-Setup-Token`, throttle 5/10 min per IP | Create first admin atomically; missing or wrong token returns 401 `SetupTokenInvalid`; a valid token after completion returns 409 `SetupAlreadyComplete`. `SETUP_TOKEN` is used verbatim when configured; otherwise a base64url token is generated once per incomplete process and logged once. |

### 7.3 Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | Public, throttle 5/10s | 201 `{ message }`; PENDING if `REQUIRE_ADMIN_APPROVAL=true`, else ACTIVE; 409 `User already exists` |
| POST | `/api/auth/login` | Public, throttle 5/10s | 200 `PublicUser` + cookies, or `{ requiresTwoFactor, preAuthToken }`; 401 `Wrong credentials` (timing-equalized); 403 `AccountPending`/`AccountBanned` |
| POST | `/api/auth/refresh` | Public, throttle 5/10s | Rotates refresh token, sets new cookies. Missing/malformed/expired/replayed refresh → 401 with machine codes; never 500 (B-P1-2) |
| POST | `/api/auth/logout` | JWT | Revokes the presented refresh row, clears cookies |
| POST | `/api/auth/logout-all` | JWT | Revokes all refresh rows, clears cookies |
| GET | `/api/auth/profile` | JWT | Current user (`req.user` shape) |
| PATCH | `/api/auth/profile` | JWT | Update **username only** (email is not editable through any endpoint today); 400 `No changes` when identical |
| PATCH | `/api/auth/password` | JWT | Change password; requires `currentPassword`; keeps current session, revokes others (normal flow) or all (forced recovery flow) |
| GET | `/api/auth/sessions` | JWT | List **unexpired** refresh-token rows (id, userId, expiresAt, createdAt); expired rows filtered (B-P1-3) |
| DELETE | `/api/auth/sessions/:id` | JWT | Revoke own session; silently succeeds for missing rows |
| POST | `/api/auth/2fa/setup` | JWT | Returns `{ secret, uri }`; secret encrypted at rest |
| POST | `/api/auth/2fa/confirm` | JWT | Verifies first code, enables 2FA, returns 8 single-use backup codes |
| POST | `/api/auth/2fa/verify` | Pre-auth Bearer, throttle 5/600s | Completes 2FA login, sets cookies |
| DELETE | `/api/auth/2fa/disable` | JWT | Requires valid TOTP or backup code |
| POST | `/api/auth/oauth/challenge` | Public, throttle 5/10s | Google-only single-use 5-minute challenge. The raw challenge is returned once and stored only as a hash; the frontend supplies it as the Google `nonce`. |
| POST | `/api/auth/oauth/google/login` | Public, throttle 5/10s | Local-JWKS-verified Google ID token with a consumed Google challenge. Returns `PublicUser` plus normal session cookies, or `{ status: 'LinkConfirmationRequired' }` without a session when its verified email matches an existing account. |
| POST | `/api/auth/oauth/google/link` | JWT, throttle 5/10s | Verifies and consumes a fresh Google challenge, then atomically links the verified `sub`; a conflicting `google_id` returns 409. |

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
| GET | `/api/servers/requestable` | JWT | List REQUEST servers available to discover and request; excludes CREATING and already-approved servers; returns `{ data, total }` |
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

### 8.1 First-run setup invariant `[IMPLEMENTED]`

`POST /api/setup/init` now requires the one-time `X-Setup-Token` header before hashing or touching the database. Missing and wrong headers are indistinguishable 401 `SetupTokenInvalid` responses; after setup completes, a valid token receives 409 `SetupAlreadyComplete`.

The write path is one transaction under `pg_advisory_xact_lock(7330)`: it re-reads `setup_state`, inserts the ADMIN row, and sets `initialAdminCreated`; any failure rolls back both writes. The route is throttled to 5 attempts per 10 minutes per IP. A configured non-empty `SETUP_TOKEN` is used verbatim and never logged; when it is absent, a 24-byte base64url token is generated once per incomplete process and emitted once in the service log for operator retrieval. Generated tokens are process-local and change on restart.

This closes the former concurrent-admin and insert/flag failure races. D-2 is adopted: setup authorization is mandatory.

### 8.2 Cookies and tokens `[IMPLEMENTED]`

- Cookie names: `access_token` (15 min TTL), `refresh_token` (7 days). Both are `HttpOnly`, explicitly `Path=/`, and use `Secure; SameSite=None; Partitioned` in production. Development uses `HttpOnly; Path=/; SameSite=Lax` and omits `Secure`/`Partitioned`.
- Access JWT: `{ sub, type: 'access', username, role, temporaryAuth? }` — TTL from `JWT_EXPIRES_IN` via `JwtModule` `signOptions`.
- Refresh JWT: `{ sub, type: 'refresh', jti, temporaryAuth? }` — TTL from the single parsed `JWT_REFRESH_EXPIRES_IN` (B-P1-5). The random `jti` is the DB row key (SHA-256 digest stored); the raw refresh token is never stored, and the DB never leaks a reusable credential.
- `type` claims pin token purpose: only `type: 'refresh'` may rotate; only `type: 'access'` passes the JWT guard; `pre-auth` is a five-minute response-body Bearer token restricted to `POST /api/auth/2fa/verify`.
- Login and refresh return `PublicUser` plus session cookies. A 2FA-required login instead returns `{ requiresTwoFactor: true, preAuthToken }` without setting session cookies; the browser-visible pre-auth exception is scoped in §5.2.

### 8.3 Refresh rotation contract `[IMPLEMENTED]` — remaining session metadata accepted

Every refresh rotates inside one transaction, keyed by the JWT `jti` SHA-256 digest. The transaction verifies the user state, deletes the presented row with `DELETE … RETURNING`, and inserts the successor; zero deleted rows means replay and returns 401. Concurrent refreshes with the same token produce exactly one successor. Refresh failures return stable 401 machine codes: `RefreshTokenMissing`, `RefreshTokenMalformed`, `RefreshTokenExpired`, `TokenWrongPurpose`, or `RefreshTokenInvalid`, never 500.

`JWT_REFRESH_EXPIRES_IN` is parsed once and supplies the JWT expiry, database `expiresAt`, and cookie `maxAge`. Expired rows for the user are lazily swept during rotation; a daily sweep remains deferred until a scheduler is justified. `GET /sessions` filters `expiresAt > now()`. Indexes cover `user_id` and `expires_at`. The frontend should single-flight refresh requests because strict rotation intentionally invalidates the losing concurrent request.

Migration `0004` deletes legacy refresh rows because the old format has no derivable `jti`; existing sessions therefore require login again after upgrade. Session metadata (`userAgent`, `lastUsedAt`) and refresh-family theft detection remain future work.

### 8.4 Guard pipeline `[IMPLEMENTED]`

Global order in `app.module.ts`:

1. `CsrfOriginGuard` — mutating requests carrying an `Origin` header must match the canonical `CORS_ORIGIN` (or the API's own origin, e.g. Swagger); mismatch/`null`/repeated → 403 `{ error: 'CsrfOriginForbidden' }`. No-Origin requests (curl/CI) pass. Socket.IO is intercepted by the adapter before Nest routing.
2. `JwtAuthGuard` — reads `access_token` cookie; `@Public()` bypasses. Verifies via `AccessTokenService` (JWT verify + DB-fresh `status`/`role`/`mustChangePassword`; **fails closed** on DB error; PENDING → 403 `AccountPending`, BANNED → 403 `AccountBanned`). Forced-recovery sessions are allowed only on `PATCH /api/auth/password`, else 403 `PasswordChangeRequired`.
3. `RolesGuard` — `@Roles('ADMIN', …)`; ADMIN always passes; route without roles passes.
4. `PermissionsGuard` — `@RequiresPermission('SERVER_LIFECYCLE')`; ADMIN passes; MOD must have a `mod_permissions` row (global `serverId IS NULL` or scoped to `:id`); fails closed 503 `Permission check unavailable` on DB error.
5. `ThrottlerGuard` — see §13.

Known nuance (B-P3-4): a MOD with a global `SERVER_LIFECYCLE` grant can pass the guard but still get 404 on a PRIVATE server without an approved `server_access` row (visibility is separate from action permission).

### 8.5 Hosted-frontend cross-origin authentication `[ACCEPTED: D-1]`

The hosted dashboard (`minepanel-pwa`) uses protocol-1 capability discovery. CHIPS `Partitioned` HttpOnly cookies are the primary cross-origin session mechanism where the browser supports them; the backend emits `SameSite=None; Secure; Partitioned` in production. The PKCE authorization-code flow with a memory-only bearer access token is the documented fallback design, but it is reserved and not implemented. Therefore complete hosted-browser compatibility remains a release blocker; same-origin deployment is fully supported.

`GET /api/info` truthfully advertises `partitionedCookies: true`, `pkceAuthorizationCode: false`, `googleOAuth` according to `GOOGLE_CLIENT_ID`, and `websocketTicket: false`. Clients MUST NOT infer support from panel version strings. The previous claim that `SameSite=None; Secure` alone is sufficient is obsolete.

### 8.6 WebSocket authentication `[ACCEPTED]` — P1

Accepted design: `POST /api/realtime/ticket` (authenticated, throttled) → single-use ticket, 60s TTL, server-bound to `{userId, role, exp}`, consumed atomically on connect; the gateway keeps its per-tick user re-validation. The cookie handshake remains the fast path. This resolves the current contradiction (§7.7) for browsers (which cannot read the HttpOnly access token) and for mobile clients (which send no Origin). Whether cookie or ticket is *primary* follows D-1.

### 8.7 Admin safety `[IMPLEMENTED]`

`pg_advisory_xact_lock(7331)` serializes role/status transitions; deactivating or demoting the last active ADMIN → 409 `Cannot deactivate the last active admin`. Banning deletes all refresh sessions (the old SPEC claimed tokens are kept on ban — **false**; unban requires re-login). Role change clears all `mod_permissions` rows. Admin password reset: 16-char base64url temp password, 24h TTL, `mustChangePassword=true`, revokes all sessions, returned plaintext once.

### 8.8 Identity normalization `[IMPLEMENTED]`

Registration trims and lowercases both email and username before persistence. Login trims and lowercases the identifier, and uniqueness remains the case-sensitive PostgreSQL constraint over canonical values. Provider-generated usernames use the same canonicalization. Migration `0005` performs a case-collision preflight and fails loudly for pairs such as `Bob` and `bob`; no silent data loss occurs.

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

**Socket default truth:** shipped Compose uses **rootful** Docker (`${DOCKER_SOCKET:-/var/run/docker.sock}`). Rootless Docker and Podman remain optional overrides through a host-local Unix socket path; `tcp://` endpoints are rejected. This is the adopted deployment default recorded in D-4.

### 10.3 Managed container specification `[IMPLEMENTED]` — normative guardrails

`DockerService.createContainer()` builds exactly (never user-driven):

- Image `itzg/minecraft-server`; name `mc-{serverId}`; labels `minepanel.server-id`, `minepanel.managed=true`.
- Env **whitelist** (nothing else): `EULA=TRUE`, `ENABLE_RCON=TRUE`, `TYPE=<provider>`, `VERSION`, `MEMORY={n}M`, `MAX_PLAYERS`, `DIFFICULTY`, `MODE` (itzg uses MODE, not GAMEMODE), `ONLINE_MODE`, `VIEW_DISTANCE`, `ALLOW_FLIGHT`, `PVP`, `MOTD` (CR/LF stripped), `SEED`.
- Binds `{MC_DATA_BIND_SOURCE}/{serverId}:/data`; port mapping `25565/tcp` → `server.port` within `MC_PORT_MIN`–`MC_PORT_MAX`; `Memory` = `memoryLimitMb` bytes (min 512); `Privileged: false`; `CapAdd: []`; `NetworkMode` = `DOCKER_NETWORK` (must be a named network — `host`/`none`/`container:` rejected); `RestartPolicy: unless-stopped`.
- Missing CPU/pids limits and untagged image are tracked in Foundation / Next (§16).

**RCON today = `docker exec rcon-cli`** (validated argv, bounded bytes/arguments, and hard timeout), used by graceful stop. The backend is intentionally not attached to the Minecraft network. There is no TCP RCON service, and `rconPassword` is not written today. Future work is a **RCON command broker/service with pluggable transport; Docker-exec transport is the default**. TCP RCON is optional only if isolation and operational needs justify it; credential ownership remains a decision, not a required encrypted-storage feature.

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

### 11.6 Deletion `[ACCEPTED: D-3]`

**Current v1 behavior (`[IMPLEMENTED]`):** requires STOPPED → CAS to STOPPING → `docker remove(force:false)` → delete DB row (with truthful reconciliation on failure) → **HTTP 202 returned for a fully synchronous operation**. The host data directory `{MC_DATA_PATH_HOST}/{serverId}` is **never removed** — no backup, no `pendingDeleteAt`, no cleanup job, no recovery window.

**Retained-data contract:** removing a server removes its container and panel registration; world data remains at `<MC_DATA_PATH_HOST>/<serverId>` and can be deleted manually. To remove it, an operator MUST provide the exact host root and server UUID; the guarded command below displays the target and refuses empty, non-absolute, malformed, or wildcard-like inputs. Deletion is irreversible and the command contains no wildcard:

```bash
: "${MC_DATA_PATH_HOST:?Set MC_DATA_PATH_HOST to the absolute host data root}"
: "${SERVER_UUID:?Set SERVER_UUID to the exact server UUID}"
case "$MC_DATA_PATH_HOST" in /*) ;; *) printf '%s\n' 'MC_DATA_PATH_HOST must be absolute' >&2; exit 1 ;; esac
if [[ ! "$SERVER_UUID" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-5][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$ ]]; then
  printf '%s\n' 'SERVER_UUID must be a UUID' >&2
  exit 1
fi
target="$MC_DATA_PATH_HOST/$SERVER_UUID"
printf 'Deletion target: %s\n' "$target"
printf '%s\n' 'WARNING: this permanently deletes retained Minecraft data and cannot be undone.'
read -r -p 'Type DELETE to continue: ' confirmation
[ "$confirmation" = DELETE ] || { printf '%s\n' 'Aborted.'; exit 1; }
rm -rf -- "$target"
```

No runtime deletion behavior or HTTP status changes are implied by this manual procedure. Tombstone/backup/sweeper/restore behavior remains deferred.

### 11.7 Startup reconciliation `[IMPLEMENTED]`

`onModuleInit` inspects every non-`STOPPED` row: container inspect → `RUNNING` if running else `STOPPED`; container missing → managed-label lookup → `STOPPED` with containerId cleared; writes are CAS-guarded (status + containerId + `updatedAt` microsecond equality). Daemon unavailable → rows left untouched.

---

## 12. Error contract

### 12.1 Reality today `[IMPLEMENTED]` — not uniform

Four shapes coexist: NestJS default for `HttpException`; `{ message }` for PostgreSQL errors through `DbExceptionFilter` (23505 → 409, 23503 → 400, 42P01/42703 → 500, other → 500); structured `{ error: '…' }` payloads on selected 401/403 paths; and `{ statusCode, error, message, details }` for 422 resource errors. Refresh token failures are normalized to 401 machine codes; other unhandled exceptions still use Nest's generic 500 response. No request ID is generated today.

### 12.2 Stable-v1 envelope and request IDs `[ACCEPTED]` — Foundation / Next

```json
{ "statusCode": 403, "error": "ACCOUNT_PENDING", "message": "human text", "details": {}, "requestId": "uuid" }
```

- `error` is a stable machine code; clients switch on `error`, never `message`.
- `details` is optional structured context; `requestId` is echoed as `X-Request-Id` and included in structured logs.
- Normalize validation, authentication/authorization, not-found, conflict, domain/resource, dependency, and generic errors without leaking internals.
- Implement this as an API/protocol quality task in the current Nest backend. It is not an Elysia migration task.

---

## 13. Configuration contract

### 13.1 Production preflight `[IMPLEMENTED]`

`NODE_ENV=production` boot fails fast unless: `DATABASE_URL` is a valid postgres URL; `JWT_SECRET` ≥ 32 chars and not the placeholder; `JWT_EXPIRES_IN` non-empty; `ENCRYPTION_KEY` is exactly 64 hex chars; `DOCKER_SOCKET` is an absolute socket path (no `tcp://`); `CORS_ORIGIN` is a single absolute origin (https, or loopback) with no path/query/credentials. Migrations run before the app listens (advisory-locked). There is **no** declarative config validation schema in `ConfigModule` — preflight is manual code (B-P2-10: consider a Joi/Zod schema).

### 13.2 Environment variables — consumed vs declared

Consumed `[IMPLEMENTED]`: `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN` (single TTL source for refresh JWT exp, DB `expiresAt`, cookie maxAge — B-P1-5), `GOOGLE_CLIENT_ID` (enables `googleOAuth` capability + issuance), `ENCRYPTION_KEY`, `DOCKER_SOCKET`, `DOCKER_NETWORK`, `MC_DATA_PATH`, `MC_DATA_BIND_SOURCE`, `MC_PORT_MIN`, `MC_PORT_MAX`, `MIN_FREE_DISK_MB`, `MAX_MEMORY_RATIO`, `STOP_WARN_SECONDS`, `REQUIRE_ADMIN_APPROVAL`, `CORS_ORIGIN`, `PORT`, `PANEL_NAME`, `PANEL_DESCRIPTION`, `PANEL_VERSION`, `NODE_ENV` (cookie/preflight behavior).

Declared but **never read** `[CONTRADICTED]`: `LOGIN_THROTTLE_LIMIT` and `LOGIN_THROTTLE_TTL_MS` are dead configuration; `SMTP_*` and `MICROSOFT_*` are reserved for future features. `DOMAIN` is consumed by Caddy only. `PANEL_ASSETS_PATH` is not mounted or consumed; panel/logo endpoints are future work. `MC_DATA_PATH_HOST` is Compose-only and required by `${MC_DATA_PATH_HOST:?}`. Foundation / Next includes deleting or wiring the two dead login-throttle variables; no current implementation should infer behavior from them.

### 13.3 Reverse-proxy contract `[IMPLEMENTED]`

The only inbound path is Caddy on the `app` network; `trust proxy = 1` is set (`main.ts`). Publishing the backend port directly breaks throttling and the CSRF same-origin check — **MUST NOT** happen (§4.2). Caddyfile forces `https://{$DOMAIN}`; `CORS_ORIGIN` is never derived from `DOMAIN` and must be set explicitly.

---

## 14. Testing and release gates

### 14.1 Unit tests `[IMPLEMENTED]`

The audited repository contains 40 colocated Jest suites and 729 passing unit tests at the revision/date in §2. `DRIZZLE` and `DOCKERODE` tokens are mocked; unit tests do not touch live PostgreSQL or Docker and do not read live secrets. Coverage spans auth, guards, setup, servers, Docker, gateway, admin, and DTO validation.

### 14.2 e2e `[IMPLEMENTED]` — real boundary

The repository contains 13 e2e suites with 91 test cases. They run against a **live loopback PostgreSQL** (`TEST_DATABASE_URL`; CI provisions `postgres:16`) with Docker mocked. No e2e suite creates a real Minecraft container. The CI `e2e` job applies migrations and runs `test:e2e`; the only daemon-touching check is the release-only `publish` smoke.


| Job | Runs | Gate |
|-----|------|------|
| `test` | biome lint:ci, build, jest in-band | PR + master |
| `migration` | full `db:migrate` chain on a fresh Postgres | PR + master |
| `e2e` | migrations + e2e on live PG (no daemon) | PR + master |
| `image` | build amd64, degraded-mode smoke (no socket), migration-before-listen check, image-content assertions, bcrypt load, Trivy CRITICAL + fixed-HIGH | PR + master |
| `publish` | trusted daemon smoke, multi-arch (amd64/arm64) GHCR push with SBOM/provenance; master publishes `edge` + full SHA, `vX.Y.Z` publishes exact/minor/major/`latest` + full SHA | master push / `v*` tags |

The audited local unit run passed (40 suites, 729 tests). The repository CI workflow defines the remaining migration, e2e, image, and trusted publish gates; no claim is made that the full CI workflow or a real Docker lifecycle run was executed during this documentation audit.

### 14.4 Missing coverage `[ACCEPTED]` — backlog

- Setup race and throttling have live-Postgres coverage in `test/setup-bootstrap.e2e-spec.ts`; refresh rotation concurrency is covered by `test/refresh-rotation.e2e-spec.ts` (exactly-one-winner). Retained-data deletion semantics remain a coverage gap.
- No **real Docker lifecycle integration test** (container create → run → graceful stop → delete → data retention). Foundation / Next tracks release-only real-daemon coverage before tagging.

---

## 15. Implemented feature matrix

Verified against commit `f638031e737117264455132de0668c0cbb9528c4` on 2026-08-27. `✓` = implemented and tested as noted; `(✓)` = implemented, partial/indirect test coverage.

| Domain | Feature | Status | Evidence |
|--------|---------|--------|----------|
| Auth | register / login (timing-equalized, dummy hash) | ✓ | `auth.service.ts`, unit+e2e |
| Auth | HttpOnly cookie sessions (access 15m / refresh 7d) | ✓ | `auth.controller.ts`, e2e |
| Auth | refresh rotation (atomic, jti-keyed, exactly-one-winner) | ✓ | `auth.service.ts`, e2e concurrency |
| Auth | Google OAuth (challenge + local JWKS + session reuse) | ✓ | `google-token.service.ts`, `google-oauth.service.ts`, e2e |
| Auth | logout / logout-all / sessions list / revoke one | ✓ | `auth.controller.ts`, unit+e2e |
| Auth | password change (keep current session) | ✓ | `users.service.ts`, unit |
| Auth | forced recovery (admin temp password, mustChangePassword) | ✓ | `auth.service.ts`, `jwt-auth.guard.ts`, unit |
| Auth | TOTP 2FA: setup/confirm/verify/disable, backup codes, lockout | ✓ | unit+e2e |
| Auth | account status enforcement (PENDING/BANNED, DB-fresh) | ✓ | `access-token.service.ts`, unit |
| Setup | status + transactional first-admin bootstrap with token/throttle | ✓ | `setup.service.ts`, unit + live-Postgres e2e |
| Admin | user list/filter, role/status changes, last-admin guard | ✓ | `admin.service.ts`, unit+e2e |
| Admin | temp-password reset, emergency 2FA removal | ✓ | `admin.service.ts`, unit |
| Admin | MOD permission grant/list/revoke (global + per-server) | ✓ | `admin.service.ts`, unit |
| Servers | create+start, list, get (visibility-filtered), requestable discovery | ✓ | `servers.service.ts`, unit+e2e |
| Servers | start/stop/restart with CAS + advisory lock | ✓ | unit+e2e |
| Servers | graceful stop (RCON warn → save-all → docker stop) | ✓ | `docker.service.ts` RCON exec, e2e (mocked) |
| Servers | resource admission (disk statfs, memory ratio) | ✓ | unit |
| Servers | startup reconciliation | ✓ | unit |
| Servers | delete: container+row, data retained (202 sync) | ✓ | `servers.service.ts:465-494` |
| Access | request/approve/revoke, OPEN/REQUEST/PRIVATE, non-disclosure | ✓ | `server-access.service.ts`, unit |
| Docker | socket-only client, degraded mode, guardrail container spec | ✓ | unit |
| Docker | host info, statfs disk, free mem | ✓ | unit |
| Gateway | WS auth (cookie/event), ADMIN metrics room, `system.stats` 10s | ✓ | `events.gateway.ts`, e2e |
| Common | CSRF origin guard, exact-origin CORS, helmet, ValidationPipe | ✓ | unit |
| Errors | PG-code filter (23505/23503/42P01/42703) | ✓ | unit |
| Deploy | compose (nestjs/postgres/caddy/prefetch), preflight, boot migrations | ✓ | image+smoke jobs |
| CI | lint/build/unit/migration/e2e/image/publish, Trivy, multi-arch | ✓ | configured CI gates |
| API | protocol-1 capability discovery with no-store | ✓ | `app.controller.ts`, unit |

**Not implemented at this audit revision** (older SPECs claimed or implied them as current): `@nestjs/schedule` cron, `nestjs-pino` logging, `/users` controller, `/versions`, `PATCH /servers/:id` (config), `PATCH /servers/:id/version`, server/panel icons, `/panel/logo`, `/system/stats` REST, GitHub OAuth, magic links, Minecraft linking endpoints, invitations, API keys, webhooks, audit log, system events, backups, scheduled tasks, notifications, plugins, file manager, player management, proxies, Bedrock, `Ban` table, and pagination beyond `GET /servers`.

---

## 16. Prioritized implementation roadmap

This roadmap is reconciled against the audited implementation revision in §2. Items are classified by delivery priority, not by framework preference. The current NestJS backend remains the implementation target until its intended feature set is complete.

### Foundation / Next — stable-v1 and release hardening

- **B-NEXT-1 Stable API error contract:** implement machine-readable error codes, one consistent response envelope, validation normalization, request IDs, `X-Request-Id`, and correlated structured logs. This is an API/protocol quality task in NestJS, not an Elysia migration task.
- **B-NEXT-2 Password semantics decision:** resolve the bcrypt 72-UTF-8-byte limit against the current 128-character DTO limit; implement the selected migration-safe policy before stable v1.
- **B-NEXT-3 Dead environment cleanup:** delete or wire `LOGIN_THROTTLE_LIMIT` and `LOGIN_THROTTLE_TTL_MS`; do not let declared-but-unused configuration imply runtime behavior.
- **B-NEXT-4 Progressive login-abuse protection:** design throttling that combines normalized account identity with source/network context and avoids hard-locking an account solely because an attacker knows its username.
- **B-NEXT-5 Minecraft resource isolation:** add CPU quota (`NanoCpus` or equivalent) and `PidsLimit` to managed containers.
- **B-NEXT-6 Image reproducibility:** replace blind `itzg/minecraft-server:latest` reliance with an explicit tag or digest strategy and record the resolved image identity where needed.
- **B-NEXT-7 Trusted Docker lifecycle coverage:** add release-gated real-daemon coverage for create → run → graceful stop → delete, including retained data assertions.
- **B-NEXT-8 Hosted-browser compatibility:** implement and verify the reserved PKCE authorization-code fallback if complete hosted cross-origin browser support remains a release requirement. Same-origin deployments are unaffected.

### Phase 1.5 — Identity / Onboarding

Completed: Google OAuth (challenge-bound local verification and linking), server visibility/access requests, requestable discovery, and MOD PBAC.

The following are **optional or deferred**, not assumed requirements for backend feature completion:

- **Optional:** GitHub OAuth; invitation flows and alternate registration modes; magic-link authentication when SMTP is deliberately enabled.
- **Deferred:** Microsoft Minecraft linking and offline UUID linking until player-management consumers and identity ownership rules are defined.

### Phase 2A — Platform foundations

- **Required foundation:** append-only audit log with an internal, framework-neutral system-event model.
- **Deferred until first consumer:** scheduler; add an in-process scheduler only when a real feature requires recurring work.

API keys, webhooks, and external integrations MUST NOT block core Minecraft management.

### Phase 3 — Core operations

Deliver in dependency order as product requirements become concrete: RCON/console command broker, real-time server logs/stats/player events, backup and restore, scheduled tasks, controlled filesystem-write architecture, file manager, player management, plugin/mod management, and notifications.

RCON future work MUST use a pluggable command-broker design with Docker-exec as the default transport; a permanent TCP connection pool is not a prerequisite. All filesystem mutation remains blocked by D-8 until its security boundary is decided.

### Phase 2B — Integrations

After Phase 2A foundations: API keys, outbound webhooks, external integrations, and system-event consumers. These are later consumers and MUST NOT gate the core server-management path.

### Later product surfaces

Creation presets/wizard, mod-loader/mod selection, Velocity/networking, Geyser/Bedrock, mobile/player surfaces, and other deferred product work remain later milestones. No detailed design is normative until its product and security decisions are made.

---

## 17. Future architecture by phase

Only current behavior is normative unless a future item is explicitly marked `[ACCEPTED]`. Unresolved features remain high-level proposals; implementation details require a later product and architecture decision.

### 17.1 Phase 1.5 — Identity / Onboarding `[IMPLEMENTED IN PART]`

**Implemented:** challenge-bound Google OIDC login and account linking, nullable provider-compatible password storage, server visibility (`OPEN`/`REQUEST`/`PRIVATE`), access requests, requestable discovery, and MOD PBAC.

**Optional:** GitHub OAuth; invitation flows and alternate registration modes; magic-link authentication when SMTP is deliberately enabled.

**Deferred:** Microsoft Minecraft linking and offline UUID linking until player-management consumers and identity ownership rules are defined. The presence of `minecraftUUID`, `minecraftName`, and `minecraftVerified` columns does not mean linking is implemented.

The implemented Google flow verifies the ID token locally, requires a configured audience and verified email, binds the credential to a single-use backend challenge, and forbids silent email-match linking. Future providers MUST preserve equivalent token binding and explicit linking confirmation.

### 17.2 Phase 2A — Platform foundations `[PROPOSED]`

Audit log and an internal framework-neutral system-event model are the required foundations. Add a scheduler only when the first real feature needs recurring work; no scheduler dependency is required merely to complete this phase.

### 17.3 Phase 3 — Core operations `[PROPOSED]`

Expected areas: RCON/console command broker; real-time server logs, stats, and player events; backup and restore; scheduled tasks; controlled filesystem writes; file manager; player management; plugin/mod management; and notifications.

The future RCON design is a command broker/service with pluggable transport; Docker-exec is the default transport because the backend is intentionally off the Minecraft container network. TCP RCON is optional, not a permanent connection-pool requirement.

All filesystem mutation remains blocked by D-8. The backend data mount stays read-only until the write boundary is selected and implemented.

### 17.4 Phase 2B — Integrations `[PROPOSED]`

Later consumers of Phase 2A: API keys, outbound webhooks, external integrations, and system-event consumers. These MUST NOT block core Minecraft management.

### 17.5 Later product surfaces `[PROPOSED]`

Creation presets/wizard, mod-loader/mod selection, Velocity/networking, Geyser/Bedrock, mobile/player surfaces, and other deferred product work remain later milestones. No detailed design is normative until its product and security decisions are made.

### 17.6 Backend 2.0 — Elysia 2 `[PROPOSED — FUTURE]`

This is a post-feature-completion migration milestone, not current preparation work. It may start only after all of the following are true:

1. The intended Nest backend feature set is complete.
2. Deferred functionality is explicitly documented.
3. SPEC, roadmap, and supporting docs are synchronized.
4. Stable API and error contracts exist.
5. Real Docker lifecycle testing exists.
6. Framework-neutral black-box HTTP and WebSocket conformance coverage exists.
7. The final Nest baseline is tagged and frozen.
8. Elysia 2 is stable enough for the required deployment.
9. The required Elysia ecosystem works reliably on the selected Bun runtime.

**Migration rule: PARITY FIRST.** The initial port MUST preserve routes, HTTP statuses, response bodies, error codes, cookies, auth/session semantics, CORS/CSRF behavior, database schema/migrations, Docker lifecycle semantics, container labels, and WebSocket protocol semantics. `protocolVersion` MUST NOT change merely because the framework changes. Performance, memory, image-size, startup, and ergonomics improvements are secondary to black-box compatibility and operational correctness.

---

## 18. Security requirements for future features

### 18.1 Password hashing `[DECISION REQUIRED: D-9]` — Foundation / Next

- **Reality:** passwords are hashed with bcrypt cost 10; DTO validation allows up to 128 JavaScript characters, while bcrypt accepts only the first 72 UTF-8 bytes.
- **Required decision:** choose and document a migration-safe policy that measures UTF-8 bytes and never silently truncates or treats two passwords sharing a 72-byte prefix as distinct.
- The implementation choice (pepper pre-hash, strict byte limit, or a deliberately planned Argon2id migration) remains open. This is a Foundation / Next hardening item, not a reason to change framework now.

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

## 19. Decision register (status as of this implementation)

| # | Decision | Status | Options / record | Blocking |
|---|----------|--------|------------------|----------|
| D-1 | Hosted-frontend cross-origin auth (§8.5) | **ADOPTED** | CHIPS `Partitioned` cookies primary; PKCE authorization-code flow with memory-only bearer access token is the reserved fallback and is not implemented | Complete hosted-browser compatibility |
| D-2 | Setup token mandatory? (§8.1) | **ADOPTED** | `X-Setup-Token` required; configured `SETUP_TOKEN` or one-time generated/logged bootstrap token | Stable v1 |
| D-3 | Deletion semantics (§11.6) | **ADOPTED** | v1 retains host data; guarded manual cleanup; tombstone/backup/sweeper deferred | Stable v1 documentation |
| D-4 | Shipped socket default (§10.2) | **ADOPTED** | Compose uses rootful Docker by default; rootless Docker and Podman are optional host-local Unix-socket overrides | Compose config |
| D-5 | OAuth token binding (§17.1) | **ADOPTED** | Single-use hashed 5-minute backend challenge carried through Google's `nonce`, atomically consumed; PKCE remains a frontend requirement for future authorization-code flows | Complete for implemented Google flow |
| D-6 | WS auth primary path (§8.6) | **OPEN** | Cookie vs ticket primary after D-1 / when cookies unavailable | Phase 3 real-time |
| D-7 | Identity linking policy (§17.1) | **ADOPTED** | Silent email-match linking is forbidden; provider login returns `LinkConfirmationRequired`; linking requires an authenticated session or explicit re-authentication | Complete for implemented Google flow |
| D-8 | Write architecture (§10.4) | **OPEN** | sidecar vs rw mount with path module vs per-op exec | Phase 3 write features |
| D-9 | Password hashing (§18.1) | **OPEN** | Pepper pre-hash vs byte-limit vs Argon2id; current bcrypt 72-byte behavior must be resolved | Foundation / Next |
| D-10 | Identity normalization (§8.8) | **ADOPTED** | canonical lowercase at write: trim + lowercase username at registration and provider-generated usernames; login keeps lowercasing; migration adds case-collision preflight (fail loudly on `Bob`+`bob` pairs, manual resolution, no silent data loss) | Stable v1 |
| D-11 | License (B-P3-10) | **ADOPTED** | MIT — LICENSE file committed (b5df536); reconcile package.json/SPEC/README/PWA metadata; no license-type change | Any public release |

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

1. **Never existed** (claimed as current in the previous document): `nestjs-pino` logging (actual: `ConsoleLogger`), `@nestjs/schedule` cron (absent), `pendingDeleteAt` + deletion cleanup, `discordWebhook`, future-model tables, `/users` endpoints, `/versions`, version-update and icon endpoints, `/panel/logo`, `/system/stats` REST, GitHub OAuth, magic links, Minecraft-linking endpoints, strict/standard/relaxed rate-limit tiers, per-username brute-force counter, refresh session metadata, 24h sliding refresh renewal, rootless-Docker default, `${XDG_RUNTIME_DIR}` Compose default, and the SvelteKit frontend.
2. **Implemented differently than described**: refresh rotates on every use (not within 24h of expiry); production `sameSite` is `none` (docs claimed `lax`); PKs are `randomUUID` (not cuid); ban deletes sessions (spec claimed it does not); 422 error code is `InsufficientResources` (not per-resource codes); `DbExceptionFilter` emits `{message}` only (spec claimed NestJS default shape); delete returns 202 for a synchronous op; RCON is `docker exec rcon-cli`, not TCP RCON; the `mc-{id}` container name (not `minepanel-mc-{id}`).
3. **Unsafe examples removed**: `startsWith(serverDir)` path check (§18.2), "128 chars is safe with bcrypt" (§18.1), `SameSite=None; Secure` described as sufficient (§8.5), `tokeninfo` + "optional audience check" OAuth flow (§17.1), silent email-match linking (§17.1), "production-ready"/"100% complete" claims (§2).
4. **Product truth**: frontend stack corrected to React 19 + Vite 7 + Tailwind 4; version strings reconciled as inconsistent (B-P2-6). The repository is MIT-licensed (LICENSE file; D-11 adopted), and `unpublished` context in earlier drafts is obsolete — `package.json` declares `"license": "MIT"`.

## Appendix B — Validation note

This specification was validated against commit `f638031e737117264455132de0668c0cbb9528c4` on 2026-08-27. The audit covered the canonical docs/config, schema and migrations, bootstrap and module composition, auth/identity/guards, admin and access-control paths, Docker and lifecycle services, gateway/adapters, controllers/DTOs, unit and e2e inventories, Compose, Dockerfile, and CI workflow. Local unit verification at this revision reported 40 suites and 729 tests passing; the repository contains 13 e2e suites with 91 test cases, which require the live PostgreSQL setup described in §14.2. No claim of a full CI or real-daemon lifecycle run is made here.
