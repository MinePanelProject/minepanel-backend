# Access Control Architecture

> Phase 1.5 Round 1 — per-server authorization spine shipped.

---

## Overview

Access control in MinePanel operates at two independent levels:

1. **Panel account** — global, open registration. One account per panel instance.
2. **Server access** — per-server, controlled by the admin.

These are separate concerns. A user having a panel account does not automatically grant access to any specific server.

---

## Guard Pipeline

Every HTTP request passes through guards in this order:

```
CsrfOriginGuard  → validates Origin on mutating requests
JwtAuthGuard     → validates access token, sets req.user = { id, username, role }
RolesGuard       → checks @Roles(): ADMIN bypasses, USER gets 403 on admin routes
PermissionsGuard → for MOD: checks mod_permissions table against @RequiresPermission()
ThrottlerGuard   → rate limiting
```

- `CsrfOriginGuard` rejects cross-site mutating requests that present an Origin header not matching the canonical frontend origin or the API's own origin.
- `JwtAuthGuard` also enforces current `status` and `role` by re-reading the user row on every verification; PENDING/BANNED users are rejected here, and a `mustChangePassword` temporary token is restricted to the password-change endpoint. DB-unavailable failures fail closed to `401`.
- `RolesGuard` passes routes with no metadata. ADMIN bypasses any `@Roles()` list. Missing principal or non-matching role gets `403`.
- `PermissionsGuard` passes routes with no `@RequiresPermission()` metadata. ADMIN bypasses. MOD users get one indexed existence query against `mod_permissions` (global `server_id IS NULL` or scoped to `request.params.id`). DB failures fail closed to `503 ServiceUnavailableException('Permission check unavailable')`.
- `ThrottlerGuard` applies global rate limits last.

---

## Server Access Model

Each server has an `accessType` field:

| accessType | Behaviour                                                  |
|------------|------------------------------------------------------------|
| `OPEN`     | All authenticated panel users can see and access it        |
| `REQUEST`  | User submits a request, admin approves before access       |
| `PRIVATE`  | Only users explicitly assigned by admin can see/access it  |

### ServerAccess table

Links users to servers for `REQUEST` and `PRIVATE` servers.

| Field      | Type     | Notes                                              |
|------------|----------|----------------------------------------------------|
| id         | String   | UUID PK (Drizzle `crypto.randomUUID()` default)    |
| userId     | String   | FK → User (cascade delete)                         |
| serverId   | String   | FK → Server (cascade delete)                       |
| status     | Enum     | PENDING \| APPROVED                                |
| createdAt  | DateTime | request timestamp                                  |
| approvedAt | DateTime | set atomically on approval (null for PENDING)      |

A total CHECK enforces: `(status='PENDING' AND approvedAt IS NULL) OR (status='APPROVED' AND approvedAt IS NOT NULL)`.

For `OPEN` servers no row is needed — visibility is implicit.
For `REQUEST`/`PRIVATE` servers, a row with `status: APPROVED` is required for visibility and PBAC.

### Request flow (REQUEST servers)

```
user    →  POST /servers/:id/request-access
server  →  creates ServerAccess row with status: PENDING (insert-on-conflict, race-safe)
admin   →  GET /servers/:id/access-requests  (sees pending list)
admin   →  POST /servers/:id/access-requests/:userId/approve
server  →  updates status to APPROVED atomically
user    →  can now see and access the server
```

- `POST /:id/request-access` returns `409` for admins, `OPEN` servers, duplicate pending requests, and already-approved rows; returns `404` for PRIVATE servers (non-disclosure).
- `GET /:id/my-access-request` returns the user's own projection or `404` (no row / OPEN server / PRIVATE server hidden).
- `GET /:id/access-requests` (ADMIN) lists pending requests joined to sanitized user fields; `409` for non-REQUEST servers.
- `POST /:id/access-requests/:userId/approve` (ADMIN) approves an existing PENDING row, or for PRIVATE servers inserts an APPROVED row; `404` when no request exists on a REQUEST server, `409` when already approved.
- `DELETE /:id/access-requests/:userId` (ADMIN) deletes the row (reject or revoke); `404` when no row exists.

All state transitions are race-safe: the write uses `INSERT ... ON CONFLICT DO NOTHING RETURNING` or a conditional `UPDATE ... WHERE status='PENDING'`, and zero-row results trigger a re-read before returning any conflict/not-found response.

