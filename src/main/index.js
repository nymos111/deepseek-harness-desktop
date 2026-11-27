'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  shell,
  clipboard,
} = require('electron');

const { CONFIG_FILE, DATA_DIR, loadConfig, migrateLegacyDirs, resolveDshPath } = require('./config');
const { Backend, redact } = require('./backend');
const { Logger } = require('./logger');
const { WindowState } = require('./window-state');

const APP_NAME = 'DeepSeek Harness';
const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const PRELOAD = path.join(ROOT, 'src', 'preload.js');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const TRAY_ICON = path.join(ROOT, 'assets', 'tray.png');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const STATE_FILE = path.join(DATA_DIR, 'window-state.json');
const BACKEND_PID_FILE = path.join(DATA_DIR, 'backend.pid');

const MAX_AUTO_RESTARTS = 3;
const RESTART_WINDOW_MS = 60000;

/** Process-wide state. */
const state = {
  config: null,
  logger: null,
  backend: null,
  attachedUrl: process.env.DSH_DESKTOP_URL || null,
  mainWindow: null,
  splashWindow: null,
  tray: null,
  windowState: null,
  quitting: false,
  restartAttempts: 0,
  restartTimer: null,
  lastError: null,
  dshPath: null,
};

if (process.env.WAYLAND_DISPLAY && !process.env.ELECTRON_OZONE_PLATFORM_HINT) {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}

app.setName(APP_NAME);
app.setAppUserModelId('dev.deepseek-harness.desktop');
migrateLegacyDirs();
app.setPath('userData', DATA_DIR);
fs.mkdirSync(DATA_DIR, { recursive: true });

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (state.quitting) return;
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    if (state.mainWindow.isMinimized()) state.mainWindow.restore();
    state.mainWindow.show();
    state.mainWindow.focus();
    return;
  }
  // Still booting (or hidden in the tray): surface the splash / tray window.
  if (state.splashWindow && !state.splashWindow.isDestroyed()) {
    state.splashWindow.show();
    state.splashWindow.focus();
  }
});

function info() {
  const backend = state.backend?.snapshot() ?? { state: 'idle', url: null, pid: null, error: null };
  return {
    app: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    state: backend.state,
    backend,
    url: backend.url ? redact(backend.url) : null,
    attached: Boolean(state.attachedUrl),
    dshPath: state.dshPath,
    profileName: state.config?.profileName ?? 'web',
    configFile: CONFIG_FILE,
    logsDir: LOGS_DIR,
    otherInstances: state.otherInstances ?? 0,
  };
}

/**
 * A hard crash (SIGKILL, power loss) can leave a `dsh web` child behind. Kill it
 * on the next launch so orphaned harness servers do not pile up.
 */
function reclaimOrphanBackend() {
  let pid = 0;
  try {
    pid = Number.parseInt(fs.readFileSync(BACKEND_PID_FILE, 'utf8').trim(), 10);
  } catch {
    return;
  }
  fs.rmSync(BACKEND_PID_FILE, { force: true });
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
    if (!cmdline.includes('--no-open') || !/dsh/u.test(cmdline)) return;
    process.kill(pid, 'SIGTERM');
    state.logger?.warn(`terminated orphaned backend pid ${pid}`);
  } catch {
    /* already gone */
  }
}

function detectOtherInstances() {
  try {
    const out = execFileSync('pgrep', ['-af', 'dsh web'], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.includes(` ${process.pid} `))
      .filter((line) => /(^|\/)(node|dsh)\b/u.test(line) || line.includes('/dsh '))
      .length;
  } catch {
    return 0;
  }
}

function logTail() {
  return state.logger?.tailSession(70) ?? '';
}

const PAGE_SIZE = {
  'splash.html': [460, 236],
  'error.html': [740, 640],
};

function createSplash(page = 'splash.html') {
  if (state.splashWindow && !state.splashWindow.isDestroyed()) {
    const [width, height] = PAGE_SIZE[page] ?? PAGE_SIZE['splash.html'];
    state.splashWindow.setSize(width, height, false);
    state.splashWindow.center();
    state.splashWindow.loadFile(path.join(RENDERER, page)).catch(() => {});
    return state.splashWindow;
  }
  const win = new BrowserWindow({
    width: PAGE_SIZE['splash.html'][0],
    height: PAGE_SIZE['splash.html'][1],
    frame: false,
    resizable: false,
    movable: true,
    type: 'splash',
    show: false,
    center: true,
    backgroundColor: '#141519',
    title: APP_NAME,
    icon: ICON,
    skipTaskbar: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(RENDERER, page));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (state.splashWindow === win) state.splashWindow = null;
  });
  state.splashWindow = win;
  return win;
}

