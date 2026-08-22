# Build and run the authorization service. Single node by design; see the server README.
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

# better-sqlite3 compiles against the local toolchain, so the stages that install need
# one. The stage that *runs* does not, and does not get one.
FROM base AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

FROM toolchain AS manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json  packages/core/
COPY packages/store/package.json packages/store/
COPY packages/server/package.json packages/server/
COPY packages/sdk/package.json   packages/sdk/
COPY packages/verify/package.json packages/verify/

# Everything, so the types can be checked.
FROM manifests AS check
RUN pnpm install --frozen-lockfile
COPY . .
# The image is not worth shipping if it does not compile, and the runtime stage below
# copies this marker so the check cannot be skipped by targeting a later stage.
RUN pnpm typecheck && date -u +%FT%TZ > /typecheck.ok

# What actually ships: no test runner, no bundler, no benchmark tool. They are not run
# in production, but a package that is not in the image cannot be exploited in it.
FROM manifests AS runtime-deps
RUN pnpm install --prod --frozen-lockfile
COPY . .

FROM base AS runtime
ENV NODE_ENV=production TEGATA_DB=/data/tegata.db HOST=0.0.0.0 PORT=8787
COPY --from=check /typecheck.ok /typecheck.ok
COPY --from=runtime-deps /app /app

# The register is the record; keep /data on a volume that outlives the container.
# It is created and handed over here because the process below cannot create it.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data
USER node
EXPOSE 8787

# No shell, no package manager, no init script between here and the server: one process,
# so signals reach it and `docker stop` runs the shutdown that closes the database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "packages/server/src/main.ts"]
