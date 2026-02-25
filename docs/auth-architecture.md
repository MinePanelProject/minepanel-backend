# Auth Architecture

## The Two Tokens

**Access token** — a signed JWT, short-lived (15 min), stored in an HttpOnly cookie called `access_token`.
- Contains: `{ sub: userId, username, role }`
- Stateless — the server doesn't store it, it just verifies the signature
- Short-lived because if stolen, it expires fast

**Refresh token** — a signed JWT, long-lived (7 days), stored in an HttpOnly cookie called `refresh_token`.
- Contains: `{ sub: userId }` — allows the server to identify the user without `req.user`
- The server stores a **bcrypt hash** of it in the DB (`RefreshToken` table), not the raw value
- Long-lived because it's used to get new access tokens without re-logging in

### Why both?

- Access token is used for every request — fast, stateless, no DB hit
- Refresh token is used only when the access token expires — hits DB, allows revocation

---

## Flows

### Login — `POST /auth/login`

```
client  →  sends email/password
server  →  verifies password with bcrypt
server  →  generates access token (JWT, signed, 15min)
server  →  generates refresh token (JWT, signed, 7d, contains sub only)
server  →  bcrypt hashes refresh token → stores hash in DB
server  →  sets both as HttpOnly cookies
server  →  returns user data (no tokens in body)
```

### Authenticated request (any protected route)

```
browser →  sends request with cookies automatically
server  →  JwtAuthGuard reads access_token cookie directly
server  →  jwtService.verifyAsync(token) — verifies signature + expiry
server  →  sets req.user = { id, username, role }
server  →  controller runs
```

### Token refresh — `POST /auth/refresh`

```
client  →  sends request (browser sends refresh_token cookie automatically)
server  →  verifies refresh token JWT → extracts userId from sub
server  →  fetches all RefreshTokens for that user from DB
server  →  bcrypt.compare(cookieToken, each DB hash) to find a match
server  →  generates new access token
server  →  if within 24h of expiry → deletes old record, issues new refresh token
server  →  sets new cookies
```

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
server  →  guard runs, validates JWT, sets req.user
server  →  controller returns req.user (already decoded by guard)
          no DB hit needed
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
      → jwtService.verifyAsync(token) with JWT_SECRET
      → sets req.user = { id, username, role }
↓
controller receives request with req.user populated
```

---

## Database — RefreshToken table

One row per active session. A user can have multiple rows (multiple devices/browsers).

| Field     | Notes                                      |
|-----------|--------------------------------------------|
| id        | cuid PK                                    |
| token     | bcrypt hash of the refresh token JWT       |
| userId    | FK → User                                  |
| expiresAt | 7 days from creation                       |
| createdAt |                                            |

Logout deletes the specific row for that session. Without DB storage you cannot invalidate a specific session — that's why refresh tokens are stateful even though access tokens are not.

---

## Cookie Settings

| Cookie          | maxAge   | httpOnly | secure (prod) | sameSite |
|-----------------|----------|----------|---------------|----------|
| `access_token`  | 15 min   | true     | true          | lax      |
| `refresh_token` | 7 days   | true     | true          | lax      |

`httpOnly: true` — JavaScript cannot read the cookie (XSS protection).
`secure: true` in production — cookie only sent over HTTPS.
`sameSite: lax` — cookie sent on same-site requests and top-level navigations.
