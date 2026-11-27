#!/usr/bin/env bash
# Regenerate PNG assets from assets/icon.svg.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
SVG="$APP_DIR/assets/icon.svg"

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "rsvg-convert is required (pacman -S librsvg)" >&2
  exit 1
fi

rsvg-convert -w 512 -h 512 "$SVG" -o "$APP_DIR/assets/icon.png"
rsvg-convert -w 256 -h 256 "$SVG" -o "$APP_DIR/assets/icon-256.png"
rsvg-convert -w 128 -h 128 "$SVG" -o "$APP_DIR/assets/icon-128.png"
rsvg-convert -w 64  -h 64  "$SVG" -o "$APP_DIR/assets/tray-64.png"
rsvg-convert -w 32  -h 32  "$SVG" -o "$APP_DIR/assets/tray.png"
echo "icons written to $APP_DIR/assets"
