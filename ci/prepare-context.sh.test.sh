#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
script="$script_dir/prepare-context.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

upstream_seed="$tmp/upstream-seed"
upstream_remote="$tmp/upstream.git"
packaging_export="$tmp/packaging-export"
git init -q "$upstream_seed"
git -C "$upstream_seed" config user.name test
git -C "$upstream_seed" config user.email test@example.invalid
printf 'upstream Dockerfile at tag\n' > "$upstream_seed/Dockerfile"
printf 'tag source\n' > "$upstream_seed/source.txt"
git -C "$upstream_seed" add .
git -C "$upstream_seed" commit -qm tagged
mkdir -p "$upstream_seed/apps/mobile"
printf '{"name":"@linkwarden/mobile"}\n' > "$upstream_seed/apps/mobile/package.json"
printf 'apps/mobile\n' > "$upstream_seed/.dockerignore"
git -C "$upstream_seed" add apps/mobile/package.json .dockerignore
git -C "$upstream_seed" commit -qm mobile-workspace
tag_sha=$(git -C "$upstream_seed" rev-parse HEAD)
git -C "$upstream_seed" tag v1.0.0
printf 'upstream Dockerfile after tag\n' > "$upstream_seed/Dockerfile"
git -C "$upstream_seed" add Dockerfile
git -C "$upstream_seed" commit -qm newer
newer_sha=$(git -C "$upstream_seed" rev-parse HEAD)
git clone -q --bare "$upstream_seed" "$upstream_remote"

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

mkdir -p "$packaging_export/ci"
printf 'packaging Dockerfile\n' > "$packaging_export/Dockerfile"
printf 'packaging entrypoint\n' > "$packaging_export/docker-entrypoint.sh"
printf 'packaging patch\n' > "$packaging_export/patch-next-standalone.js"
printf 'packaging source tests\n' > "$packaging_export/ci/run-source-tests.sh"

dest="$tmp/context"
"${BASH:-bash}" "$script" "$upstream_remote" v1.0.0 "$packaging_export" "$dest"

[ "$(git -C "$dest" rev-parse HEAD)" = "$tag_sha" ] || fail 'prepare-context did not checkout the requested tag commit'
[ "$(git -C "$dest" symbolic-ref -q HEAD || true)" = '' ] || fail 'prepare-context checkout is not detached'
[ "$(<"$dest/Dockerfile")" = 'upstream Dockerfile at tag' ] || fail 'prepare-context copied the packaging Dockerfile into the upstream context'
[ "$(<"$dest/docker-entrypoint.sh")" = 'packaging entrypoint' ] || fail 'prepare-context did not inject the entrypoint'
[ "$(<"$dest/patch-next-standalone.js")" = 'packaging patch' ] || fail 'prepare-context did not inject the standalone patch'
[ "$(<"$dest/run-source-tests.sh")" = 'packaging source tests' ] || fail 'prepare-context did not inject the source-test launcher'
[ "$(<"$dest/mobile-package.json")" = '{"name":"@linkwarden/mobile"}' ] || fail 'prepare-context did not stage the ignored mobile workspace manifest'

nonempty_dest="$tmp/nonempty-context"
mkdir -p "$nonempty_dest"
printf 'keep\n' > "$nonempty_dest/sentinel"
if "${BASH:-bash}" "$script" "$upstream_remote" v1.0.0 "$packaging_export" "$nonempty_dest"; then
  fail 'prepare-context removed a nonempty destination'
fi
[ "$(<"$nonempty_dest/sentinel")" = keep ] || fail 'prepare-context changed a nonempty destination'

printf 'stale entrypoint\n' > "$packaging_export/docker-entrypoint.sh"
stale_dest="$tmp/stale-context"
"${BASH:-bash}" "$script" "$upstream_remote" v1.0.0 "$packaging_export" "$stale_dest"
[ "$(<"$stale_dest/docker-entrypoint.sh")" = 'stale entrypoint' ] || fail 'prepare-context did not use the supplied packaging export'
printf 'packaging entrypoint\n' > "$packaging_export/docker-entrypoint.sh"

sha_dest="$tmp/sha-context"
"${BASH:-bash}" "$script" "$upstream_remote" "$tag_sha" "$packaging_export" "$sha_dest"
[ "$(git -C "$sha_dest" rev-parse HEAD)" = "$tag_sha" ] || fail 'prepare-context did not checkout the requested SHA'

if PATH="$fake_bin:$PATH" REQUESTED_SHA="$tag_sha" FETCHED_SHA="$newer_sha" REAL_GIT="$real_git" \
  "${BASH:-bash}" "$script" "$upstream_remote" "$tag_sha" "$packaging_export" "$tmp/mismatched-context"; then
  fail 'prepare-context accepted a checkout that differs from the requested SHA'
fi

missing_export="$tmp/missing-export"
mkdir -p "$missing_export/ci"
printf 'entrypoint\n' > "$missing_export/docker-entrypoint.sh"
printf 'source tests\n' > "$missing_export/ci/run-source-tests.sh"
mkdir -p "$tmp/untouched"
printf 'keep\n' > "$tmp/untouched/sentinel"

if "${BASH:-bash}" "$script" "$upstream_remote" "$tag_sha" "$missing_export" "$tmp/untouched"; then
  fail 'prepare-context accepted an export missing the standalone patch'
fi
[ "$(<"$tmp/untouched/sentinel")" = keep ] || fail 'prepare-context changed the destination after export validation failed'

printf '%s\n' 'prepare-context tests passed'
