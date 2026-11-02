# syntax = docker/dockerfile:1

# Node server (server/) replaces the busybox placeholder. It serves HTTP on
# 0.0.0.0:$PORT (fly.toml sets PORT), publishes README.md verbatim at
# /readme/ (spec/README.md says what's checked), and persists game state to
# a SQLite file under DATA_DIR (fly.toml mounts the volume at /data).
#
# Pinned to the node version mise.toml pins for local dev, so "works on my
# machine" and "works in the image" mean the same node.

FROM docker.io/library/node:24.21.0-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM docker.io/library/node:24.21.0-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server/ ./server/
COPY README.md ./

ENV PORT=8080
ENV DATA_DIR=/data

# SQLite and type-stripping are both stable in 24.x but still log an
# experimental-feature warning on every boot; silenced so it doesn't clutter
# the logs read live at the week-11 crit.
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
