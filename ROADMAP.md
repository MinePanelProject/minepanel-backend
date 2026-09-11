# MinePanel — Roadmap

## 1. Purpose, authority and scope

This file is the canonical human-readable roadmap for the MinePanel project: what is shipped, what
is next, what is committed but unscheduled, what is conditional, and what is only exploratory.

| Question | Authoritative source |
|----------|----------------------|
| What must the system do (contracts, invariants, decisions) | [`SPEC.md`](./SPEC.md) |
| How the current system is built | [`ARCHITECTURE.md`](./ARCHITECTURE.md) |
| What is planned, deferred or conditional | this file |
| How to build, test and validate changes | [`DEVELOPMENT.md`](./DEVELOPMENT.md) |
| Machine-readable progress published to the website | [`roadmap.json`](./roadmap.json) |

**Scope:** the MinePanel platform as a whole. The hosted dashboard roadmap is owned by
`minepanel-pwa`; the website (`minepanel-site`) owns no roadmap content and only renders published
roadmap data server-side.

### 1.1 Relationship to `roadmap.json`

`roadmap.json` is the **published projection** of this file, not a second source of truth. It is
fetched at request time by `minepanel-site` (`src/lib/data/endpoints.ts`, `master` branch of this
repository), so it stays machine-readable and carries no presentation content.

* Progress items and their `done` flags live in `roadmap.json`.
* Rationale, dependencies, gates and acceptance conditions live in this file.
* A change to planned work updates both in the same commit.
* Never rename or repurpose an existing `phases[].id`: published ids are consumed by the website.

Published id → `roadmap.json` phase name → section of this document:

| `id` | Published name | Section here |
|------|----------------|--------------|
| `1` | Foundation — v1.0 RC | §3.1 |
| `next` | Stable-v1 Hardening | §3.2 |
| `1.5` | Identity / Onboarding | §3.3 |
| `2a` | Platform Foundations | §4 |
| `3` | Core Operations | §5 |
| `2b` | Integrations | §7.1 |
| `identity-future` | Optional Follow-ons | §7.2 |
| `later` | Product Surfaces | §7.3 |
| `backend-2` | Elysia 2 | §6.1 |
| `mcp-server` | MCP / Agent Adapter | §6.2 |

The phase headings in this document are prose titles; the published names above are what the website
renders. Keep both in step.

### 1.2 Status vocabulary

This file describes **future and planned work**. It is never evidence that functionality currently
exists: `Completed` records work that has shipped and been verified against the code, while every
other status lists intent only. The currently implemented behavior is evidenced by production code,
schema, migrations, tests and deployment configuration, and the required behavior is defined by
[`SPEC.md`](./SPEC.md) — see its §1 for how to classify a disagreement between the two.

| Status | Meaning |
|--------|---------|
| `Completed` | Shipped and verified at the current revision. |
| `Next` | Immediate committed milestone. |
| `Committed` | Agreed scope, not scheduled. |
| `Conditional` | Starts only if an external requirement or a pending decision changes. |
| `Exploratory` | Idea under discussion; not approved scope, never a completion blocker. |

No deadlines, versions or release names are implied anywhere in this file. MinePanel has no stable
release; `edge` from `master` is the current channel (see [`docs/deployment.md`](./docs/deployment.md)).

---

## 2. Where the project stands

| Track | State | Record |
|-------|-------|--------|
| Backend — Foundation / v1.0 release candidate | Completed | `roadmap.json` phase `1` |
| Backend — Stable-v1 hardening (B-NEXT-1…7) | Completed | `roadmap.json` phase `next` (7/7) |
| Backend — Identity / Onboarding, core scope | Completed | `roadmap.json` phase `1.5` |
| Backend — Platform foundations | Next | `roadmap.json` phase `2a` |
| Backend — Core operations | Committed | `roadmap.json` phase `3` |
| Backend — Integrations | Committed | `roadmap.json` phase `2b` |
| Backend — Backend 2.0, Elysia 2 | Conditional | `roadmap.json` phase `backend-2`; §6.1 |
| Backend — MCP Server / Agent Interface | Conditional | `roadmap.json` phase `mcp-server`; §6.2 |
| Hosted dashboard — discovery shell, hosted auth, management surface | Completed | `minepanel-pwa/roadmap.json` phases `1`, `1.5`, `2` |
| Hosted dashboard — operations surface | Committed | `minepanel-pwa/roadmap.json` phase `3` |
| Mobile client / player portal | Exploratory | no repository and no `roadmap.json` phase exist |

