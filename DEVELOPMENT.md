# MinePanel Backend — Development Guide

How to work on this repository: environment, commands, local topology, validation gates, and the
cross-repository compatibility rules that constrain changes. This documents the **current** workflow
and is updated when the tooling or gates change.

Read first: [`SPEC.md`](./SPEC.md) for contracts and invariants, [`ARCHITECTURE.md`](./ARCHITECTURE.md)
for the current structure, [`ROADMAP.md`](./ROADMAP.md) before assuming future scope, and
[`AGENTS.md`](./AGENTS.md) for code style and red lines.

---

## 1. Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Bun | `>=1.3.14` (pinned by `packageManager`) | Package manager and production runtime |
| Node.js | 20+ | Development tooling only (`nest start`, Jest, drizzle-kit run under Bun or Node) |
| Docker Engine + Compose plugin | v2 (`docker compose`) | Local PostgreSQL, image builds, real-lifecycle smoke |
| PostgreSQL | 16 | Provided by `docker-compose.dev.yml`; e2e requires a loopback instance |

`bun install --frozen-lockfile` is the supported install; keep `bun.lock` synchronized when adding
dependencies.

---

## 2. Local setup

```bash
bun install
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d   # local PostgreSQL only
bun db:push                                      # sync schema (development)
bun run start:dev                                # nest --watch
```

The API listens on `http://localhost:3000` (global prefix `api`, except `/health`); Swagger UI is at
`http://localhost:3000/docs`.

Direct (non-Compose) execution reads configuration from `.env`. Production behaviour — preflight,
cookie attributes, boot migrations — differs from development; see §4.

### 2.1 Minimal development environment

`.env.example` documents every variable. For a working local API the essentials are:

* `DATABASE_URL` — the `docker-compose.dev.yml` default is
  `postgresql://minepanel:changeme@localhost:5432/minepanel`.
* `JWT_SECRET` — any string ≥ 32 characters.
* `JWT_EXPIRES_IN` — e.g. `15m`.
* `ENCRYPTION_KEY` — exactly 64 hex characters; generate with `openssl rand -hex 32`. Required for
  TOTP secret encryption.
* `CORS_ORIGIN` — the single exact frontend origin (e.g. `http://localhost:5173` for the PWA dev
  server). Wildcards and lists are not supported.
* `MC_DATA_PATH` / `MC_DATA_BIND_SOURCE` / `DOCKER_SOCKET` — required for real Docker operations.

`GOOGLE_CLIENT_ID` is optional; when unset the `googleOAuth` capability is `false` and Google sign-in
is unavailable. `SMTP_*` and `MICROSOFT_*` variables are reserved for future features and are not
read by any code path.

Full variable semantics, including which variables are consumed by the application versus declared
for Compose only, are in `SPEC.md` §13.2 and `.env.example`.

---

## 3. Commands

| Purpose | Command |
|---------|---------|
| Development server | `bun run start:dev` |
| Debug server | `bun run start:debug` |
| Build (Nest + alias rewrite) | `bun run build` |
| Run compiled output | `bun run start:prod` |
| Typecheck | `bun run typecheck` |
| Format + lint (mutates files) | `bun run format`, `bun run lint` |
| Read-only CI check | `bun run lint:ci` |
| Unit tests | `bun run test` |
| Unit tests, CI mode | `bun run test:ci` |
| e2e tests | `bun run test:e2e` |
| Generate a migration | `bun db:generate` |
| Apply migrations | `bun db:migrate` |
| Push schema (development) | `bun db:push` |
| Drizzle Studio | `bun db:studio` |
| Package-script contract | `bun run check:scripts` |
| Deployment/release contract | `bun run check:deployment` |
| Compiled TOTP seam smoke | `bun run smoke:totp` |
| Real-Docker lifecycle smoke | `bun run docker:lifecycle` |

Never run `bun run lint` or `bun run format` in CI — they write to the working tree. CI uses
`bun run lint:ci`.

`bun run build` also runs `scripts/postbuild.mjs`, which rewrites compiled `src/...` import specifiers
for the dist-only runtime; a build that reports rewritten files is normal.

---

## 4. Production behaviour you must not forget locally

* `NODE_ENV=production` triggers `runProductionPreflight` in `src/main.ts` and fails startup on a
  missing/invalid `DATABASE_URL`, `JWT_SECRET` (< 32 chars or the placeholder), empty
  `JWT_EXPIRES_IN`, non-64-hex `ENCRYPTION_KEY`, a `tcp://` or relative `DOCKER_SOCKET`, or a
  `CORS_ORIGIN` that is not a single absolute `https:` (or loopback) origin.
* Production also runs the whole migration chain before the HTTP server listens, under advisory lock
  `7333`. A failing migration prevents the port from opening.
* Session cookies use `Secure; SameSite=None; Partitioned; Path=/` in production and
  `SameSite=Lax` without `Secure`/`Partitioned` in development.
* Docker daemon absence is **not** fatal: the process starts in degraded mode, `/health` returns 503,
  and Docker operations return 503.

---

## 5. Database work

* All tables, enums and inferred row types live in `src/db/schema.ts`. Do not declare a Drizzle table
  anywhere else.
* Schema change → `bun db:generate` produces a numbered SQL file plus journal metadata in `drizzle/`.
  Review the generated SQL; never hand-edit `drizzle/` SQL or the journal.
