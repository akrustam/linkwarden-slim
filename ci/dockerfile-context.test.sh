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
grep -Fq 'ARG NODE_IMAGE' "$dockerfile" \
  || fail 'Dockerfile is missing the sealed Node image argument'
grep -Fq 'ARG RUST_IMAGE' "$dockerfile" \
  || fail 'Dockerfile is missing the sealed Rust image argument'
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
source_deps_openssl_line=$(grep -n 'apt-get install -yqq --no-install-recommends openssl' "$dockerfile" | cut -d: -f1 | awk -v start="$source_deps_start" -v end="$source_deps_end" '$1 > start && $1 < end { print; exit }')
[ -n "$source_deps_openssl_line" ] || fail 'source-deps does not install the runtime OpenSSL major before Prisma generation'
[ "$source_deps_openssl_line" -lt "$immutable_install_line" ] || fail 'source-deps installs OpenSSL after the immutable dependency install'
grep -Fq 'yarn prisma:generate' "$dockerfile" \
  || fail 'app-builder does not generate Prisma from its native build platform'
grep -Fq 'yarn workspace @linkwarden/prisma generate' "$dockerfile" \
  || fail 'app-builder does not regenerate Prisma after copying standalone dependencies'
if grep -Fq 'PRISMA_CLI_BINARY_TARGETS=' "$dockerfile"; then
  fail 'Dockerfile hard-codes a Prisma CLI binary target across platforms'
fi
if grep -Fq 'cp node_modules/@prisma/engines/libquery_engine-' "$dockerfile"; then
  fail 'Dockerfile copies an architecture-specific Prisma engine by filename'
fi

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

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  fail 'Docker is required when CI_RUN_NETWORK_TESTS=1'
fi

packaging_seed="$tmp/packaging-seed"
packaging_remote="$tmp/packaging.git"
mkdir -p "$packaging_seed/ci"
for path in Dockerfile docker-entrypoint.sh patch-next-standalone.js ci/run-source-tests.sh build-lock.json; do
  cp "$repo_root/$path" "$packaging_seed/$path"
done
git init -q "$packaging_seed"
git -C "$packaging_seed" add .
git -C "$packaging_seed" -c user.name=test -c user.email=test@example.invalid commit -qm 'test packaging snapshot'
git clone -q --bare "$packaging_seed" "$packaging_remote"
packaging_sha=$(git --git-dir="$packaging_remote" rev-parse HEAD)
packaging_export="$tmp/packaging-export"
"${BASH:-bash}" "$script_dir/materialize-packaging.sh" "file://$packaging_remote" "$packaging_sha" "$packaging_export"

[ "$(git -C "$packaging_export" rev-parse HEAD)" = "$packaging_sha" ] \
  || fail 'materializer did not use the local packaging remote SHA'
[ -f "$packaging_export/export/ci/run-source-tests.sh" ] \
  || fail 'materializer did not export the source-test launcher'

upstream_remote="$tmp/upstream.git"
upstream_sha=$(node -p 'require(process.argv[1]).upstream.commit' "$repo_root/build-lock.json")
upstream_url=$(node -p 'require(process.argv[1]).upstream.url' "$repo_root/build-lock.json")
[ -n "$upstream_sha" ] || fail 'missing locked upstream commit'
git init -q --bare "$upstream_remote"
git --git-dir="$upstream_remote" fetch -q --no-tags "$upstream_url" "$upstream_sha"

context="$tmp/context"
"${BASH:-bash}" "$script_dir/prepare-context.sh" "file://$upstream_remote" "$upstream_sha" "$packaging_export/export" "$context"

[ -f "$context/package.json" ] || fail 'locked upstream is missing package.json'
[ ! -e "$context/mobile-package.json" ] || fail 'prepare-context still stages a mobile workspace manifest workaround'
[ -f "$context/run-source-tests.sh" ] || fail 'prepare-context did not place the source-test launcher at the build-context root'
[ -f "$packaging_export/export/Dockerfile" ] \
  || fail 'packaging Dockerfile is missing from the materialized export'
grep -Fq 'CMD ["/usr/local/bin/run-source-tests.sh"]' "$packaging_export/export/Dockerfile" \
  || fail 'source-test target does not run the root source-test launcher'

node_image=$(node -p 'require(process.argv[1]).images.node' "$repo_root/build-lock.json")
rust_image=$(node -p 'require(process.argv[1]).images.rust' "$repo_root/build-lock.json")

docker buildx build --load \
  --target source-deps \
  -f "$packaging_export/export/Dockerfile" \
  --build-arg "NODE_IMAGE=$node_image" \
  --build-arg "RUST_IMAGE=$rust_image" \
  "$context"

printf '%s\n' 'dockerfile context tests passed'