No item is currently in progress: `roadmap.json` reports `completed` for `1`, `next` and `1.5` and
`planned`/`future` for the rest.

---

## 3. Completed

### 3.1 Foundation — v1.0 release candidate (phase `1`)

JWT cookie sessions with atomic refresh rotation, TOTP with backup codes, transactional first-admin
bootstrap, roles and MOD PBAC, admin user management with last-admin protection, the Docker boundary
with managed-container guardrails, server lifecycle with graceful RCON stop, resource admission and
startup reconciliation, server visibility with access requests, host metrics over WebSocket, unit +
PostgreSQL e2e suites, CI/CD with GHCR `edge`/stable channels, and the Compose deployment with Caddy
and boot migrations. Contracts: [`SPEC.md`](./SPEC.md) §4, §6, §7, §8, §9, §10, §11.

### 3.2 Stable-v1 hardening (phase `next`)

Stable API error envelope with machine codes and request IDs; explicit 72 UTF-8-byte password
semantics; removal of dead login-throttle configuration; bounded progressive login-abuse protection;
Minecraft CPU/PID isolation; one required reproducible `MINECRAFT_IMAGE` identity; trusted real-Docker
lifecycle coverage in CI. Contracts: SPEC §12, §13, §14, §18.1.

### 3.3 Identity / Onboarding — core scope (phase `1.5`)

Challenge-bound Google login and account linking, nullable provider-compatible password storage,
server visibility (`OPEN`/`REQUEST`/`PRIVATE`) with request/approval workflows, requestable-server
discovery, and MOD granular permissions. Contracts: SPEC §8.5, §8.8, §9.

### 3.4 Hosted dashboard (phases `1`, `1.5`, `2` of `minepanel-pwa`)

Discovery shell with multi-backend registry, hosted authentication (CHIPS partitioned cookies +
Web Locks), and the authenticated management surface (lifecycle, access control, admin users, MOD
grants, host metrics). Contracts: `minepanel-pwa/SPEC.md`.

---

## 4. Next — Platform foundations (phase `2a`)

Framework-neutral foundations that later operations and integrations consume, and that nothing else
can replace.

| Item | Objective | Repository | Dependencies | Acceptance condition | Status |
|------|-----------|------------|--------------|----------------------|--------|
| Append-only audit log | Durable record of privileged mutations (auth, admin, lifecycle, access, and later file/backup operations) | `minepanel-backend` | None | Every privileged mutation path writes an entry; application code never updates or deletes an entry | Committed (next) |
| Framework-neutral system-event model | One internal event model for later consumers (webhooks, notifications, realtime) that carries no HTTP/WebSocket framework types | `minepanel-backend` | None | Services emit events; an event can be consumed without an HTTP request in flight | Committed (next) |
| Scheduler | In-process recurring work | `minepanel-backend` | First real recurring feature | Added only when a concrete feature requires it; no scheduler dependency exists today | Conditional |

API keys, outbound webhooks and external integrations are **consumers** of these foundations (§7.1) and
MUST NOT gate the core Minecraft management path.

---

## 5. Committed — Core operations (phase `3`)

Item order is the published order in `roadmap.json`; it expresses dependency order, not a schedule.
No item has a normative design today: each requires its own product and architecture decision before
implementation, and none is implemented in the current revision.

| # | Item | Depends on / constraint |
|---|------|-------------------------|
| 1 | RCON / console command broker (Docker-exec default transport) | Chosen design is a broker with pluggable transport; the backend stays off the Minecraft container network. TCP RCON and credential ownership remain undecided |
| 2 | Real-time server logs, stats and player events | Decision register **D-6** (cookie handshake vs one-time ticket) |
| 3 | Backup and restore | Decision register **D-8**; archive/restore safety requirements in SPEC §18.3, §18.4 |
| 4 | Scheduler foundation | Phase 2A scheduler item |
| 5 | Scheduled tasks | Item 4 |
| 6 | Controlled filesystem-write architecture | Decision register **D-8** — this item *is* that decision, implemented |
| 7 | File manager | Items 3, 6; path-safety algorithm in SPEC §18.2 |
| 8 | Player management | Microsoft Minecraft linking / offline UUID rules (§7.2) |
| 9 | Microsoft Minecraft account linking (player-management consumers) | Identity ownership rules (§7.2) |
| 10 | Offline player UUID linking with explicit offline-mode identity rules | Item 9 |
| 11 | Plugin and mod management | Items 6, 7; archive safety SPEC §18.3 |
| 12 | Notifications | Phase 2B consumers; no `servers.discordWebhook` column exists today |

