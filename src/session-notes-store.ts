/** @fileoverview Durable owner-scoped Markdown notebooks with revision conflicts and recoverable filesystem transactions. */

import { randomUUID } from 'node:crypto';
import { chmod, link, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { dataPath } from './config/instance.js';
import {
  SessionNotesFilesystem,
  safeNotesId as safeId,
  isNotesMissing as isMissing,
} from './session-notes-filesystem.js';
import { noteRevision, parseSessionNote, serializeSessionNote } from './session-notes-markdown.js';
import type {
  SessionNote,
  SessionNoteCreate,
  SessionNoteEntry,
  SessionNotesRecoveryIssue,
} from './types/session-notes.js';

export class SessionNotesNotFoundError extends Error {}
export class SessionNotesMalformedError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
    public readonly revision: string
  ) {
    super(message);
  }
}
export class SessionNotesConflictError extends Error {
  constructor(
    message: string,
    public readonly current: SessionNote | SessionNotesMalformedError | null
  ) {
    super(message);
  }
}
interface Journal {
  source: string;
  target: string;
  backup: string;
  staged: string;
  revision: string;
  originalRevision: string;
}
interface RecoveryConflict {
  path: string;
  journal: Journal;
  message: string;
}
type RecoveryConflicts = Map<string, RecoveryConflict> & { issues: SessionNotesRecoveryIssue[] };
interface StoreOptions {
  checkpoint?: (stage: 'journal-ready' | 'prepared' | 'displaced' | 'installed') => void | Promise<void>;
}
/** Canonical files are refreshed on every operation. No session lifecycle state is consulted. */
export class SessionNotesStore extends SessionNotesFilesystem {
  constructor(
    root = dataPath('notes'),
    private readonly options: StoreOptions = {}
  ) {
    super(root);
  }

  create(owner: string, input: SessionNoteCreate): SessionNote {
    safeId(owner);
    safeId(input.projectId);
    const id = safeId(input.id ?? randomUUID());
    const now = Date.now();
    return {
      metadata: { ...input, id, ownerKey: owner, version: 1, createdAt: now, updatedAt: now },
      markdown: '',
      revision: '',
    };
  }

  async read(owner: string, projectId: string, id: string): Promise<SessionNote> {
    return this.locked(owner, async (conflicts) => {
      const path = this.notePath(owner, projectId, id);
      await this.requireResolved(owner, path, conflicts);
      return this.readAt(owner, path);
    });
  }

  async export(owner: string, projectId: string, id: string): Promise<string> {
    return (await this.read(owner, projectId, id)).markdown;
  }

