#!/usr/bin/env bash
set -euo pipefail

: "${REGCTL_PATH:?REGCTL_PATH is required}"
if [ ! -x "$REGCTL_PATH" ]; then
  printf 'REGCTL_PATH must name an executable\n' >&2
  exit 64
fi

docker_config=$(mktemp -d)
trap 'rm -rf "$docker_config"' EXIT
export DOCKER_CONFIG=$docker_config

index_ref=docker.io/library/node:lts-bookworm-slim
head=$("$REGCTL_PATH" manifest head "$index_ref" --require-digest 2>&1) || {
  printf 'regctl manifest head failed: %.4000s\n' "$head" >&2
  exit 1
}
digest=$(printf '%s\n' "$head" | awk '/^(sha256:|Digest: sha256:|Docker-Content-Digest: sha256:)/ { print $NF; exit }')
if ! [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  printf 'manifest head did not return a digest\n' >&2
  exit 1
fi
raw=$("$REGCTL_PATH" manifest get "docker.io/library/node@$digest" --format raw-body 2>&1) || {
  printf 'regctl manifest get failed: %.4000s\n' "$raw" >&2
  exit 1
}
printf '%s' "$raw" | node -e '
let body=""; process.stdin.on("data", chunk => { body += chunk; }); process.stdin.on("end", () => {
  const index = JSON.parse(body);
  for (const architecture of ["amd64", "arm64"]) {
    if (!index.manifests?.some(item => item?.platform?.os === "linux" && item?.platform?.architecture === architecture && /^sha256:[a-f0-9]{64}$/.test(item?.digest ?? ""))) process.exitCode = 1;
  }
});
' || { printf 'node index is missing linux/amd64 or linux/arm64\n' >&2; exit 1; }

absent="docker.io/library/node:linkwarden-slim-probe-$(date +%s)-$$"
if output=$("$REGCTL_PATH" manifest head "$absent" --require-digest 2>&1); then
  printf 'expected absent probe tag to be missing\n' >&2
  exit 1
elif ! printf '%s' "$output" | grep -Eqi 'MANIFEST_UNKNOWN|request failed: not found \[http 404\]'; then
  printf 'absent probe did not return a known absence response: %.4000s\n' "$output" >&2
  exit 1
fi

if output=$("$REGCTL_PATH" manifest head "invalid.invalid/linkwarden-slim:probe" --require-digest 2>&1); then
  printf 'expected invalid registry host to fail\n' >&2
  exit 1
fi