function showErrorPage() {
  const splash = createSplash('error.html');
  splash.show();
  splash.focus();
}

function showSplashPage() {
  const splash = createSplash('splash.html');
  splash.show();
  return splash;
}

function closeSplash() {
  const splash = state.splashWindow;
  state.splashWindow = null;
  if (splash && !splash.isDestroyed()) splash.destroy();
}

function createMainWindow(url) {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    const win = state.mainWindow;
    win
      .loadURL(url)
      .then(() => closeSplash())
      .catch((error) => {
        if (error?.code !== 'ERR_ABORTED') state.logger?.error(`reload failed: ${error.message}`);
        closeSplash();
      });
    win.show();
    win.focus();
    return win;
  }

  const bounds = state.config.rememberWindowState ? state.windowState.bounds() : { width: 1280, height: 840 };
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#141519',
    title: APP_NAME,
    icon: ICON,
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      webviewTag: false,
    },
  });

  if (state.config.rememberWindowState) {
    state.windowState.track(win);
    if (state.windowState.maximized) win.maximize();
  }

  const origin = new URL(url).origin;
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/u.test(target)) shell.openExternal(target).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    let next;
    try {
      next = new URL(target);
    } catch {
      event.preventDefault();
      return;
    }
    if (`${next.protocol}//${next.host}` !== origin) {
      event.preventDefault();
      if (/^https?:/u.test(target)) shell.openExternal(target).catch(() => {});
    }
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.on('did-finish-load', () => {
    try {
      win.webContents.setZoomFactor(state.config.zoomFactor);
    } catch {
      /* ignore */
    }
  });
  win.webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    state.logger?.error(`UI failed to load (${code} ${description}) ${redact(failedUrl)}`);
    dialog
      .showMessageBox(win, {
        type: 'error',
        title: APP_NAME,
        message: 'Не удалось загрузить интерфейс',
        detail: `${description} (${code})\n\nДвижок отвечает, но страница не открылась. Перезапустить движок?`,
        buttons: ['Перезапустить', 'Открыть логи', 'Закрыть'],
        defaultId: 0,
        cancelId: 2,
      })
      .then(({ response }) => {
        if (response === 0) retryBackend();
        if (response === 1) openLogs();
      })
      .catch(() => {});
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    state.logger?.error(`renderer gone: ${details.reason}`);
    if (details.reason !== 'clean-exit') win.reload();
  });
  win.once('ready-to-show', () => {
    win.show();
    closeSplash();
  });
  // Never leave the splash hanging if `ready-to-show` fires late (or not at all).
  setTimeout(() => {
    if (!win.isDestroyed() && win.isVisible()) closeSplash();
  }, 8000).unref?.();
  win.on('close', (event) => {
    if (!state.quitting && state.config.closeToTray) {
      event.preventDefault();
      win.hide();
      state.tray?.displayBalloon?.({ title: APP_NAME, content: 'Приложение свёрнуто в трей' });
    }
  });
  win.on('closed', () => {
    if (state.mainWindow === win) state.mainWindow = null;
    if (state.windowState) state.windowState.flush();
  });

  state.mainWindow = win;
  win.loadURL(url).catch((error) => {
    if (error?.code === 'ERR_ABORTED') return;
    state.logger?.error(`loadURL failed: ${error.message}`);
  });
  return win;
}

function openLogs() {
  const target = fs.existsSync(LOGS_DIR) ? LOGS_DIR : DATA_DIR;
  shell.openPath(target).catch(() => {});
}

function saveConfig(patch) {
  try {
    const current = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, 'utf8');
    Object.assign(state.config, patch);
  } catch (error) {
    state.logger?.warn(`config not saved: ${error.message}`);
  }
}

async function startBackend() {
  if (state.attachedUrl) {
    createMainWindow(state.attachedUrl);
    return;
  }
  if (!state.dshPath) {
    state.lastError = new Error(
      'Не найден исполняемый файл dsh. Укажите путь в ~/.config/deepseek-harness/config.json (поле dshPath).',
    );
    state.logger?.error(state.lastError.message);
    showErrorPage();
    return;
  }
  showSplashPage();
  try {
    const url = await state.backend.start();
    createMainWindow(url);
  } catch (error) {
    state.lastError = error;
    state.logger?.error(`startup failed: ${error.message}`);
    showErrorPage();
  }
}

