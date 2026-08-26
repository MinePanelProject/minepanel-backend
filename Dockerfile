# Multi-stage production build on the exact Bun runtime.

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# ── Stage 2: production dependencies ──────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS production

WORKDIR /app

COPY package.json bun.lock ./
# --omit=peer drops drizzle-orm's optional peers that Bun would otherwise
# install; @grpc/grpc-js (needed by dockerode) and its protobufjs subtree stay.
# protobufjs is pinned via overrides to the CVE-fixed 7.5.5. Only @prisma is
# pruned — it is never imported by the app.
RUN bun install --frozen-lockfile --production --omit=peer \
 && rm -rf node_modules/@prisma

# ── Stage 3: final runtime image ──────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS final

WORKDIR /app

# Cache-busted apk resolve with explicit openssl guard: the plain `apk upgrade`
# RUN layer is served from gha build cache and can pin a stale openssl
# (CVE-2026-14456, fixed 3.5.8-r0). The version constraint fails the build if
# the mirror lags.
RUN apk upgrade --no-cache && apk add --no-cache curl 'libcrypto3>=3.5.8' 'libssl3>=3.5.8'

COPY --from=production /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY package.json ./

ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD ["curl", "-f", "http://localhost:3000/health"]

CMD ["bun", "dist/src/main.js"]
