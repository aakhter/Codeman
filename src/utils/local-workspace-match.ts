import { realpathSync } from 'node:fs';

/** Exact spelling or a proven filesystem alias; never guesses from folder names. */
export function localWorkspaceMatcher(workingDir: string): (candidate: unknown) => boolean {
  const canonical = (path: string): string | undefined => {
    try {
      return realpathSync.native(path);
    } catch {
      return undefined;
    }
  };
  const original = canonical(workingDir);
  const cache = new Map<string, string | undefined>();
  return (candidate) => {
    if (typeof candidate !== 'string') return false;
    if (candidate === workingDir) return true;
    if (!original) return false;
    if (!cache.has(candidate)) cache.set(candidate, canonical(candidate));
    return cache.get(candidate) === original;
  };
}
