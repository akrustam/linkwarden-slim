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
docker pull ghcr.io/<owner>/linkwarden-slim:v2.15.1
docker pull ghcr.io/<owner>/linkwarden-slim:latest

# Docker Hub
docker pull docker.io/<user>/linkwarden-slim:v2.15.1
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
  … ghcr.io/<owner>/linkwarden-slim:v2.15.1
```

## CI / sync policy

**One** workflow: [`.github/workflows/build-publish.yml`](./.github/workflows/build-publish.yml).

| Trigger | Version source |
|---------|----------------|
| `schedule` every 6h (`0 */6 * * *`) | `releases/latest` → `tag_name` |
| `workflow_dispatch` | input `version` (+ optional `force`) |
| `push` to `main` (Dockerfile / entrypoint / workflow) | pin from `VERSION` |

**Source of truth for “already built”:** versioned tag on GHCR  
`ghcr.io/<owner>/linkwarden-slim:vX.Y.Z`.  
If it exists and `force` is false → skip. `VERSION` in git is only a pin (docs + path-push); commit of the pin after publish is best-effort.

Build contract:

```text
checkout this repo
checkout linkwarden/linkwarden @ <tag> → ./src
cp docker-entrypoint.sh ./src/
docker buildx build -f Dockerfile ./src
```

### Dockerfile sync-policy

Our `Dockerfile` is a deliberate fork of the [upstream Dockerfile](https://github.com/linkwarden/linkwarden/blob/v2.15.1/Dockerfile) for the same tag:

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
4. Run **Actions → build-publish → Run workflow** with `version=v2.15.1` (first publish).
5. Confirm tags on GHCR and Docker Hub; compare Hub compressed size vs Docker Desktop uncompressed size.

## Disclaimer

This is an unofficial packaging project. Linkwarden® and the application source are owned by their respective authors under [AGPL-3.0](https://github.com/linkwarden/linkwarden/blob/main/LICENSE). Packaging files in this repository are MIT; the image contents include AGPL software — comply with AGPL when redistributing the image. Use at your own risk; no warranty.
