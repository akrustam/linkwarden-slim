#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
script="$script_dir/pin-version.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

[ -f "$script" ] || fail 'missing VERSION pin helper'
bash -n "$script"

fake_bin="$tmp/fake-bin"
mkdir "$fake_bin"
cat > "$fake_bin/gh" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$GH_LOG"
[ "$1" = api ]
[ "$2" = repos/example-owner/example-repo/releases/latest ]
[ "$3" = --jq ]
[ "$4" = .tag_name ]
printf '%s\n' "$GH_VERSION"
EOF
cat > "$fake_bin/git" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$GIT_LOG"
case "$1" in
  fetch)
    [ "$2" = origin ] && [ "$3" = main ]
    ;;
  checkout)
    [ "$2" = -B ] && [ "$3" = main ] && [ "$4" = origin/main ]
    printf '%s\n' "$CHECKOUT_VERSION" > VERSION
    ;;
  config|add|commit)
    ;;
  push)
    [ "$2" = origin ] && [ "$3" = HEAD:main ]
    count=0
    [ ! -f "$PUSH_COUNT" ] || count=$(<"$PUSH_COUNT")
    count=$((count + 1))
    printf '%s\n' "$count" > "$PUSH_COUNT"
    if [ "${FAIL_FIRST_PUSH:-false}" = true ] && [ "$count" -eq 1 ]; then
      printf '%s\n' 'non-fast-forward' >&2
      exit 1
    fi
    ;;
  *)
    exit 1
    ;;
esac
EOF
chmod +x "$fake_bin/gh" "$fake_bin/git"

run_pin() {
  PATH="$fake_bin:$PATH" \
    GH_LOG="$tmp/gh.log" \
    GIT_LOG="$tmp/git.log" \
    PUSH_COUNT="$tmp/push-count" \
    GH_VERSION=v2.10.1 \
    CHECKOUT_VERSION="${CHECKOUT_VERSION:-v2.9.0}" \
    FAIL_FIRST_PUSH="${FAIL_FIRST_PUSH:-false}" \
    SELECTED_VERSION=v2.10.1 \
    LATEST_PUBLISHED="$1" \
    UPSTREAM_URL=https://github.com/example-owner/example-repo.git \
    GH_TOKEN=test-token \
    bash "$script"
}

worktree="$tmp/worktree"
mkdir "$worktree"
cd "$worktree"

: > "$tmp/gh.log"
: > "$tmp/git.log"
printf '%s\n' v2.9.0 > VERSION
run_pin false
[ ! -s "$tmp/gh.log" ] || fail 'non-latest publication queried GitHub'
[ ! -s "$tmp/git.log" ] || fail 'non-latest publication touched git'

: > "$tmp/gh.log"
: > "$tmp/git.log"
CHECKOUT_VERSION=v2.10.1 run_pin true
grep -Fxq 'api repos/example-owner/example-repo/releases/latest --jq .tag_name' "$tmp/gh.log" \
  || fail 'pin helper did not derive the upstream GitHub release path'
[ ! -f "$tmp/push-count" ] || fail 'already pinned VERSION was pushed'
if grep -Fq 'commit ' "$tmp/git.log"; then
  fail 'already pinned VERSION was committed'
fi
grep -Fq 'checkout -B main origin/main' "$tmp/git.log" || fail 'pin helper did not check out origin/main'

: > "$tmp/gh.log"
: > "$tmp/git.log"
rm -f "$tmp/push-count"
FAIL_FIRST_PUSH=true CHECKOUT_VERSION=v2.9.0 run_pin true
[ "$(<"$tmp/push-count")" = 2 ] || fail 'non-fast-forward push was not retried exactly once'
[ "$(grep -Fc 'push origin HEAD:main' "$tmp/git.log")" = 2 ] || fail 'pin helper did not push only HEAD:main on retry'
if grep -Fq -- '--force' "$tmp/git.log"; then
  fail 'pin helper force pushed VERSION'
fi

if PATH="$fake_bin:$PATH" \
  SELECTED_VERSION=v2.10.1 \
  LATEST_PUBLISHED=true \
  UPSTREAM_URL=git@github.com:example-owner/example-repo.git \
  GH_TOKEN=test-token \
  bash "$script"; then
  fail 'pin helper accepted a non-HTTPS GitHub URL'
fi

printf '%s\n' 'pin-version tests passed'
