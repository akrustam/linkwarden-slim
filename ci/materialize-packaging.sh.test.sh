#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
script="$script_dir/materialize-packaging.sh"
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

write_packaging_files() {
  local dir=$1
  local label=$2

  mkdir -p "$dir/ci"
  printf 'FROM %s\n' "$label" > "$dir/Dockerfile"
  printf '%s entrypoint\n' "$label" > "$dir/docker-entrypoint.sh"
  printf '%s patch\n' "$label" > "$dir/patch-next-standalone.js"
  printf '%s source tests\n' "$label" > "$dir/ci/run-source-tests.sh"
}

seed="$tmp/seed"
remote="$tmp/packaging.git"
git init -q "$seed"
git -C "$seed" config user.name test
git -C "$seed" config user.email test@example.invalid
write_packaging_files "$seed" first
git -C "$seed" add .
git -C "$seed" commit -qm first
first_sha=$(git -C "$seed" rev-parse HEAD)
git -C "$seed" tag v1.0.0

write_packaging_files "$seed" second
git -C "$seed" add .
git -C "$seed" commit -qm second
second_sha=$(git -C "$seed" rev-parse HEAD)
git clone -q --bare "$seed" "$remote"

fake_bin="$tmp/fake-bin"
mkdir "$fake_bin"
real_git=$(command -v git)
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'if [ "${3-}" = fetch ] && [ "${!#}" = "$REQUESTED_SHA" ]; then' \
  '  args=("$@")' \
  '  args[$(($# - 1))]=$FETCHED_SHA' \
  '  exec "$REAL_GIT" "${args[@]}"' \
  'fi' \
  'exec "$REAL_GIT" "$@"' > "$fake_bin/git"
chmod +x "$fake_bin/git"

if PATH="$fake_bin:$PATH" REQUESTED_SHA="$first_sha" FETCHED_SHA="$second_sha" REAL_GIT="$real_git" \
  "${BASH:-bash}" "$script" "$remote" "$first_sha" "$tmp/mismatched-output"; then
  fail 'materializer accepted a checkout that differs from the requested SHA'
fi

tag_out="$tmp/tag-output"
"${BASH:-bash}" "$script" "$remote" v1.0.0 "$tag_out"
[ "$(git -C "$tag_out" rev-parse HEAD)" = "$first_sha" ] || fail 'materializer did not resolve the requested tag commit'

out="$tmp/output"
mkdir -p "$out/export"
printf 'stale\n' > "$out/export/stale"
"${BASH:-bash}" "$script" "$remote" "$first_sha" "$out"

[ "$(git -C "$out" rev-parse HEAD)" = "$first_sha" ] || fail 'materializer did not checkout the requested SHA'
[ "$(<"$out/export/Dockerfile")" = 'FROM first' ] || fail 'materializer used stale or newer packaging bytes'
[ "$(<"$out/export/docker-entrypoint.sh")" = 'first entrypoint' ] || fail 'materializer did not export the entrypoint'
[ "$(<"$out/export/patch-next-standalone.js")" = 'first patch' ] || fail 'materializer did not export the standalone patch'
[ "$(<"$out/export/ci/run-source-tests.sh")" = 'first source tests' ] || fail 'materializer did not export the source-test launcher'
[ ! -e "$out/export/stale" ] || fail 'materializer retained stale export content'
[ "$first_sha" != "$second_sha" ] || fail 'fixture must contain distinct commits'

git -C "$seed" rm -q ci/run-source-tests.sh
git -C "$seed" commit -qm missing-launcher
missing_sha=$(git -C "$seed" rev-parse HEAD)
git --git-dir="$remote" fetch -q "$seed" "$missing_sha"

if "${BASH:-bash}" "$script" "$remote" "$missing_sha" "$tmp/missing-output"; then
  fail 'materializer accepted a checkout missing a required export'
fi

dockerfile="$repo_root/Dockerfile"
for required in \
  'ARG NODE_IMAGE' \
  'ARG RUST_IMAGE' \
  'ARG MONOLITH_VERSION=2.10.1' \
  'FROM ${RUST_IMAGE} AS monolith-builder' \
  'cargo install --locked monolith@${MONOLITH_VERSION}' \
  'FROM ${NODE_IMAGE} AS source-deps' \
  'COPY mobile-package.json ./apps/mobile/package.json' \
  'COPY apps/extension/package.json ./apps/extension/' \
  'yarn install --immutable' \
  'FROM source-deps AS source-test' \
  'CMD ["/usr/local/bin/run-source-tests.sh"]' \
  'FROM source-deps AS app-builder' \
  'FROM ${NODE_IMAGE} AS main-app' \
  'org.opencontainers.image.version=$UPSTREAM_TAG' \
  'org.opencontainers.image.revision=$PACKAGING_INPUTS_DIGEST' \
  'io.linkwarden-slim.recipe-id=$RECIPE_ID' \
  'io.linkwarden-slim.upstream-revision=$UPSTREAM_SHA' \
  'io.linkwarden-slim.packaging-source-revision=$PACKAGING_SOURCE_SHA' \
  'io.linkwarden-slim.node-base=$NODE_BASE_DIGEST' \
  'io.linkwarden-slim.rust-base=$RUST_BASE_DIGEST' \
  'io.linkwarden-slim.monolith-version=$MONOLITH_VERSION'; do
  grep -Fq "$required" "$dockerfile" || fail "Dockerfile is missing: $required"
done

if grep -Fq 'node:22' "$dockerfile" || grep -Fq 'rust:1.96' "$dockerfile"; then
  fail 'Dockerfile retains a hard-coded base image reference'
fi

if ! grep -Fq 'p.scripts={...(p.scripts||{}),postinstall:"patch-package"}' "$dockerfile"; then
  fail 'source dependency install does not preserve root patch-package postinstall'
fi

if ! grep -Fq 'if(q.scripts) delete q.scripts.postinstall' "$dockerfile"; then
  fail 'source dependency install does not remove web postinstall'
fi

if ! grep -Fq 'YARN_ENABLE_SCRIPTS=false yarn workspaces focus --production linkwarden @linkwarden/worker' "$dockerfile"; then
  fail 'production focus does not retain the browser-disabled worker dependency flow'
fi

printf '%s\n' 'materialize-packaging tests passed'
