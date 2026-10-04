/**
 * Probe user-selected paths without letting a stalled network mount block the
 * web event loop. A hard NFS mount can leave an async stat pending indefinitely,
 * so keep at most two probes in the shared libuv filesystem pool.
 */
import fs from 'node:fs/promises';

const PROBE_TIMEOUT_MS = 1_500;
const MAX_PENDING_PROBES = 2;
const pending = new Map<string, Promise<boolean>>();
const timedOut = new Set<string>();

export async function boundedPathExists(path: string): Promise<boolean> {
  if (timedOut.has(path)) return false;

  let probe = pending.get(path);
  if (!probe) {
    if (pending.size >= MAX_PENDING_PROBES) return false;
    probe = fs.stat(path).then(
      () => true,
      () => false
    );
    pending.set(path, probe);
    void probe.finally(() => {
      pending.delete(path);
      timedOut.delete(path);
    });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          timedOut.add(path);
          resolve(false);
        }, PROBE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
