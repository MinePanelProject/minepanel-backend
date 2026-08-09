# AGENTS.md — MinePanel Backend

## 1. Overview

MinePanel backend is a self-hosted Minecraft server management panel API. It is a NestJS 11 application written entirely in TypeScript 5 (ES2022, `nodenext`), running on Node 20 in development and Bun in production. It exposes a REST API (global prefix `api`, plus a public `/health` route and Swagger at `/docs`) that manages user authentication — JWT access tokens and hashed refresh tokens delivered via HttpOnly cookies, with TOTP two-factor authentication — and spawns/controls Minecraft server containers through the Docker socket via Dockerode (server lifecycle endpoints are planned). Persistence is PostgreSQL 16 accessed through Drizzle ORM with a single hand-written schema file. The application is organized as small feature modules (`auth`, `users`, `setup`, `servers`, `docker`, `db`) coordinated by a root `AppModule`, with shared utilities in `src/common`.

## 2. Repository Structure

```
src/
  main.ts                    # bootstrap: helmet, cookie-parser, ValidationPipe,
                             # DbExceptionFilter, CORS, global prefix, Swagger — no business logic
  app.module.ts              # root module: imports all feature modules, registers
                             # global guards (JwtAuthGuard, RolesGuard, ThrottlerGuard)
  app.controller.ts          # GET /api/info, GET /health (public)
  auth/                      # authentication: controller, service, guards/, dto/
    guards/                  # jwt-auth.guard, pre-auth.guard, roles.guard
    dto/                     # request/response DTOs, each with a colocated spec
  users/                     # user lookup/update service; public-user.ts (sanitized shape)
  setup/                     # first-run bootstrap: status + first-admin registration
  servers/                   # WIP stub — module wired, controller/service skeletal
    dto/create-server.dto.ts # fully validated server creation DTO
  docker/                    # Dockerode provider factory + DockerService (create/start/stop/remove/inspect, host resources, ping)
  db/                        # DRIZZLE provider factory (postgres-js) + schema.ts
    schema.ts                # ALL Drizzle tables, enums, inferred types live here
  common/                    # shared, cross-module code only
    decorators/              # @Public(), @Roles()
    filters/db-exception.filter.ts
    crypto.util.ts           # AES-256-GCM encrypt/decrypt
    custom-logger.ts
test/                        # e2e specs (require live Postgres + Docker; not run in CI)
drizzle/                     # generated SQL migrations + meta (drizzle-kit output)
docs/                        # deployment, servers, auth-architecture, access-control
.github/workflows/ci.yml     # CI: Bun 1.3.14, frozen install, Biome check, build, Jest
```

Rules:

- A new feature gets its own `src/<feature>/` directory containing `*.module.ts`, `*.controller.ts`, `*.service.ts` and a `dto/` subdirectory. Register the module in `app.module.ts` imports.
- All database tables, enums, and their inferred types are defined in `src/db/schema.ts` — never split the schema across files.
- `src/common/` is the only place shared code may live; feature modules must not duplicate each other's utilities.
- Test files are colocated next to their subject as `*.spec.ts` — never in a separate test tree (except e2e, which lives in `test/`).
- Root level holds only configuration, deployment files (`docker-compose*.yml`, `Dockerfile`, `Caddyfile`), setup wizards (`setup.sh`, `setup-mac.sh`, `setup.ps1`), and docs — no source code.
- Generated artifacts (`dist/`, `coverage/`) are gitignored and never placed under `src/`.

## 5. Commands and Workflows

```bash
# Install
bun install                      # install dependencies (canonical)
bun install --frozen-lockfile    # CI: fail if bun.lock would change

# Environment
cp .env.example .env             # required before running
docker compose -f docker-compose.dev.yml up -d   # local PostgreSQL

# Development
bun run start:dev                # nest start --watch

# Build / production
bun run build                    # nest build → dist/
bun run start:prod               # bun dist/src/main.js

# Lint and format
bun run lint                     # biome check --write . (dev — auto-fixes)
bun run lint:ci                  # biome check . (CI — read-only, canonical for CI)
bun run format                   # biome format --write .

# Tests
bun run test                     # jest (dev)
bun run test:ci                  # jest --runInBand (CI — deterministic, canonical for CI)
bun run test:cov                 # jest --coverage (optional, writes coverage/)
bun run test:e2e                 # requires live Postgres + Docker — never in CI

# Database (Drizzle Kit)
bun db:push                      # sync schema to DB (dev)
bun db:generate                  # generate migration SQL
bun db:migrate                   # apply migrations (prod)
bun db:studio                    # Drizzle Studio GUI
```

