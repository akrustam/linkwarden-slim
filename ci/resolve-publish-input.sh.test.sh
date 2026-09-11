#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
script="$script_dir/resolve-publish-input.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

sha_a=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
sha_b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
sha_c=cccccccccccccccccccccccccccccccccccccccc
sha_d=dddddddddddddddddddddddddddddddddddddddd

[ -f "$script" ] || fail 'missing canonical publish input resolver'
bash -n "$script"

fake_bin="$tmp/fake-bin"
mkdir "$fake_bin"
cat > "$fake_bin/gh" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$GH_LOG"
printf '%s\n' "${GH_TAG:-v1.2.3}"
EOF
cat > "$fake_bin/git" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$GIT_LOG"
[ "$1" = ls-remote ] || exit 1
case "$2" in
  upstream|https://github.com/linkwarden/linkwarden.git|https://github.com/example-owner/example-repo.git|git@github.com:linkwarden/linkwarden.git)
    printf '%s\t%s\n' "$UPSTREAM_PEELED_SHA" 'refs/tags/v1.2.3^{}'
    printf '%s\t%s\n' "$UPSTREAM_TAG_SHA" 'refs/tags/v1.2.3'
    ;;
  packaging)
    printf '%s\t%s\n' "$PACKAGING_MAIN_SHA" 'refs/heads/main'
    ;;
  *) exit 1 ;;
esac
EOF
cat > "$fake_bin/bash" <<'EOF'
#!/bin/sh
set -eu
if [ "$1" = "$MATERIALIZE_SCRIPT" ]; then
  printf '%s\n' "$*" >> "$MATERIALIZE_LOG"
  printf '%s\n' "$4" > "$MATERIALIZE_DEST"
  mkdir -p "$4/export"
  exit 0
fi
exec "$REAL_BASH" "$@"
EOF
cat > "$fake_bin/node" <<'EOF'
#!/bin/sh
set -eu
if [ "$1" = -e ]; then
  exec "$REAL_NODE" "$@" </dev/null
fi
[ -n "${DOCKER_CONFIG:-}" ] || exit 1
[ -d "$DOCKER_CONFIG" ] || exit 1
[ -z "$(ls -A "$DOCKER_CONFIG")" ] || exit 1
printf '%s\n' "$DOCKER_CONFIG" > "$DOCKER_CONFIG_PATH"
printf '%s\n' "$*" > "$NODE_ARGS"
while [ "$#" -gt 0 ]; do
  if [ "$1" = --out ]; then
    printf '%s\n' '{}' > "$2"
    exit 0
  fi
  shift
done
exit 1
EOF
chmod +x "$fake_bin/gh" "$fake_bin/git" "$fake_bin/bash" "$fake_bin/node"
real_node="$(PATH="${PATH#*:}" command -v node)"

upstream_url=https://github.com/linkwarden/linkwarden.git
common=(
  --out "$tmp/input.json"
  --regctl regctl
  --packaging-url packaging
  --upstream-url "$upstream_url"
  --postgres postgres:16-alpine
  --meili getmeili/meilisearch:v1.13.3
  --node node:lts-bookworm-slim
  --rust rust:1.96-bookworm
  --monolith-version 2.10.1
)

run_resolver() {
  : > "$tmp/gh.log"
  : > "$tmp/git.log"
  : > "$tmp/materialize.log"
  PATH="$fake_bin:$PATH" \
    REAL_BASH="$(command -v bash)" \
    REAL_NODE="$real_node" \
    MATERIALIZE_SCRIPT="$script_dir/materialize-packaging.sh" \
    MATERIALIZE_LOG="$tmp/materialize.log" \
    MATERIALIZE_DEST="$tmp/materialize-dest" \
    GH_LOG="$tmp/gh.log" \
    GIT_LOG="$tmp/git.log" \
    NODE_ARGS="$tmp/node-args" \
    DOCKER_CONFIG_PATH="$tmp/docker-config-path" \
    UPSTREAM_PEELED_SHA="$sha_a" \
    UPSTREAM_TAG_SHA="$sha_b" \
    PACKAGING_MAIN_SHA="$sha_c" \
    "${BASH:-bash}" "$script" "$@"
}

: > "$tmp/gh.log"
: > "$tmp/git.log"
: > "$tmp/materialize.log"
fresh_args="$(
  PATH="$fake_bin:$PATH" \
    REAL_NODE="$real_node" \
    GH_LOG="$tmp/gh.log" \
    GIT_LOG="$tmp/git.log" \
    MATERIALIZE_LOG="$tmp/materialize.log" \
    "${BASH:-bash}" "$script" --print-fresh-args \
      --regctl regctl \
      --packaging-url packaging \
      --upstream-url "$upstream_url" \
      --postgres postgres:16-alpine \
      --meili getmeili/meilisearch:v1.13.3 \
      --node node:lts-bookworm-slim \
      --rust rust:1.96-bookworm \
      --monolith-version 2.10.1
)"
node -e '
  const args = JSON.parse(process.argv[1]);
  const expected = [
    "--latest-upstream", "--packaging-main", "--regctl", "regctl",
    "--packaging-url", "packaging", "--upstream-url", "https://github.com/linkwarden/linkwarden.git",
    "--postgres", "postgres:16-alpine", "--meili", "getmeili/meilisearch:v1.13.3",
    "--node", "node:lts-bookworm-slim", "--rust", "rust:1.96-bookworm",
    "--monolith-version", "2.10.1",
  ];
  if (JSON.stringify(args) !== JSON.stringify(expected)) process.exit(1);
