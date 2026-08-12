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
RUN bun install --frozen-lockfile --production

# ── Stage 3: final runtime image ──────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS final

WORKDIR /app

RUN apk add --no-cache curl

COPY --from=production /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY package.json ./

ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD ["curl", "-f", "http://localhost:3000/health"]

CMD ["bun", "dist/src/main.js"]
