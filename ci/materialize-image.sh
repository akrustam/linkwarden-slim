#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  printf 'usage: %s PLATFORM DIGEST_SOURCE LOCAL_TAG\n' "$0" >&2
  exit 64
fi

platform=$1
digest_source=$2
local_tag=$3

case "$platform" in
  linux/amd64) expected_architecture=amd64 ;;
  linux/arm64) expected_architecture=arm64 ;;
  *)
    printf 'PLATFORM must be linux/amd64 or linux/arm64\n' >&2
    exit 64
    ;;
esac

if ! [[ "$digest_source" =~ ^[a-z0-9][a-z0-9.-]*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$ ]]; then
  printf 'DIGEST_SOURCE must be an immutable @sha256 reference\n' >&2
  exit 64
fi

if [ -z "$local_tag" ] || [[ "$local_tag" = -* ]] || [[ "$local_tag" =~ [[:space:]@] ]]; then
  printf 'LOCAL_TAG must be a nonempty image tag\n' >&2
  exit 64
fi

docker pull --platform "$platform" "$digest_source"

image_metadata=$(docker image inspect --format '{{.Id}} {{.Architecture}}' "$digest_source")
IFS=' ' read -r image_id architecture extra <<< "$image_metadata"
if [ -z "$image_id" ] || [ -n "${extra:-}" ] || [ "$architecture" != "$expected_architecture" ]; then
  printf 'pulled image architecture %s does not match %s\n' "$architecture" "$expected_architecture" >&2
  exit 1
fi

docker tag "$image_id" "$local_tag" 2>/dev/null || docker tag "$digest_source" "$local_tag"
