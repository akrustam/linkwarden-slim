#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -eq 1 ]; then
  output_path=$1
  regctl_path=${FRESH_REGCTL_PATH:?FRESH_REGCTL_PATH is required}
  packaging_url=${FRESH_PACKAGING_URL:?FRESH_PACKAGING_URL is required}
  upstream_url=${FRESH_UPSTREAM_URL:?FRESH_UPSTREAM_URL is required}
  postgres_ref=${FRESH_POSTGRES_REF:?FRESH_POSTGRES_REF is required}
  meili_ref=${FRESH_MEILI_REF:?FRESH_MEILI_REF is required}
  node_ref=${FRESH_NODE_REF:?FRESH_NODE_REF is required}
  rust_ref=${FRESH_RUST_REF:?FRESH_RUST_REF is required}
  monolith_version=${FRESH_MONOLITH_VERSION:?FRESH_MONOLITH_VERSION is required}
elif [ "$#" -eq 9 ]; then
  output_path=$1
  regctl_path=$2
  packaging_url=$3
  upstream_url=$4
  postgres_ref=$5
  meili_ref=$6
  node_ref=$7
  rust_ref=$8
  monolith_version=$9
else
  printf 'usage: %s OUTPUT_PATH REGCTL_PATH PACKAGING_URL UPSTREAM_URL POSTGRES_REF MEILI_REF NODE_REF RUST_REF MONOLITH_VERSION\n' "$0" >&2
  exit 64
fi

: "${GH_TOKEN:?GH_TOKEN is required}"

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
latest_tag="$(gh api repos/linkwarden/linkwarden/releases/latest --jq .tag_name)"
if ! [[ "$latest_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'Latest upstream release is not a supported tag: %s\n' "$latest_tag" >&2
  exit 1
fi

tag_refs="$(git ls-remote "$upstream_url" "refs/tags/$latest_tag^{}" "refs/tags/$latest_tag")"
latest_sha="$(printf '%s\n' "$tag_refs" | awk -F '\t' -v peeled="refs/tags/$latest_tag^{}" '$2 == peeled { print $1; exit }')"
if [ -z "$latest_sha" ]; then
  latest_sha="$(printf '%s\n' "$tag_refs" | awk -F '\t' -v tag="refs/tags/$latest_tag" '$2 == tag { print $1; exit }')"
fi
if ! [[ "$latest_sha" =~ ^[a-f0-9]{40}$ ]]; then
  printf 'Unable to resolve latest upstream tag to an exact SHA: %s\n' "$latest_tag" >&2
  exit 1
fi

latest_packaging_sha="$(git ls-remote "$packaging_url" refs/heads/main | awk -F '\t' '$2 == "refs/heads/main" { print $1; exit }')"
if ! [[ "$latest_packaging_sha" =~ ^[a-f0-9]{40}$ ]]; then
  printf 'Unable to resolve the default packaging branch to an exact SHA\n' >&2
  exit 1
fi

fresh_packaging_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/linkwarden-fresh-packaging.XXXXXX")"
fresh_docker_config="$(mktemp -d "${RUNNER_TEMP:-/tmp}/linkwarden-fresh-docker-config.XXXXXX")"
trap 'rm -rf "$fresh_packaging_dir" "$fresh_docker_config"' EXIT
bash "$script_dir/materialize-packaging.sh" "$packaging_url" "$latest_packaging_sha" "$fresh_packaging_dir"
DOCKER_CONFIG="$fresh_docker_config" node "$script_dir/resolve-inputs.mjs" \
  --regctl "$regctl_path" \
  --packaging-url "$packaging_url" \
  --packaging-sha "$latest_packaging_sha" \
  --packaging-export "$fresh_packaging_dir/export" \
  --upstream-tag "$latest_tag" \
  --upstream-url "$upstream_url" \
  --upstream-sha "$latest_sha" \
  --postgres "$postgres_ref" \
  --meili "$meili_ref" \
  --node "$node_ref" \
  --rust "$rust_ref" \
  --monolith-version "$monolith_version" \
  --out "$output_path"
