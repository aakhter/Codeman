/** @fileoverview Shared guarded filesystem operations and owner locks for persistent session notes metadata. */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { dataPath } from './config/instance.js';

export function safeNotesId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error('Unsafe note path identifier');
  return id;
}
export function isNotesMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

interface OwnerLease {
  root: string;
  owner: string;
  active: boolean;
}
const ownerLease = new AsyncLocalStorage<OwnerLease>();
/** Background callbacks must acquire their own lease, even when registered inside a transaction. */
export function outsideNotesTransaction<T>(operation: () => T): T {
  return ownerLease.exit(operation);
}

export class SessionNotesFilesystem {
  protected root: string;
  private initialization?: Promise<void>;
  constructor(root = dataPath('notes')) {
    this.root = resolve(root);
  }
  protected ownerPath(owner: string): string {
    return join(this.root, safeNotesId(owner));
  }
  /** Refuse symlinks in every existing component, including the configured root's ancestors. */
  protected async guard(path: string, missing = false): Promise<void> {
    const absolute = resolve(path);
    if (absolute !== this.root && !absolute.startsWith(this.root + sep)) throw new Error('Note path escapes root');
    const parts = absolute.split(sep).filter(Boolean);
    let current: string = sep;
    for (const part of parts) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlink note paths are forbidden');
      } catch (error) {
        if (missing && isNotesMissing(error)) return;
        throw error;
      }
    }
    try {
      if ((await realpath(absolute)) !== absolute) throw new Error('Noncanonical note path');
    } catch (error) {
      if (missing && isNotesMissing(error)) return;
      throw error;
    }
  }
  protected async directory(path: string): Promise<void> {
    await this.guard(path, true);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await this.guard(path);
    // Only modify directories inside this store, never its configured ancestors.
    let current = path;
    while (current === this.root || current.startsWith(this.root + sep)) {
      await chmod(current, 0o700);
      if (current === this.root) break;
      current = dirname(current);
    }
  }
  protected async bytes(path: string): Promise<Buffer> {
    await this.guard(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Note is not a regular file');
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }
  protected async writePrivate(path: string, bytes: Buffer): Promise<void> {
    await this.guard(path, true);
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  protected async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  protected async canonicalizeRoot(): Promise<void> {
    const suffix: string[] = [];
    let existing = this.root;
    for (;;) {
      try {
        this.root = join(await realpath(existing), ...suffix);
        return;
      } catch (error) {
        if (!isNotesMissing(error)) throw error;
        suffix.unshift(basename(existing));
        existing = dirname(existing);
      }
    }
  }
  /** Remove only this observed owner's marker. A replacement live directory is nonempty and survives rmdir. */
  protected async releaseLock(lock: string, marker: string): Promise<void> {
    await this.guard(lock, true);
    try {
      await unlink(join(lock, marker));
    } catch (error) {
      if (!isNotesMissing(error)) throw error;
    }
    try {
      await rmdir(lock);
    } catch (error) {
      if (!isNotesMissing(error) && !['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error;
    }
  }
  protected async withOwnerLock<T>(owner: string, operation: () => Promise<T>): Promise<T> {
    await (this.initialization ??= this.canonicalizeRoot());
    const lease = ownerLease.getStore();
    if (lease?.active && lease.root === this.root && lease.owner === owner) return operation();
    const directory = this.ownerPath(owner);
    await this.directory(directory);
    const lock = join(directory, '.lock');
    const deadline = Date.now() + 5000;
    const token = randomUUID();
    const marker = `${token}.owner`;
    const candidate = join(directory, `${token}.lock-candidate`);
    await this.directory(candidate);
    await this.writePrivate(join(candidate, marker), Buffer.from(String(process.pid)));
    await this.syncDirectory(candidate);
    let acquired = false;
    const held: OwnerLease = { root: this.root, owner, active: false };
    try {
      while (!acquired) {
        if (Date.now() >= deadline) throw new Error('Session notes store is locked');
        await this.guard(lock, true);
        try {
          // Rename publishes a complete nonempty directory and cannot replace another live nonempty directory.
          await rename(candidate, lock);
          acquired = true;
          await this.syncDirectory(directory);
        } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          let markers: string[];
          try {
            await this.guard(lock);
            if (!(await lstat(lock)).isDirectory()) throw new Error('Malformed notes lock requires manual repair');
            markers = await readdir(lock);
          } catch (error) {
            if (isNotesMissing(error)) continue;
            throw error;
          }
          if (markers.length === 0) continue; // An empty abandoned directory can be replaced atomically.
          if (markers.length !== 1 || !/^[a-f0-9-]{36}\.owner$/.test(markers[0]))
            throw new Error('Ambiguous notes lock requires manual repair');
          let pid: number;
          try {
            pid = Number((await this.bytes(join(lock, markers[0]))).toString('utf8'));
          } catch (error) {
            if (isNotesMissing(error)) continue;
            throw error;
          }
          if (Number.isInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
                await this.releaseLock(lock, markers[0]);
                continue;
              }
            }
          }
          if (Date.now() >= deadline) throw new Error('Session notes store is locked');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      held.active = true;
      return await ownerLease.run(held, operation);
    } finally {
      held.active = false;
      if (acquired) {
        await this.releaseLock(lock, marker);
        await this.syncDirectory(directory);
      }
      // Private candidate directories never become visible until complete. Clean only this attempt's unique marker.
      await this.releaseLock(candidate, marker);
    }
  }
}
