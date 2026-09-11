#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
script="$script_dir/materialize-image.sh"
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

[ -f "$script" ] || fail "missing script: $script"
bash -n "$script"

source_ref="docker.io/library/alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

expect_failure 'usage:' "${BASH:-bash}" "$script"
expect_failure 'DIGEST_SOURCE must be an immutable @sha256 reference' \
  "${BASH:-bash}" "$script" linux/amd64 alpine:3.20 local:test
expect_failure 'DIGEST_SOURCE must be an immutable @sha256 reference' \
  "${BASH:-bash}" "$script" linux/amd64 "alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" local:test
expect_failure 'DIGEST_SOURCE must be an immutable @sha256 reference' \
  "${BASH:-bash}" "$script" linux/amd64 "docker.io/library/alpine:3.20@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" local:test
expect_failure 'DIGEST_SOURCE must be an immutable @sha256 reference' \
  "${BASH:-bash}" "$script" linux/amd64 'alpine@sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' local:test
expect_failure 'PLATFORM must be linux/amd64 or linux/arm64' \
  "${BASH:-bash}" "$script" linux/s390x "$source_ref" local:test
expect_failure 'LOCAL_TAG must be a nonempty image tag' \
  "${BASH:-bash}" "$script" linux/amd64 "$source_ref" ''

fake_bin="$tmp/fake-bin"
mkdir "$fake_bin"
fake_log="$tmp/docker.log"
cat > "$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  pull)
    [ "$2" = '--platform' ]
    [ "$3" = "$EXPECTED_PLATFORM" ]
    [ "$4" = "$EXPECTED_SOURCE" ]
    ;;
  image)
    [ "$2" = 'inspect' ]
    [ "$3" = '--format' ]
    [ "$4" = '{{.Id}} {{.Architecture}}' ]
    [ "$5" = "$EXPECTED_SOURCE" ]
    printf '%s %s\n' 'sha256:local-image-id' "$FAKE_ARCHITECTURE"
    ;;
  tag)
    [ "$2" = 'sha256:local-image-id' ]
    [ "$3" = "$EXPECTED_TAG" ]
    ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$fake_bin/docker"

PATH="$fake_bin:$PATH" \
  FAKE_DOCKER_LOG="$fake_log" \
  EXPECTED_PLATFORM=linux/amd64 \
  EXPECTED_SOURCE="$source_ref" \
  EXPECTED_TAG=local:test \
  FAKE_ARCHITECTURE=amd64 \
  "${BASH:-bash}" "$script" linux/amd64 "$source_ref" local:test

grep -Fqx -- "pull --platform linux/amd64 $source_ref" "$fake_log" \
  || fail 'materializer did not pull the requested immutable source for the platform'
grep -Fqx -- "image inspect --format {{.Id}} {{.Architecture}} $source_ref" "$fake_log" \
  || fail 'materializer did not inspect the requested immutable source for the platform'
grep -Fqx -- 'tag sha256:local-image-id local:test' "$fake_log" \
  || fail 'materializer did not tag the platform-specific local image id'

if PATH="$fake_bin:$PATH" \
  FAKE_DOCKER_LOG="$fake_log" \
  EXPECTED_PLATFORM=linux/amd64 \
  EXPECTED_SOURCE="$source_ref" \
  EXPECTED_TAG=local:mismatch \
  FAKE_ARCHITECTURE=arm64 \
  "${BASH:-bash}" "$script" linux/amd64 "$source_ref" local:mismatch; then
  fail 'materializer accepted a pulled image with the wrong architecture'
fi

if docker info >/dev/null 2>&1 && [ "${CI_RUN_NETWORK_TESTS:-}" = '1' ]; then
  local_tag="linkwarden-ci-materialize-test-$$"
  network_source='docker.io/library/postgres@sha256:075f7ba66bc9b3ce7d6b8b635208ff61cd7cf1a67d71ec530eec5d7ae0cbe571'
  "${BASH:-bash}" "$script" linux/amd64 "$network_source" "$local_tag"
  [ "$(docker image inspect --format '{{.Architecture}}' "$local_tag")" = amd64 ] \
    || fail 'materializer tag did not resolve to the requested platform architecture'
  docker image rm "$local_tag" >/dev/null
fi

printf '%s\n' 'materialize-image tests passed'