' "$fresh_args" || fail 'fresh argument mode did not output the canonical publish argv JSON array'
[ ! -s "$tmp/gh.log" ] || fail 'fresh argument mode invoked gh'
[ ! -s "$tmp/git.log" ] || fail 'fresh argument mode resolved the network'
[ ! -s "$tmp/materialize.log" ] || fail 'fresh argument mode materialized packaging'
if run_resolver --print-fresh-args "${common[@]}"; then
  fail 'fresh argument mode accepted --out'
fi
if run_resolver --print-fresh-args --regctl regctl --packaging-url packaging --upstream-url "$upstream_url" \
  --postgres postgres:16-alpine --meili getmeili/meilisearch:v1.13.3 --node node:lts-bookworm-slim \
  --rust rust:1.96-bookworm --monolith-version 2.10.1 --upstream-tag v1.2.3; then
  fail 'fresh argument mode accepted a resolver source mode'
fi

if run_resolver "${common[@]}" --upstream-tag v1.2.3 --latest-upstream --packaging-sha "$sha_d"; then
  fail 'canonical resolver accepted conflicting upstream source modes'
fi
if run_resolver "${common[@]}" --upstream-tag v1.2.3 --packaging-sha "$sha_d" --packaging-main; then
  fail 'canonical resolver accepted conflicting packaging source modes'
fi
if run_resolver "${common[@]}" --latest-upstream --packaging-sha "$sha_d"; then
  fail 'canonical resolver accepted latest upstream mode without GH_TOKEN'
fi

run_resolver "${common[@]}" --upstream-tag v1.2.3 --packaging-sha "$sha_d"

[ ! -s "$tmp/gh.log" ] || fail 'explicit upstream tag unexpectedly invoked gh'
grep -Fxq "ls-remote $upstream_url refs/tags/v1.2.3^{} refs/tags/v1.2.3" "$tmp/git.log" \
  || fail 'explicit upstream tag did not request peeled and direct refs in order'
[ "$(wc -l < "$tmp/git.log" | tr -d '[:space:]')" = 1 ] || fail 'explicit packaging SHA unexpectedly resolved packaging main'
materialized_dir=$(<"$tmp/materialize-dest")
grep -Fxq "${script_dir}/materialize-packaging.sh packaging $sha_d $materialized_dir" "$tmp/materialize.log" \
  || fail 'explicit packaging SHA was not materialized at its exact value'
grep -Fq -- "--packaging-sha $sha_d" "$tmp/node-args" || fail 'exact packaging SHA was not passed to resolve-inputs'
grep -Fq -- "--upstream-sha $sha_a" "$tmp/node-args" || fail 'peeled upstream tag SHA was not passed to resolve-inputs'
[ ! -e "$materialized_dir" ] || fail 'canonical resolver did not clean up materialized packaging'
docker_config=$(<"$tmp/docker-config-path")
[ ! -e "$docker_config" ] || fail 'canonical resolver did not clean up its isolated Docker configuration'
grep -Fq -- "--packaging-export $materialized_dir/export" "$tmp/node-args" \
  || fail 'canonical resolver did not use its materialized packaging export'

GH_TOKEN=test-token run_resolver "${common[@]}" --latest-upstream --packaging-main

grep -Fxq 'api repos/linkwarden/linkwarden/releases/latest --jq .tag_name' "$tmp/gh.log" \
  || fail 'latest upstream mode did not resolve the GitHub release tag'
grep -Fxq "ls-remote $upstream_url refs/tags/v1.2.3^{} refs/tags/v1.2.3" "$tmp/git.log" \
  || fail 'latest upstream mode did not peel the resolved tag'
grep -Fxq 'ls-remote packaging refs/heads/main' "$tmp/git.log" \
  || fail 'packaging main mode did not resolve the main branch'
grep -Fq -- "--packaging-sha $sha_c" "$tmp/node-args" || fail 'packaging main SHA was not passed to resolve-inputs'
grep -Fq -- "--upstream-sha $sha_a" "$tmp/node-args" || fail 'latest upstream did not pass the peeled SHA to resolve-inputs'
[ "$(grep -Fc 'resolve-inputs.mjs' "$script")" = 1 ] || fail 'canonical resolver contains duplicate resolve-inputs orchestration'

custom_upstream_url=https://github.com/example-owner/example-repo.git
GH_TOKEN=test-token run_resolver \
  --out "$tmp/custom-input.json" \
  --regctl regctl \
  --packaging-url packaging \
  --upstream-url "$custom_upstream_url" \
  --postgres postgres:16-alpine \
  --meili getmeili/meilisearch:v1.13.3 \
  --node node:lts-bookworm-slim \
  --rust rust:1.96-bookworm \
  --monolith-version 2.10.1 \
  --latest-upstream \
  --packaging-main
grep -Fxq 'api repos/example-owner/example-repo/releases/latest --jq .tag_name' "$tmp/gh.log" \
  || fail 'latest upstream mode did not derive the GitHub repository from UPSTREAM_URL'
if GH_TOKEN=test-token run_resolver "${common[@]}" --latest-upstream --packaging-main \
  --upstream-url git@github.com:linkwarden/linkwarden.git; then
  fail 'latest upstream mode accepted a non-HTTPS GitHub URL'
fi
run_resolver \
  --out "$tmp/explicit-input.json" \
  --regctl regctl \
  --packaging-url packaging \
  --upstream-url git@github.com:linkwarden/linkwarden.git \
  --postgres postgres:16-alpine \
  --meili getmeili/meilisearch:v1.13.3 \
  --node node:lts-bookworm-slim \
  --rust rust:1.96-bookworm \
  --monolith-version 2.10.1 \
  --upstream-tag v1.2.3 \
  --packaging-sha "$sha_d"
[ ! -s "$tmp/gh.log" ] || fail 'explicit upstream tag unexpectedly derived a GitHub repository path'

printf '%s\n' 'resolve-publish-input tests passed'
