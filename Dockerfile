# Multi-stage build for smaller image

# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY bun.lock ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

RUN npm ci

RUN npx prisma generate

COPY . .

RUN npm run build

# Stage 2: Production
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache curl

COPY package*.json ./
COPY bun.lock ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

RUN npm ci --only=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/generated ./generated

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
