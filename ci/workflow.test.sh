#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workflow="$repo_root/.github/workflows/build-publish.yml"

fail() {
  printf 'workflow test failed: %s\n' "$*" >&2
  exit 1
}

[ -f "$workflow" ] || fail "missing workflow"
ruby -e 'require "yaml"; Psych.parse_file(ARGV.fetch(0))' "$workflow" \
  || fail "workflow is not valid YAML"

require() {
  grep -Fq -- "$1" "$workflow" || fail "missing $1"
}

forbid() {
  if grep -Fq -- "$1" "$workflow"; then
    fail "unexpected $1"
  fi
}

require 'cron: "0 */6 * * *"'
require 'workflow_dispatch:'
require 'version:'
require 'force:'
require 'ci/**'
require 'validate-packaging:'
require 'publish:'
require 'if: github.event_name == '\''push'\'''
require 'if: github.event_name != '\''push'\'''
require 'group: linkwarden-slim-publisher'
require 'cancel-in-progress: false'
require 'contents: read'
require 'contents: write'
require 'packages: write'
require 'ci/download-regctl.sh'
require 'ci/registry-probe.sh'
require 'ci/materialize-packaging.sh'
require 'ci/resolve-inputs.mjs'
require 'ci/publish.mjs validate'
require 'ci/publish.mjs publish'
require '--fresh-command'
require 'refs/heads/main'
require 'refs/tags/$version^{}'
require 'refs/tags/$latest_tag^{}'
require 'GITHUB_SHA'
require 'GITHUB_RUN_ID'
require 'candidate-${RECIPE_ID}'
require 'staging-${GITHUB_RUN_ID}'
require 'tr '\''[:upper:]'\'' '\''[:lower:]'\'''
require 'docker/setup-qemu-action@v3'
require 'docker/setup-buildx-action@v3'
require 'docker/login-action@v3'
require 'getmeili/meilisearch:v1.13.3'
forbid 'docker/build-push-action'
forbid 'docker/metadata-action'
forbid 'Check if GHCR tag exists'

publish_start="$(grep -n '^  publish:$' "$workflow" | cut -d: -f1)"
resolve_line="$(grep -n 'name: Resolve publish inputs' "$workflow" | cut -d: -f1)"
ghcr_login_line="$(grep -n 'name: Log in to GHCR' "$workflow" | cut -d: -f1)"
hub_login_line="$(grep -n 'name: Log in to Docker Hub' "$workflow" | cut -d: -f1)"

[ -n "$publish_start" ] || fail "missing publisher job"
[ -n "$resolve_line" ] || fail "missing publish input resolution"
[ -n "$ghcr_login_line" ] || fail "missing GHCR login"
[ -n "$hub_login_line" ] || fail "missing Docker Hub login"
[ "$resolve_line" -gt "$publish_start" ] || fail "publish input resolution is outside publisher job"
[ "$ghcr_login_line" -gt "$resolve_line" ] || fail "GHCR login occurs before input resolution"
[ "$hub_login_line" -gt "$resolve_line" ] || fail "Docker Hub login occurs before input resolution"

if grep -A140 '^  validate-packaging:$' "$workflow" | grep -Fq 'docker/login-action'; then
  fail "validation job must not log in to a registry"
fi

printf 'workflow structural tests passed\n'