---

## MOD Granular Permissions (PBAC)

Simple role checks are insufficient for MODs — an admin needs to assign specific capabilities per MOD, optionally scoped to a specific server.

### Permission enum

```
SERVER_LIFECYCLE      // start, stop, restart servers
SERVER_CONFIG         // modify server settings (future route)
PLUGIN_MANAGEMENT     // install/remove plugins (future route)
WHITELIST_MANAGEMENT  // add/remove players from whitelist (future route)
USER_MANAGEMENT       // view/manage users assigned to a server (future route)
FILE_MANAGER          // reserved enum only, no route in this round
```

### ModPermission table

| Field      | Type     | Notes                                             |
|------------|----------|---------------------------------------------------|
| id         | String   | UUID PK                                           |
| userId     | String   | FK → User (role must be MOD; cascade delete)      |
| permission | Enum     | see above                                         |
| serverId   | String?  | FK → Server (null = global; cascade delete)       |
| createdAt  | DateTime |                                                   |

Unique constraints:
- `(userId, permission)` where `serverId IS NULL` (partial unique index)
- `(userId, permission, serverId)` for scoped grants

Redundant global+scoped rows are allowed and combine with logical OR.

### Admin management endpoints

| Method | Path                                | Auth  | Description                              |
|--------|-------------------------------------|-------|------------------------------------------|
| GET    | /admin/users/:id/permissions        | ADMIN | List grants for a user                   |
| POST   | /admin/users/:id/permissions        | ADMIN | Grant a permission (global or scoped)    |
| DELETE | /admin/users/:id/permissions/:permId| ADMIN | Revoke a grant (IDOR-safe via userId)    |

Grants are serialized under `LAST_ADMIN_LOCK_KEY` (7331); the target user must exist and have role `MOD`; a non-null `serverId` must reference an existing server. Duplicate exact-scope grants return `409` (including concurrent attempts). Revocation deletes `WHERE id AND userId`, preventing cross-user revocation.

### Role transition invariant

`AdminService.updateRole` deletes **all** `mod_permissions` rows for the user in the same transaction as the role change, under the same `LAST_ADMIN_LOCK_KEY`. This keeps grants aligned with the user's actual role. PENDING/BANNED status changes do not delete grants — `AccessTokenService` already blocks those users.

### Usage in code

```ts
@Roles('ADMIN', 'MOD')
@RequiresPermission('SERVER_LIFECYCLE')
@Post(':id/start')
async startServer(...) {}
```

Guard logic for a MOD hitting this route:
1. `RolesGuard` — role is MOD, passes
2. `PermissionsGuard` — checks `mod_permissions` table for `{ userId, permission: SERVER_LIFECYCLE }`
   - If `serverId` is null → permission applies to all servers → allow
   - If `serverId` matches `request.params.id` → allow
   - Otherwise → 403

---

## User Account Status

`User.status` is enforced by `AccessTokenService.verify` on every authenticated request. A banned or pending user is rejected even if their JWT is valid.

| Status  | Behaviour                                    |
|---------|----------------------------------------------|
| ACTIVE  | Full access                                  |
| PENDING | `403 { error: 'AccountPending' }`            |
| BANNED  | `403 { error: 'AccountBanned' }`             |

Registration defaults to `ACTIVE` unless `REQUIRE_ADMIN_APPROVAL=true`, in which case new users start as `PENDING`.

---

## Minecraft Account Linking

Minecraft account linking is **not implemented**. The schema contains `minecraftUUID`, `minecraftName`, and `minecraftVerified` fields, but no endpoint or service currently writes them. Microsoft Minecraft account linking and offline UUID linking remain deferred future onboarding work; they are not prerequisites for the current server-access implementation.

The future player-management phase may consume linked identities for whitelist automation, but it must define the provider, verification, unlinking, and offline-mode rules before adding an endpoint.

---

## Key IDs

- `LAST_ADMIN_LOCK_KEY` = 7331 (role/status transitions + mod permission grants)
- `LIFECYCLE_LOCK_KEY` = 7332 (server create/start/restart resource admission)
- Migration lock = 7333 (database migrations)

Total DB outage behaviour is unchanged: `JwtAuthGuard`/`AccessTokenService` fail closed to `401` because current role/status cannot be verified without the database.
