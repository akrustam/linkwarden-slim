#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  printf 'usage: %s PACKAGING_REPOSITORY_URL PACKAGING_SHA DEST\n' "$0" >&2
  exit 64
fi

repository_url=$1
packaging_sha=$2
destination=$3
export_dir="$destination/export"

rm -rf "$destination"
git init -q "$destination"
git -C "$destination" remote add origin "$repository_url"
git -C "$destination" fetch -q --no-tags origin "$packaging_sha"
git -C "$destination" checkout -q --detach FETCH_HEAD

resolved_sha=$(git -C "$destination" rev-parse HEAD)
fetched_sha=$(git -C "$destination" rev-parse FETCH_HEAD)
if [ "$resolved_sha" != "$fetched_sha" ]; then
  printf 'packaging checkout does not match fetched ref\n' >&2
  exit 1
fi

if [[ "$packaging_sha" =~ ^[0-9a-f]{40}$ ]] && [ "$resolved_sha" != "$packaging_sha" ]; then
  printf 'packaging checkout does not match requested SHA\n' >&2
  exit 1
fi

required_paths=(
  Dockerfile
  docker-entrypoint.sh
  patch-next-standalone.js
  ci/run-source-tests.sh
)

for path in "${required_paths[@]}"; do
  if [ ! -f "$destination/$path" ]; then
    printf 'missing required packaging file: %s\n' "$path" >&2
    exit 1
  fi
done

mkdir -p "$export_dir/ci"
for path in "${required_paths[@]}"; do
  cp "$destination/$path" "$export_dir/$path"
done
