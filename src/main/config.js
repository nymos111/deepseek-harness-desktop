'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'deepseek-harness');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DATA_DIR = path.join(os.homedir(), '.local', 'share', 'deepseek-harness');

/** Earlier builds called themselves "DSH Desktop"; adopt their state once. */
const LEGACY_DIRS = [
  [path.join(os.homedir(), '.config', 'dsh-desktop'), CONFIG_DIR],
  [path.join(os.homedir(), '.local', 'share', 'dsh-desktop'), DATA_DIR],
];

function migrateLegacyDirs() {
  for (const [from, to] of LEGACY_DIRS) {
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      try {
        fs.renameSync(from, to);
      } catch {
        /* a stale directory is not worth failing the launch over */
      }
    }
  }
}

const DEFAULTS = {
  /** Absolute path to the `dsh` launcher. null = resolve from PATH / ~/.local/bin. */
  dshPath: null,
  /** Profile booted by the backend (`dsh <profileName> ...`). */
  profileName: 'web',
  /** Backend bind address. Loopback only; the app does not expose the harness to the network. */
  host: '127.0.0.1',
  /** Backend port. 0 lets the OS pick a free port (recommended: avoids clashing with `dsh web`). */
  port: 0,
  /** Extra CLI arguments appended to `dsh <profileName> --no-open`. */
  extraArgs: [],
  /** Working directory of the backend process. */
  cwd: os.homedir(),
  /** How long to wait for the backend to print its URL. */
  readyTimeoutMs: 180000,
  /** Keep running in the tray when the window is closed. */
  closeToTray: false,
  /** Remember window geometry between launches. */
  rememberWindowState: true,
  /** Page zoom factor applied to the harness UI. */
  zoomFactor: 1,
};

function isDir(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function pickKnown(raw, defaults) {
  const out = { ...defaults };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(defaults)) {
    if (!(key in raw)) continue;
    const value = raw[key];
    const expected = defaults[key];
    if (expected === null) {
      if (value === null || typeof value === 'string') out[key] = value;
      continue;
    }
    if (Array.isArray(expected)) {
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) out[key] = value;
      continue;
    }
    if (typeof value === typeof expected) out[key] = value;
  }
  return out;
}

function ensureConfigFile() {
  if (fs.existsSync(CONFIG_FILE)) return;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(DEFAULTS, null, 2)}\n`, 'utf8');
}

function loadConfig(overrides = {}) {
  ensureConfigFile();
  const fileConfig = pickKnown(readJsonSafe(CONFIG_FILE), DEFAULTS);
  const config = { ...fileConfig, ...overrides };
  config.port = Number.isFinite(Number(config.port)) ? Number(config.port) : 0;
  config.zoomFactor = Number(config.zoomFactor) > 0 ? Number(config.zoomFactor) : 1;
  if (isDir(config.cwd) === false) config.cwd = os.homedir();
  return config;
}

/** Find an executable on PATH (and in the conventional user bin directory). */
function which(command, extraDirs = []) {
  const dirs = [
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean),
    ...extraDirs,
  ];
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Resolve the dsh launcher: explicit config > env override > PATH > user-local install.
 */
function resolveDshPath(config) {
  const candidates = [
    config.dshPath,
    process.env.DSH_DESKTOP_DSH,
    which('dsh', [path.join(os.homedir(), '.local', 'bin')]),
    path.join(os.homedir(), '.local', 'bin', 'dsh'),
    '/usr/local/bin/dsh',
    '/usr/bin/dsh',
  ].filter((value) => typeof value === 'string' && value.length > 0);

  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

module.exports = {
  migrateLegacyDirs,
  CONFIG_DIR,
  CONFIG_FILE,
  DATA_DIR,
  DEFAULTS,
  loadConfig,
  resolveDshPath,
  which,
};
