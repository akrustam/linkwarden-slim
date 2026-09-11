#!/usr/bin/env bash
set -euo pipefail

: "${CI_PLATFORM:?CI_PLATFORM is required}"
: "${CI_IMAGE_REF:?CI_IMAGE_REF is required}"
: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required}"

case "$CI_PLATFORM" in
  linux/amd64)
    expected_architecture=amd64
    config_timeout=180
    running_seconds=30
    ;;
  linux/arm64)
    expected_architecture=arm64
    config_timeout=300
    running_seconds=15
    ;;
  *)
    printf 'CI_PLATFORM must be linux/amd64 or linux/arm64\n' >&2
    exit 64
    ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dependencies_compose="$script_dir/dependencies-compose.yml"
runtime_compose="$script_dir/runtime-compose.yml"
compose=(docker compose -f "$dependencies_compose" -f "$runtime_compose")

port_mapping=$("${compose[@]}" port linkwarden 3000)
host_port=${port_mapping##*:}
if ! [[ "$host_port" =~ ^[0-9]+$ ]]; then
  printf 'could not determine the published linkwarden port\n' >&2
  exit 1
fi

wait_for_config() {
  local deadline=$((SECONDS + config_timeout))
  local response
  local response_file
  local status

  while [ "$SECONDS" -lt "$deadline" ]; do
    response_file=$(mktemp)
    status=$(curl --silent --show-error --output "$response_file" --write-out '%{http_code}' --max-time 10 \
      "http://127.0.0.1:${host_port}/api/v1/config" || true)
    response=$(<"$response_file")
    rm -f "$response_file"
    if [ "$status" = 200 ]; then
      if printf '%s' "$response" | node -e '
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => { input += chunk; });
        process.stdin.on("end", () => {
          try {
            const parsed = JSON.parse(input);
            const value = parsed.response;
            process.exit(value && typeof value === "object" && !Array.isArray(value) ? 0 : 1);
          } catch {
            process.exit(1);
          }
        });
      '; then
        return 0
      fi
    fi
    sleep 2
  done

  printf 'config endpoint did not return a JSON response object before timeout\n' >&2
  return 1
}

wait_for_config

root_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 15 \
  "http://127.0.0.1:${host_port}/")
case "$root_status" in
  200|302|303|307|308) ;;
  *)
    printf 'root endpoint returned unexpected status %s\n' "$root_status" >&2
    exit 1
    ;;
esac

container_id=$("${compose[@]}" ps -q linkwarden)
if [ -z "$container_id" ]; then
  printf 'linkwarden container is not running\n' >&2
  exit 1
fi

sleep "$running_seconds"
running=$(docker inspect --format '{{.State.Running}}' "$container_id")
if [ "$running" != true ]; then
  printf 'linkwarden container stopped during smoke verification\n' >&2
  exit 1
fi

architecture=$(docker image inspect --format '{{.Architecture}}' "$CI_IMAGE_REF")
if [ "$architecture" != "$expected_architecture" ]; then
  printf 'runtime image architecture %s does not match %s\n' "$architecture" "$expected_architecture" >&2
  exit 1
fi

browser_check_output=$(mktemp)
trap 'rm -f "$browser_check_output"' EXIT
if docker run --rm --platform "$CI_PLATFORM" \
  -e DISABLE_BROWSER=false \
  -e DISABLE_PRESERVATION=false \
  --entrypoint /usr/local/bin/docker-entrypoint.sh \
  "$CI_IMAGE_REF" true >"$browser_check_output" 2>&1; then
  printf 'browser-enabled runtime unexpectedly started\n' >&2
  exit 1
fi
if ! grep -Fq 'linkwarden-slim: no local Chromium' "$browser_check_output"; then
  printf 'browser invariant failure output was not observed\n' >&2
  exit 1
fi
