#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
workspace=$(mktemp -d)
trap 'rm -rf "$workspace"' EXIT
fake_regctl="$workspace/regctl"
calls="$workspace/calls"
digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
child="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

cat > "$fake_regctl" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "\$*" >> '$calls'
if [ "\$1" = manifest ] && [ "\$2" = head ] && [[ "\$3" == invalid.invalid/* ]]; then
  printf 'dial tcp: no such host\\n' >&2
  exit 1
fi
if [ "\$1" = manifest ] && [ "\$2" = head ] && [[ "\$3" == *linkwarden-slim-probe-* ]]; then
  printf '%s\\n' "\${ABSENT_MANIFEST_OUTPUT:?}" >&2
  exit 1
fi
if [ "\$1" = manifest ] && [ "\$2" = head ] && [ "\$3" = 'docker.io/library/node:lts-bookworm-slim' ]; then
  printf '%s\\n' '$digest'
  exit 0
fi
if [ "\$1" = manifest ] && [ "\$2" = get ]; then
  printf '%s\\n' '{"schemaVersion":2,"manifests":[{"digest":"$child","platform":{"os":"linux","architecture":"amd64"}},{"digest":"$digest","platform":{"os":"linux","architecture":"arm64"}}]}'
  exit 0
fi
printf 'invalid reference\n' >&2
exit 1
EOF
chmod +x "$fake_regctl"

run_probe() {
  ABSENT_MANIFEST_OUTPUT="$1" REGCTL_PATH="$fake_regctl" bash "$script_dir/registry-probe.sh"
}

run_probe 'MANIFEST_UNKNOWN: manifest unknown'
run_probe 'REQUEST FAILED: NOT FOUND [HTTP 404]'

for output in 'request failed: unauthorized [http 404]' 'unrelated error [http 404]'; do
  if run_probe "$output" >/dev/null 2>&1; then
    printf 'expected absent probe to reject: %s\n' "$output" >&2
    exit 1
  fi
done

grep -q '^manifest head invalid.invalid/' "$calls"
