#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dependencies="$script_dir/dependencies-compose.yml"
runtime="$script_dir/runtime-compose.yml"
stack="$script_dir/test-stack.sh"
smoke="$script_dir/runtime-smoke.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

expect_failure() {
  local expected=$1
  shift
  local output

  if output=$("$@" 2>&1); then
    fail "expected command to fail: $*"
  fi
  case "$output" in
    *"$expected"*) ;;
    *) fail "failure output did not contain: $expected" ;;
  esac
}

for file in "$dependencies" "$runtime" "$stack" "$smoke"; do
  [ -f "$file" ] || fail "missing required CI artifact: $file"
done

bash -n "$stack"
bash -n "$smoke"

browser_gate_line="$(grep -n '^check_no_local_browser_installs() {' "$smoke" | cut -d: -f1 || true)"
browser_invariant_line="$(grep -n '^browser_check_output=' "$smoke" | cut -d: -f1 || true)"
prisma_gate_line="$(grep -n '^check_prisma_client() {' "$smoke" | cut -d: -f1 || true)"
[ -n "$browser_gate_line" ] || fail 'runtime smoke does not define a local browser installation gate'
[ -n "$browser_invariant_line" ] || fail 'runtime smoke does not retain the browser-enabled startup invariant'
[ -n "$prisma_gate_line" ] || fail 'runtime smoke does not verify the Prisma client against its target platform'
[ "$browser_gate_line" -lt "$browser_invariant_line" ] \
  || fail 'runtime smoke checks browser startup before inspecting the image filesystem'
[ "$prisma_gate_line" -lt "$browser_gate_line" ] \
  || fail 'runtime smoke checks the browser before loading the Prisma client'
if ! grep -A18 -F 'check_prisma_client() {' "$smoke" | grep -Fq -- '--network "${COMPOSE_PROJECT_NAME}_default"'; then
  fail 'runtime smoke Prisma check does not use the running dependency network'
fi
if ! grep -A18 -F 'check_prisma_client() {' "$smoke" | grep -Fq -- 'libquery_engine-${target}.so.node'; then
  fail 'runtime smoke Prisma check does not require the platform-specific query engine'
fi
if ! grep -A18 -F 'check_prisma_client() {' "$smoke" | grep -Fq -- 'paths.slice(0, -3)'; then
  fail 'runtime smoke does not locate the Prisma client beneath node_modules'
fi
if ! grep -A18 -F 'check_prisma_client() {' "$smoke" | grep -Fq -- 'new PrismaClient'; then
  fail 'runtime smoke Prisma check does not initialize the generated client'
fi
if ! grep -A12 -F 'check_no_local_browser_installs() {' "$smoke" | grep -Fq -- '--entrypoint /bin/sh'; then
  fail 'runtime smoke local browser gate does not execute inside the runtime image'
fi
if ! grep -A12 -F 'check_no_local_browser_installs() {' "$smoke" | grep -Fq -- 'for path in /ms-playwright'; then
  fail 'runtime smoke local browser gate does not inspect Playwright browser directories'
fi
if ! grep -A12 -F 'check_no_local_browser_installs() {' "$smoke" | grep -Fq -- 'test ! -e "$path" || exit 1'; then
  fail 'runtime smoke local browser gate does not reject discovered browser paths'
fi

expect_failure 'CI_POSTGRES_IMAGE is required' env -u CI_POSTGRES_IMAGE \
  CI_MEILI_IMAGE=getmeili/meilisearch:v1.12.8 \
  "${BASH:-bash}" "$stack" source
expect_failure 'CI_MEILI_IMAGE is required' env -u CI_MEILI_IMAGE \
  CI_POSTGRES_IMAGE=postgres:16-alpine \
  "${BASH:-bash}" "$stack" source
expect_failure 'CI_IMAGE_REF is required' env -u CI_IMAGE_REF \
  CI_POSTGRES_IMAGE=postgres:16-alpine \
  CI_MEILI_IMAGE=getmeili/meilisearch:v1.12.8 \
  "${BASH:-bash}" "$stack" runtime
