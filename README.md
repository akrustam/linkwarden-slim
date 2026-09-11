# linkwarden-slim

Unofficial **slim** multi-arch Docker image of [Linkwarden](https://github.com/linkwarden/linkwarden), built from upstream source **without** bundling Chromium / Playwright browsers.

- Monolith HTML capture binary is still included (Rust `monolith`).
- Default runtime: `DISABLE_BROWSER=true`.
- Image name: `linkwarden-slim`
- Platforms: `linux/amd64`, `linux/arm64`
- Tags: `vX.Y.Z` (same as [upstream releases](https://github.com/linkwarden/linkwarden/releases)) and `latest`

Not affiliated with the Linkwarden project. See [Disclaimer](#disclaimer).

## Pull

Replace `<owner>` / `<user>` with your GitHub org/user and Docker Hub username after you publish.

```bash
# GHCR
docker pull ghcr.io/<owner>/linkwarden-slim:vX.Y.Z
docker pull ghcr.io/<owner>/linkwarden-slim:latest

# Docker Hub
docker pull docker.io/<user>/linkwarden-slim:vX.Y.Z
docker pull docker.io/<user>/linkwarden-slim:latest
```

Pinned upstream version used for local docs / path-push rebuilds: see [`VERSION`](./VERSION) (pin only — **not** the source of truth for “already published”).

## Capabilities without a browser

| Works | Broken / skipped for *new* links |
|-------|----------------------------------|
| UI / API | Screenshot |
| Collections, tags, users | PDF |
| MeiliSearch | Preview images |
| RSS | Readable extraction (browser path) |
| AI tagging (if configured) | Monolith HTML via browser flow* |
| Viewing **already** saved archives | Wayback capture for new links |

\*The `monolith` binary is in the image, but browser-driven preservation paths still require a browser or remote Playwright.

## Entrypoint OR invariant

There is **no** local Chromium. On start, `docker-entrypoint.sh` requires:

```text
ok := (DISABLE_BROWSER|DISABLE_PRESERVATION is truthy) OR (PLAYWRIGHT_WS_URL nonempty)
```

Otherwise the container exits with code `1`.

| Config | Result |
|--------|--------|
| Default (`DISABLE_BROWSER=true`) | OK |
| Disable false + `PLAYWRIGHT_WS_URL=ws://…` | OK |
| Disable false, URL empty | **exit 1** |

Truthy values: `true`, `1`, `yes` (case-insensitive). No TCP probe of the remote browser.

Example — remote Playwright:

```bash
docker run --rm \
  -e DISABLE_BROWSER=false \
  -e PLAYWRIGHT_WS_URL=ws://browser:3000/ \
  … ghcr.io/<owner>/linkwarden-slim:vX.Y.Z
```

## CI / sync policy

**One** workflow: [`.github/workflows/build-publish.yml`](./.github/workflows/build-publish.yml).

| Trigger | Behavior |
|---------|----------|
| Scheduled every 6h (`0 */6 * * *`) | Resolves and publishes the latest upstream release from the default `main` branch. |
| Manual dispatch | Publishes the requested `vX.Y.Z`, or the current upstream release when empty. A historical release can receive any missing immutable registry copy, but cannot move `latest` when freshly resolved inputs differ. |
| Push to `main` affecting packaging | Runs validation only. It never writes a registry tag. |

The publisher seals the default-branch packaging commit and the upstream tag's exact commit SHA before building. It resolves the Node, Rust, Postgres, and Meilisearch references to digests, then builds only from those pinned inputs.

### Base images

The Dockerfile tracks `node:lts-bookworm-slim` and `rust:1.96-bookworm`. The Node tag intentionally follows the current Node LTS line, so its major version can change. A newly resolved base digest does not move `latest` by itself: the candidate must pass all required gates first.

Base inspection is anonymous and credential-free. A registry can still require a bearer-token exchange or apply anonymous rate limits. `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` are used only for publishing; GHCR publishing uses `GITHUB_TOKEN` with `packages: write`.

### Validation and promotion

The CI fail-closed sequence is:

1. Seal the `main` packaging SHA and upstream SHA; resolve digest-pinned bases and services.
2. Build and run the upstream source test suite.
3. Build and smoke-test the amd64 runtime.
4. Push a GHCR-only staging image, then smoke-test its amd64 and arm64 runtime images.
5. Verify the browser invariant on each runtime image: there is no Chromium, and a browser-enabled configuration without a remote Playwright endpoint must fail.
6. Promote the verified artifact to GHCR, mirror it to Docker Hub, and only then consider `latest`.

There is no local Chromium in the image. The source and runtime gates use the same digest-pinned Postgres and Meilisearch service images. If input resolution, build, or any required test fails before promotion, no version or `latest` release tag is published.

`vX.Y.Z` tags are immutable. A base- or packaging-only update never overwrites an existing version tag; it may advance the guarded mutable `latest` tag after the candidate passes the gates and fresh inputs still match. `latest` is evaluated after immutable promotion, so an older manual version does not replace a newer valid `latest` when current inputs have changed.

GHCR and Docker Hub do not support a cross-registry transaction. A failure during promotion can temporarily leave their immutable tags or `latest` tags out of sync. If a `latest` update reaches only one registry, that registry retains the new verified artifact while the other retains its existing `latest`; a later publish run reconciles missing immutable copies and retries the guarded `latest` update.

### Dockerfile sync-policy

Our `Dockerfile` is a deliberate fork of the upstream Dockerfile for the selected `vX.Y.Z` tag:

- Keep `monolith-builder` + `app-builder` (with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`) aligned with upstream.
- **Omit** `playwright install` / `/ms-playwright` and Playwright apt deps in the runtime stage.
- **Add** `DISABLE_BROWSER=true` and `ENTRYPOINT` for `docker-entrypoint.sh`.

On every `VERSION` bump: manually `diff` against upstream’s Dockerfile for that tag; update `node:` / `rust:` base pins in lockstep. No sed/patch in CI.

After `yarn workspaces focus --production`, the Dockerfile:

1. Builds web with Next.js **`output: "standalone"`** (patched via `patch-next-standalone.js`, including `outputFileTracingRoot` for the yarn monorepo).
2. Re-focuses production deps on **root + worker** (not the full web install).
3. Merges standalone traced `node_modules` into that tree.
4. Runs a **safe prune** (keeps `playwright` / `playwright-core` for `PLAYWRIGHT_WS_URL`):
   - remove `@next/swc-*` (build-only)
   - remove unused Prisma WASM for mysql/sqlite/sqlserver (Postgres engines kept)
   - strip `*.md` / `*.map` / lucide UMD / phosphor SVG asset pack

Runtime starts `node apps/web/server.js` (standalone) + `tsx worker.ts`. Desktop “Size” is uncompressed; Hub shows compressed download.

## Compose

See [`docker-compose.example.yml`](./docker-compose.example.yml) for Postgres + MeiliSearch + slim Linkwarden.

## Local build

```bash
git clone https://github.com/linkwarden/linkwarden.git src
git -C src checkout "$(cat VERSION)"
cp docker-entrypoint.sh patch-next-standalone.js ./src/
docker build -f Dockerfile -t linkwarden-slim:local ./src
```

## Publishing setup (maintainers)

1. Create a GitHub repo and push this tree.
2. Add secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`.
3. Ensure `GITHUB_TOKEN` can write packages (`packages: write` is in the workflow).
4. Run **Actions → build-publish → Run workflow** with `version=vX.Y.Z` (first publish).
5. Confirm tags on GHCR and Docker Hub; compare Hub compressed size vs Docker Desktop uncompressed size.

## Disclaimer

This is an unofficial packaging project. Linkwarden® and the application source are owned by their respective authors under [AGPL-3.0](https://github.com/linkwarden/linkwarden/blob/main/LICENSE). Packaging files in this repository are MIT; the image contents include AGPL software — comply with AGPL when redistributing the image. Use at your own risk; no warranty.
