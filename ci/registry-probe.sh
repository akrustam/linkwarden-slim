#!/usr/bin/env bash
set -euo pipefail

: "${REGCTL_PATH:?REGCTL_PATH is required}"
if [ ! -x "$REGCTL_PATH" ]; then
  printf 'REGCTL_PATH must name an executable\n' >&2
  exit 64
fi

docker_config=$(mktemp -d)
trap 'rm -rf "$docker_config"' EXIT
export DOCKER_CONFIG=$docker_config

absent="docker.io/library/node:linkwarden-slim-probe-$(date +%s)-$$"
if output=$("$REGCTL_PATH" manifest head "$absent" --require-digest 2>&1); then
  printf 'expected absent probe tag to be missing\n' >&2
  exit 1
elif ! printf '%s' "$output" | grep -Eqi 'MANIFEST_UNKNOWN|request failed: not found \[http 404\]'; then
  printf 'absent probe did not return a known absence response: %.4000s\n' "$output" >&2
  exit 1
fi

if output=$("$REGCTL_PATH" manifest head "invalid.invalid/linkwarden-slim:probe" --require-digest 2>&1); then
  printf 'expected invalid registry host to fail\n' >&2
  exit 1
fi