Never use `bun run lint` in CI — it mutates the tree; CI uses `bun run lint:ci`.

## 6. Code Formatting

Formatter: Biome 2.4 (`biome.json`), lint + format + `organizeImports` (on). Editor: format-on-save with the Biome extension (`.vscode/settings.json`). Produce formatter-compliant code directly — never rely on a post-pass.

### TypeScript

```typescript
import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SetupService } from './setup.service';

@ApiTags('setup')
@Controller('setup')
export class SetupController {
  constructor(private readonly setupService: SetupService) {}

  @Get('status')
  @HttpCode(HttpStatus.OK)
  async getStatus(): Promise<SetupStatus> {
    return this.setupService.getSetupState();
  }
}
```

- **Indentation:** 2 spaces. Never tabs.
- **Line length:** Biome `lineWidth` is 100; the measured p95 is ~83 characters. Keep lines comfortably under 100.
- **Blank lines — methods:** exactly one blank line between methods (and between the last method and a trailing private helper).
- **Blank lines — class open:** class members start immediately after the class declaration; when fields precede the constructor, one blank line separates them [tentative].
- **Blank lines — top-level:** one blank line between top-level declarations. Exception: adjacent `export const` / `export type` pairs share the same block (see `src/db/db.module.ts`).
- **Blank lines — after imports:** exactly one blank line after the last import before the first declaration.
- **End of file:** always a single trailing newline; no trailing whitespace anywhere.
- **Braces:** K&R — opening brace on the same line as the statement. Single-line `if (cond) return x;` without braces is allowed. `catch {` without a binding is used for swallow-with-fallback.
- **Quote style:** single quotes for all string literals. Template literals (backticks) only for interpolation or multi-line strings.
- **Spacing — operators:** spaces around binary operators (`a === b`, `now + 60000`).
- **Spacing — brackets:** no spaces inside parentheses, brackets, or braces (`f(x)`, `{ a: 1 }`).
- **Spacing — commas:** one space after commas, never before (`and(eq(a, b), ne(c, d))`).
- **Spacing — colons:** no space before, one space after, in both type annotations and object literals (`private db: DrizzleDB`, `{ error: 'AccountPending' }`).
- **Decorators:** stacked directly on the line above the decorated target with no blank line between; one blank line separates the whole decorated method from the previous method.
- **Import block:** one import per line, contiguous (no blank lines between imports), sorted alphabetically by module path (Biome `organizeImports`), followed by exactly one blank line.
- **Trailing commas:** always present in multi-line object literals, array literals, and argument lists.
- **Line continuation:** implicit via open parentheses — never backslash (bash scripts excepted).
- **Semicolons:** always present at the end of statements.

### Bash (setup scripts)

- `#!/usr/bin/env bash` shebang and `set -euo pipefail` first.
- 2-space indentation; single-quoted strings; `$(...)` command substitution.
- Helper functions defined as lowercase names with parens: `step()`, `ok()`, `fail()`.
- Section banners as box comments: `# ── Step 1: Prerequisites ──...`.
- Variables in UPPER_SNAKE (`CURRENT`, `LATEST`, `SKIP_ENV`).

## 7. Naming Conventions

### TypeScript