expect_failure 'CI_PLATFORM is required' env -u CI_PLATFORM \
  CI_POSTGRES_IMAGE=postgres:16-alpine \
  CI_MEILI_IMAGE=getmeili/meilisearch:v1.12.8 \
  CI_IMAGE_REF=example.invalid/linkwarden:ci \
  "${BASH:-bash}" "$stack" runtime
expect_failure 'COMPOSE_PROJECT_NAME is required' env \
  CI_PLATFORM=linux/amd64 \
  CI_IMAGE_REF=example.invalid/linkwarden:ci \
  "${BASH:-bash}" "$smoke"

fake_bin="$tmp/fake-bin"
mkdir "$fake_bin"
cat > "$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = compose ]; then
  shift
  while [ "$1" = -f ]; do shift 2; done
  case "$1" in
    port) printf '%s\n' '0.0.0.0:49152' ;;
    ps) printf '%s\n' 'container-id' ;;
    up|down|logs) ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = inspect ]; then
  case "$4" in
    container-id) printf '%s\n' true ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = image ] && [ "$2" = inspect ] && [ "$5" = example.invalid/linkwarden:ci ]; then
  printf '%s\n' amd64
  exit 0
fi
if [ "$1" = run ]; then
  case " $* " in
    *' --entrypoint node '*)
      case " $* " in
        *' --platform linux/amd64 --network linkwarden-ci-smoke-test_default -e DATABASE_URL=postgresql://linkwarden:ci-password@postgres:5432/linkwarden --entrypoint node '*) exit 0 ;;
        *)
          printf 'runtime Prisma check did not use the requested image platform and dependency network: %s\n' "$*" >&2
          exit 1
          ;;
      esac
      ;;
    *' --entrypoint /bin/sh '*)
      case " $* " in
        *' --platform linux/amd64 '*'-ec '*"for path in /ms-playwright"*) exit 0 ;;
        *)
          printf 'runtime browser filesystem check did not run in the requested image platform: %s\n' "$*" >&2
          exit 1
          ;;
      esac
      ;;
    *' --entrypoint '*)
      printf '%s\n' 'linkwarden-slim: no local Chromium' >&2
      exit 1
      ;;
    *)
      case "$*" in
        'run --rm --pull never --network linkwarden-ci-'[0-9]*'_default -e DATABASE_URL=postgresql://linkwarden:ci-password@postgres:5432/linkwarden linkwarden-source-test:ci') exit 0 ;;
        *)
          printf 'source stack run does not disable image pulls before selecting the test image: %s\n' "$*" >&2
          exit 1
          ;;
      esac
      ;;
  esac
fi
exit 1
EOF
cat > "$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case " $* " in
  *'/api/v1/config'*)
    output_file=''
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --output ]; then
        output_file=$2
        shift 2
      else
        shift
      fi
    done
    count=0
    if [ -f "$FAKE_CONFIG_REQUEST_COUNT" ]; then count=$(<"$FAKE_CONFIG_REQUEST_COUNT"); fi
    count=$((count + 1))
    printf '%s' "$count" > "$FAKE_CONFIG_REQUEST_COUNT"
    printf '%s' '{"response":{}}' > "$output_file"
    if [ "$count" -eq 1 ]; then printf '%s' '503'; else printf '%s' '200'; fi
    ;;
  *) printf '%s' '200' ;;
esac
EOF
cat > "$fake_bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$fake_bin/docker" "$fake_bin/curl" "$fake_bin/sleep"

PATH="$fake_bin:$PATH" \
  FAKE_CONFIG_REQUEST_COUNT="$tmp/config-request-count" \
  CI_PLATFORM=linux/amd64 \
  CI_IMAGE_REF=example.invalid/linkwarden:ci \
  COMPOSE_PROJECT_NAME=linkwarden-ci-smoke-test \
  "${BASH:-bash}" "$smoke"
[ "$(<"$tmp/config-request-count")" -eq 2 ] \
  || fail 'runtime smoke accepted a config response that was not explicitly HTTP 200'

