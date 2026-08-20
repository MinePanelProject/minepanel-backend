# AGENTS.md — MinePanel Backend

## 1. Overview

MinePanel Backend is a self-hosted Minecraft server-management API. It is a NestJS 11 application written primarily in TypeScript 5 with PostgreSQL 16 through Drizzle ORM. The API authenticates users with JWT cookie sessions and TOTP, manages Docker-backed Minecraft server lifecycle and access control, publishes minimal host metrics through Socket.IO, and runs behind Caddy in the Compose deployment. Development uses the Nest CLI; production runs the compiled application with Bun. `SPEC.md` is the authoritative distinction between implemented behavior, accepted backlog, proposals, and owner decisions.

## 2. Repository Structure

```text
src/
  main.ts                    # bootstrap, production preflight, migrations, global Nest setup
  app.module.ts              # module composition and global guard ordering
  app.controller.ts          # public GET /health and GET /api/info only
  admin/                     # ADMIN user management and MOD permission grants
  auth/                      # sessions, JWT, TOTP, guards, auth DTOs
    guards/                  # JWT, roles, permissions, and pre-auth guards
    dto/                     # request DTOs and colocated specs
  common/                    # cross-feature decorators, guards, filters, utilities, logger
  db/                        # sole Drizzle provider, schema, and production migrations
  docker/                    # Dockerode boundary, constants, and managed-container guardrails
  gateway/                   # Socket.IO adapter, reservation, metrics, and events gateway
  servers/                   # lifecycle, resource admission, visibility, access workflows, DTOs
  setup/                     # first-admin status and setup flow
  users/                     # user lookup/update and public-user projection
scripts/
  postbuild.mjs              # rewrites compiled src/ aliases for the dist-only runtime
test/                        # e2e tests: live PostgreSQL, mocked Docker boundary
drizzle/                     # generated Drizzle migrations and metadata
docs/                        # deployment, auth, access-control, realtime, and server docs
.github/workflows/ci.yml     # test, migration, e2e, image, and publish jobs
```

> **Repo-wide:** create an HTTP feature in `src/<feature>/` with module, controller, service, DTOs, and colocated specs; register it in `AppModule`. Keep controllers as request/response adapters and put business rules in services.

- Keep all Drizzle tables, enums, inferred row types, and schema relations in `src/db/schema.ts`; never split the schema.
- Put shared code only in `src/common/`; cross-feature imports use `src/<feature>/<file>`, never `../../` traversal.
- Colocate unit specs as `<subject>.spec.ts`. Keep e2e specs in `test/`.
- Keep root source code out of the repository root. Root files are configuration, deployment, setup wizards, scripts, and project documentation.
- Do not add generated artifacts under `src/`; `dist/` and `coverage/` stay ignored.

## 5. Commands and Workflows

```bash
# Dependencies
bun install
bun install --frozen-lockfile

# Local development
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d
bun db:push
bun run start:dev

# Build and production
bun run build                 # nest build, then scripts/postbuild.mjs
bun run start:prod

# Formatting and linting
bun run format                # mutates files
bun run lint                  # mutates files
bun run lint:ci               # read-only CI check

# Tests
bun run test
bun run test:ci
bun run test:e2e

# Database
bun db:generate
bun db:migrate
bun db:push
bun db:studio
```

Use `bun install --frozen-lockfile`, `bun run lint:ci`, `bun run build`, and `bun run test:ci` for the unit-test CI gate. Never run `bun run lint` in CI: it writes changes.

`bun run test:e2e` uses a live PostgreSQL instance and applies migrations, but mocks Docker. It does not create real Minecraft containers. The trusted `publish` job is the only current CI job with daemon-backed smoke coverage; a full real Docker lifecycle integration test remains backlog work in `SPEC.md`.

## 6. Code Formatting

Formatter and import organizer: Biome 2.4 in `biome.json`. Generate formatter-compliant code directly; do not rely on a cleanup pass.

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

