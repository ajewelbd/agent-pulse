# Layer 3 proxy. A SEPARATE image and service from the collector on purpose:
# restarting the proxy to change an upstream must not drop the tailer's file
# watches or its checkpoints.
FROM node:20-bookworm-slim AS builder

WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
COPY packages/schema/package.json packages/schema/
COPY apps/proxy/package.json apps/proxy/
RUN corepack enable && pnpm install --no-frozen-lockfile

COPY packages/schema packages/schema
COPY apps/proxy apps/proxy
RUN pnpm --filter @aiuo/proxy run build

# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production TZ=UTC
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/proxy/dist ./apps/proxy/dist
COPY --from=builder /app/apps/proxy/package.json ./apps/proxy/
COPY --from=builder /app/packages/schema ./packages/schema

# No host mounts and no git needed — the proxy only speaks HTTP and Postgres.
USER node

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PROXY_PORT||4318)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/proxy/dist/main.js"]
