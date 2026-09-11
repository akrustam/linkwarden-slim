#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ] || { [ "$1" != source ] && [ "$1" != runtime ]; }; then
  printf 'usage: %s source|runtime\n' "$0" >&2
  exit 64
fi

mode=$1
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dependencies_compose="$script_dir/dependencies-compose.yml"
runtime_compose="$script_dir/runtime-compose.yml"

: "${CI_POSTGRES_IMAGE:?CI_POSTGRES_IMAGE is required}"
: "${CI_MEILI_IMAGE:?CI_MEILI_IMAGE is required}"

if [ "$mode" = source ]; then
  : "${CI_SOURCE_TEST_IMAGE:?CI_SOURCE_TEST_IMAGE is required}"
else
  : "${CI_IMAGE_REF:?CI_IMAGE_REF is required}"
  : "${CI_PLATFORM:?CI_PLATFORM is required}"
fi

if [ -z "${GITHUB_RUN_ID:-}" ]; then
  export COMPOSE_PROJECT_NAME="linkwarden-ci-$$"
else
  export COMPOSE_PROJECT_NAME="linkwarden-ci-${GITHUB_RUN_ID}"
fi

compose=(docker compose -f "$dependencies_compose")
services=(postgres meilisearch)
if [ "$mode" = runtime ]; then
  compose+=(-f "$runtime_compose")
  services+=(linkwarden)
fi

cleanup() {
  status=$?
  trap - EXIT

  if [ "$status" -ne 0 ]; then
    "${compose[@]}" ps >&2 || true
    for service in "${services[@]}"; do
      "${compose[@]}" logs --tail 200 "$service" >&2 || true
    done
  fi
  "${compose[@]}" down -v --remove-orphans >&2 || true
  exit "$status"
}
trap cleanup EXIT

"${compose[@]}" up -d --wait --wait-timeout 120 postgres meilisearch

if [ "$mode" = source ]; then
  docker run --rm \
    --pull never \
    --network "${COMPOSE_PROJECT_NAME}_default" \
    -e DATABASE_URL='postgresql://linkwarden:ci-password@postgres:5432/linkwarden' \
    "$CI_SOURCE_TEST_IMAGE"
else
  "${compose[@]}" up -d linkwarden
  "$script_dir/runtime-smoke.sh"
fi