async function retryBackend() {
  if (state.restartTimer) {
    clearTimeout(state.restartTimer);
    state.restartTimer = null;
  }
  if (state.attachedUrl) {
    createMainWindow(state.attachedUrl);
    return;
  }
  if (!state.dshPath) {
    showErrorPage();
    return;
  }
  state.lastError = null;
  showSplashPage();
  try {
    await state.backend.restart();
    state.restartAttempts = 0;
  } catch (error) {
    state.lastError = error;
    state.logger?.error(`restart failed: ${error.message}`);
    showErrorPage();
    return;
  }
  const url = state.backend.url;
  if (url) createMainWindow(url);
}

function scheduleAutoRestart(reason) {
  const now = Date.now();
  if (now - (state.lastRestartAt || 0) > RESTART_WINDOW_MS) state.restartAttempts = 0;
  state.lastRestartAt = now;
  if (state.restartAttempts >= MAX_AUTO_RESTARTS) {
    state.logger?.warn('backend keeps crashing; giving up on auto-restart');
    return;
  }
  state.restartAttempts += 1;
  const delay = 1000 * 2 ** (state.restartAttempts - 1);
  state.logger?.warn(`auto-restart #${state.restartAttempts} in ${delay}ms (${reason})`);
  if (state.splashWindow && !state.splashWindow.isDestroyed()) state.splashWindow.show();
  state.restartTimer = setTimeout(() => {
    state.restartTimer = null;
    retryBackend().catch(() => {});
  }, delay);
}