- Indent with two spaces; never tabs.
- Keep lines within Biome's configured width of 100 characters.
- Leave one blank line after imports and between top-level declarations. Leave one blank line between class methods; class members begin immediately after the opening brace.
- Use K&R braces, semicolons, single-quoted strings, and trailing commas in multiline imports, arguments, objects, and arrays.
- Use spaces around binary operators and after commas. Do not put spaces inside parentheses, brackets, or braces.
- Place decorators directly above their target without blank lines between decorators. Separate decorated members from the preceding member with one blank line.
- Use implicit continuation inside delimiters; never use a TypeScript line-continuation backslash.
- Keep imports contiguous; Biome orders and organizes them.

```typescript
if (parsedUrl.protocol !== 'postgres:' && parsedUrl.protocol !== 'postgresql:') {
  throw new Error('Missing required environment configuration');
}
```

### JavaScript (`scripts/`) [tentative]

`scripts/postbuild.mjs` is the only maintained JavaScript source. Follow its single-quote, semicolon, `const`, arrow-function, and `node:` import style when editing it. Do not generalize additional JavaScript conventions without more evidence.

```javascript
const relativeTo = (fromFile, target) => {
  const rel = toPosix(path.relative(path.dirname(fromFile), target));
  return rel.startsWith('.') ? rel : `./${rel}`;
};
```

### Bash setup wizards [tentative]

The Linux and macOS wizards use Bash with a portable shebang, strict mode, uppercase state variables, and boxed section banners.

```bash
#!/usr/bin/env bash
set -euo pipefail

# ── Step 1: Prerequisites ─────────────────────────────────────────────────────
step "1/3" "Checking prerequisites"
```

Use `docker compose`, never `docker-compose`. Do not source `.env`; parse only required values because it is untrusted input. `setup.ps1` is the only PowerShell source, so do not invent repository-wide PowerShell style rules.

## 7. Naming Conventions

### TypeScript

- Use `camelCase` for values and methods: `getSetupState`, `checkMemoryAdmission`, `completeTwoFactorLogin`.
- Use `PascalCase` for classes, DTOs, services, types, and errors: `ServersService`, `CreateServerDto`, `RconUnavailableError`.
- Use `UPPER_SNAKE_CASE` for module constants and injection tokens: `LIFECYCLE_LOCK_KEY`, `DRIZZLE`, `DOCKERODE`.
- Use no leading underscore for private members. Reserve `_name` for intentionally discarded destructuring values only.
- Name injection tokens as exported uppercase symbols from their module/constants file.
- Prefer descriptive type aliases for object shapes and unions. `AuthTokens` is an existing exported `interface`; do not add an `I` prefix to any type.
- Use kebab-case filenames. Auth DTO filenames are an established exception (`editUser.dto.ts`, `updatePw.dto.ts`); match the directory being edited.
- Name tests `<subject>.spec.ts` and fixtures `make<Subject>` where a full fixture is needed.

```typescript
const makeServer = (overrides: Partial<Server> = {}): Server => ({
  id: 'server-1',
  name: 'Survival',
  ...overrides,
});
```

- Keep schema table constants camelCase (`refreshTokens`, `serverAccess`), inferred row types PascalCase (`Server`, `RefreshToken`), and enum constants with the existing `Enum` suffix where used.
- Use UPPER_SNAKE_CASE environment variables in `.env.example` and setup wizard output.

## 8. Type Annotations

### TypeScript

Use explicit return types for public or exported asynchronous methods and boundary helpers. Use `private readonly` constructor injection with explicit dependency types.

```typescript
async createServer(dto: CreateServerDto, principal: ServerPrincipal): Promise<PublicServer> {
  // ...
}
```

