#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
script="$script_dir/resolve-fresh-input.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

[ -f "$script" ] || fail 'missing fresh input resolver'
bash -n "$script"

if bash "$script"; then
  fail 'fresh input resolver accepted no arguments'
fi

if bash "$script" "$tmp/input.json" a b c d e f g; then
  fail 'fresh input resolver accepted an incomplete positional invocation'
fi

if GH_TOKEN=test-token bash "$script" "$tmp/input.json"; then
  fail 'fresh input resolver accepted a wrapper invocation without FRESH_ configuration'
fi

if FRESH_REGCTL_PATH=regctl FRESH_PACKAGING_URL=packaging FRESH_UPSTREAM_URL=upstream \
  FRESH_POSTGRES_REF=postgres FRESH_MEILI_REF=meili FRESH_NODE_REF=node FRESH_RUST_REF=rust \
  FRESH_MONOLITH_VERSION=monolith bash "$script" "$tmp/input.json"; then
  fail 'fresh input resolver accepted an invocation without GH_TOKEN'
fi

grep -Fq 'FRESH_REGCTL_PATH' "$script" || fail 'fresh input resolver does not support publisher wrapper configuration'
grep -Fq 'FRESH_MONOLITH_VERSION' "$script" || fail 'fresh input resolver does not support the monolith wrapper configuration'
grep -Fq 'refs/tags/$latest_tag^{}' "$script" || fail 'fresh input resolver does not prefer peeled upstream tags'
grep -Fq 'refs/heads/main' "$script" || fail 'fresh input resolver does not resolve packaging main'
grep -Fq 'materialize-packaging.sh' "$script" || fail 'fresh input resolver does not materialize packaging'
grep -Fq 'resolve-inputs.mjs' "$script" || fail 'fresh input resolver does not resolve immutable inputs'
grep -Fq 'fresh_docker_config="$(mktemp -d' "$script" \
  || fail 'fresh input resolver does not create an isolated Docker config directory'
grep -Fq 'DOCKER_CONFIG="$fresh_docker_config" node "$script_dir/resolve-inputs.mjs"' "$script" \
  || fail 'fresh input resolver does not scope the isolated Docker config to immutable input resolution'

fake_bin="$tmp/fake-bin"
mkdir "$fake_bin"
cat > "$fake_bin/gh" <<'EOF'
#!/bin/sh
printf '%s\n' v1.2.3
EOF
cat > "$fake_bin/git" <<'EOF'
#!/bin/sh
set -eu
if [ "$1" = ls-remote ]; then
  case "$2" in
    upstream) printf '%s\t%s\n' 0123456789012345678901234567890123456789 refs/tags/v1.2.3 ;;
    packaging) printf '%s\t%s\n' abcdefabcdefabcdefabcdefabcdefabcdefabcd refs/heads/main ;;
    *) exit 1 ;;
  esac
  exit 0
fi
exit 1
EOF
cat > "$fake_bin/bash" <<'EOF'
#!/bin/sh
set -eu
if [ "$1" = "$FRESH_MATERIALIZE_SCRIPT" ]; then
  mkdir -p "$4/export"
  exit 0
fi
exec "$REAL_BASH" "$@"
EOF
cat > "$fake_bin/node" <<'EOF'
#!/bin/sh
set -eu
[ -n "${DOCKER_CONFIG:-}" ] || exit 1
[ "$DOCKER_CONFIG" != "$PARENT_DOCKER_CONFIG" ] || exit 1
[ -d "$DOCKER_CONFIG" ] || exit 1
[ -z "$(ls -A "$DOCKER_CONFIG")" ] || exit 1
[ "$(cat "$PARENT_DOCKER_CONFIG/config.json")" = parent-config ] || exit 1
printf '%s\n' "$DOCKER_CONFIG" > "$CAPTURED_DOCKER_CONFIG"
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

parent_docker_config="$tmp/parent-docker-config"
mkdir "$parent_docker_config"
printf '%s\n' parent-config > "$parent_docker_config/config.json"
captured_docker_config="$tmp/captured-docker-config"
PATH="$fake_bin:$PATH" \
  REAL_BASH="${BASH:-bash}" \
  FRESH_MATERIALIZE_SCRIPT="$script_dir/materialize-packaging.sh" \
  PARENT_DOCKER_CONFIG="$parent_docker_config" \
  CAPTURED_DOCKER_CONFIG="$captured_docker_config" \
  DOCKER_CONFIG="$parent_docker_config" \
  GH_TOKEN=test-token \
  FRESH_REGCTL_PATH=regctl \
  FRESH_PACKAGING_URL=packaging \
  FRESH_UPSTREAM_URL=upstream \
  FRESH_POSTGRES_REF=postgres \
  FRESH_MEILI_REF=meili \
  FRESH_NODE_REF=node \
  FRESH_RUST_REF=rust \
  FRESH_MONOLITH_VERSION=monolith \
  "${BASH:-bash}" "$script" "$tmp/input.json"
[ "$(cat "$parent_docker_config/config.json")" = parent-config ] \
  || fail 'fresh input resolver modified the parent Docker configuration'
captured_config_path="$(cat "$captured_docker_config")"
[ ! -e "$captured_config_path" ] \
  || fail 'fresh input resolver did not clean up its isolated Docker configuration'

printf '%s\n' 'resolve-fresh-input tests passed'
