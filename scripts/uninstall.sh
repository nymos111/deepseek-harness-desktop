#!/usr/bin/env bash
# Remove the application-menu entry, launcher and icons. Config and logs are kept.
set -euo pipefail

BIN_DIR="${HOME}/.local/bin"
APPS_DIR="${HOME}/.local/share/applications"
ICON_ROOT="${HOME}/.local/share/icons/hicolor"

rm -f "${APPS_DIR}/deepseek-harness.desktop"
rm -f "${BIN_DIR}/deepseek-harness"
for size in 16 24 32 48 64 128 256 512; do
  rm -f "$ICON_ROOT/${size}x${size}/apps/deepseek-harness.png"
  rmdir --ignore-fail-on-non-empty "$ICON_ROOT/${size}x${size}/apps" 2>/dev/null || true
done

update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
gtk-update-icon-cache -f -t "$ICON_ROOT" >/dev/null 2>&1 || true

echo "DeepSeek Harness removed from the application menu."
echo "Kept: ~/.config/deepseek-harness (settings) and ~/.local/share/deepseek-harness (logs, window state)."