- Use `T | null` and `T | undefined`, not `Optional<T>`.
- Prefer `unknown` for untrusted values, then narrow it. Use `as` only at typed boundaries.
- Mark type-only imports with `import type` or inline `type`; `isolatedModules` is enabled.
- Type test mocks with `Pick<Dependency, 'method'>` and narrow structurally different mocks through `unknown`.
- `tsconfig.json` enables `strictNullChecks` but not full strict mode. Do not introduce implicit uncertainty merely because `noImplicitAny` is disabled.

```typescript
type ReconciliationOutcome =
  | { kind: 'state'; status: ServerStatus; containerId: string | null }
  | { kind: 'unavailable' }
  | { kind: 'unchanged' };
```

## 9. Imports

### TypeScript

Order imports as: `node:` builtins, third-party packages, `src/` module imports, then local relative imports. Keep the block contiguous with one blank line before declarations. Use namespace imports only for CommonJS interop.

```typescript
import crypto from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import { type PublicUser, toPublicUser } from 'src/users/public-user';
import { LoginUserDto } from './dto/login.dto';
```

Never cross feature boundaries through relative traversal. Do not use wildcard imports as a re-export mechanism.

## 10. Error Handling

### TypeScript

Use Nest built-in exceptions with human-readable messages. Reserve structured `{ error: 'MachineCode' }` payloads for client-discriminable auth and authorization states. Let `DbExceptionFilter` map PostgreSQL codes; do not duplicate SQLSTATE handling in services.

```typescript
if (userExists) {
  throw new ConflictException('User already exists');
}
```

Guard and boundary code converts unexpected verification failures to unauthorized responses while preserving deliberate typed failures:

```typescript
try {
  const payload = await this.jwtService.verifyAsync<PreAuthPayload>(bearerToken);
  // ...
} catch (error) {
  if (error instanceof ForbiddenException) throw error;
  throw new UnauthorizedException();
}
```

- Use bare `catch` only when the fallback is defined, such as Docker ping returning `false` or best-effort stream cleanup.
- Production configuration and migrations fail before Nest starts. Keep the single sanitized `process.exit(1)` boundary in `main.ts`; do not add one elsewhere.
- Docker daemon absence is nonfatal at startup. Health becomes degraded and Docker operations return 503; a lifecycle operation already in progress may settle its row as `ERROR` when the daemon outcome is unknown.
- Preserve the timing-equalized password flow: compare against `DUMMY_PASSWORD_HASH` when no user exists.

## 11. Comments and Docstrings

### TypeScript

Do not add JSDoc or method/class docstrings. Express public API intent with Swagger decorators. Use short `//` comments for non-obvious flow, security rationale, or magic values; do not narrate obvious statements.

```typescript
// the only inbound path is the Caddy reverse proxy on the app network:
// honor X-Forwarded-* from it so protocol/host detection (CSRF same-origin
// check) and per-client throttling see the real client
httpAdapter.set('trust proxy', 1);
```

- Keep comments adjacent to the code they justify.
- Do not leave commented-out code, `TODO`, or `FIXME` markers.
- Use trailing comments for error-code or unit explanations when needed.
- Group `.env.example` variables with section banners and document non-obvious values near their declaration.

## 12. Testing

### TypeScript

Jest 30 with ts-jest is configured in `package.json`. Unit specs live next to source under `src/`; e2e specs live under `test/`.

```typescript
describe('ServersService', () => {
  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServersService,
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile();

    service = module.get(ServersService);
  });
});
```

- Use `describe('<ClassName>', ...)` and behavior sentences in `it(...)`.
- Hand-roll mocks with `jest.fn()`. Mock `DRIZZLE`, `DOCKERODE`, and Docker services in unit tests; no mock library.
- Use fixtures such as `makeServer(overrides)` and assert observable behavior, transitions, errors, and delegated calls.
- Unit tests must never connect to PostgreSQL or Docker and must not read live secrets.
- E2e tests use live loopback PostgreSQL with `TEST_DATABASE_URL`, but override the Docker boundary. Do not claim or write e2e tests that assume a daemon unless they are explicitly release-only integration coverage.
- Never add “should be defined” scaffolding assertions.