- **Variables and methods:** camelCase (`getSetupState`, `passwordMatches`, `backupCodes`).
- **Classes and injectables:** PascalCase (`AppController`, `AuthService`, `DbExceptionFilter`, `TwoFactorTokenDto`).
- **Module-level constants:** UPPER_SNAKE with a clear unit suffix where relevant (`REFRESH_TOKEN_MAX_AGE_MS`, `TWO_FACTOR_FAILURE_LIMIT`, `TOTP_WINDOW_SECONDS`, `IS_PUBLIC_KEY`).
- **Private members:** no underscore prefix (`private readonly encryptionKey`). The `_` prefix appears only for discarded destructured properties: `const { token: _token, ...tableWithoutToken }` and `({ passwordHash: _passwordHash, ...user }: User)`.
- **Injection tokens:** UPPER_SNAKE symbols (`DRIZZLE`, `DOCKERODE`) exported from their module file (`src/db/db.module.ts`, `src/docker/docker.constants.ts`).
- **Types:** PascalCase; object shapes are `type` aliases, not `interface` declarations [tentative — no `interface` keyword observed]. No `I` prefix. Union types get descriptive names (`TwoFactorChallenge`, `LoginResponse`).
- **DTO classes:** PascalCase with a `Dto`/`DTO` suffix. Casing of the suffix is inconsistent across the repo (`CreateUserDto`, `TwoFactorTokenDto` vs `UpdatePasswordDTO`) — match the file you are editing.
- **Files:** kebab-case (`db-exception.filter.ts`, `custom-logger.ts`, `create-server.dto.ts`). Exception: DTOs under `src/auth/dto/` use camelCase names (`register.dto.ts`, `editUser.dto.ts`, `updatePw.dto.ts`) — an existing inconsistency; follow the directory you are in.
- **Test files:** `<subject>.spec.ts`, colocated (`setup.service.ts` → `setup.service.spec.ts`).
- **DB schema:** table constants camelCase (`users`, `refreshTokens`, `setupState`, `servers`); enum constants PascalCase with `Enum` suffix (`roleEnum`, `DifficultyEnum`, `userStatusEnum`); inferred types PascalCase (`User`, `NewUser`, `Server`).
- **Environment variables:** UPPER_SNAKE, grouped by section in `.env.example` (`DATABASE_URL`, `REQUIRE_ADMIN_APPROVAL`, `MC_PORT_MIN`).

## 8. Type Annotations

- Explicit return types on all public/exported async methods: `async getSetupState(): Promise<SetupStatus>`, `async findById(id: string): Promise<User | null>`.
- Constructor injection uses the `private readonly` shorthand with explicit types, including token injection: `@Inject(DRIZZLE) private readonly db: DrizzleDB`.
- Nullable values use `| null` / `| undefined` unions — never `Optional<T>`: `Promise<User | null>`, `string | undefined`.
- Literal narrowing with `as const`: `.then(() => 'ok' as const)`.
- Pragmatic `as` casts at boundary points, always from a wider to a narrower shape: `req.user as JwtPayload`, `req.cookies.refresh_token as AuthTokens['refreshToken']`.
- `unknown` preferred over `any` for untyped external values, followed by explicit narrowing (`catch (exception: unknown)` + property checks; `const parsed: unknown = JSON.parse(...)` + `Array.isArray` checks).
- Type-only imports use `import type { ... }` or the inline `type` modifier in mixed imports: `import { DRIZZLE, type DrizzleDB } from 'src/db/db.module'`.
- Specs narrow dependencies with `Pick<Type, 'methodName'>` (e.g. `Pick<JwtService, 'verifyAsync'>`) and cast with `as unknown as Type` when a mock is structurally different.
- Type checker: `tsc` with `strictNullChecks: true` only — full strict mode is off (`noImplicitAny: false`). `isolatedModules: true` means type-only imports must be marked `type`.

## 9. Imports

Order: `node:` builtins → third-party packages → `src/` internal paths → relative `./` paths. All contiguous, sorted alphabetically within that order, exactly one blank line after the block. This is enforced by Biome `organizeImports`.

Canonical example (`src/auth/auth.service.ts`):

```typescript
import crypto from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { and, eq, getTableColumns } from 'drizzle-orm';
import { generateSecret, generateURI, verifySync } from 'otplib';
import { decrypt, encrypt } from 'src/common/crypto.util';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import { RefreshToken, refreshTokens, type User, users } from 'src/db/schema';
import { type PublicUser, toPublicUser } from 'src/users/public-user';
import { UsersService } from 'src/users/users.service';
import { EditUserDto } from './dto/editUser.dto';
```

- Cross-module imports always use the `src/<module>/<file>` path style (resolved via `baseUrl`); never `../../` relative traversal.
- CJS modules are imported as namespaces: `import * as bcrypt from 'bcrypt'`.
- Node builtins use the `node:` scheme: `import crypto from 'node:crypto'`.
- Wildcard imports (`import * as ...`) are reserved for CJS interop — never use them to re-export a module's API surface.

