#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
script="$script_dir/download-regctl.sh"

bash -n "$script"
grep -q '^REGCTL_VERSION=[0-9]' "$script"
grep -Eq '^REGCTL_LINUX_AMD64_SHA256=[a-f0-9]{64}$' "$script"
grep -q 'github.com/regclient/regclient/releases/download/v' "$script"
grep -q 'sha256sum --check --status' "$script"
grep -q '"\$target" version' "$script"
