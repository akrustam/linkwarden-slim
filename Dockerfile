# linkwarden-slim: fork of upstream Dockerfile @ v2.15.1
# https://github.com/linkwarden/linkwarden/blob/v2.15.1/Dockerfile
# Diff vs upstream:
#  - omit playwright install / /ms-playwright
#  - Next.js output: "standalone" (+ outputFileTracingRoot for yarn workspaces)
#  - worker-focused production node_modules merged with standalone trace
#  - safe prune; DISABLE_BROWSER + entrypoint
# Sync-policy: on VERSION bump, manually diff against upstream Dockerfile for that tag;
# keep node:/rust: pins in lockstep.

# ==============================================================================
# Stage 1: Monolith Builder
# ==============================================================================
FROM docker.io/rust:1.96-bullseye AS monolith-builder
RUN set -eux && cargo install --locked monolith

# ==============================================================================
# Stage 2: App Builder
# ==============================================================================
FROM node:22.23.1-bullseye-slim AS app-builder

ENV YARN_HTTP_TIMEOUT=10000000
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PRISMA_HIDE_UPDATE_MESSAGE=1
# Skip browser download during yarn postinstall (slim image never installs Chromium).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /data

RUN corepack enable

# Copy only structure first for optimized caching
COPY package.json yarn.lock .yarnrc.yml ./
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/filesystem/package.json ./packages/filesystem/
COPY packages/lib/package.json ./packages/lib/
COPY packages/prisma/package.json ./packages/prisma/
COPY packages/router/package.json ./packages/router/
COPY packages/types/package.json ./packages/types/

# Install everything needed to build
RUN --mount=type=cache,sharing=locked,target=/root/.yarn/berry/cache \
 yarn workspaces focus linkwarden @linkwarden/web @linkwarden/worker

# Copy source, enable standalone, build web
COPY . .
# patch-next-standalone.js is injected into the build context by CI / local build instructions
RUN node patch-next-standalone.js && \
 yarn prisma:generate && \
 yarn web:build

# Worker + root (concurrently) production deps — not the full web tree.
# Root postinstall runs web playwright install; strip it before focusing without web.
# Standalone already traced web runtime files under apps/web/.next/standalone.
RUN node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json','utf8')); if (p.scripts) delete p.scripts.postinstall; fs.writeFileSync('package.json', JSON.stringify(p, null, 2));" && \
 YARN_ENABLE_SCRIPTS=false yarn workspaces focus --production linkwarden @linkwarden/worker && \
 rm -rf apps/web/.next/cache && \
 yarn cache clean

# Merge Next standalone traced node_modules into the worker production tree
# so `node apps/web/server.js` and `tsx worker.ts` share one /data/node_modules.
RUN set -eux; \
  STANDALONE_NM=apps/web/.next/standalone/node_modules; \
  if [ -d "$STANDALONE_NM" ]; then \
    cp -a "$STANDALONE_NM"/. node_modules/; \
  fi

# Safe prune (keep playwright / playwright-core for PLAYWRIGHT_WS_URL).
RUN set -eux; \
  find node_modules -type d -name 'swc-*' -path '*/@next/*' -prune -exec rm -rf {} +; \
  find node_modules -type f \( \
    -name 'query_engine_bg.mysql*' -o \
    -name 'query_engine_bg.sqlite*' -o \
    -name 'query_engine_bg.sqlserver*' \
  \) -delete; \
  find node_modules -type f \( \
    -name '*.md' -o -name '*.markdown' -o -name '*.map' -o \
    -name 'CHANGELOG' -o -name 'CHANGELOG.*' -o -name 'LICENSE.md' \
  \) -delete; \
  rm -rf \
    node_modules/@next/eslint-plugin-next \
    node_modules/lucide-react/dist/umd \
    node_modules/lucide-react/dist/lucide-react.prefixed.d.ts \
    node_modules/lucide-react/dist/lucide-react.suffixed.d.ts \
    ; \
  rm -rf node_modules/@phosphor-icons/core/assets

# ==============================================================================
# Stage 3: Slim Runtime
# ==============================================================================
FROM node:22.23.1-bullseye-slim AS main-app
ENV NODE_ENV=production
ENV PRISMA_HIDE_UPDATE_MESSAGE=1
ENV DISABLE_BROWSER=true
# Required for Next standalone to accept connections from outside the container
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ARG DEBIAN_FRONTEND=noninteractive
WORKDIR /data

COPY --from=monolith-builder /usr/local/cargo/bin/monolith /usr/local/bin/monolith

RUN set -eux && \
 apt-get update && \
 apt-get install -yqq --no-install-recommends curl ca-certificates openssl procps && \
 apt-get clean && \
 rm -rf /var/lib/apt/lists/*

# Standalone server tree (apps/web/server.js + traced files + packages as traced)
COPY --from=app-builder /data/apps/web/.next/standalone ./
# Static assets are not inside standalone by default
COPY --from=app-builder /data/apps/web/.next/static ./apps/web/.next/static
COPY --from=app-builder /data/apps/web/public ./apps/web/public

# Shared production node_modules (worker focus + standalone merge) and worker/packages
COPY --from=app-builder /data/node_modules ./node_modules
COPY --from=app-builder /data/package.json ./package.json
COPY --from=app-builder /data/apps/worker ./apps/worker
COPY --from=app-builder /data/packages ./packages

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

HEALTHCHECK --interval=30s \
 --timeout=5s \
 --start-period=10s \
 --retries=3 \
 CMD [ "/usr/bin/curl", "--silent", "--fail", "http://127.0.0.1:3000/" ]

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
# Web: Next standalone server. Worker: unchanged tsx entrypoint.
CMD ["sh", "-c", "export PATH=/data/node_modules/.bin:$PATH && prisma migrate deploy --schema=/data/packages/prisma/schema.prisma && exec concurrently -k -n web,worker \"cd /data && exec node apps/web/server.js\" \"cd /data/apps/worker && exec tsx worker.ts\""]
