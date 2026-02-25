# Access Control Architecture

> Phase 1.5 — implement after Docker + Servers are working.

---

## Overview

Access control in MinePanel operates at two independent levels:

1. **Panel account** — global, open registration. One account per panel instance.
2. **Server access** — per-server, controlled by the admin.

These are separate concerns. A user having a panel account does not automatically grant access to any specific server.

---

## Guard Pipeline

Every authenticated request passes through guards in this order:

```
JwtAuthGuard        → validates access token, sets req.user = { id, username, role }
RolesGuard          → checks @Roles(): ADMIN bypasses, USER gets 403 on admin routes
PermissionsGuard    → for MOD: checks ModPermission table against @RequiresPermission()
```

ADMIN skips `PermissionsGuard` entirely — they always have full access.
Routes without `@Roles()` pass through `RolesGuard` freely.
Routes without `@RequiresPermission()` pass through `PermissionsGuard` freely.

---

## Server Access Model

Each server has an `accessType` field:

| accessType | Behaviour                                                   |
|------------|-------------------------------------------------------------|
| `OPEN`     | All authenticated panel users can see and access it        |
| `REQUEST`  | User submits a request, admin approves before access       |
| `PRIVATE`  | Only users explicitly assigned by admin can see/access it  |

### ServerAccess table

Links users to servers for `REQUEST` and `PRIVATE` servers.

| Field     | Type     | Notes                   |
|-----------|----------|-------------------------|
| id        | String   | cuid PK                 |
| userId    | String   | FK → User               |
| serverId  | String   | FK → Server             |
| status    | Enum     | PENDING \| APPROVED     |
| createdAt | DateTime |                         |

For `OPEN` servers no row is needed — visibility is implicit.
For `REQUEST`/`PRIVATE` servers, a row with `status: APPROVED` is required.

### Request flow (REQUEST servers)

```
user    →  POST /servers/:id/request-access
server  →  creates ServerAccess row with status: PENDING
admin   →  GET /servers/:id/access-requests  (sees pending list)
admin   →  POST /servers/:id/access-requests/:userId/approve
server  →  updates status to APPROVED
user    →  can now see and access the server
```

---

## MOD Granular Permissions (PBAC)

Simple role checks are insufficient for MODs — an admin needs to assign specific capabilities per MOD, optionally scoped to a specific server.

### Permission enum

```
SERVER_LIFECYCLE      // start, stop, restart servers
SERVER_CONFIG         // modify server settings (port, difficulty, gamemode, etc.)
PLUGIN_MANAGEMENT     // install/remove plugins
WHITELIST_MANAGEMENT  // add/remove players from whitelist
USER_MANAGEMENT       // view/manage users assigned to a server
```

### ModPermission table

| Field      | Type     | Notes                                       |
|------------|----------|---------------------------------------------|
| id         | String   | cuid PK                                     |
| userId     | String   | FK → User (role must be MOD)                |
| permission | Enum     | see above                                   |
| serverId   | String?  | FK → Server (null = permission on all servers) |
| createdAt  | DateTime |                                             |

### Usage in code

```ts
@Roles(Role.ADMIN, Role.MOD)
@RequiresPermission(Permission.SERVER_LIFECYCLE)
@Post(':id/start')
async startServer(...) {}
```

Guard logic for a MOD hitting this route:
1. `RolesGuard` — role is MOD, passes
2. `PermissionsGuard` — checks `ModPermission` table for `{ userId, permission: SERVER_LIFECYCLE }`
   - If `serverId` is null → permission applies to all servers → allow
   - If `serverId` matches → allow
   - Otherwise → 403

---

## User Account Status

Optional global gate — add if the admin wants to approve/ban users at the panel level.

Add `status: PENDING | ACTIVE | BANNED` to the `User` model.

A guard (or middleware) checks `status === ACTIVE` on every authenticated request before any other check. A banned user is rejected even if their JWT is valid.

For now: registration is open and all new users are `ACTIVE` by default. This field only matters if the feature is enabled in setup settings (future).

---

## Minecraft Account Linking

Users can link their Minecraft account to their panel profile.

Fields already on `User` model:
- `minecraftUUID` — unique Mojang UUID
- `minecraftName` — in-game username

Endpoint to add: `PATCH /auth/profile`

```ts
// body
{ minecraftUUID: string, minecraftName: string }
```

Required for whitelist automation (Phase 3): when a user with an approved `ServerAccess` record links their Minecraft account, they can be automatically added to that server's whitelist.
