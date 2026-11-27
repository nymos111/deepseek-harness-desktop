# DeepSeek Harness — desktop shell

[Русский](README.ru.md) · ![license](https://img.shields.io/github/license/nymos111/deepseek-harness-desktop) ![platform](https://img.shields.io/badge/platform-Linux-informational) ![electron](https://img.shields.io/badge/electron-38%2B-47848f) ![size](https://img.shields.io/github/repo-size/nymos111/deepseek-harness-desktop) ![check](https://github.com/nymos111/deepseek-harness-desktop/actions/workflows/check.yml/badge.svg)

A native window for **DeepSeek Harness**. The app boots its own local `dsh web`
engine, supervises it, and shows the harness UI in a dedicated Electron window —
no browser, no tabs, no address bar, no bundled Chromium.

> Unofficial shell. Not affiliated with DeepSeek. The whale mark belongs to
> DeepSeek and is used here only to denote a compatible client.

## Why this one

- **No 250 MB download.** It uses the Electron you already have (`electron38`–`electron43`
  from your distro or `node_modules/electron`). The whole repo is a few hundred KB.
- **It supervises the engine, not just displays it.** Boots `dsh web --port 0`, waits
  for the announced URL, restarts it with backoff if it dies, shows an error screen
  with the log tail instead of a blank window, and reaps orphaned engines after a
  hard crash.
- **Wayland-first.** Tested on Hyprland (`ozone-platform-hint=auto`), works on X11.
- **Nothing leaves the machine.** The engine binds `127.0.0.1` only, tokens are
  redacted in logs, no telemetry, no analytics, plain MIT.
- **Small enough to audit.** ~1k lines of plain CommonJS, four small renderer pages.

## Requirements

- Linux with a graphical session (Hyprland/Wayland and X11);
- `dsh` (profile `web`) in `PATH` or `~/.local/bin/dsh`;
- Electron 38+ installed system-wide (`electron43` / `electron39`) **or**
  `node_modules/electron` inside the app directory.

## Install

```sh
git clone https://github.com/nymos111/deepseek-harness-desktop.git
cd deepseek-harness-desktop
bash scripts/install.sh
```

The installer adds an application-menu entry (`deepseek-harness.desktop`), icons
under `~/.local/share/icons/hicolor/*`, and a `~/.local/bin/deepseek-harness`
launcher.

Run it:

```sh
deepseek-harness              # from a terminal
gtk-launch deepseek-harness   # as the menu does
```

Without installing:

```sh
bash scripts/launch.sh
```

## Settings

`~/.config/deepseek-harness/config.json` is created on first launch:

| Field | Default | Meaning |
| --- | --- | --- |
| `dshPath` | `null` | Path to `dsh`; `null` searches `PATH` and `~/.local/bin`. |
| `profileName` | `"web"` | DSH profile to boot. |
| `host` | `"127.0.0.1"` | Engine bind address. Nothing is exposed to the network. |
| `port` | `0` | `0` = let the OS choose a free port. |
| `extraArgs` | `[]` | Extra `dsh web` arguments. |
| `cwd` | `$HOME` | Engine working directory. |
| `readyTimeoutMs` | `180000` | How long to wait for the engine URL. |
| `closeToTray` | `false` | `true` hides the window to the tray and keeps the engine running. |
| `rememberWindowState` | `true` | Remember window size and position. |
| `zoomFactor` | `1` | UI zoom (saved from the View menu). |

Environment: `DSH_DESKTOP_DSH` — path to `dsh`; `DSH_DESKTOP_URL` — attach to an
already running server by its token URL (the app will not boot an engine).

## Logs

```
~/.local/share/deepseek-harness/logs/desktop.log   # shell: start, crashes, restarts
~/.local/share/deepseek-harness/logs/backend.log   # engine stdout/stderr
~/.local/share/deepseek-harness/window-state.json  # window geometry
~/.local/share/deepseek-harness/backend.pid        # engine PID for orphan cleanup
```

Tokens are masked (`token=***`); the error screen only shows lines from the
current launch. Help → Open log folder opens the directory.

## Shortcuts

| Keys | Action |
| --- | --- |
| `Ctrl+Shift+R` | Restart the engine |
| `Ctrl+R` | Reload the UI |
| `Ctrl+±`, `Ctrl+0` | Zoom |
| `Ctrl+Q` | Quit |
| `F11` | Fullscreen |
| `Ctrl+Shift+I` | DevTools |

## About a second DSH instance

The app runs **its own** engine. If `dsh web` is already running (e.g. the browser
GUI), both share `~/.dsh`: sessions and settings are common, but account-token
refreshes can race (a `403` on `auth-api/v0/users/current` shows up in the log).
Prefer one at a time; the splash warns when another instance is detected.

Attaching to a running server needs its token URL:

```sh
DSH_DESKTOP_URL='http://127.0.0.1:3080/?token=…' deepseek-harness
```

## Packaging

`packaging/PKGBUILD` builds a system package from this repository
(`deepseek-harness-desktop-git`, installs to `/opt/deepseek-harness`). It is not
in the AUR yet — build it locally with `makepkg -si` or submit it there.

## Update / uninstall

```sh
git pull && bash scripts/install.sh   # refresh entry and icons
bash scripts/uninstall.sh             # remove from the menu; config and logs stay
```

## Layout

```
src/main/index.js        # lifecycle, windows, menu, tray, IPC
src/main/backend.js      # spawn/stop/restart `dsh web`, URL parsing
src/main/config.js       # config.json, dsh discovery, legacy-dir migration
src/main/logger.js       # rotating logs + per-launch buffer
src/main/window-state.js # window geometry
src/preload.js           # bridge for the splash and error pages only
src/renderer/            # splash, error screen, styles
assets/icon.svg          # source icon; PNGs via `bash scripts/make-icons.sh`
scripts/install.sh       # menu entry + icons + `deepseek-harness` on PATH
```

The harness UI itself is DSH's own frontend; the shell does not reimplement it.
The window loads the local engine URL with a one-time token.