PATH="$fake_bin:$PATH" \
  CI_POSTGRES_IMAGE=postgres:16-alpine \
  CI_MEILI_IMAGE=getmeili/meilisearch:v1.12.8 \
  CI_SOURCE_TEST_IMAGE=linkwarden-source-test:ci \
  COMPOSE_PROJECT_NAME=linkwarden-ci-source-test \
  "${BASH:-bash}" "$stack" source

if ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' 'stack script compose tests skipped: docker compose is unavailable'
  exit 0
fi

dependencies_config="$tmp/dependencies.yml"
CI_POSTGRES_IMAGE=postgres:16-alpine \
  CI_MEILI_IMAGE=getmeili/meilisearch:v1.12.8 \
  docker compose -f "$dependencies" config > "$dependencies_config"

for expected in \
  'image: postgres:16-alpine' \
  'image: getmeili/meilisearch:v1.12.8' \
  'platform: linux/amd64' \
  'pull_policy: never' \
  "restart: 'no'" \
  'POSTGRES_USER: linkwarden' \
  'POSTGRES_PASSWORD: ci-password' \
  'POSTGRES_DB: linkwarden' \
  'MEILI_MASTER_KEY: ci-meilisearch-key' \
  'MEILI_NO_ANALYTICS: "true"'; do
  case "$expected" in
    "restart: 'no'") grep -Eq -- "restart: ('no'|\"no\"|no)" "$dependencies_config" ;;
    *) grep -Fq -- "$expected" "$dependencies_config" ;;
  esac \
    || fail "dependencies compose config is missing: $expected"
done

if grep -Eq 'DATABASE_URL|NEXTAUTH_|MEILI_HOST|MEILI_KEY|DISABLE_BROWSER' "$dependencies_config"; then
  fail 'dependencies compose config contains application-only variables'
fi

expect_failure 'CI_POSTGRES_IMAGE is required' env -u CI_POSTGRES_IMAGE \
  CI_MEILI_IMAGE=getmeili/meilisearch:v1.12.8 \
  docker compose -f "$dependencies" config
expect_failure 'CI_MEILI_IMAGE is required' env -u CI_MEILI_IMAGE \
  CI_POSTGRES_IMAGE=postgres:16-alpine \
  docker compose -f "$dependencies" config

merged_config="$tmp/runtime.yml"
CI_POSTGRES_IMAGE=postgres:16-alpine \
  CI_MEILI_IMAGE=getmeili/meilisearch:v1.12.8 \
  CI_IMAGE_REF=example.invalid/linkwarden:ci \
  CI_PLATFORM=linux/arm64 \
  docker compose -f "$dependencies" -f "$runtime" config > "$merged_config"

for expected in \
  'image: example.invalid/linkwarden:ci' \
  'platform: linux/arm64' \
  'DATABASE_URL: postgresql://linkwarden:ci-password@postgres:5432/linkwarden' \
  'NEXTAUTH_URL: http://localhost:3000' \
  'NEXTAUTH_SECRET: ci-nextauth-secret-not-for-production' \
  'MEILI_HOST: http://meilisearch:7700' \
  'MEILI_KEY: ci-meilisearch-key' \
  'DISABLE_BROWSER: "true"' \
  'condition: service_healthy' \
  'target: 3000'; do
  grep -Fq -- "$expected" "$merged_config" \
    || fail "runtime compose config is missing: $expected"
done

if grep -Fq -- 'published: "3000"' "$merged_config"; then
  fail 'runtime compose config hardcodes the host port'
fi

expect_failure 'CI_IMAGE_REF is required' env -u CI_IMAGE_REF \
  CI_POSTGRES_IMAGE=postgres:16-alpine \
  CI_MEILI_IMAGE=getmeili/meilisearch:v1.12.8 \
  CI_PLATFORM=linux/amd64 \
  docker compose -f "$dependencies" -f "$runtime" config
expect_failure 'CI_PLATFORM is required' env -u CI_PLATFORM \
  CI_POSTGRES_IMAGE=postgres:16-alpine \
  CI_MEILI_IMAGE=getmeili/meilisearch:v1.12.8 \
  CI_IMAGE_REF=example.invalid/linkwarden:ci \
  docker compose -f "$dependencies" -f "$runtime" config

printf '%s\n' 'stack script tests passed'