## 13. Git

> **Repo-wide:** use Conventional Commit prefixes for all new commits.

- `feat:` — new user-visible capability.
- `fix:` — defect correction.
- `docs:` — documentation or specification change.
- `chore:` — tooling, dependency, or maintenance change.
- `refactor:` — behavior-preserving code restructuring.
- `ci:` — CI-specific change when that scope is unambiguous.

Use an optional scope only when the change is clearly feature-local, for example `fix(auth):`. Keep subjects imperative and lowercase-initial. Keep history linear; rebase rather than create merge commits. Do not commit, push, publish, or alter the user's existing uncommitted changes without explicit approval.

## 14. Dependencies and Tooling

### TypeScript and JavaScript

- Bun is the package manager, pinned by `packageManager` and `bun.lock`. Add dependencies with `bun add <package>` or `bun add -d <package>` and keep the lockfile synchronized.
- Biome is the formatter, linter, and import organizer. Its scope currently includes `src/**` and `test/**`; root Markdown and JSON files are ignored by Biome unless the configuration changes.
- TypeScript uses `nodenext`, ES2022, decorator metadata, and `src/` base-url aliases. The production build runs `scripts/postbuild.mjs` because compiled artifacts must not retain `src/...` imports.
- Drizzle schema changes require a generated migration (`bun db:generate`) and the appropriate migration validation; development may use `bun db:push`.
- Controllers and DTOs use `class-validator`, `class-transformer`, and Swagger decorators. Global validation whitelists, transforms, and rejects extra properties.
- CI contains separate unit/build, migration, e2e, image, and trusted publish jobs. Preserve the daemon boundary: ordinary PR image tests run degraded without a mounted Docker socket.

## 15. Anti-slop and trust-boundary checklist

Repository policy: `docs/engineering/anti-slop.md`. Anti-slop lint rules are
guardrails, never the reason a design exists. Before completing any lint
remediation, every agent must verify all of the following:

1. Did any trust boundary change from `unknown` to a typed generic?
2. Did any runtime guard disappear?
3. Did runtime reflection appear solely to avoid an assertion?
4. Did a new production abstraction exist only because tests/lint required it?
5. Did tests begin mocking the exact integration that needs validation?
6. Are SAFETY comments describing actual producer + invariant?
7. Did package scripts/config/files unrelated to the task change?
8. Would this production code exist without the linter?

If any answer indicates the linter drove the code, fix the code or the lint rule.

## 16. Red Lines

> **Repo-wide:** these prohibitions are grounded in the current codebase and release design.

- Never use double-quoted TypeScript string literals when a single-quoted literal is sufficient.
- Never indent TypeScript with tabs or omit statement semicolons.
- Never cross modules with `../../` imports; use `src/<feature>/<file>` paths.
- Never define a Drizzle table, enum, or inferred schema type outside `src/db/schema.ts`.
- Never put lifecycle, authorization, Docker, or data-access rules in a controller.
- Never use `Optional<T>` or an `I` prefix for TypeScript types; use nullable unions and descriptive names.
- Never add `any` without a localized justification; narrow external values from `unknown`.
- Never let a unit test connect to PostgreSQL or Docker, or read live production secrets.
- Never represent mocked Docker coverage as a real container-lifecycle test.
- Never commit `.env`, `dist/`, `coverage/`, `node_modules`, or other generated runtime artifacts.
- Never create an unprefixed commit subject or a merge commit in the linear `master` history.
- Never return access or refresh session tokens in JSON. The five-minute 2FA `preAuthToken` is the deliberately scoped exception and may authorize only the 2FA verification flow.
- Never log or store plaintext passwords. Preserve bcrypt hashing and the dummy-hash comparison path.
- Never expose the backend port directly in Compose deployments; Caddy is the trusted inbound proxy for throttling and CSRF origin semantics.
- Never mount Minecraft data read-write into the backend before the write-architecture decision in `SPEC.md` is implemented.
