# Multi-stage: the runtime image carries no compiler, no dev dependencies and
# no Tailwind/TypeScript toolchain — only the traced standalone server.
FROM node:20-bookworm-slim AS builder

WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN corepack enable && pnpm install --no-frozen-lockfile

COPY apps/web apps/web

# DATABASE_URL is deliberately absent at build time. Every page is
# `dynamic = 'force-dynamic'`, so nothing is prerendered and the build never
# needs a database. If a future page drops that and starts prerendering, the
# build will fail here with "DATABASE_URL is not set" — which is the right
# outcome: baking query results into the image would serve stale history.
RUN pnpm --filter @agentpulse/web run build

# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production TZ=UTC PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app

# The standalone bundle is laid out relative to the workspace root (see
# outputFileTracingRoot in next.config.ts), so it unpacks to /app/apps/web/…
# with the traced node_modules at /app/node_modules.
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static

# Unprivileged. The dashboard reads one database over the compose network and
# mounts nothing from the host, so it needs no host uid alignment.
USER node

EXPOSE 3000

# Hits /healthz, which runs SELECT 1. A process that is listening but cannot
# reach Postgres must not report healthy.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
