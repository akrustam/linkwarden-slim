#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  printf 'usage: %s UPSTREAM_URL UPSTREAM_REF PACKAGING_EXPORT_DIR DEST\n' "$0" >&2
  exit 64
fi

upstream_url=$1
upstream_ref=$2
packaging_export_dir=$3
destination=$4

required_exports=(
  docker-entrypoint.sh
  patch-next-standalone.js
  ci/run-source-tests.sh
)

for path in "${required_exports[@]}"; do
  if [ ! -f "$packaging_export_dir/$path" ]; then
    printf 'missing required packaging export: %s\n' "$path" >&2
    exit 1
  fi
done

if [ -e "$destination" ] || [ -L "$destination" ]; then
  if [ ! -d "$destination" ] || [ -L "$destination" ]; then
    printf 'destination must be an empty directory: %s\n' "$destination" >&2
    exit 1
  fi
  shopt -s nullglob dotglob
  destination_entries=("$destination"/*)
  shopt -u nullglob dotglob
  if [ "${#destination_entries[@]}" -ne 0 ]; then
    printf 'destination must be empty: %s\n' "$destination" >&2
    exit 1
  fi
fi

rm -rf "$destination"
git init -q "$destination"
git -C "$destination" remote add origin "$upstream_url"
git -C "$destination" fetch -q --no-tags origin "$upstream_ref"
git -C "$destination" checkout -q --detach FETCH_HEAD

resolved_sha=$(git -C "$destination" rev-parse HEAD)
fetched_sha=$(git -C "$destination" rev-parse FETCH_HEAD)
if [ "$resolved_sha" != "$fetched_sha" ]; then
  printf 'upstream checkout does not match requested ref\n' >&2
  exit 1
fi

if [[ "$upstream_ref" =~ ^[0-9a-f]{40}$ ]] && [ "$resolved_sha" != "$upstream_ref" ]; then
  printf 'upstream checkout does not match requested SHA\n' >&2
  exit 1
fi

if [ ! -f "$destination/apps/mobile/package.json" ]; then
  printf 'missing required upstream workspace manifest: apps/mobile/package.json\n' >&2
  exit 1
fi

cp "$destination/apps/mobile/package.json" "$destination/mobile-package.json"

for path in "${required_exports[@]}"; do
  cp "$packaging_export_dir/$path" "$destination/${path#ci/}"
done
