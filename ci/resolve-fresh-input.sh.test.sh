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

printf '%s\n' 'resolve-fresh-input tests passed'
