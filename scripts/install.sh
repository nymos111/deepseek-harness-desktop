#!/usr/bin/env bash
# Install DeepSeek Harness into the current user's application menu.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
APPS_DIR="${HOME}/.local/share/applications"
ICON_ROOT="${HOME}/.local/share/icons/hicolor"
ENTRY="${APPS_DIR}/deepseek-harness.desktop"

command -v rsvg-convert >/dev/null 2>&1 || {
  echo "install: rsvg-convert is required (pacman -S librsvg)" >&2
  exit 1
}

mkdir -p "$BIN_DIR" "$APPS_DIR" "$ICON_ROOT"

chmod +x "$APP_DIR/scripts/launch.sh" "$APP_DIR/scripts/make-icons.sh"

# --- launcher on PATH -------------------------------------------------------
ln -sf "$APP_DIR/scripts/launch.sh" "$BIN_DIR/deepseek-harness"

# --- icons ------------------------------------------------------------------
for size in 16 24 32 48 64 128 256 512; do
  dir="$ICON_ROOT/${size}x${size}/apps"
  mkdir -p "$dir"
  rsvg-convert -w "$size" -h "$size" "$APP_DIR/assets/icon.svg" -o "$dir/deepseek-harness.png"
done

# --- desktop entry ----------------------------------------------------------
cat > "$ENTRY" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=DeepSeek Harness
GenericName=AI Agent Workspace
Comment=DeepSeek Harness in a native desktop window
Exec="${APP_DIR}/scripts/launch.sh"
Icon=deepseek-harness
Terminal=false
Categories=Development;
Keywords=dsh;deepseek;harness;ai;agent;code;
StartupWMClass=deepseek-harness
StartupNotify=true
EOF

update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
gtk-update-icon-cache -f -t "$ICON_ROOT" >/dev/null 2>&1 || true

echo "DeepSeek Harness installed:"
echo "  launcher: $BIN_DIR/deepseek-harness"
echo "  entry:    $ENTRY"
echo "  icons:    $ICON_ROOT/*/apps/deepseek-harness.png"
echo
echo "Start it from the application menu, or run: deepseek-harness"
