#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'usage: %s --out FILE --regctl PATH --packaging-url URL --upstream-url URL --postgres REF --meili REF --node REF --rust REF --monolith-version VERSION (--upstream-tag TAG | --latest-upstream) (--packaging-sha SHA | --packaging-main)\n' "$0" >&2
  exit 64
}

while [ "$#" -gt 0 ]; do
  flag=$1
  case "$flag" in
    --latest-upstream)
      [ -z "${latest_upstream:-}" ] || usage
      latest_upstream=true
      shift
      ;;
    --packaging-main)
      [ -z "${packaging_main:-}" ] || usage
      packaging_main=true
      shift
      ;;
    --out|--regctl|--packaging-url|--upstream-url|--postgres|--meili|--node|--rust|--monolith-version|--upstream-tag|--packaging-sha)
      [ "$#" -ge 2 ] || usage
      case "$flag" in
        --out) output_path=$2 ;;
        --regctl) regctl_path=$2 ;;
        --packaging-url) packaging_url=$2 ;;
        --upstream-url) upstream_url=$2 ;;
        --postgres) postgres_ref=$2 ;;
        --meili) meili_ref=$2 ;;
        --node) node_ref=$2 ;;
        --rust) rust_ref=$2 ;;
        --monolith-version) monolith_version=$2 ;;
        --upstream-tag) [ -z "${upstream_tag:-}" ] || usage; upstream_tag=$2 ;;
        --packaging-sha) [ -z "${packaging_sha:-}" ] || usage; packaging_sha=$2 ;;
      esac
      shift 2
      ;;
    *) usage ;;
  esac
done

for required in output_path regctl_path packaging_url upstream_url postgres_ref meili_ref node_ref rust_ref monolith_version; do
  [ -n "${!required:-}" ] || usage
done
if [ -n "${upstream_tag:-}" ]; then
  [ -z "${latest_upstream:-}" ] || usage
else
  [ -n "${latest_upstream:-}" ] || usage
fi
if [ -n "${packaging_sha:-}" ]; then
  [ -z "${packaging_main:-}" ] || usage
else
  [ -n "${packaging_main:-}" ] || usage
fi

if [ -z "${upstream_tag:-}" ]; then
  : "${GH_TOKEN:?GH_TOKEN is required for --latest-upstream}"
  upstream_tag="$(gh api repos/linkwarden/linkwarden/releases/latest --jq .tag_name)"
fi
if ! [[ "$upstream_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'Upstream release is not a supported tag: %s\n' "$upstream_tag" >&2
  exit 1
fi

tag_refs="$(git ls-remote "$upstream_url" "refs/tags/$upstream_tag^{}" "refs/tags/$upstream_tag")"
upstream_sha="$(printf '%s\n' "$tag_refs" | awk -F '\t' -v peeled="refs/tags/$upstream_tag^{}" '$2 == peeled { print $1; exit }')"
if [ -z "$upstream_sha" ]; then
  upstream_sha="$(printf '%s\n' "$tag_refs" | awk -F '\t' -v tag="refs/tags/$upstream_tag" '$2 == tag { print $1; exit }')"
fi
if ! [[ "$upstream_sha" =~ ^[a-f0-9]{40}$ ]]; then
  printf 'Unable to resolve upstream tag to an exact SHA: %s\n' "$upstream_tag" >&2
  exit 1
fi

if [ -n "${packaging_main:-}" ]; then
  packaging_sha="$(git ls-remote "$packaging_url" refs/heads/main | awk -F '\t' '$2 == "refs/heads/main" { print $1; exit }')"
fi
if ! [[ "$packaging_sha" =~ ^[a-f0-9]{40}$ ]]; then
  printf 'Unable to resolve packaging to an exact SHA\n' >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
packaging_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/linkwarden-publish-packaging.XXXXXX")"
docker_config="$(mktemp -d "${RUNNER_TEMP:-/tmp}/linkwarden-publish-docker-config.XXXXXX")"
trap 'rm -rf "$packaging_dir" "$docker_config"' EXIT
bash "$script_dir/materialize-packaging.sh" "$packaging_url" "$packaging_sha" "$packaging_dir"
DOCKER_CONFIG="$docker_config" node "$script_dir/resolve-inputs.mjs" \
  --regctl "$regctl_path" \
  --packaging-url "$packaging_url" \
  --packaging-sha "$packaging_sha" \
  --packaging-export "$packaging_dir/export" \
  --upstream-tag "$upstream_tag" \
  --upstream-url "$upstream_url" \
  --upstream-sha "$upstream_sha" \
  --postgres "$postgres_ref" \
  --meili "$meili_ref" \
  --node "$node_ref" \
  --rust "$rust_ref" \
  --monolith-version "$monolith_version" \
  --out "$output_path"
