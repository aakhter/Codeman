import { rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export function validateDisposableTmuxSocket({ socketName, socketPath, runNonce, allowedSocketDirectory }) {
  const expectedName = `cod356-benchmark-${runNonce}`;
  if (!/^[a-zA-Z0-9_.-]+$/.test(socketName) || socketName !== expectedName) {
    throw new Error('tmux cleanup requires the exact disposable tmux socket name for this run');
  }
  if (!isAbsolute(socketPath) || resolve(dirname(socketPath)) !== resolve(allowedSocketDirectory)) {
    throw new Error('tmux socket path is outside the exact allowed socket directory');
  }
  if (basename(socketPath) !== socketName || socketPath !== join(allowedSocketDirectory, socketName)) {
    throw new Error('tmux socket path does not match the exact disposable socket name');
  }
  return true;
}

function timeoutAfter(milliseconds, label) {
  return new Promise((_, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} exceeded cleanup deadline`)), milliseconds);
    timeout.unref?.();
  });
}

export class CleanupRegistry {
  #children = new Map();
  #tempRoots = new Set();
  #browsers = new Set();
  #sessions = new Map();
  #tmuxSocket = null;
  #cleanupPromise;
  #state = 'open';

  constructor({ cleanupTimeoutMs = 15_000 } = {}) {
    if (!Number.isFinite(cleanupTimeoutMs) || cleanupTimeoutMs <= 0)
      throw new Error('cleanup timeout must be positive');
    this.cleanupTimeoutMs = cleanupTimeoutMs;
  }

  #assertOpen() {
    if (this.#state !== 'open') throw new Error('cleanup has started; resource registration is closed');
  }

  registerChild(child) {
    this.#assertOpen();
    if (!Number.isSafeInteger(child?.pid) || child.pid < 1 || typeof child.kill !== 'function') {
      throw new Error('registered child must expose an exact PID and kill method');
    }
    this.#children.set(child.pid, child);
    return child;
  }

  registerTempRoot(tempRoot) {
    this.#assertOpen();
    if (!isAbsolute(tempRoot) || !/^cod356-run-[a-zA-Z0-9_-]{6,}$/.test(basename(tempRoot))) {
      throw new Error('registered path must be the exact benchmark temp root');
    }
    this.#tempRoots.add(tempRoot);
    return tempRoot;
  }

  registerBrowser(browser) {
    this.#assertOpen();
    if (typeof browser?.close !== 'function') throw new Error('registered browser must expose close()');
    this.#browsers.add(browser);
    return browser;
  }

  registerSession(sessionId, remove) {
    this.#assertOpen();
    if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof remove !== 'function') {
      throw new Error('registered session must have an exact ID and cleanup callback');
    }
    this.#sessions.set(sessionId, remove);
    return sessionId;
  }

  registerTmuxSocket(socket) {
    this.#assertOpen();
    if (typeof socket?.name !== 'string' || !isAbsolute(socket?.path ?? '') || typeof socket?.cleanup !== 'function') {
      throw new Error('registered tmux socket must have an exact name, path, and cleanup callback');
    }
    if (this.#tmuxSocket) throw new Error('only one exact tmux socket may be registered');
    this.#tmuxSocket = socket;
    return socket;
  }

  cleanup() {
    if (!this.#cleanupPromise) {
      this.#state = 'cleaning';
      this.#cleanupPromise = this.#cleanupOnce();
    }
    return this.#cleanupPromise;
  }

  async #cleanupOnce() {
    const deadline = Date.now() + this.cleanupTimeoutMs;
    const evidence = {
      childPids: [...this.#children.keys()],
      tempRoots: [...this.#tempRoots],
      browserCount: this.#browsers.size,
      sessionIds: [...this.#sessions.keys()],
      tmuxSocket: this.#tmuxSocket ? { name: this.#tmuxSocket.name, path: this.#tmuxSocket.path } : null,
      tmuxSocketFallback: false,
      warnings: [],
      errors: [],
      clean: false,
    };
    const attempt = async (label, action, { warning = false, maximumMs } = {}) => {
      const remainingMs = Math.max(1, deadline - Date.now());
      const timeoutMs = Math.max(1, Math.min(remainingMs, maximumMs ?? remainingMs));
      try {
        return await Promise.race([Promise.resolve().then(action), timeoutAfter(timeoutMs, label)]);
      } catch (error) {
        const message = `${label}: ${error instanceof Error ? error.message : String(error)}`;
        (warning ? evidence.warnings : evidence.errors).push(message);
        return null;
      }
    };

    const sessionResults = await Promise.all(
      [...this.#sessions].map(([sessionId, remove]) =>
        attempt(`session ${sessionId}`, () => remove(sessionId), {
          warning: Boolean(this.#tmuxSocket),
          maximumMs: Math.min(2_000, this.cleanupTimeoutMs),
        })
      )
    );
    void sessionResults;

    if (this.#tmuxSocket) {
      const result = await attempt('exact tmux socket fallback', () => this.#tmuxSocket.cleanup(), {
        maximumMs: Math.min(3_000, this.cleanupTimeoutMs),
      });
      evidence.tmuxSocketFallback = true;
      if (result && (result.remainingSessions !== 0 || result.socketPresent !== false)) {
        evidence.errors.push('exact tmux socket fallback did not prove an empty removed socket');
      }
    }

    await Promise.all([
      ...[...this.#browsers].map((browser) => attempt('browser', () => browser.close())),
      ...[...this.#children].map(([pid, child]) =>
        attempt(`PID ${pid}`, async () => {
          if (child.exitCode !== null && child.exitCode !== undefined) return;
          child.kill('SIGTERM');
          if (typeof child.once !== 'function') return;
          await new Promise((resolveExit, rejectExit) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              clearTimeout(forceTimer);
              clearTimeout(failureTimer);
              resolveExit();
            };
            child.once('exit', finish);
            const forceTimer = setTimeout(
              () => {
                if (child.exitCode === null || child.exitCode === undefined) child.kill('SIGKILL');
              },
              Math.min(1_000, this.cleanupTimeoutMs / 2)
            );
            const failureTimer = setTimeout(
              () => {
                if (child.exitCode === null || child.exitCode === undefined)
                  rejectExit(new Error('child did not exit'));
                else finish();
              },
              Math.min(2_000, this.cleanupTimeoutMs)
            );
          });
        })
      ),
    ]);
    await Promise.all(
      [...this.#tempRoots].map((tempRoot) => attempt(`temp root ${tempRoot}`, () => rm(tempRoot, { recursive: true })))
    );
    evidence.clean = evidence.errors.length === 0;
    this.#state = 'closed';
    return evidence;
  }
}

export class SignalCleanupController {
  constructor({ processLike, registry, controller, signals = ['SIGINT', 'SIGTERM', 'SIGHUP'], onAbort = () => {} }) {
    this.processLike = processLike;
    this.registry = registry;
    this.controller = controller;
    this.signals = signals;
    this.onAbort = onAbort;
    this.handlers = new Map();
    this.cleanupPromise = null;
  }

  install() {
    for (const signal of this.signals) {
      const handler = () => this.abort(signal);
      this.handlers.set(signal, handler);
      this.processLike.on(signal, handler);
    }
  }

  abort(reason) {
    if (!this.controller.signal.aborted) {
      this.onAbort(reason);
      this.controller.abort(new Error(`benchmark aborted: ${reason}`));
    }
    this.cleanupPromise ??= this.registry.cleanup();
    return this.cleanupPromise;
  }

  async finish() {
    this.cleanupPromise ??= this.registry.cleanup();
    try {
      return await this.cleanupPromise;
    } finally {
      for (const [signal, handler] of this.handlers) this.processLike.removeListener(signal, handler);
      this.handlers.clear();
    }
  }
}

export async function withCleanup(registry, operation) {
  try {
    return await operation();
  } finally {
    await registry.cleanup();
  }
}
