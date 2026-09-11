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

require_action_count() {
  local action=$1
  local expected=$2
  local actual
  actual="$(grep -Fc -- "uses: $action@" "$workflow")"
  [ "$actual" -eq "$expected" ] || fail "expected $expected uses of $action, found $actual"
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
require 'test-ci:'
require 'validate-packaging:'
require 'publish:'
require_count 'needs: test-ci' 2
require 'if: github.event_name == '\''push'\'''
require 'if: github.event_name != '\''push'\'''
require 'group: linkwarden-slim-publisher'
require 'cancel-in-progress: false'
require 'contents: read'
require 'contents: write'
require 'packages: write'
require 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262'
require 'docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130'
require 'docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f'
require 'docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9'
require 'ci/download-regctl.sh'
require 'ci/registry-probe.sh'
require_count 'bash ci/resolve-publish-input.sh' 3
require 'ci/publish.mjs validate'
require 'ci/publish.mjs publish-ghcr'
require 'ci/publish.mjs mirror-docker'
require 'ci/summarize-publish.mjs'
require 'ci/pin-version.sh'
require '--result-out "$RUNNER_TEMP/ghcr-publish-result.json"'
require '--result-out "$result_path"'
require '--fresh-command'
require '--fresh-args'
require 'FRESH_COMMAND=ci/resolve-publish-input.sh'
require 'FRESH_ARGS="$('
require '--print-fresh-args'
require 'echo "FRESH_ARGS=$FRESH_ARGS"'
require 'MONOLITH_VERSION: 2.10.1'
require_count '--monolith-version "$MONOLITH_VERSION"' 3
require 'GITHUB_SHA'
require 'GITHUB_RUN_ID'
require 'candidate-${RECIPE_ID}'
require 'staging-${GITHUB_RUN_ID}'
require 'tr '\''[:upper:]'\'' '\''[:lower:]'\'''
require 'getmeili/meilisearch:v1.13.3'
require 'bash ci/workflow.test.sh'
require 'node --test ci/*.test.mjs ci/lib/*.test.mjs'
require 'CI_RUN_NETWORK_TESTS=0 bash "$test_script"'
require 'ref: main'
require 'fetch-depth: 0'
require_action_count 'actions/checkout' 3
require_action_count 'docker/setup-qemu-action' 2
require_action_count 'docker/setup-buildx-action' 2
require_action_count 'docker/login-action' 2
forbid 'force:'
forbid 'actions/checkout@v'
forbid 'docker/setup-qemu-action@v'
forbid 'docker/setup-buildx-action@v'
forbid 'docker/login-action@v'
forbid '## Published linkwarden-slim'
forbid 'Reconcile and publish even when version tags already exist'
forbid 'fresh_command='
forbid '--monolith-version "${version#v}"'
forbid 'FRESH_MONOLITH_VERSION="${SELECTED_VERSION#v}"'
forbid 'ci/resolve-inputs.mjs'
forbid 'ci/materialize-packaging.sh'
forbid 'git ls-remote'
forbid 'refs/tags/$version^{}'
forbid 'refs/heads/main'
forbid "node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))'"
forbid 'const { appendFileSync, readFileSync } = require("node:fs");'
forbid 'LATEST_PUBLISHED=${result.latest'
forbid 'summary = `## Latest moved'
forbid 'reconcile_version_pin() {'
forbid 'repos/linkwarden/linkwarden'
forbid 'cat >'
forbid '<<'
forbid 'docker/build-push-action'
forbid 'docker/metadata-action'
forbid 'docker() { return 1; }'
forbid 'Check if GHCR tag exists'
forbid 'docker-candidate'

publish_start="$(grep -n '^  publish:$' "$workflow" | cut -d: -f1)"
test_ci_start="$(grep -n '^  test-ci:$' "$workflow" | cut -d: -f1)"
validate_start="$(grep -n '^  validate-packaging:$' "$workflow" | cut -d: -f1)"
validate_needs_line="$(grep -n '^    needs: test-ci$' "$workflow" | cut -d: -f1 | awk 'NR == 1 { print }')"
publish_needs_line="$(grep -n '^    needs: test-ci$' "$workflow" | cut -d: -f1 | awk 'NR == 2 { print }')"
publish_checkout_line="$(grep -n 'ref: main' "$workflow" | cut -d: -f1)"
validate_checkout_line="$(grep -n '^      - name: Checkout this repository' "$workflow" | cut -d: -f1 | awk 'NR == 2 { print }')"
test_ci_workflow_test_line="$(grep -n 'bash ci/workflow.test.sh' "$workflow" | cut -d: -f1 | awk 'NR == 1 { print }')"
workflow_test_line="$(grep -n 'bash ci/workflow.test.sh' "$workflow" | cut -d: -f1 | awk 'NR == 2 { print }')"
resolve_line="$(grep -n 'name: Resolve publish inputs' "$workflow" | cut -d: -f1)"
ghcr_login_line="$(grep -n 'name: Log in to GHCR' "$workflow" | cut -d: -f1)"
hub_login_line="$(grep -n 'name: Log in to Docker Hub' "$workflow" | cut -d: -f1)"
ghcr_publish_line="$(grep -n 'name: Validate, stage, and publish GHCR' "$workflow" | cut -d: -f1)"
docker_mirror_line="$(grep -n 'name: Mirror GHCR release to Docker Hub' "$workflow" | cut -d: -f1)"

[ -n "$publish_start" ] || fail "missing publisher job"
[ -n "$test_ci_start" ] || fail "missing test-ci job"
[ -n "$validate_start" ] || fail "missing validation job"
[ -n "$validate_needs_line" ] || fail "validation job does not need test-ci"
[ -n "$publish_needs_line" ] || fail "publish job does not need test-ci"
[ -n "$publish_checkout_line" ] || fail "publisher checkout does not target main"
[ -n "$validate_checkout_line" ] || fail "missing validation checkout"
[ -n "$workflow_test_line" ] || fail "missing workflow structural test gate"
[ -n "$resolve_line" ] || fail "missing publish input resolution"
[ -n "$ghcr_login_line" ] || fail "missing GHCR login"
[ -n "$hub_login_line" ] || fail "missing Docker Hub login"
[ -n "$ghcr_publish_line" ] || fail "missing GHCR publish phase"
[ -n "$docker_mirror_line" ] || fail "missing Docker mirror phase"
[ "$resolve_line" -gt "$publish_start" ] || fail "publish input resolution is outside publisher job"
[ "$publish_checkout_line" -gt "$publish_start" ] || fail "publisher main checkout is outside publisher job"
[ "$publish_checkout_line" -lt "$resolve_line" ] || fail "publisher main checkout occurs after input resolution"
[ "$validate_needs_line" -gt "$validate_start" ] || fail "validation test-ci gate is outside validation job"
[ "$validate_needs_line" -lt "$publish_start" ] || fail "validation test-ci gate is outside validation job"
[ "$publish_needs_line" -gt "$publish_start" ] || fail "publish test-ci gate is outside publish job"
[ "$workflow_test_line" -gt "$validate_checkout_line" ] || fail "workflow structural test runs before checkout"
[ "$test_ci_workflow_test_line" -gt "$test_ci_start" ] || fail "test-ci workflow structural test is outside test-ci"
[ "$ghcr_login_line" -gt "$resolve_line" ] || fail "GHCR login occurs before input resolution"
[ "$hub_login_line" -gt "$resolve_line" ] || fail "Docker Hub login occurs before input resolution"
[ "$ghcr_login_line" -lt "$ghcr_publish_line" ] || fail "GHCR login must precede the GHCR publish phase"
[ "$ghcr_publish_line" -lt "$hub_login_line" ] || fail "Docker Hub login must follow the GHCR publish phase"
[ "$hub_login_line" -lt "$docker_mirror_line" ] || fail "Docker Hub login must precede Docker mirroring"

if grep -A60 '^  test-ci:$' "$workflow" | grep -Eq 'docker/login-action|packages: write|contents: write'; then
  fail "test-ci job must not log in to a registry or have write permissions"
fi

if ! grep -A60 '^  test-ci:$' "$workflow" | grep -Fq 'contents: read'; then
  fail "test-ci job must have read-only contents permission"
fi

printf 'workflow structural tests passed\n'