## 10. Error Handling

- Use NestJS built-in exceptions with a human-readable message: `UnauthorizedException('Wrong credentials')`, `ConflictException('User already exists')`, `ForbiddenException('First admin already created')`, `BadRequestException('No changes')`.
- Structured error payloads for client-discriminable cases: `throw new ForbiddenException({ error: 'AccountPending' })` / `{ error: 'AccountBanned' }` / `{ error: 'PasswordChangeRequired' }`.
- Rate-limit or retryable failures use `HttpException` with an explicit status: `new HttpException('Two-factor authentication is temporarily locked', HttpStatus.TOO_MANY_REQUESTS)`.
- A global `DbExceptionFilter` (`@Catch()`) in `src/common/filters/` maps Postgres error codes from the `cause` chain: `23505` → 409 "Resource already exists", `23503` → 400 "Related resource not found", `42P01`/`42703` → 500 "Database schema error", anything else → 500. Non-Postgres `HttpException`s pass through with their own status. Do not handle raw Postgres codes in services.
- Guards use catch-and-convert: rethrow typed exceptions, convert everything else to `UnauthorizedException`:

```typescript
try {
  const payload = await this.jwtService.verifyAsync<{ sub: string }>(token);
  ...
} catch (error) {
  if (error instanceof ForbiddenException) throw error;
  throw new UnauthorizedException();
}
```

- Bare `catch { return false; }` (no binding) is acceptable only when the failure has a defined fallback value (Docker ping, backup-code JSON parsing). Never swallow an exception and continue without an alternate return path.
- Startup invariants: missing critical secrets or an unrecoverable database connection fail fast — `main.ts` and `DbModule` log via `Logger` and call `process.exit(1)`. Docker unavailability at startup is NOT fatal: `DockerModule` logs the unreachable daemon and continues in degraded mode (health reports 503, Docker operations throw 503). Do not add new `process.exit` call sites elsewhere.
- Password verification always runs `bcrypt.compare(input, user?.passwordHash ?? DUMMY_PASSWORD_HASH)` — never reveal whether a user exists.

## 11. Comments and Docstrings

- No JSDoc and no docstrings on classes or methods. API documentation is expressed with Swagger decorators: `@ApiOperation({ summary: '...' })`, `@ApiProperty({ description: '...', maxLength: 17 })`, `@ApiTags('auth')`.
- Short `//` comments explain flow intent in controllers — placement before the operation, one blank line above the comment:

```typescript
// find token in cookies
const refreshToken = req.cookies.refresh_token as AuthTokens['refreshToken'];
```

- Magic values and error codes carry a trailing inline comment: `maxAge: 15 * 60 * 1000, // 15 minutes in ms`, `case '23505': // unique_violation`.
- No module-level docstrings, no commented-out code, no `TODO`/`FIXME` markers.
- `.env.example` groups variables with box section comments (`# ─── Database ──...`) and explains non-obvious values on the same line or above.

## 12. Testing

- Framework: Jest 30 + ts-jest 29, configured inline in `package.json` (rootDir `src`, `testRegex: '.*\\.spec\\.ts$'`, `moduleNameMapper` maps `^src/(.*)$`). Run with `bun run test:ci` (in-band, deterministic) — the CI command — or `bun run test`.
- Specs are colocated as `<subject>.spec.ts`; suites are `describe('<ClassName>', ...)`, tests are `it('does something ...', ...)` sentences, table tests use `it.each([...])('... %s', ...)`.
- DI-based units are compiled with `Test.createTestingModule` and mocked providers via `useValue`:

```typescript
const module: TestingModule = await Test.createTestingModule({
  controllers: [SetupController],
  providers: [{ provide: SetupService, useValue: setupService }],
}).compile();
```

- Plain units (guards, controllers) are instantiated directly with typed mocks: `guard = new PreAuthGuard(jwtService as JwtService)`.
- Mocks are hand-rolled `jest.fn()` objects — no mocking library. Module-level mocks use `jest.mock('module', () => ({ ... }))` for third-party/utility modules (`otplib`, `src/common/crypto.util`).
- Fixtures use factory helpers: a `makeUser(overrides)` function returning a full `User` object with sensible defaults, overridden per test.
- Assertions favor `await expect(...).resolves.toEqual(...)` / `.rejects.toBeInstanceOf(UnauthorizedException)`; use `.toHaveBeenCalledWith(...)` for delegation checks.
- Unit tests must never touch a real PostgreSQL database or Docker daemon — the `DRIZZLE` and `DOCKERODE` tokens are always mocked with chained `jest.fn()` builders.
- e2e specs live in `test/` and require live Postgres + Docker; they are not part of CI.

