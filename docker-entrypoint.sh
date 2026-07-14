#!/bin/sh
set -eu

# Truthy helper: case-insensitive "true" / "1" / "yes"
is_truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    true|1|yes) return 0 ;;
    *) return 1 ;;
  esac
}

disabled=false
if is_truthy "${DISABLE_BROWSER:-}" || is_truthy "${DISABLE_PRESERVATION:-}"; then
  disabled=true
fi

ws_url="${PLAYWRIGHT_WS_URL:-}"

# OR invariant: disable flags OR nonempty remote Playwright WS URL
if [ "$disabled" = "true" ] || [ -n "$ws_url" ]; then
  exec "$@"
fi

cat >&2 <<'EOF'
linkwarden-slim: no local Chromium in this image.

Set DISABLE_BROWSER=true (or DISABLE_PRESERVATION=true), or provide
PLAYWRIGHT_WS_URL=ws://… for a remote Playwright browser.

See README for capabilities without a browser.
EOF
exit 1
