# Multi-stage: the runtime image carries no compiler and no dev dependencies.
FROM node:20-bookworm-slim AS builder

WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
COPY packages/schema/package.json packages/schema/
COPY apps/collector/package.json apps/collector/
RUN corepack enable && pnpm install --no-frozen-lockfile

COPY packages/schema packages/schema
COPY apps/collector apps/collector
RUN pnpm --filter @aiuo/collector run build

# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

# git is needed for the gap-fill path (HEAD sha, dirty flag, diffs for agents
# whose logs carry no edit payloads).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Belt and braces for "detected dubious ownership": the bind-mounted repos are
# owned by the host user, and git refuses to operate on a repo owned by someone
# else. Without this, every git-based gap fill silently returns nothing.
# Safe here because all host mounts are read-only.
RUN git config --global --add safe.directory '*'

# Match the host user so file ownership lines up. Find yours with `id -u; id -g`
# (or `make uid`) and pass as build args.
ARG HOST_UID=501
ARG HOST_GID=20
RUN if ! getent group "${HOST_GID}" >/dev/null; then groupadd -g "${HOST_GID}" aiuo; fi \
 && useradd -u "${HOST_UID}" -g "${HOST_GID}" -m -s /bin/bash aiuo 2>/dev/null || true

ENV NODE_ENV=production TZ=UTC
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/collector/dist ./apps/collector/dist
COPY --from=builder /app/apps/collector/package.json ./apps/collector/
COPY --from=builder /app/packages/schema ./packages/schema

USER ${HOST_UID}:${HOST_GID}

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.COLLECTOR_PORT||4317)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/collector/dist/main.js"]
