# One-shot migration runner. Deliberately a separate image from the collector:
# migrations must run once, to completion, before any app starts — not on boot.
FROM node:20-bookworm-slim AS builder

WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
COPY packages/schema/package.json packages/schema/
RUN corepack enable && pnpm install --no-frozen-lockfile

COPY packages/schema packages/schema
RUN pnpm --filter @aiuo/schema exec tsc -p tsconfig.json

# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production TZ=UTC
WORKDIR /app

# Both halves are required. The root node_modules holds pnpm's content store
# (.pnpm/…); the per-package node_modules holds the SYMLINKS that make `pg`
# resolvable from packages/schema. Copying only the root gives you an image
# that starts and then dies on ERR_MODULE_NOT_FOUND.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/schema/node_modules ./packages/schema/node_modules
COPY --from=builder /app/packages/schema/dist ./packages/schema/dist
COPY --from=builder /app/packages/schema/migrations ./packages/schema/migrations
COPY --from=builder /app/packages/schema/package.json ./packages/schema/

USER node

CMD ["node", "packages/schema/dist/migrate.js", "up"]
