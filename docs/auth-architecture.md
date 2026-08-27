# Auth Architecture
## The Two Tokens

**Access token** — a signed JWT, short-lived (15 min), stored in an HttpOnly cookie called `access_token`.
- Contains `{ sub, username, role, type: 'access', temporaryAuth? }`; the guard also checks current user status, role, and recovery state in PostgreSQL.
- It is not sufficient to authorize a request by signature alone.

**Refresh token** — a signed JWT, long-lived (7 days by default), stored in an HttpOnly cookie called `refresh_token`.
- Contains `{ sub, type: 'refresh', jti, temporaryAuth? }`.
- The database stores only a SHA-256 digest of the random `jti`; the raw refresh token is never stored.
- Every successful refresh atomically consumes the presented row and inserts a successor.

### Why both?

- Access tokens authorize ordinary requests while the guard re-checks DB-current role/status; refresh tokens provide server-side rotation and revocation.

---

## Flows

### Login — `POST /auth/login`

```
client  →  sends email/password
server  →  verifies password with bcrypt
server  →  generates access token (JWT, signed, 15m)
server  →  generates refresh token (JWT, signed, 7d by default, includes random jti)
server  →  stores SHA-256(jti) for the refresh session
server  →  sets both as HttpOnly cookies
server  →  returns user data (no tokens in body)
```

### Authenticated request (any protected route)

```
browser →  sends request with cookies automatically
server  →  JwtAuthGuard reads access_token cookie directly
server  →  AccessTokenService.verify(token) — shared verifier for HTTP + WebSocket
server  →  sets req.user = { id, username, role }
server  →  controller runs
```

### Token refresh — `POST /auth/refresh`

```
client  →  sends request (browser sends refresh_token cookie automatically)
server  →  verifies refresh JWT purpose, subject, jti, and expiry
server  →  checks the refresh row by SHA-256(jti) and current user state
server  →  atomically deletes the presented row and inserts a successor
server  →  generates new access token and sets both cookies
```

Concurrent use of the same refresh token has exactly one winner. Missing, malformed, expired, wrong-purpose, or replayed tokens return 401 machine codes.

### Logout — `POST /auth/logout`

```
client  →  sends request (authenticated, so access_token cookie needed)
server  →  reads refresh_token cookie
server  →  finds + deletes matching refresh token from DB
server  →  clears both cookies (maxAge: 0)
```

### Profile — `GET /auth/profile`

```
client  →  sends request (access_token cookie)
server  →  shared AccessTokenService verifies JWT and re-reads DB-current role/status, sets req.user
server  →  controller returns req.user (populated by the guard)
```

---

## Guard Flow

Happens on every request that is not decorated with `@Public()`.

```
request comes in
↓
JwtAuthGuard.canActivate()
  → checks if route has @Public()  →  if yes: allow through
  → if no: reads access_token cookie directly
      → AccessTokenService.verify(token) — shared verifier for HTTP + WebSocket
      → sets req.user = { id, username, role }
↓
controller receives request with req.user populated
```

## Shared access-token verifier

`AccessTokenService` is the single authority for access-token verification used by both the HTTP guard and the WebSocket gateway. It validates the JWT signature, enforces `type === 'access'`, requires a safe `exp`, and queries PostgreSQL for the user's current `status`, `role`, and `mustChangePassword`. It returns a typed principal and never knows about HTTP routes or Socket.IO rooms.

The HTTP `JwtAuthGuard` is the only place that owns the temporary-password route exception: a `temporaryAuth` access token is accepted only for `PATCH /api/auth/password`, and only while `mustChangePassword` is true. The WebSocket gateway rejects every temporary/recovery session silently.

---

## Database — RefreshToken table

One row per active session. A user can have multiple rows (multiple devices/browsers).

| Field        | Notes                                      |
|--------------|--------------------------------------------|
| id           | UUID PK                                    |
| tokenIdHash  | SHA-256 digest of the JWT `jti`; raw token is never stored |
| userId       | FK → User                                  |
| expiresAt    | Derived from `JWT_REFRESH_EXPIRES_IN`       |
| createdAt    |                                             |

Logout deletes the row for that session. Session metadata such as `userAgent` and `lastUsedAt` remains future work.

---

## Cookie Settings

| Cookie          | maxAge   | httpOnly | secure (prod) | sameSite | path | partitioned (prod) |
|-----------------|----------|----------|---------------|----------|------|--------------------|
| `access_token`  | 15 min   | true     | true          | none     | `/`  | true |
| `refresh_token` | 7 days   | true     | true          | none     | `/`  | true |

Production issuance and clearing use the same explicit attributes: `HttpOnly; Secure; SameSite=None; Partitioned; Path=/`. Development uses `HttpOnly; SameSite=Lax; Path=/` and omits `Secure` and `Partitioned`.

`httpOnly: true` — JavaScript cannot read the cookie (XSS protection).
`secure: true` in production — cookie only sent over HTTPS.
`sameSite: none` plus `Partitioned` — CHIPS is the primary hosted cross-origin mechanism on supported browsers.
The PKCE authorization-code flow with a memory-only bearer access token is the reserved fallback and is not implemented; this backend does not claim complete hosted-browser compatibility.
