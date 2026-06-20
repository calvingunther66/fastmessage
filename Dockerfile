# syntax=docker/dockerfile:1

# ---- builder: install deps, build the PWA -------------------------------
FROM node:22-bookworm AS builder
WORKDIR /app
RUN corepack enable

# Install with the full workspace context so native modules (better-sqlite3)
# compile for this image's architecture (matches the Pi when built on the Pi).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY server ./server
COPY web ./web
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @fastmessage/web build

# ---- runtime ------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    WEB_DIST=/app/web/dist

# Bring over the resolved workspace (incl. the compiled native module and the
# built PWA) from the builder stage.
COPY --from=builder /app /app

VOLUME ["/data"]
EXPOSE 8080
CMD ["pnpm", "--filter", "@fastmessage/server", "start"]
