/**
 * @fileoverview Per-host backoff for remote (ssh) pane captures (COD-463).
 *
 * Every tab switch to a remote session captures the pane over a fresh or pooled
 * ssh connection. When a host is degraded (observed: wedged systemd/dbus on the
 * remote made every NEW ssh session take ~136s to open while established ones
 * kept working), each capture used to sit out the whole REMOTE_CAPTURE_TIMEOUT_MS
 * before falling back to the local wrapper capture, so every switch blocked ~10s.
 *
 * After a TRANSPORT failure (ssh killed by the timeout, or exit 255) the host is
 * marked degraded. While degraded, `run()` does not block on ssh: it starts at
 * most one probe at a time (no more often than `probeIntervalMs`), waits for it
 * only `probeWaitMs`, and otherwise returns `null` so the caller serves its local
 * fallback immediately. A probe that later succeeds, or fails with a
 * non-transport error (the host answered; tmux did not), clears the state.
 *
 * Pure apart from the injected clock/timer, so it is unit-tested directly.
 */

export const REMOTE_CAPTURE_PROBE_INTERVAL_MS = 15_000;
export const REMOTE_CAPTURE_PROBE_WAIT_MS = 1_500;

/** ssh exits 255 for its own failures; `killed` is the execFile timeout. */
export function isSshTransportFailure(error: unknown): boolean {
  const failure = error as { code?: unknown; killed?: unknown } | null;
  return failure?.killed === true || failure?.code === 255;
}

interface HostState {
  since: number;
  nextProbeAt: number;
  probe: Promise<unknown> | null;
}

export interface RemoteCaptureBackoffOptions {
  now?: () => number;
  probeIntervalMs?: number;
  probeWaitMs?: number;
  /** Resolves after `ms`; injectable so tests need no real timers. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export class RemoteCaptureBackoff {
  private readonly hosts = new Map<string, HostState>();
  private readonly now: () => number;
  private readonly probeIntervalMs: number;
  private readonly probeWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: RemoteCaptureBackoffOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.probeIntervalMs = opts.probeIntervalMs ?? REMOTE_CAPTURE_PROBE_INTERVAL_MS;
    this.probeWaitMs = opts.probeWaitMs ?? REMOTE_CAPTURE_PROBE_WAIT_MS;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  isDegraded(key: string): boolean {
    return this.hosts.has(key);
  }

  /** Epoch ms the host was first marked degraded, or null when healthy. */
  degradedSince(key: string): number | null {
    return this.hosts.get(key)?.since ?? null;
  }

  /**
   * Run a capture through the backoff. Healthy host: runs normally; a transport
   * failure marks the host and is rethrown. Degraded host: returns null without
   * blocking on ssh (see the module comment), or the probe's result if it lands
   * within `probeWaitMs`.
   */
  async run<T>(key: string, capture: () => Promise<T>): Promise<T | null> {
    const state = this.hosts.get(key);
    if (!state) {
      try {
        return await capture();
      } catch (error) {
        if (isSshTransportFailure(error)) this.markDegraded(key);
        throw error;
      }
    }
    if (state.probe || this.now() < state.nextProbeAt) return null;

    const probe = capture().then(
      (value) => {
        this.hosts.delete(key);
        return { ok: true as const, value };
      },
      (error: unknown) => {
        if (isSshTransportFailure(error)) {
          state.nextProbeAt = this.now() + this.probeIntervalMs;
        } else {
          this.hosts.delete(key);
        }
        return { ok: false as const };
      }
    );
    state.probe = probe;
    void probe.finally(() => {
      if (state.probe === probe) state.probe = null;
    });

    const outcome = await Promise.race([probe, this.sleep(this.probeWaitMs).then(() => null)]);
    return outcome && outcome.ok ? outcome.value : null;
  }

  private markDegraded(key: string): void {
    if (this.hosts.has(key)) return;
    const now = this.now();
    this.hosts.set(key, { since: now, nextProbeAt: now + this.probeIntervalMs, probe: null });
  }

  clear(): void {
    this.hosts.clear();
  }
}