function buildMenu() {
  const backendReady = Boolean(state.backend?.url);
  const template = [
    {
      label: 'Файл',
      submenu: [
        { label: 'Перезапустить движок', accelerator: 'CmdOrCtrl+Shift+R', click: () => retryBackend().catch(() => {}) },
        {
          label: 'Открыть интерфейс в браузере',
          enabled: backendReady,
          click: () => {
            if (state.backend?.url) shell.openExternal(state.backend.url).catch(() => {});
          },
        },
        {
          label: 'Скопировать адрес',
          enabled: backendReady,
          click: () => {
            if (state.backend?.url) clipboard.writeText(state.backend.url);
          },
        },
        { type: 'separator' },
        { label: 'Выход', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Повторить' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выделить всё' },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { role: 'reload', label: 'Обновить' },
        { role: 'forceReload', label: 'Обновить без кэша' },
        { type: 'separator' },
        {
          label: 'Увеличить',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => setZoom(state.config.zoomFactor + 0.1),
        },
        {
          label: 'Уменьшить',
          accelerator: 'CmdOrCtrl+-',
          click: () => setZoom(state.config.zoomFactor - 0.1),
        },
        {
          label: 'Исходный масштаб',
          accelerator: 'CmdOrCtrl+0',
          click: () => setZoom(1),
        },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Полный экран' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
      ],
    },
    {
      label: 'Окно',
      submenu: [
        { role: 'minimize', label: 'Свернуть' },
        { role: 'close', label: 'Закрыть' },
      ],
    },
    {
      label: 'Справка',
      submenu: [
        { label: 'Открыть папку логов', click: () => openLogs() },
        {
          label: 'О приложении',
          click: () => {
            const data = info();
            dialog.showMessageBox({
              type: 'info',
              title: `О ${APP_NAME}`,
              message: `${APP_NAME} ${data.version}`,
              detail: [
                `Electron ${data.electron} · Chromium ${data.chrome} · Node ${data.node}`,
                `Профиль: ${data.profileName}`,
                `dsh: ${data.dshPath ?? 'не найден'}`,
                `Движок: ${data.backend.state}${data.url ? ` · ${data.url}` : ''}`,
                `Конфиг: ${data.configFile}`,
                `Логи: ${data.logsDir}`,
              ].join('\n'),
            }).catch(() => {});
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setZoom(factor) {
  const value = Math.min(2.5, Math.max(0.5, Math.round(factor * 100) / 100));
  saveConfig({ zoomFactor: value });
  const win = state.mainWindow;
  if (win && !win.isDestroyed()) win.webContents.setZoomFactor(value);
}

function createTray() {
  if (state.tray) return;
  let image = nativeImage.createFromPath(TRAY_ICON);
  if (image.isEmpty()) image = nativeImage.createFromPath(ICON);
  if (image.isEmpty()) return;
  try {
    const tray = new Tray(image);
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Показать окно',
          click: () => {
            if (state.mainWindow && !state.mainWindow.isDestroyed()) {
              state.mainWindow.show();
              state.mainWindow.focus();
            } else if (state.splashWindow && !state.splashWindow.isDestroyed()) {
              state.splashWindow.show();
            } else {
              retryBackend().catch(() => {});
            }
          },
        },
        { label: 'Перезапустить движок', click: () => retryBackend().catch(() => {}) },
        { type: 'separator' },
        { label: 'Выход', click: () => app.quit() },
      ]),
    );
    tray.on('click', () => {
      const win = state.mainWindow;
      if (!win || win.isDestroyed()) {
        retryBackend().catch(() => {});
        return;
      }
      if (win.isVisible()) win.hide();
      else {
        win.show();
        win.focus();
      }
    });
    state.tray = tray;
  } catch (error) {
    state.logger?.warn(`tray unavailable: ${error.message}`);
  }
}

function registerIpc() {
  ipcMain.handle('desktop:info', () => ({
    ...info(),
    logTail: state.lastError ? logTail() : '',
    error: state.lastError ? state.lastError.message : null,
  }));
  ipcMain.handle('desktop:retry', async () => {
    await retryBackend();
    return true;
  });
  ipcMain.handle('desktop:open-logs', () => {
    openLogs();
    return true;
  });
  ipcMain.handle('desktop:copy-log', () => {
    clipboard.writeText(logTail());
    return true;
  });
  ipcMain.handle('desktop:quit', () => {
    app.quit();
    return true;
  });
}

function wireBackend() {
  const backend = state.backend;
  backend.on('ready', (url) => {
    state.lastError = null;
    if (backend.pid) {
      try {
        fs.writeFileSync(BACKEND_PID_FILE, String(backend.pid), 'utf8');
      } catch {
        /* best effort */
      }
    }
    buildMenu();
    createMainWindow(url);
  });
  backend.on('state', (snapshot) => {
    if (snapshot.state === 'stopped' || snapshot.state === 'error') {
      fs.rmSync(BACKEND_PID_FILE, { force: true });
    }
  });
  backend.on('crash', ({ reason }) => {
    state.lastError = new Error(`Движок остановился.\n${reason}`);
    state.logger?.error(`backend crash: ${reason}`);
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.hide();
    }
    showErrorPage();
    buildMenu();
    scheduleAutoRestart(reason);
  });
}

async function bootstrap() {
  state.logger = new Logger(LOGS_DIR);
  state.logger.info(`${APP_NAME} ${app.getVersion()} starting (electron ${process.versions.electron})`);
  reclaimOrphanBackend();

  state.config = loadConfig();
  state.windowState = new WindowState(STATE_FILE);
  state.dshPath = resolveDshPath(state.config);
  state.otherInstances = detectOtherInstances();
  if (state.otherInstances > 0) {
    state.logger.warn(`${state.otherInstances} other dsh web process(es) detected; sessions are shared via ~/.dsh`);
  }
  state.logger.info(`dsh: ${state.dshPath ?? '(not found)'}; profile: ${state.config.profileName}; port: ${state.config.port}`);

  registerIpc();
  buildMenu();
  createSplash();
  createTray();

  state.backend = new Backend({
    dshPath: state.dshPath ?? 'dsh',
    profileName: state.config.profileName,
    host: state.config.host,
    port: state.config.port,
    extraArgs: state.config.extraArgs,
    cwd: state.config.cwd,
    readyTimeoutMs: state.config.readyTimeoutMs,
    logger: state.logger,
  });
  wireBackend();

  if (state.attachedUrl) {
    state.logger.info(`attaching to ${redact(state.attachedUrl)}`);
    createMainWindow(state.attachedUrl);
    return;
  }
  await startBackend();
}

app.whenReady().then(bootstrap).catch((error) => {
  state.logger?.error(`fatal: ${error?.stack ?? error}`);
  dialog.showErrorBox(APP_NAME, String(error?.message ?? error));
  app.quit();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  if (state.quitting) return;
  state.quitting = true;
  event.preventDefault();
  const timeout = new Promise((resolve) => setTimeout(resolve, 12000));
  const stop = state.backend ? state.backend.stop() : Promise.resolve();
  Promise.race([stop, timeout])
    .catch(() => {})
    .finally(() => {
      state.windowState?.flush();
      state.logger?.info('quit');
      app.quit();
    });
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => app.quit());
}
