'use strict';

const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');
const noteEl = document.getElementById('note');
const metaEl = document.getElementById('meta');
const timerEl = document.getElementById('timer');

const LABELS = {
  idle: 'Подготовка…',
  starting: 'Запускаю движок…',
  ready: 'Открываю интерфейс…',
  stopping: 'Останавливаю движок…',
  stopped: 'Движок остановлен',
  error: 'Ошибка запуска',
};

const HINTS = {
  starting: 'Запускается локальный сервис. Первый запуск с плагинами может занять до минуты.',
  ready: 'Загружаю интерфейс.',
  stopping: 'Останавливаю сервис.',
};

let startedAt = 0;

function render(info) {
  const state = info.backend?.state ?? 'idle';
  statusEl.textContent = LABELS[state] ?? state;
  if (HINTS[state]) hintEl.textContent = HINTS[state];
  if (info.otherInstances > 0) {
    noteEl.hidden = false;
    noteEl.textContent =
      'Рядом уже работает другой экземпляр DSH — сессии общие, это нормально.';
  } else {
    noteEl.hidden = true;
  }

  const parts = [`профиль ${info.profileName}`];
  if (info.backend?.pid) parts.push(`pid ${info.backend.pid}`);
  metaEl.textContent = parts.join(' · ');

  if (!startedAt && info.backend?.startedAt) startedAt = info.backend.startedAt;
  if (startedAt && state !== 'ready') {
    timerEl.textContent = `${Math.max(0, Math.round((Date.now() - startedAt) / 1000))} с`;
  } else if (state === 'ready') {
    timerEl.textContent = 'готово';
  }
}

async function tick() {
  try {
    const info = await window.dshDesktop.info();
    render(info);
  } catch {
    statusEl.textContent = 'Нет связи с оболочкой';
  }
}

tick();
setInterval(tick, 500);
