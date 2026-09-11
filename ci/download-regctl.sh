#!/usr/bin/env bash
set -euo pipefail

REGCTL_VERSION=0.8.1
REGCTL_LINUX_AMD64_SHA256=92bf59fbc874c8b17a9cad2f7a737da47eea3fb3162c66efbbb0ed17ec05d983

target=${1:-"${RUNNER_TEMP:-/tmp}/regctl"}
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)
    asset="regctl-linux-amd64"
    checksum=$REGCTL_LINUX_AMD64_SHA256
    ;;
  *)
    printf 'unsupported platform: %s/%s\n' "$(uname -s)" "$(uname -m)" >&2
    exit 1
    ;;
esac

mkdir -p "$(dirname "$target")"
url="https://github.com/regclient/regclient/releases/download/v${REGCTL_VERSION}/${asset}"
curl --fail --location --retry 3 --silent --show-error --output "$target" "$url"
printf '%s  %s\n' "$checksum" "$target" | sha256sum --check --status
chmod 0755 "$target"
"$target" version
