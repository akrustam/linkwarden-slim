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

require_count() {
  local actual
  actual="$(grep -Fc -- "$1" "$workflow")"
  [ "$actual" -eq "$2" ] || fail "expected $2 occurrences of $1, found $actual"
}

forbid() {
  if grep -Fq -- "$1" "$workflow"; then
    fail "unexpected $1"
  fi
}

require 'cron: "0 */6 * * *"'
require 'workflow_dispatch:'
require 'version:'
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
require 'ci/resolve-fresh-input.sh'
require 'ci/publish.mjs validate'
require 'ci/publish.mjs publish'
require '--fresh-command'
require 'FRESH_COMMAND=ci/resolve-fresh-input.sh'
require 'export FRESH_REGCTL_PATH="$REGCTL_PATH"'
require 'export FRESH_PACKAGING_URL="$PACKAGING_URL"'
require 'export FRESH_UPSTREAM_URL="$UPSTREAM_URL"'
require 'export FRESH_POSTGRES_REF="$POSTGRES_REF"'
require 'export FRESH_MEILI_REF="$MEILI_REF"'
require 'export FRESH_NODE_REF="$NODE_REF"'
require 'export FRESH_RUST_REF="$RUST_REF"'
require 'MONOLITH_VERSION: 2.10.1'
require_count '--monolith-version "$MONOLITH_VERSION"' 2
require 'export FRESH_MONOLITH_VERSION="$MONOLITH_VERSION"'
require 'refs/heads/main'
require 'refs/tags/$version^{}'
require 'GITHUB_SHA'
require 'GITHUB_RUN_ID'
require 'candidate-${RECIPE_ID}'
require 'staging-${GITHUB_RUN_ID}'
require 'tr '\''[:upper:]'\'' '\''[:lower:]'\'''
require 'docker/setup-qemu-action@v3'
require 'docker/setup-buildx-action@v3'
require 'docker/login-action@v3'
require 'getmeili/meilisearch:v1.13.3'
require 'bash ci/workflow.test.sh'
require 'ref: main'
require 'fetch-depth: 0'
require 'git fetch origin main'
require 'git checkout -B main origin/main'
require 'git push origin HEAD:main'
forbid 'force:'
forbid 'Reconcile and publish even when version tags already exist'
forbid 'fresh_command='
forbid '--monolith-version "${version#v}"'
forbid 'FRESH_MONOLITH_VERSION="${SELECTED_VERSION#v}"'
forbid 'cat >'
forbid '<<'
forbid 'docker/build-push-action'
forbid 'docker/metadata-action'
forbid 'Check if GHCR tag exists'

publish_start="$(grep -n '^  publish:$' "$workflow" | cut -d: -f1)"
publish_checkout_line="$(grep -n 'ref: main' "$workflow" | cut -d: -f1)"
validate_checkout_line="$(grep -n '^      - name: Checkout this repository' "$workflow" | cut -d: -f1 | awk 'NR == 1 { print }')"
workflow_test_line="$(grep -n 'bash ci/workflow.test.sh' "$workflow" | cut -d: -f1)"
resolve_line="$(grep -n 'name: Resolve publish inputs' "$workflow" | cut -d: -f1)"
ghcr_login_line="$(grep -n 'name: Log in to GHCR' "$workflow" | cut -d: -f1)"
hub_login_line="$(grep -n 'name: Log in to Docker Hub' "$workflow" | cut -d: -f1)"

[ -n "$publish_start" ] || fail "missing publisher job"
[ -n "$publish_checkout_line" ] || fail "publisher checkout does not target main"
[ -n "$validate_checkout_line" ] || fail "missing validation checkout"
[ -n "$workflow_test_line" ] || fail "missing workflow structural test gate"
[ -n "$resolve_line" ] || fail "missing publish input resolution"
[ -n "$ghcr_login_line" ] || fail "missing GHCR login"
[ -n "$hub_login_line" ] || fail "missing Docker Hub login"
[ "$resolve_line" -gt "$publish_start" ] || fail "publish input resolution is outside publisher job"
[ "$publish_checkout_line" -gt "$publish_start" ] || fail "publisher main checkout is outside publisher job"
[ "$publish_checkout_line" -lt "$resolve_line" ] || fail "publisher main checkout occurs after input resolution"
[ "$workflow_test_line" -gt "$validate_checkout_line" ] || fail "workflow structural test runs before checkout"
[ "$ghcr_login_line" -gt "$resolve_line" ] || fail "GHCR login occurs before input resolution"
[ "$hub_login_line" -gt "$resolve_line" ] || fail "Docker Hub login occurs before input resolution"

if grep -A140 '^  validate-packaging:$' "$workflow" | grep -Fq 'docker/login-action'; then
  fail "validation job must not log in to a registry"
fi

printf 'workflow structural tests passed\n'