## 13. Git

- Conventional Commits prefixes (the dominant convention in recent history): `feat:` new features, `fix:` bug fixes, `docs:` docs/spec/roadmap updates, `chore:` config/tooling, `refactor:` behavior-preserving rewrites. Many older commits are unprefixed — do not add new ones.
- Scopes are rare but valid: `fix(auth):`, `docs(spec):` — use them only when the change is confined to one module.
- Subjects are short, imperative, lowercase-initial: `feat: implement 2FA (TOTP) - setup, confirm, verify, disable + pre-auth token on login`. Keep the subject under ~90 characters; bodies are optional and uncommon.
- Commits are not GPG-signed. History is linear — no merge commits; integrate with rebase.
- All work happens on `master` (single branch; no feature-branch convention observed).

## 14. Dependencies and Tooling

- Package manager: Bun, pinned exactly via `"packageManager": "bun@1.3.14"` (also `"engines": { "bun": ">=1.3.14" }`). `bun.lock` is committed. Add a dependency with `bun add <pkg>` or `bun add -d <pkg>` (dev); the lockfile must stay consistent — CI fails on drift.
- Linter/formatter: Biome 2.4, config at `biome.json` (single quotes, trailing commas, 100-width, `organizeImports` on, `noExplicitAny` off). `.vscode/settings.json` wires format-on-save.
- TypeScript: `tsconfig.json` (`nodenext`, ES2022, strictNullChecks, emitDecoratorMetadata). `tsconfig.build.json` excludes `**/*spec.ts` and `test/`; the production build is `nest build`.
- ORM: Drizzle + postgres-js; `drizzle.config.ts` points at `src/db/schema.ts` with output to `drizzle/`. Schema changes go through `bun db:generate` + `bun db:migrate` (or `db:push` in dev).
- Validation: `class-validator` + `class-transformer` decorators on DTOs; `ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })` is global (in `main.ts`).
- API docs: `@nestjs/swagger` decorators on every controller, method, and DTO; served at `/docs`.
- CI: `.github/workflows/ci.yml` — triggers on PRs and pushes to `master`; checks out, installs Bun 1.3.14, runs `bun install --frozen-lockfile`, `bun run lint:ci`, `bun run build`, `bun run test:ci`. Keep these four commands green before pushing.

## 15. Red Lines

> **Repo-wide:** the following are absolute prohibitions, grounded in what this codebase consistently avoids.

- Never use double quotes for string literals in TypeScript files — single quotes only (formatting).
- Never indent with tabs — 2 spaces in every `.ts` file (formatting).
- Never omit the trailing semicolon on a TypeScript statement (formatting).
- Never reach across modules with relative `../../` imports — use the `src/<module>/<file>` path style (architecture).
- Never define a Drizzle table or enum outside `src/db/schema.ts` (architecture).
- Never put business logic in a controller — controllers parse requests and delegate to services (architecture).
- Never use `any` or `Optional<T>` — use `unknown` with narrowing or `T | null` / `T | undefined` (style).
- Never prefix a type or interface name with `I` (style).
- Never let a unit spec connect to a real PostgreSQL database or Docker daemon — mock `DRIZZLE` and `DOCKERODE` (testing).
- Never write "should be defined" scaffolding tests — every test asserts observable behavior (testing).
- Never let a unit test read live environment secrets (`DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`) (testing).
- Never commit a `.env` file — only `.env.example` is tracked (git).
- Never commit build or test artifacts: `dist/`, `coverage/`, `node_modules` (git).
- Never open a commit with an unprefixed subject — use `feat:` / `fix:` / `docs:` / `chore:` / `refactor:` (git).
- Never send raw tokens in a JSON response body — auth tokens travel only in HttpOnly cookies (security).
- Never store or log a plaintext password — always `bcrypt.hash(password, 10)` (security).