Open decisions and accepted engineering items that constrain this phase are listed in §8.

---

## 6. Conditional — post-feature-completion tracks

Neither track is current work, and neither is a completion blocker. Both are `future` in
`roadmap.json` and none of their items has a normative design today.

### 6.1 Backend 2.0 — Elysia 2 (phase `backend-2`)

A parity-first port from NestJS to Elysia 2 after the Nest baseline is frozen. It is **not** current
preparation work and no Elysia code exists in the repository.

Every start gate is required:

1. The intended Nest backend feature set is complete.
2. Deferred functionality is explicitly documented.
3. SPEC, roadmap and supporting docs are synchronized.
4. Stable API and error contracts exist — satisfied (SPEC §12).
5. Trusted real-Docker lifecycle coverage exists — satisfied (SPEC §14.2).
6. Framework-neutral black-box HTTP and WebSocket conformance coverage exists.
7. The final Nest baseline is tagged and frozen.
8. Elysia 2 is stable enough for the required deployment.
9. The required Elysia ecosystem works reliably on the selected Bun runtime.

**Migration rule — parity first.** The port preserves routes, HTTP statuses, response bodies, error
codes, cookies, auth/session semantics, CORS/CSRF behaviour, database schema and migrations, Docker
lifecycle semantics, container labels and WebSocket protocol semantics. `protocolVersion` MUST NOT
change because the framework changed. Performance, image size, startup time and ergonomics are
secondary to black-box compatibility and operational correctness.

### 6.2 MCP Server / Agent Interface (phase `mcp-server`)

| Item | Objective | Dependencies | Acceptance condition | Status |
|------|-----------|--------------|----------------------|--------|
| MCP boundary adapter | Thin, client-agnostic MCP server over the application/domain layer for agent clients | Phase 6.1 (Elysia 2) complete | MCP capabilities are composed from the same application services as the HTTP API — no direct Docker, filesystem or database access | Conditional |
| Scoped MCP auth | Authorization for agents, including per-server restrictions | Existing authorization boundary | Every MCP operation passes MinePanel authorization; read / control / destructive capabilities are separable | Conditional |
| Capability surface | Server state, logs, metrics, players, backups, node resources, lifecycle and console operations | Phase 3 core operations; decision D-8 for anything touching server data | Each capability exists as an application service first and is exposed, not reimplemented | Conditional |
| Structured diagnostics | Higher-level composed tools such as `diagnose_server` and `safe_restart` | Capability surface above | Tools compose existing services and add no privileged path | Conditional |
| Audit attribution | Agent-triggered mutations are attributable | Phase 2A audit log | Every agent-triggered mutation carries its originating principal | Conditional |
| Client compatibility | Generic MCP clients, with Hermes as an example integration | MCP boundary adapter | A generic MCP client can connect without MinePanel-specific client code | Conditional |

Binding constraints for this track are recorded in `SPEC.md` §17.6: MCP is a boundary adapter over the
application/domain layer, never direct Docker, filesystem or database access; it MUST NOT become a new
privileged path; and it may start only after the Elysia 2 port. **MCP is not implemented** — no MCP
server, endpoint or transport exists in the repository today, and this section is not evidence that
it does.

---

## 7. Later

### 7.1 Committed, unscheduled

| Item | Track | Notes |
|------|-------|-------|
| API keys | Backend phase `2b` | Consumer of the system-event model |
| Outbound webhooks | Backend phase `2b` | Consumer of the system-event model |
| External integrations | Backend phase `2b` | Must not gate core management |
| System-event consumers | Backend phase `2b` | Internal consumers of Phase 2A events |
| Dashboard operations surface | `minepanel-pwa` phase `3` | Console, backups, file manager, player/plugin management, notifications — tracks the backend Phase 3 API |