* Migrations are forward-only. `ALTER TYPE ... ADD VALUE` is safe only under the single-process
  invariant documented in `SPEC.md` §11.7.
* Production applies migrations through `runProductionMigrations`; the `migration` CI job applies the
  full chain to a fresh PostgreSQL 16 database.

---

## 6. Tests and validation

### 6.1 Unit tests

`bun run test` runs Jest over `src/**/*.spec.ts` with mocked `DRIZZLE` and `DOCKERODE` providers. Unit
suites must never connect to PostgreSQL or Docker, and must never read live secrets.

### 6.2 e2e tests

`bun run test:e2e` runs `test/**/*.e2e-spec.ts` against a **live loopback PostgreSQL** and a mocked
Docker boundary. It is guarded by `test/test-database.ts`:

* `TEST_DATABASE_URL` is required, must be a `postgres:` URL on a loopback host, and must not be the
  same target as `DATABASE_URL`.
* `NODE_ENV=production` refuses to run them at all.

Suites create and drop databases on that server, so point `TEST_DATABASE_URL` at a throwaway
instance. Apply migrations to it first (`DATABASE_URL=$TEST_DATABASE_URL bun run db:migrate`).

No e2e suite creates a real Minecraft container. Real Docker coverage lives in
`scripts/docker-lifecycle-smoke.mjs`, exercised by the release-gated `trusted-lifecycle` CI job.

### 6.3 Real-Docker lifecycle smoke

`bun run docker:lifecycle` requires a reachable Docker daemon, a live database, and an immutable
`MINECRAFT_IMAGE` (it refuses `:latest` and any reference without an `@sha256:` digest). It creates an
isolated temporary data root and a unique bridge network, drives create → readiness → graceful RCON
stop → delete, asserts the retained data directory, and cleans up.

### 6.4 What to run before claiming completion

| Change | Minimum validation |
|--------|--------------------|
| Documentation only | Link/path sanity; the contract scripts below if the touched files are validated by them |
| `src/**` behaviour | `bun run lint:ci`, `bun run test:ci`, `bun run build` |
| Database schema or migrations | Above + `bun db:migrate` on a fresh database + `bun run test:e2e` |
| Docker boundary, lifecycle, Compose, Dockerfile | Above + `bun run check:deployment` + `bun run docker:lifecycle` |
| `package.json` scripts | `bun run check:scripts` |
| Anything touching `README.md` or `docs/deployment.md` deployment claims | `bun run check:deployment` |

`check:scripts` and `check:deployment` assert that the documented workflow, image channels, Compose
flags and asset-download instructions still match the repository. Editing `README.md`,
`docs/deployment.md`, `docker-compose.yml`, `.env.example` or `.github/workflows/ci.yml` can break
them even when no application code changes.

CI path filters skip the backend jobs for documentation-only changes (`README.md`, `SPEC.md`,
`ARCHITECTURE.md`, `ROADMAP.md`, `DEVELOPMENT.md`, `AGENTS.md`, `roadmap.json`, `LICENSE`, `docs/**`,
`.github/FUNDING.yml`, `.vscode/**`). Those changes therefore need local validation instead of a green
CI run. Adding a new canonical Markdown file at the repository root means adding it to the workflows'
`paths-ignore` lists, otherwise a documentation commit on `master` would trigger the image build,
trusted lifecycle and publish jobs.

---

## 7. Working across the MinePanel repositories

This repository defines the backend contract consumed by `minepanel-pwa` and referenced by
`minepanel-site`. Two rules keep the repositories consistent:

1. **Capability flags are the compatibility mechanism.** A client feature that depends on new backend
   behaviour must be advertised through `GET /api/info` as a boolean capability (see
   `ARCHITECTURE.md` §8). Clients branch on flags and never on version strings. Adding a flag is
   backward compatible; changing or removing a published flag requires a protocol version decision.
2. **Cross-repository facts must be updated together.** When you change a port, path, environment
   variable name, route, cookie attribute, capability flag, or roadmap item that another repository
   documents or consumes, update that repository in the same work session — in particular
   `minepanel-pwa` (`SPEC.md`, `README.md`, `src/api/types.ts`, `src/api/backend-client.ts`) and
   `minepanel-site` (`src/lib/data/endpoints.ts`, `static/llms.txt`, README).

Roadmap changes are always two files in one commit: [`ROADMAP.md`](./ROADMAP.md) for rationale and
[`roadmap.json`](./roadmap.json) for published progress. Never rename a `phases[].id`.

---

## 8. Documentation maintenance

| File | Update when |
|------|-------------|
| [`SPEC.md`](./SPEC.md) | Observable product behaviour, contracts, status markers or the decision register change |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Modules, boundaries, data flow, trust boundaries or storage model change |
| [`ROADMAP.md`](./ROADMAP.md) + [`roadmap.json`](./roadmap.json) | Planned work changes state, scope or gates |
| `DEVELOPMENT.md` (this file) | Tooling, commands, environment or validation gates change |
| `docs/deployment.md` | Deployment topology, variables, release channels or operator procedures change |
| `docs/servers.md`, `docs/realtime.md`, `docs/auth-architecture.md`, `docs/access-control.md` | The corresponding domain changes |
| [`AGENTS.md`](./AGENTS.md) | Repository conventions or red lines change |

Put durable detail in the canonical document that owns it and link to it from `README.md` instead of
duplicating it. Do not create a new Markdown file when an existing canonical document can hold the
content.
