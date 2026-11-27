'use strict';

const messageEl = document.getElementById('message');
const logEl = document.getElementById('log');
const footEl = document.getElementById('foot');
const retryBtn = document.getElementById('retry');
const copyBtn = document.getElementById('copy');
const logsBtn = document.getElementById('logs');
const quitBtn = document.getElementById('quit');

let busy = false;

function setBusy(value) {
  busy = value;
  for (const button of [retryBtn, copyBtn, logsBtn, quitBtn]) button.disabled = value;
  retryBtn.textContent = value ? 'Перезапускаю…' : 'Повторить запуск';
}

function render(info) {
  const message = info.error || 'Не удалось поднять локальный DeepSeek Harness.';
  if (messageEl.textContent !== message) messageEl.textContent = message;

  const tail = (info.logTail || '').trim();
  const text = tail || 'Журнал пуст.';
  if (logEl.textContent !== text) logEl.textContent = text;

  const parts = [`профиль ${info.profileName}`, `dsh: ${info.dshPath || 'не найден'}`];
  if (info.backend?.pid) parts.push(`pid ${info.backend.pid}`);
  parts.push(`логи: ${info.logsDir}`);
  footEl.textContent = parts.join(' · ');
  footEl.title = `${info.configFile}\n${info.logsDir}`;

  if (!busy && info.backend?.state && info.backend.state !== 'error') {
    retryBtn.textContent = 'Перезапускаю…';
    retryBtn.disabled = true;
  }
}

async function tick() {
  try {
    render(await window.dshDesktop.info());
  } catch {
    /* the page stays usable even if the shell is busy quitting */
  }
}

retryBtn.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try {
    await window.dshDesktop.retry();
  } finally {
    setBusy(false);
    tick();
  }
});

copyBtn.addEventListener('click', async () => {
  await window.dshDesktop.copyLog();
  copyBtn.textContent = 'Скопировано';
  setTimeout(() => {
    copyBtn.textContent = 'Копировать лог';
  }, 1500);
});

logsBtn.addEventListener('click', () => window.dshDesktop.openLogs());
quitBtn.addEventListener('click', () => window.dshDesktop.quit());

tick();
setInterval(tick, 1000);