### 7.2 Optional identity follow-ons (phase `identity-future`)

GitHub OAuth, invitation/alternate registration modes, and magic-link authentication (only when SMTP
is deliberately enabled) are optional. Microsoft Minecraft linking and offline UUID linking are
deferred until player-management consumers and identity ownership rules — provider, verification,
unlinking and offline-mode semantics — are defined.

Columns `users.githubId`, `users.minecraftUUID`, `users.minecraftName` and `users.minecraftVerified`
exist in the schema but no code path writes them: their presence is not evidence of an implemented
linking flow (SPEC §6.1).

### 7.3 Exploratory — not committed scope

`Creation presets and server wizard`, `mod-loader/mod selection`, `Velocity networking`,
`Geyser/Bedrock support`, and `mobile client / player portal` (phase `later` in `roadmap.json`) are
ideas under discussion. No phase number, design, dependency or deadline is assigned, and none is a
completion blocker. SPEC §3 previously labelled the mobile/player surface "Phase 6"; no such phase
exists in `roadmap.json` and the label is withdrawn.

**B-COMPAT-1 — hosted-browser expansion — conditional.** It starts only if product requirements move
beyond the supported hosted-browser contract (public HTTPS PWA, secure context, CHIPS partitioned
cookies, Web Locks). Any future browser-based OAuth authorization-code flow MUST use PKCE and receive
a fresh security/design review against then-current guidance. PKCE is not implemented, is not a
Stable-v1 gap, and is advertised as unsupported by `GET /api/info` (SPEC §8.5).

---

## 8. Engineering backlog tracked outside the roadmap

Accepted internal improvements with no product commitment and no milestone gate. Contracts and
status markers for the implemented behaviour they touch live in SPEC §4, §8.9, §13.1 and §15.

| ID | Item | Status |
|----|------|--------|
| B-P2-4 | Document/restrict inter-container traffic on the managed Minecraft bridge; per-server networks remain proposed | Open |
| B-P2-5 | Run the backend container as a non-root user with `group_add` for the Docker group instead of `user: root` | Open |
| B-P2-6 | Version-string consistency (`package.json` `1.0.0`, `PANEL_VERSION` default `1.0`, Swagger fallback `N/A`) and backend container hardening (`cap_drop: [ALL]`, `read_only: true`, `tmpfs: /tmp`) | Open |
| B-P2-8 | `system.stats.usedRamMb` combines Docker `info.MemTotal` with the backend's `os.freemem()`; a runtime whose `/proc/meminfo` is cgroup-scoped rather than host-wide would skew the derived value. Display telemetry only — never an admission or authorization input | Open |
| B-P2-10 | Replace manual production preflight with a declarative config schema (`ConfigService` has none) | Open |
| B-P3-3 | Swagger UI at `/docs` is public in current builds | Open |
| B-P3-4 | A MOD with a global `SERVER_LIFECYCLE` grant still gets 404 on a `PRIVATE` server without an approved access row | Open |
| B-P3-5 | The 2FA failure lockout is in-process memory and is lost on restart (accepted: single-instance) | Accepted |
| B-P3-10 | License reconciliation (D-11 adopted: MIT) across `package.json`, SPEC, README and PWA metadata | Adopted |
| D-6 | Primary WebSocket auth path (cookie handshake vs one-time ticket) | Open |
| D-8 | Write architecture for data-tree mutations (sidecar vs read-write mount vs per-operation exec) | Open |

---

## 9. Documentation maintenance

| Document | Update when |
|----------|-------------|
| [`SPEC.md`](./SPEC.md) | Observable product behaviour, contracts or invariants change |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | System structure, component boundaries or data flows change |
| `ROADMAP.md` (this file) | Planned work changes state, scope, dependencies or gates |
| [`roadmap.json`](./roadmap.json) | Progress items change — same commit as this file |
| [`DEVELOPMENT.md`](./DEVELOPMENT.md) | Developer workflow, tooling, environment or validation gates change |
| `docs/*.md` | The domain they describe changes; keep them consistent with SPEC and ARCHITECTURE |
