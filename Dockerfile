ARG NODE_IMAGE=node:lts-bookworm-slim
ARG RUST_IMAGE=rust:1.96-bookworm
ARG MONOLITH_VERSION=2.10.1

FROM ${RUST_IMAGE} AS monolith-builder
ARG MONOLITH_VERSION
RUN set -eux && cargo install --locked monolith@${MONOLITH_VERSION}

FROM ${NODE_IMAGE} AS source-deps
ENV YARN_HTTP_TIMEOUT=10000000
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PRISMA_HIDE_UPDATE_MESSAGE=1
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /data
RUN corepack enable

COPY package.json yarn.lock .yarnrc.yml ./
COPY mobile-package.json ./apps/mobile/package.json
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/filesystem/package.json ./packages/filesystem/
COPY packages/lib/package.json ./packages/lib/
COPY packages/prisma/package.json ./packages/prisma/
COPY packages/router/package.json ./packages/router/
COPY packages/types/package.json ./packages/types/
COPY patches ./patches

RUN node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync("package.json", "utf8")); p.scripts={...(p.scripts||{}),postinstall:"patch-package"}; fs.writeFileSync("package.json", JSON.stringify(p, null, 2)); const w="apps/web/package.json"; const q=JSON.parse(fs.readFileSync(w, "utf8")); if(q.scripts) delete q.scripts.postinstall; fs.writeFileSync(w, JSON.stringify(q, null, 2));'
RUN --mount=type=cache,sharing=locked,target=/root/.yarn/berry/cache \
  sh -c 'yarn install --immutable || { status=$?; for log in /tmp/xfs-*/build.log; do [ -f "$log" ] && tail -n 200 "$log"; done; exit "$status"; }'

FROM source-deps AS source-test
COPY . .
COPY run-source-tests.sh /usr/local/bin/run-source-tests.sh
RUN chmod +x /usr/local/bin/run-source-tests.sh
CMD ["/usr/local/bin/run-source-tests.sh"]

FROM source-deps AS app-builder
COPY . .
RUN node patch-next-standalone.js && \
  yarn prisma:generate && \
  yarn web:build

RUN node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync("package.json", "utf8")); if(p.scripts) delete p.scripts.postinstall; fs.writeFileSync("package.json", JSON.stringify(p, null, 2));' && \
  YARN_ENABLE_SCRIPTS=false yarn workspaces focus --production linkwarden @linkwarden/worker && \
  rm -rf apps/web/.next/cache && \
  yarn cache clean

RUN set -eux; \
  standalone_node_modules=apps/web/.next/standalone/node_modules; \
  if [ -d "$standalone_node_modules" ]; then cp -a "$standalone_node_modules"/. node_modules/; fi; \
  find node_modules -type d -name 'swc-*' -path '*/@next/*' -prune -exec rm -rf {} +; \
  find node_modules -type f \( -name 'query_engine_bg.mysql*' -o -name 'query_engine_bg.sqlite*' -o -name 'query_engine_bg.sqlserver*' \) -delete; \
  find node_modules -type f \( -name '*.md' -o -name '*.markdown' -o -name '*.map' -o -name 'CHANGELOG' -o -name 'CHANGELOG.*' -o -name 'LICENSE.md' \) -delete; \
  rm -rf node_modules/@next/eslint-plugin-next node_modules/lucide-react/dist/umd node_modules/lucide-react/dist/lucide-react.prefixed.d.ts node_modules/lucide-react/dist/lucide-react.suffixed.d.ts node_modules/@phosphor-icons/core/assets

FROM ${NODE_IMAGE} AS main-app
ARG UPSTREAM_TAG
ARG UPSTREAM_SHA
ARG RECIPE_ID
ARG PACKAGING_INPUTS_DIGEST
ARG PACKAGING_SOURCE_SHA
ARG NODE_BASE_DIGEST
ARG RUST_BASE_DIGEST
ARG MONOLITH_VERSION=2.10.1
ARG DEBIAN_FRONTEND=noninteractive
LABEL org.opencontainers.image.version=$UPSTREAM_TAG \
  org.opencontainers.image.revision=$PACKAGING_INPUTS_DIGEST \
  io.linkwarden-slim.recipe-id=$RECIPE_ID \
  io.linkwarden-slim.upstream-revision=$UPSTREAM_SHA \
  io.linkwarden-slim.packaging-source-revision=$PACKAGING_SOURCE_SHA \
  io.linkwarden-slim.node-base=$NODE_BASE_DIGEST \
  io.linkwarden-slim.rust-base=$RUST_BASE_DIGEST \
  io.linkwarden-slim.monolith-version=$MONOLITH_VERSION
ENV NODE_ENV=production
ENV PRISMA_HIDE_UPDATE_MESSAGE=1
ENV DISABLE_BROWSER=true
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /data

COPY --from=monolith-builder /usr/local/cargo/bin/monolith /usr/local/bin/monolith
RUN set -eux && \
  apt-get update && \
  apt-get install -yqq --no-install-recommends curl ca-certificates openssl procps && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/*

COPY --from=app-builder /data/apps/web/.next/standalone ./
COPY --from=app-builder /data/apps/web/.next/static ./apps/web/.next/static
COPY --from=app-builder /data/apps/web/public ./apps/web/public
COPY --from=app-builder /data/node_modules ./node_modules
COPY --from=app-builder /data/package.json ./package.json
COPY --from=app-builder /data/apps/worker ./apps/worker
COPY --from=app-builder /data/packages ./packages
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/usr/bin/curl", "--silent", "--fail", "http://127.0.0.1:3000/"]
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["sh", "-c", "export PATH=/data/node_modules/.bin:$PATH && prisma migrate deploy --schema=/data/packages/prisma/schema.prisma && exec concurrently -k -n web,worker \"cd /data && exec node apps/web/server.js\" \"cd /data/apps/worker && exec tsx worker.ts\""]
