export interface WorkingFramePollRegistration {
  key: string;
  capture: () => Promise<string | null>;
  onFrame: (frame: string | null) => void;
  /** Test/one-shot scheduling override. Production registrations use stable ID staggering. */
  initialDelayMs?: number;
}

export interface WorkingFramePollCoordinatorOptions {
  intervalMs?: number;
  maxConcurrency?: number;
  maxBackoffMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface Entry extends WorkingFramePollRegistration {
  token: number;
  sequence: number;
  dueAt: number;
  failures: number;
  requests: Array<(frame: string | null) => void>;
}

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

function stableOffset(key: string, intervalMs: number): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % intervalMs;
}

/**
 * Process-wide scheduler for bounded, staggered activity-frame captures.
 * Registrations are generation-fenced: replacing or removing a key makes an
 * already-running completion stale without rejecting or invoking callbacks.
 */
export class WorkingFramePollCoordinator {
  private readonly intervalMs: number;
  private readonly maxConcurrency: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly entries = new Map<string, Entry>();
  private readonly activeKeys = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeCount = 0;
  private maximumActiveCount = 0;
  private captureFailures = 0;
  private nextToken = 1;
  private nextSequence = 1;

  constructor(options: WorkingFramePollCoordinatorOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  register(registration: WorkingFramePollRegistration): () => void {
    this.resolveRequests(this.entries.get(registration.key), null);
    const token = this.nextToken++;
    const entry: Entry = {
      ...registration,
      token,
      sequence: this.nextSequence++,
      dueAt:
        this.now() +
        (registration.initialDelayMs ?? this.intervalMs + stableOffset(registration.key, Math.max(1, this.intervalMs))),
      failures: 0,
      requests: [],
    };
    this.entries.set(registration.key, entry);
    this.schedule();
    return () => {
      if (this.entries.get(registration.key)?.token !== token) return;
      this.resolveRequests(entry, null);
      this.entries.delete(registration.key);
      this.schedule();
    };
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  getStats(): {
    registrations: number;
    activeCaptures: number;
    maximumActiveCaptures: number;
    captureFailures: number;
  } {
    return {
      registrations: this.entries.size,
      activeCaptures: this.activeCount,
      maximumActiveCaptures: this.maximumActiveCount,
      captureFailures: this.captureFailures,
    };
  }

  /** Queue a fresh capture through the same global cap, sharing an active capture for this key. */
  captureNow(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve(null);
    const promise = new Promise<string | null>((resolve) => entry.requests.push(resolve));
    if (!this.activeKeys.has(key)) entry.dueAt = Math.min(entry.dueAt, this.now());
    this.schedule();
    return promise;
  }

  private schedule(): void {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.entries.size === 0 || this.activeCount >= this.maxConcurrency) return;

    const eligible = [...this.entries.values()].filter((entry) => !this.activeKeys.has(entry.key));
    if (eligible.length === 0) return;
    const nearest = Math.min(...eligible.map((entry) => entry.dueAt));
    this.timer = this.setTimer(
      () => {
        this.timer = null;
        this.pump();
      },
      Math.max(0, nearest - this.now())
    );
    this.timer.unref?.();
  }

  private pump(): void {
    const now = this.now();
    const due = [...this.entries.values()]
      .filter((entry) => !this.activeKeys.has(entry.key) && entry.dueAt <= now)
      .sort((left, right) => left.dueAt - right.dueAt || left.sequence - right.sequence);

    while (this.activeCount < this.maxConcurrency && due.length > 0) {
      this.start(due.shift()!);
    }
    this.schedule();
  }

  private start(entry: Entry): void {
    this.activeCount += 1;
    this.maximumActiveCount = Math.max(this.maximumActiveCount, this.activeCount);
    this.activeKeys.add(entry.key);
    const { key, token } = entry;

    Promise.resolve()
      .then(entry.capture)
      .then((frame) => {
        if (this.entries.get(key)?.token !== token) return;
        if (frame === null) {
          entry.failures += 1;
          this.captureFailures += 1;
        } else {
          entry.failures = 0;
        }
        this.resolveRequests(entry, frame);
        try {
          entry.onFrame(frame);
        } catch {
          // Activity observation must never create an unhandled rejection.
        }
      })
      .catch(() => {
        if (this.entries.get(key)?.token === token) {
          entry.failures += 1;
          this.captureFailures += 1;
          this.resolveRequests(entry, null);
        }
      })
      .finally(() => {
        this.activeCount -= 1;
        this.activeKeys.delete(key);
        if (this.entries.get(key)?.token === token) {
          const delay =
            entry.failures === 0 ? this.intervalMs : Math.min(this.maxBackoffMs, this.intervalMs * 2 ** entry.failures);
          entry.dueAt = this.now() + delay;
          entry.sequence = this.nextSequence++;
        }
        this.pump();
      });
  }

  private resolveRequests(entry: Entry | undefined, frame: string | null): void {
    if (!entry) return;
    for (const resolve of entry.requests.splice(0)) resolve(frame);
  }
}

export const workingFramePollCoordinator = new WorkingFramePollCoordinator();
