#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

dockerfile="$repo_root/Dockerfile"
grep -Fq 'ARG NODE_IMAGE=node:lts-bookworm-slim' "$dockerfile" \
  || fail 'Dockerfile is missing the local Node image default'
grep -Fq 'ARG RUST_IMAGE=rust:1.96-bookworm' "$dockerfile" \
  || fail 'Dockerfile is missing the local Rust image default'
if grep -Fq 'COPY apps/extension/package.json ./apps/extension/' "$dockerfile"; then
  fail 'Dockerfile still requires the removed apps/extension workspace'
fi
if grep -Fq 'mobile-package.json' "$dockerfile"; then
  fail 'Dockerfile still relies on the mobile workspace manifest workaround'
fi
if grep -Fq 'COPY apps/' "$dockerfile" || grep -Fq 'COPY packages/' "$dockerfile"; then
  fail 'Dockerfile still enumerates workspace manifests'
fi

source_deps_start=$(grep -n '^FROM ${NODE_IMAGE} AS source-deps$' "$dockerfile" | cut -d: -f1)
source_deps_end=$(grep -n '^FROM source-deps AS source-test$' "$dockerfile" | cut -d: -f1)
full_source_copy_line=$(grep -n '^COPY \. \.$' "$dockerfile" | cut -d: -f1 | awk -F: -v start="$source_deps_start" -v end="$source_deps_end" '$1 > start && $1 < end { print $1; exit }')
immutable_install_line=$(grep -n 'yarn install --immutable' "$dockerfile" | cut -d: -f1 | awk -F: -v start="$source_deps_start" -v end="$source_deps_end" '$1 > start && $1 < end { print $1; exit }')

[ -n "$source_deps_start" ] || fail 'Dockerfile is missing source-deps stage'
[ -n "$source_deps_end" ] || fail 'Dockerfile is missing source-test stage'
[ -n "$full_source_copy_line" ] || fail 'source-deps does not copy the complete upstream source'
[ -n "$immutable_install_line" ] || fail 'source-deps does not retain yarn install --immutable'
[ "$full_source_copy_line" -lt "$immutable_install_line" ] || fail 'source-deps copies the complete source after immutable install'

for path in \
  "$script_dir/materialize-packaging.sh" \
  "$script_dir/materialize-packaging.sh.test.sh" \
  "$script_dir/prepare-context.sh" \
  "$script_dir/prepare-context.sh.test.sh"; do
  [ -f "$path" ] || fail "missing context helper or test: $path"
done

if [ "${CI_RUN_NETWORK_TESTS:-0}" != '1' ]; then
  printf '%s\n' 'skipping networked dockerfile context build; set CI_RUN_NETWORK_TESTS=1 to run it'
  exit 0
fi

packaging_seed="$tmp/packaging-seed"
packaging_remote="$tmp/packaging.git"
git clone -q "$repo_root" "$packaging_seed"
# Include uncommitted packaging changes so this local remote exactly represents
# the branch content the harness is validating before its focused commit.
if ! git -C "$repo_root" diff --quiet -- Dockerfile docker-entrypoint.sh patch-next-standalone.js ci/run-source-tests.sh; then
  git -C "$repo_root" diff --binary -- Dockerfile docker-entrypoint.sh patch-next-standalone.js ci/run-source-tests.sh \
    | git -C "$packaging_seed" apply
  git -C "$packaging_seed" add Dockerfile docker-entrypoint.sh patch-next-standalone.js ci/run-source-tests.sh
  git -C "$packaging_seed" -c user.name=test -c user.email=test@example.invalid commit -qm 'test packaging snapshot'
fi
git clone -q --bare "$packaging_seed" "$packaging_remote"
packaging_sha=$(git --git-dir="$packaging_remote" rev-parse HEAD)
packaging_export="$tmp/packaging-export"
"${BASH:-bash}" "$script_dir/materialize-packaging.sh" "file://$packaging_remote" "$packaging_sha" "$packaging_export"

[ "$(git -C "$packaging_export" rev-parse HEAD)" = "$packaging_sha" ] \
  || fail 'materializer did not use the local packaging remote SHA'
[ -f "$packaging_export/export/ci/run-source-tests.sh" ] \
  || fail 'materializer did not export the source-test launcher'

upstream_remote="$tmp/upstream.git"
upstream_sha=$(git ls-remote https://github.com/linkwarden/linkwarden.git refs/tags/v2.16.3 | cut -f1)
[ -n "$upstream_sha" ] || fail 'could not resolve upstream v2.16.3'
git init -q --bare "$upstream_remote"
git --git-dir="$upstream_remote" fetch -q --no-tags https://github.com/linkwarden/linkwarden.git "$upstream_sha"

context="$tmp/context"
"${BASH:-bash}" "$script_dir/prepare-context.sh" "file://$upstream_remote" "$upstream_sha" "$packaging_export/export" "$context"

[ -f "$context/apps/mobile/package.json" ] || fail 'upstream v2.16.3 is missing apps/mobile/package.json'
[ -f "$context/apps/extension/package.json" ] || fail 'upstream v2.16.3 is missing apps/extension/package.json'
[ ! -e "$context/mobile-package.json" ] || fail 'prepare-context still stages a mobile workspace manifest workaround'
[ -f "$context/run-source-tests.sh" ] || fail 'prepare-context did not place the source-test launcher at the build-context root'
[ -f "$packaging_export/export/Dockerfile" ] \
  || fail 'packaging Dockerfile is missing from the materialized export'
grep -Fq 'CMD ["/usr/local/bin/run-source-tests.sh"]' "$packaging_export/export/Dockerfile" \
  || fail 'source-test target does not run the root source-test launcher'

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  printf '%s\n' 'docker unavailable; static context validation passed'
  exit 0
fi

node_image=$(docker buildx imagetools inspect --format '{{json .Manifest.Digest}}' node:lts-bookworm-slim)
rust_image=$(docker buildx imagetools inspect --format '{{json .Manifest.Digest}}' rust:1.96-bookworm)

case "$node_image" in
  '"sha256:'[a-f0-9][a-f0-9]*) ;;
  *) fail 'could not resolve an immutable Node image digest' ;;
esac
case "$rust_image" in
  '"sha256:'[a-f0-9][a-f0-9]*) ;;
  *) fail 'could not resolve an immutable Rust image digest' ;;
esac
node_image=${node_image#\"}
node_image=${node_image%\"}
rust_image=${rust_image#\"}
rust_image=${rust_image%\"}

docker build \
  --target source-deps \
  -f "$packaging_export/export/Dockerfile" \
  --build-arg "NODE_IMAGE=node:lts-bookworm-slim@$node_image" \
  --build-arg "RUST_IMAGE=rust:1.96-bookworm@$rust_image" \
  "$context"

printf '%s\n' 'dockerfile context tests passed'
