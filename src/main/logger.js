'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Tiny synchronous logger with size-based rotation. Synchronous writes keep the
 * ordering of child-process output intact and are cheap at this volume.
 */
class Logger {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'desktop.log');
    this.backendFile = path.join(dir, 'backend.log');
    /** Lines produced since this launch, for the error page (no stale history, no old tokens). */
    this.session = [];
    this.rotate(this.file);
  }

  rotate(file) {
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      /* no file yet */
    }
  }

  write(file, message) {
    const line = message.endsWith('\n') ? message : `${message}\n`;
    for (const entry of line.split(/\r?\n/u)) {
      if (entry.trim()) this.session.push(entry);
    }
    if (this.session.length > 500) this.session.splice(0, this.session.length - 500);
    try {
      this.rotate(file);
      fs.appendFileSync(file, line, 'utf8');
    } catch {
      /* logging must never crash the app */
    }
  }

  info(message) {
    this.write(this.file, `${new Date().toISOString()} ${message}`);
  }

  warn(message) {
    this.info(`WARN ${message}`);
  }

  error(message) {
    this.info(`ERROR ${message}`);
  }

  backend(chunk) {
    this.write(this.backendFile, chunk.replace(/\s+$/u, ''));
  }

  tail(file, maxLines = 80, maxChars = 8000) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split(/\r?\n/u).filter((line) => line.length > 0);
      const tail = lines.slice(-maxLines).join('\n');
      return tail.length > maxChars ? tail.slice(-maxChars) : tail;
    } catch {
      return '';
    }
  }

  tailSession(maxLines = 60) {
    const tail = this.session.slice(-maxLines).join('\n');
    return tail.length > 9000 ? tail.slice(-9000) : tail;
  }

  tailAll(maxLines = 120) {
    const desktop = this.tail(this.file, 40);
    const backend = this.tail(this.backendFile, maxLines);
    return [desktop, backend].filter(Boolean).join('\n');
  }
}

module.exports = { Logger };
