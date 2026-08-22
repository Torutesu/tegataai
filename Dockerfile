# Build and run the authorization service. Single node by design; see the server README.
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
# better-sqlite3 compiles against the local toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json  packages/core/
COPY packages/store/package.json packages/store/
COPY packages/server/package.json packages/server/
COPY packages/sdk/package.json   packages/sdk/
COPY packages/verify/package.json packages/verify/
RUN pnpm install --frozen-lockfile

FROM deps AS app
COPY . .
RUN pnpm typecheck

FROM base AS runtime
ENV NODE_ENV=production TEGATA_DB=/data/tegata.db HOST=0.0.0.0 PORT=8787
COPY --from=app /app /app
VOLUME /data
EXPOSE 8787
# The register is the record; keep /data on a volume that outlives the container.
CMD ["pnpm", "start"]