  async list(owner: string, projectId?: string): Promise<SessionNoteEntry[]> {
    return this.locked(owner, async (conflicts) => {
      const projects = join(this.ownerPath(owner), 'projects');
      await this.guard(projects, true);
      let ids: string[];
      try {
        ids = projectId ? [safeId(projectId)] : await readdir(projects);
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
      const result: SessionNoteEntry[] = [];
      for (const project of ids) {
        safeId(project);
        const directory = join(projects, project);
        await this.guard(directory, true);
        let files: string[];
        try {
          files = await readdir(directory);
        } catch (error) {
          if (isMissing(error)) continue;
          throw error;
        }
        for (const file of files.filter((file) => file.endsWith('.md'))) {
          const id = safeId(file.slice(0, -3));
          try {
            result.push({
              id,
              projectId: project,
              note: await this.readAt(owner, this.notePath(owner, project, id)),
              repairable: false,
            });
          } catch (error) {
            if (!(error instanceof SessionNotesMalformedError)) throw error;
            result.push({ id, projectId: project, repairable: true, raw: error.raw, error: error.message });
          }
        }
      }
      for (const [path, conflict] of conflicts) {
        const id = basename(path, '.md');
        const project = basename(dirname(path));
        if (projectId && project !== projectId) continue;
        const entry = result.find((entry) => entry.id === id && entry.projectId === project);
        if (entry) entry.conflict = conflict.message;
        else result.push({ id, projectId: project, repairable: true, conflict: conflict.message });
      }
      return result;
    });
  }

  async save(
    owner: string,
    note: SessionNote,
    markdown: string,
    update: { title?: string } = {}
  ): Promise<SessionNote | null> {
    this.authorize(owner, note);
    if (!note.revision && !markdown.trim()) return null;
    return this.locked(owner, async (conflicts) => {
      const source = this.notePath(owner, note.metadata.projectId, note.metadata.id);
      await this.requireResolved(owner, source, conflicts);
      await this.checkRevision(owner, source, note.revision);
      const loaded = note.revision ? await this.readAt(owner, source) : note;
      const metadata = { ...loaded.metadata, title: update.title ?? loaded.metadata.title, updatedAt: Date.now() };
      const bytes = serializeSessionNote(metadata, markdown);
      parseSessionNote(bytes);
      await this.replace(owner, source, source, bytes, note.revision);
      return parseSessionNote(bytes);
    });
  }

  async reassign(owner: string, note: SessionNote, projectId: string): Promise<SessionNote> {
    this.authorize(owner, note);
    safeId(projectId);
    return this.locked(owner, async (conflicts) => {
      const source = this.notePath(owner, note.metadata.projectId, note.metadata.id);
      await this.requireResolved(owner, source, conflicts);
      await this.checkRevision(owner, source, note.revision);
      if (projectId === note.metadata.projectId) return this.readAt(owner, source);
      const target = this.notePath(owner, projectId, note.metadata.id);
      await this.requireResolved(owner, target, conflicts);
      await this.checkRevision(owner, target, '');
      const loaded = await this.readAt(owner, source);
      const bytes = serializeSessionNote({ ...loaded.metadata, projectId, updatedAt: Date.now() }, loaded.markdown);
      await this.replace(owner, source, target, bytes, note.revision);
      return parseSessionNote(bytes);
    });
  }

  /** Report preserved malformed/unpublished journals separately from canonical notebooks. */
  async listRecoveryIssues(owner: string): Promise<SessionNotesRecoveryIssue[]> {
    return this.locked(owner, async (conflicts) => conflicts.issues);
  }

  /** Explicitly choose a retained candidate, with the current full-byte revision checked first. */
  async resolveRecovery(
    owner: string,
    projectId: string,
    id: string,
    revision: string,
    choice: 'external' | 'staged'
  ): Promise<void> {
    return this.locked(owner, async (conflicts) => {
      const path = this.notePath(owner, projectId, id);
      const conflict = conflicts.get(path);
      if (!conflict) throw new Error('No recovery conflict for this note');
      if (choice === 'external' && !(await this.current(owner, path))) {
        throw new SessionNotesNotFoundError('External recovery candidate not found');
      }
      await this.checkRevision(owner, path, revision);
      const { journal } = conflict;
      const kept = choice === 'staged' ? journal.target : path;
      if (choice === 'staged') {
        const staged = await this.bytes(journal.staged);
        const parsed = parseSessionNote(staged);
        this.authorize(owner, parsed);
        if (this.notePath(owner, parsed.metadata.projectId, parsed.metadata.id) !== journal.target)
          throw new Error('Invalid staged identity');
        if (path !== journal.target) throw new Error('Resolve staged move at its target using that target revision');
        await this.replace(owner, path, path, staged, revision);
      }
      for (const displaced of new Set([journal.source, journal.target])) {
        if (displaced === kept) continue;
        try {
          await this.guard(displaced);
          await rename(displaced, join(dirname(journal.backup), `${randomUUID()}.md`));
          await this.syncDirectory(dirname(displaced));
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      await rename(conflict.path, conflict.path + '.resolved');
      await this.syncDirectory(dirname(conflict.path));
    });
  }

  private async requireResolved(owner: string, path: string, conflicts: RecoveryConflicts): Promise<void> {
    const conflict = conflicts.get(path);
    if (conflict) throw new SessionNotesConflictError(conflict.message, await this.current(owner, path));
  }

  private authorize(owner: string, note: SessionNote): void {
    safeId(owner);
    safeId(note.metadata.projectId);
    safeId(note.metadata.id);
    if (note.metadata.ownerKey !== owner) throw new Error('Note owner mismatch');
  }

  private notePath(owner: string, project: string, id: string): string {
    return join(this.ownerPath(owner), 'projects', safeId(project), `${safeId(id)}.md`);
  }

  private async readAt(owner: string, path: string): Promise<SessionNote> {
    let bytes: Buffer;
    try {
      bytes = await this.bytes(path);
    } catch (error) {
      if (isMissing(error)) throw new SessionNotesNotFoundError('Note not found');
      throw error;
    }
    try {
      const note = parseSessionNote(bytes);
      this.authorize(owner, note);
      if (this.notePath(owner, note.metadata.projectId, note.metadata.id) !== path)
        throw new Error('Metadata path mismatch');
      return note;
    } catch (error) {
      throw new SessionNotesMalformedError((error as Error).message, bytes.toString('utf8'), noteRevision(bytes));
    }
  }
  private async current(owner: string, path: string): Promise<SessionNote | SessionNotesMalformedError | null> {
    try {
      return await this.readAt(owner, path);
    } catch (error) {
      if (error instanceof SessionNotesNotFoundError) return null;
      if (error instanceof SessionNotesMalformedError) return error;
      throw error;
    }
  }
  private async checkRevision(owner: string, path: string, expected: string): Promise<void> {
    const current = await this.current(owner, path);
    if ((current?.revision ?? '') !== expected) throw new SessionNotesConflictError('Note changed on disk', current);
  }

  /** A published .json is always complete; a failed write remains an unpublished repair artifact. */
  private async writeJournal(path: string, bytes: Buffer): Promise<void> {
    const temporary = path.replace(/\.json$/, '.journal-tmp');
    await this.writePrivate(temporary, bytes);
    await this.syncDirectory(dirname(path));
    await this.options.checkpoint?.('journal-ready');
    await this.guard(path, true);
    await link(temporary, path);
    await this.syncDirectory(dirname(path));
    await unlink(temporary);
    await this.syncDirectory(dirname(path));
  }

  private async replace(
    owner: string,
    source: string,
    target: string,
    bytes: Buffer,
    originalRevision: string
  ): Promise<void> {
    const history = join(this.ownerPath(owner), '.history');
    await this.directory(history);
    await this.directory(dirname(target));
    const transaction = randomUUID();
    const journal: Journal = {
      source,
      target,
      backup: join(history, `${transaction}.md`),
      staged: join(history, `${transaction}.staged`),
      revision: noteRevision(bytes),
      originalRevision,
    };
    const journalPath = join(history, `${transaction}.json`);
    await this.writePrivate(journal.staged, bytes);
    await this.writeJournal(journalPath, Buffer.from(JSON.stringify(journal)));
    await this.syncDirectory(history);
    await this.options.checkpoint?.('prepared');
    if (originalRevision) {
      await this.guard(source);
      await rename(source, journal.backup);
      await this.guard(journal.backup);
      await chmod(journal.backup, 0o600);
      await this.syncDirectory(dirname(source));
      await this.syncDirectory(history);
      // This is the ACTUAL displaced version, even if an external writer raced the preceding revision check.
      if (noteRevision(await this.bytes(journal.backup)) !== originalRevision) {
        try {
          await this.publish(journal.backup, source);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        await unlink(journalPath);
        throw new SessionNotesConflictError(
          'External edit raced replacement; displaced bytes retained in history',
          await this.current(owner, source)
        );
      }
    }
    await this.options.checkpoint?.('displaced');
    await this.finish(owner, journalPath, journal);
    await this.options.checkpoint?.('installed');
  }
  private async finish(owner: string, path: string, journal: Journal): Promise<void> {
    for (const candidate of [journal.source, journal.target, journal.backup, journal.staged]) {
      if (
        typeof candidate !== 'string' ||
        resolve(candidate) !== candidate ||
        !candidate.startsWith(this.ownerPath(owner) + sep)
      )
        throw new Error('Invalid recovery journal path');
      await this.guard(candidate, true);
    }
    const stagedBytes = await this.bytes(journal.staged);
    const stagedNote = parseSessionNote(stagedBytes);
    this.authorize(owner, stagedNote);
    if (
      this.notePath(owner, stagedNote.metadata.projectId, stagedNote.metadata.id) !== journal.target ||
      noteRevision(stagedBytes) !== journal.revision
    ) {
      throw new Error('Invalid recovery journal content');
    }
    if (
      dirname(journal.backup) !== join(this.ownerPath(owner), '.history') ||
      dirname(journal.staged) !== dirname(journal.backup)
    )
      throw new Error('Invalid recovery history path');
    const sourceProject = basename(dirname(journal.source));
    const sourceId = basename(journal.source, '.md');
    if (this.notePath(owner, sourceProject, sourceId) !== journal.source)
      throw new Error('Invalid recovery source path');
    // A prepared move may still have its original source: displace it before publishing the target.
    if (journal.originalRevision) {
      let backupExists = true;
      try {
        await this.bytes(journal.backup);
      } catch (error) {
        if (isMissing(error)) backupExists = false;
        else throw error;
      }
      if (!backupExists) {
        await this.checkRevision(owner, journal.source, journal.originalRevision);
        await rename(journal.source, journal.backup);
        await this.guard(journal.backup);
        await chmod(journal.backup, 0o600);
      }
      await this.syncDirectory(dirname(journal.source));
      await this.syncDirectory(dirname(journal.backup));
      if (noteRevision(await this.bytes(journal.backup)) !== journal.originalRevision) {
        try {
          await this.publish(journal.backup, journal.source);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        throw new SessionNotesConflictError(
          'Recovery displaced newer external bytes; all versions retained',
          await this.current(owner, journal.source)
        );
      }
      if (journal.source !== journal.target && (await this.current(owner, journal.source))) {
        throw new SessionNotesConflictError(
          'Recovery source recreated externally; all versions retained',
          await this.current(owner, journal.source)
        );
      }
    }
    try {
      await this.publish(journal.staged, journal.target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (noteRevision(await this.bytes(journal.target)) !== journal.revision)
        throw new SessionNotesConflictError(
          'Recovery target changed; all versions retained',
          await this.current(owner, journal.target)
        );
    }
    await this.syncDirectory(dirname(journal.target));
    await unlink(path);
    await this.syncDirectory(dirname(path));
    // Staged bytes are retained alongside history so a later external overwrite remains recoverable.
  }
  private async recover(owner: string): Promise<RecoveryConflicts> {
    const conflicts: RecoveryConflicts = Object.assign(new Map<string, RecoveryConflict>(), {
      issues: [] as SessionNotesRecoveryIssue[],
    });
    const history = join(this.ownerPath(owner), '.history');
    await this.guard(history, true);
    let files: string[];
    try {
      files = await readdir(history);
    } catch (error) {
      if (isMissing(error)) return conflicts;
      throw error;
    }
    for (const file of files.filter((file) => /^[a-f0-9-]+\.json$/.test(file)).sort()) {
      const path = join(history, file);
      let journal: Journal | undefined;
      try {
        journal = JSON.parse((await this.bytes(path)).toString('utf8')) as Journal;
        await this.finish(owner, path, journal);
      } catch (error) {
        if (error instanceof SessionNotesConflictError && journal) {
          const conflict = { path, journal, message: error.message };
          conflicts.set(journal.source, conflict);
          conflicts.set(journal.target, conflict);
        } else {
          // Preserve the actual artifact and every staged/displaced file; unknown intent cannot be replayed safely.
          const quarantined = `${path}.${randomUUID()}.quarantined`;
          await this.guard(quarantined, true);
          await rename(path, quarantined);
          await this.syncDirectory(history);
          const bytes = await this.bytes(quarantined);
          conflicts.issues.push({
            path: quarantined,
            raw: bytes.toString('utf8'),
            revision: noteRevision(bytes),
            error: (error as Error).message,
          });
        }
      }
    }
    for (const file of files.filter((file) =>
      /^[a-f0-9-]+(?:\.journal-tmp|\.json\.[a-f0-9-]+\.quarantined)$/.test(file)
    )) {
      const path = join(history, file);
      const bytes = await this.bytes(path);
      conflicts.issues.push({
        path,
        raw: bytes.toString('utf8'),
        revision: noteRevision(bytes),
        error: file.endsWith('.journal-tmp')
          ? 'Unpublished or retained journal artifact requires inspection'
          : 'Quarantined recovery metadata requires repair',
      });
    }
    return conflicts;
  }

  private async publish(snapshot: string, target: string): Promise<void> {
    const temporary = join(dirname(snapshot), `${randomUUID()}.install`);
    await this.writePrivate(temporary, await this.bytes(snapshot));
    try {
      await this.guard(target, true);
      await link(temporary, target);
    } finally {
      await unlink(temporary);
    }
  }

  private async locked<T>(owner: string, operation: (conflicts: RecoveryConflicts) => Promise<T>): Promise<T> {
    return this.withOwnerLock(owner, async () => operation(await this.recover(owner)));
  }
}
