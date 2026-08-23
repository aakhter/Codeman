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
  #ownedProcessTrees = new Map();
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

  registerOwnedProcessTree(resource) {
    this.#assertOpen();
    const identities = resource?.processIdentities;
    if (
      !Number.isSafeInteger(resource?.rootPid) ||
      resource.rootPid < 1 ||
      !Number.isSafeInteger(resource?.listenerPid) ||
      resource.listenerPid < 1 ||
      !Number.isSafeInteger(resource?.port) ||
      resource.port < 1 ||
      resource.port > 65_535 ||
      !Array.isArray(identities) ||
      identities.length === 0 ||
      typeof resource?.terminate !== 'function' ||
      typeof resource?.verify !== 'function'
    ) {
      throw new Error('owned process tree requires exact root/listener PIDs, port, identities, terminate, and verify');
    }
    const pids = new Set();
    for (const identity of identities) {
      const validStartTime =
        (typeof identity?.startTimeTicks === 'string' && /^\d+$/.test(identity.startTimeTicks)) ||
        typeof identity?.startTimeTicks === 'bigint' ||
        (Number.isSafeInteger(identity?.startTimeTicks) && identity.startTimeTicks >= 0);
      if (
        !Number.isSafeInteger(identity?.pid) ||
        identity.pid < 1 ||
        !Number.isSafeInteger(identity?.parentPid) ||
        identity.parentPid < 0 ||
        !Number.isSafeInteger(identity?.depth) ||
        identity.depth < 0 ||
        !validStartTime ||
        pids.has(identity.pid)
      ) {
        throw new Error('owned process tree identities must be exact and unique');
      }
      pids.add(identity.pid);
    }
    if (!pids.has(resource.rootPid) || !pids.has(resource.listenerPid)) {
      throw new Error('owned process tree identities must include the exact root and listener PIDs');
    }
    if (this.#ownedProcessTrees.has(resource.rootPid)) {
      throw new Error('owned process tree root PID is already registered');
    }
    this.#ownedProcessTrees.set(resource.rootPid, resource);
    return resource;
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
      ownedProcessTrees: [...this.#ownedProcessTrees.values()].map((resource) => ({
        rootPid: resource.rootPid,
        listenerPid: resource.listenerPid,
        port: resource.port,
        processPids: resource.processIdentities.map(({ pid }) => pid),
        termSignal: null,
        killSignal: null,
        exactPidsStillAlive: resource.processIdentities.map(({ pid }) => pid),
        listenerPidsStillBound: [resource.listenerPid],
        portClosed: false,
      })),
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

    const ownedEvidence = new Map(evidence.ownedProcessTrees.map((entry) => [entry.rootPid, entry]));
    await Promise.all(
      [...this.#ownedProcessTrees].map(([rootPid, resource]) =>
        attempt(`owned descendants of PID ${rootPid} SIGTERM`, async () => {
          const result = await resource.terminate('SIGTERM');
          ownedEvidence.get(rootPid).termSignal = result;
        })
      )
    );

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
    for (const [rootPid, resource] of this.#ownedProcessTrees) {
      let verification = await attempt(`owned process tree PID ${rootPid} verification`, () => resource.verify());
      if (
        verification &&
        (verification.exactPidsStillAlive.length > 0 ||
          verification.listenerPidsStillBound.length > 0 ||
          verification.portClosed !== true)
      ) {
        const result = await attempt(`owned descendants of PID ${rootPid} SIGKILL`, () =>
          resource.terminate('SIGKILL')
        );
        ownedEvidence.get(rootPid).killSignal = result;
        verification = await attempt(`owned process tree PID ${rootPid} final verification`, () => resource.verify());
      }
      if (!verification) continue;
      Object.assign(ownedEvidence.get(rootPid), verification);
      if (
        verification.exactPidsStillAlive.length > 0 ||
        verification.listenerPidsStillBound.length > 0 ||
        verification.portClosed !== true
      ) {
        evidence.errors.push(
          `owned process tree PID ${rootPid} was not fully released: live=${verification.exactPidsStillAlive.join(',') || 'none'} listeners=${verification.listenerPidsStillBound.join(',') || 'none'} portClosed=${verification.portClosed}`
        );
      }
    }
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

function ownedProcessTreeReleased(verification) {
  return (
    verification &&
    verification.exactPidsStillAlive.length === 0 &&
    verification.listenerPidsStillBound.length === 0 &&
    verification.portClosed === true
  );
}

export async function registerOwnedProcessTreeOrCleanup({ registry, resource, finishRootCleanup }) {
  try {
    return registry.registerOwnedProcessTree(resource);
  } catch (registrationError) {
    const cleanupErrors = [];
    await resource.terminate('SIGTERM').catch((error) => cleanupErrors.push(error));
    await finishRootCleanup().catch((error) => cleanupErrors.push(error));
    let verification = await resource.verify().catch((error) => {
      cleanupErrors.push(error);
      return null;
    });
    if (verification && !ownedProcessTreeReleased(verification)) {
      await resource.terminate('SIGKILL').catch((error) => cleanupErrors.push(error));
      verification = await resource.verify().catch((error) => {
        cleanupErrors.push(error);
        return null;
      });
    }
    if (cleanupErrors.length > 0 || !ownedProcessTreeReleased(verification)) {
      throw new AggregateError(
        [registrationError, ...cleanupErrors],
        'owned server cleanup failed after resource registration race'
      );
    }
    throw registrationError;
  }
}

export async function withCleanup(registry, operation) {
  try {
    return await operation();
  } finally {
    await registry.cleanup();
  }
}
