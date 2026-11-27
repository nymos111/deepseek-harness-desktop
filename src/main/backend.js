'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const URL_LINE = /dsh web:\s+(https?:\/\/\S+)/iu;
const STOP_GRACE_MS = 8000;

function redact(url) {
  return String(url).replace(/([?&]token=)[^&\s]+/gu, '$1***');
}

/** Remove launch tokens from arbitrary log lines before they reach disk. */
function redactLine(line) {
  return String(line).replace(/([?&]token=)[^&\s'"]+/gu, '$1***');
}

/**
 * Supervises one `dsh web` child process.
 *
 * States: idle -> starting -> ready -> stopping -> stopped | error
 * Emits: 'state' (snapshot), 'ready' (url), 'crash' ({code, signal, reason}),
 *        'log' ({stream, line})
 */
class Backend extends EventEmitter {
  constructor(options) {
    super();
    this.dshPath = options.dshPath;
    this.profileName = options.profileName || 'web';
    this.host = options.host || '127.0.0.1';
    this.port = Number.isFinite(options.port) ? options.port : 0;
    this.extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    this.cwd = options.cwd;
    this.readyTimeoutMs = options.readyTimeoutMs || 180000;
    this.logger = options.logger;

    this.child = null;
    this.state = 'idle';
    this.url = null;
    this.error = null;
    this.pid = null;
    this.startedAt = 0;
    this.readyAt = 0;
    this.stderrTail = [];
    this.stopRequested = false;
    this.exited = false;
    this.timer = null;
  }

  snapshot() {
    return {
      state: this.state,
      url: this.url,
      pid: this.pid,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      error: this.error,
      uptimeMs: this.readyAt ? Date.now() - this.readyAt : 0,
    };
  }

  setState(state, patch = {}) {
    this.state = state;
    Object.assign(this, patch);
    this.emit('state', this.snapshot());
  }

  args() {
    return [
      this.profileName,
      '--no-open',
      '--host',
      this.host,
      '--port',
      String(this.port),
      ...this.extraArgs,
    ];
  }

  start() {
    if (this.child) return Promise.resolve(this.url);

    this.startedAt = Date.now();
    this.readyAt = 0;
    this.url = null;
    this.error = null;
    this.stderrTail = [];
    this.stopRequested = false;
    this.exited = false;
    this.setState('starting', { pid: null });

    const args = this.args();
    this.logger?.info(`backend: ${this.dshPath} ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      let settled = false;
      let child;
      try {
        child = spawn(this.dshPath, args, {
          cwd: this.cwd,
          env: {
            ...process.env,
            NO_COLOR: '1',
            FORCE_COLOR: '0',
            // Never let the child think it should relaunch a browser.
            BROWSER: 'true',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        this.fail(error);
        reject(error);
        return;
      }

      this.child = child;
      this.pid = child.pid ?? null;
      this.emit('state', this.snapshot());

      this.timer = setTimeout(() => {
        if (settled) return;
        const error = new Error(
          `Движок не сообщил адрес за ${Math.round(this.readyTimeoutMs / 1000)} с`,
        );
        settled = true;
        this.fail(error);
        this.kill('SIGTERM');
        reject(error);
      }, this.readyTimeoutMs);
      if (typeof this.timer.unref === 'function') this.timer.unref();

      const onLine = (stream) => (line) => {
        if (!line.trim()) return;
        this.emit('log', { stream, line });
        this.logger?.backend(`[${stream}] ${redactLine(line)}`);
        if (stream === 'stderr') {
          this.stderrTail.push(line);
          if (this.stderrTail.length > 60) this.stderrTail.shift();
        }
        const match = URL_LINE.exec(line);
        if (match && !settled) {
          settled = true;
          clearTimeout(this.timer);
          this.readyAt = Date.now();
          this.setState('ready', { url: match[1], pid: child.pid ?? null });
          this.logger?.info(`backend ready at ${redact(match[1])}`);
          this.emit('ready', match[1]);
          resolve(match[1]);
        }
      };

      for (const [stream, source] of [
        ['stdout', child.stdout],
        ['stderr', child.stderr],
      ]) {
        let buffer = '';
        source.setEncoding('utf8');
        source.on('data', (chunk) => {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/u);
          buffer = lines.pop() ?? '';
          for (const line of lines) onLine(stream)(line);
        });
        source.on('end', () => {
          if (buffer) onLine(stream)(buffer);
        });
      }

      child.once('error', (error) => {
        if (settled) {
          this.logger?.error(`backend process error: ${error.message}`);
          return;
        }
        settled = true;
        clearTimeout(this.timer);
        this.fail(error);
        reject(error);
      });

      child.once('exit', (code, signal) => {
        clearTimeout(this.timer);
        const wasReady = this.state === 'ready';
        this.child = null;
        this.exited = true;
        this.pid = null;
        const reason = this.describeExit(code, signal);

        if (this.stopRequested) {
          this.setState('stopped', { url: null });
          this.logger?.info(`backend stopped (${reason})`);
          return;
        }
        if (!settled) {
          settled = true;
          const error = new Error(reason);
          this.fail(error);
          reject(error);
          return;
        }
        this.setState('error', { url: null, error: reason });
        this.logger?.error(`backend exited unexpectedly: ${reason}`);
        this.emit('crash', { code, signal, reason, wasReady });
      });
    });
  }

  describeExit(code, signal) {
    return signal
      ? `Процесс движка завершился по сигналу ${signal}`
      : `Процесс движка завершился с кодом ${code}`;
  }

  fail(error) {
    this.error = error.message;
    this.setState('error', { url: null });
    this.logger?.error(`backend failed: ${error.message}`);
  }

  kill(signal) {
    if (!this.child) return;
    try {
      this.child.kill(signal);
    } catch (error) {
      this.logger?.warn(`could not send ${signal}: ${error.message}`);
    }
  }

  /** Stop the child and wait for it to exit (SIGTERM, then SIGKILL after a grace period). */
  stop() {
    if (!this.child) {
      if (this.state !== 'stopped') this.setState('stopped', { url: null });
      return Promise.resolve();
    }
    const child = this.child;
    this.stopRequested = true;
    this.setState('stopping', { url: null });

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.logger?.warn('backend did not exit after SIGTERM; sending SIGKILL');
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        setTimeout(finish, 1000);
      }, STOP_GRACE_MS);
      if (typeof timer.unref === 'function') timer.unref();

      child.once('exit', finish);
      try {
        child.kill('SIGTERM');
      } catch {
        finish();
      }
    });
  }

  async restart() {
    await this.stop();
    this.setState('idle');
    return this.start();
  }
}

module.exports = { Backend, redact, redactLine };
