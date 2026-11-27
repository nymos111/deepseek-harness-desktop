'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { screen } = require('electron');

const DEFAULT_BOUNDS = { width: 1280, height: 840 };

/** Persist window geometry in the app's userData directory. */
class WindowState {
  constructor(file, defaults = DEFAULT_BOUNDS) {
    this.file = file;
    this.defaults = defaults;
    this.state = this.read();
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return {};
      return parsed;
    } catch {
      return {};
    }
  }

  /** Geometry to use for a new window, clamped to a currently visible display. */
  bounds() {
    const { x, y, width, height } = this.state;
    const size = {
      width: Number.isFinite(width) ? Math.max(900, width) : this.defaults.width,
      height: Number.isFinite(height) ? Math.max(600, height) : this.defaults.height,
    };
    if (!Number.isFinite(x) || !Number.isFinite(y)) return size;

    const visible = screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      return (
        x + 80 > area.x &&
        y + 40 > area.y &&
        x < area.x + area.width - 80 &&
        y < area.y + area.height - 40
      );
    });
    return visible ? { x, y, ...size } : size;
  }

  get maximized() {
    return Boolean(this.state.maximized);
  }

  track(win) {
    const save = () => {
      if (win.isDestroyed()) return;
      const normal = win.getNormalBounds();
      this.state = {
        ...normal,
        maximized: win.isMaximized(),
      };
    };
    win.on('resize', save);
    win.on('move', save);
    win.on('maximize', save);
    win.on('unmaximize', save);
    win.on('close', () => {
      save();
      this.flush();
    });
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    } catch {
      /* geometry is a convenience, never a hard failure */
    }
  }
}

module.exports = { WindowState, DEFAULT_BOUNDS };
