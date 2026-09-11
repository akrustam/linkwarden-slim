#!/usr/bin/env bash
set -euo pipefail

: "${SELECTED_VERSION:?SELECTED_VERSION is required}"
: "${LATEST_PUBLISHED:?LATEST_PUBLISHED is required}"
: "${UPSTREAM_URL:?UPSTREAM_URL is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

if [ "$LATEST_PUBLISHED" != true ]; then
  printf 'Not updating VERSION: latest was not moved by this publish run\n'
  exit 0
fi

if ! [[ "$UPSTREAM_URL" =~ ^https://github\.com/([^/]+)/([^/]+)\.git$ ]]; then
  printf 'UPSTREAM_URL must be an HTTPS GitHub repository URL ending in .git: %s\n' "$UPSTREAM_URL" >&2
  exit 1
fi
upstream_repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"

reconcile_version_pin() {
  local current_version latest_version push_error
  git fetch origin main || return 1
  git checkout -B main origin/main || return 1

  latest_version="$(gh api "repos/$upstream_repo/releases/latest" --jq .tag_name)" || return 1
  if [ "$SELECTED_VERSION" != "$latest_version" ]; then
    printf 'Not updating VERSION: %s is not the current upstream release %s\n' "$SELECTED_VERSION" "$latest_version"
    return 0
  fi

  current_version="$(tr -d '[:space:]' < VERSION)" || return 1
  if [ "$current_version" = "$SELECTED_VERSION" ]; then
    printf 'VERSION already pins %s\n' "$SELECTED_VERSION"
    return 0
  fi

  printf '%s\n' "$SELECTED_VERSION" > VERSION || return 1
  git config user.name 'github-actions[bot]' || return 1
  git config user.email '41898282+github-actions[bot]@users.noreply.github.com' || return 1
  git add VERSION || return 1
  git commit -m "chore: pin VERSION to ${SELECTED_VERSION}" || return 1

  push_error="$(mktemp)" || return 1
  if git push origin HEAD:main 2>"$push_error"; then
    rm -f "$push_error"
    return 0
  fi
  if grep -Eqi 'non-fast-forward|fetch first' "$push_error"; then
    rm -f "$push_error"
    return 2
  fi
  rm -f "$push_error"
  return 1
}

if reconcile_version_pin; then
  exit 0
else
  status=$?
fi
if [ "$status" -ne 2 ]; then
  exit "$status"
fi

printf 'VERSION pin push was non-fast-forward; reconciling once with origin/main\n' >&2
reconcile_version_pin
