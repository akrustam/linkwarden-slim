# linkwarden-slim: fork of upstream Dockerfile @ v2.15.1
# https://github.com/linkwarden/linkwarden/blob/v2.15.1/Dockerfile
# Diff: omit playwright install / /ms-playwright; add DISABLE_BROWSER + entrypoint.
# Sync-policy: on VERSION bump, manually diff against upstream Dockerfile for that tag;
# keep node:/rust: pins in lockstep.

# ==============================================================================
# Stage 1: Monolith Builder
# ==============================================================================
FROM docker.io/rust:1.96-bullseye AS monolith-builder
RUN set -eux && cargo install --locked monolith

# ==============================================================================
# Stage 2: App Builder (Where the heavy building happens)
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

# Copy source and build
COPY . .
RUN yarn prisma:generate && \
 yarn web:build

# Clean up dev dependencies right here before copying to the final stage
RUN yarn workspaces focus --production linkwarden @linkwarden/web @linkwarden/worker && \
 rm -rf apps/web/.next/cache && \
 yarn cache clean

# ==============================================================================
# Stage 3: Slim Runtime (no Chromium / Playwright browsers)
# ==============================================================================
FROM node:22.23.1-bullseye-slim AS main-app
ENV NODE_ENV=production
ENV PRISMA_HIDE_UPDATE_MESSAGE=1
# Slim default: skip browser-based preservation at runtime.
# Override with DISABLE_BROWSER=false and set PLAYWRIGHT_WS_URL for a remote browser.
ENV DISABLE_BROWSER=true
ARG DEBIAN_FRONTEND=noninteractive
WORKDIR /data

# Copy the Rust monolith binary
COPY --from=monolith-builder /usr/local/cargo/bin/monolith /usr/local/bin/monolith

# Install minimal runtime system utilities
# procps provides `ps`, which concurrently -k needs to manage child processes
RUN set -eux && \
 apt-get update && \
 apt-get install -yqq --no-install-recommends curl ca-certificates openssl procps && \
 apt-get clean && \
 rm -rf /var/lib/apt/lists/*

# Copy ONLY the clean production assets from Stage 2
COPY --from=app-builder /data/node_modules ./node_modules
COPY --from=app-builder /data/package.json ./package.json
COPY --from=app-builder /data/apps/web ./apps/web
COPY --from=app-builder /data/apps/worker ./apps/worker
COPY --from=app-builder /data/packages ./packages

# Fail-fast entrypoint (OR: disable flags or PLAYWRIGHT_WS_URL)
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

HEALTHCHECK --interval=30s \
 --timeout=5s \
 --start-period=10s \
 --retries=3 \
 CMD [ "/usr/bin/curl", "--silent", "--fail", "http://127.0.0.1:3000/" ]

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["sh", "-c", "export PATH=/data/node_modules/.bin:$PATH && prisma migrate deploy --schema=/data/packages/prisma/schema.prisma && exec concurrently -k -n web,worker \"cd /data/apps/web && exec next start\" \"cd /data/apps/worker && exec tsx worker.ts\""]
