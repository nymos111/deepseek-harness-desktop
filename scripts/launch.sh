#!/usr/bin/env bash
# Launch DeepSeek Harness with a system-wide Electron installation.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"

ELECTRON=""
if [[ -x "$APP_DIR/node_modules/electron/dist/electron" ]]; then
  ELECTRON="$APP_DIR/node_modules/electron/dist/electron"
elif [[ -n "${ELECTRON_BIN:-}" ]]; then
  ELECTRON="$ELECTRON_BIN"
else
  for candidate in electron electron43 electron39 electron38 electron37; do
    if command -v "$candidate" >/dev/null 2>&1; then
      ELECTRON="$(command -v "$candidate")"
      break
    fi
  done
fi

if [[ -z "${ELECTRON:-}" ]]; then
  echo "DeepSeek Harness: Electron не найден. Установите его (pacman -S electron43) или задайте ELECTRON_BIN." >&2
  exit 1
fi

# Let Electron choose Wayland when the session provides it, X11 otherwise.
export ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-auto}"

exec "$ELECTRON" "$APP_DIR" "$@"
