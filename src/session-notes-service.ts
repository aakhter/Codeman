/** @fileoverview Owner-private notebook operations independent of the source session lifecycle. */
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { dataPath } from './config/instance.js';
import { SessionNotesBindings } from './session-notes-bindings.js';
import { safeNotesId } from './session-notes-filesystem.js';
import {
  checklistItems,
  filterSessionNotes,
  setChecklistItem,
  type SessionNotesFilter,
} from './session-notes-index.js';
import { SessionNotesProjects, type SessionNotesProjectSession } from './session-notes-projects.js';
import { SessionNotesConflictError, SessionNotesNotFoundError, SessionNotesStore } from './session-notes-store.js';
import type { CaseInfo } from './types/api.js';
import type { SessionNote, SessionNoteEntry } from './types/session-notes.js';

export interface SessionNotesSource extends SessionNotesProjectSession {
  name?: string;
  sessionAliases?: string[];
  claudeSessionId?: string;
  resumeId?: string | null;
  notesLaunchCase?: CaseInfo;
  worktreeRepo?: string;
}
interface Options {
  root?: string;
  store?: SessionNotesStore;
  pollInterval?: number;
  onChanged?: (ownerKey: string) => void;
}
interface Observer {
  signature: string;
  timer: ReturnType<typeof setInterval>;
  watchers: Map<string, FSWatcher>;
  scanning: boolean;
}
export class SessionNotesService {
  readonly store: SessionNotesStore;
  readonly projects: SessionNotesProjects;
  private readonly bindings: SessionNotesBindings;
  private readonly root: string;
  private readonly observers = new Map<string, Observer>();
  private closed = false;
  constructor(private readonly options: Options = {}) {
    this.root = options.root ?? dataPath('notes');
    this.store = options.store ?? new SessionNotesStore(this.root);
    this.projects = new SessionNotesProjects(this.root);
    this.bindings = new SessionNotesBindings(this.root);
  }
  context(owner: string) {
    return this.bindings.context(owner);
  }
  async open(owner: string, source: SessionNotesSource, cases: CaseInfo[]): Promise<SessionNote> {
    const aliases = [source.id, ...(source.sessionAliases ?? []), source.claudeSessionId, source.resumeId].filter(
      (value): value is string => typeof value === 'string' && !!value
    );
    const existing = await this.projects.findNotebook(owner, { ...source, sessionAliases: aliases }, this.store);
    const bindings = await this.bindings.list(owner);
    const matches = bindings.filter((binding) =>
      [binding.sessionId, ...binding.sessionAliases].some((alias) => aliases.includes(alias))
    );
    if (matches.length > 1 || (existing && matches[0] && existing.metadata.id !== matches[0].id))
      throw new Error('Ambiguous session notebook association');
    let draft: SessionNote;
    if (existing) draft = existing;
    else if (matches[0]) draft = await this.read(owner, matches[0].id);
    else {
      const project = await this.projects.resolve(owner, source, cases, {
        chosenCase: source.notesLaunchCase,
        mainRepositoryRoot: source.worktreeRepo,
      });
      draft = this.store.create(owner, {
        projectId: project.id,
        sessionId: source.id,
        sessionAliases: aliases.filter((alias) => alias !== source.id),
        sessionTitle: source.name ?? '',
        title: source.name ? `${source.name} notes` : 'Session notes',
        workingDir: source.workingDir,
        executionLocation: project.executionLocation,
      });
    }
    const binding = await this.bindings.observe(owner, draft, aliases);
    // A competing process can allocate before this process publishes its candidate binding.
    const note = await this.read(owner, binding.id);
    await this.observe(owner);
    return note;
  }
  async read(owner: string, id: string): Promise<SessionNote> {
    safeNotesId(id);
    const entries = await this.store.list(owner);
    const matches = entries.filter((entry) => entry.id === id);
    if (matches.length > 1) throw new Error('Ambiguous notebook identity');
    if (matches[0]) {
      const note = await this.store.read(owner, matches[0].projectId, id);
      await this.bindings.observe(owner, note, [], true);
      return note;
    }
    const binding = (await this.bindings.list(owner)).find((candidate) => candidate.id === id);
    if (!binding) throw new SessionNotesNotFoundError('Note not found');
    return { metadata: binding, markdown: '', revision: '' };
  }
  async save(
    owner: string,
    id: string,
    revision: string,
    markdown: string,
    title?: string
  ): Promise<SessionNote | null> {
    const note = await this.atRevision(owner, id, revision);
    if (!revision && !markdown.trim()) {
      if (title !== undefined) {
        note.metadata = await this.bindings.update(owner, id, { title });
        this.options.onChanged?.(owner);
      }
      return note;
    }
    const result = await this.store.save(owner, note, markdown, { title });
    if (result) await this.bindings.observe(owner, result, [], true);
    await this.observe(owner);
    return result;
  }
  async list(owner: string, filter: SessionNotesFilter = {}): Promise<SessionNoteEntry[]> {
    const entries = await this.store.list(owner);
    await this.observe(owner, entries);
    const bindings = await this.bindings.list(owner);
    for (const entry of entries) {
      entry.sessionAliases = bindings.find((binding) => binding.id === entry.id)?.sessionAliases ?? [];
      entry.checklist = entry.note
        ? checklistItems(entry.note.markdown).map(({ line, checked, text }) => ({ line, checked, text }))
        : [];
      entry.unfinishedCount = entry.note
        ? checklistItems(entry.note.markdown).filter((item) => !item.checked).length
        : 0;
    }
    return filterSessionNotes(entries, filter).sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
  }
  async reassign(owner: string, id: string, revision: string, projectId: string): Promise<SessionNote> {
    const note = await this.atRevision(owner, id, revision);
    let result: SessionNote;
    if (!note.revision) {
      if (!(await this.projects.list(owner)).some((project) => project.id === projectId))
        throw new SessionNotesNotFoundError('Notes project not found');
      result = { ...note, metadata: await this.bindings.update(owner, id, { projectId }) };
    } else {
      if (!(await this.projects.list(owner)).some((project) => project.id === projectId))
        throw new SessionNotesNotFoundError('Notes project not found');
      result = await this.projects.reassign(owner, note, projectId, this.store);
      await this.bindings.update(owner, id, { projectId });
    }
    await this.observe(owner);
    this.options.onChanged?.(owner);
    return result;
  }
  async renameProject(owner: string, id: string, name: string) {
    if (!(await this.projects.list(owner)).some((project) => project.id === id))
      throw new SessionNotesNotFoundError('Notes project not found');
    const result = await this.projects.rename(owner, id, name);
    this.options.onChanged?.(owner);
    return result;
  }
  async resolveRecovery(
    owner: string,
    projectId: string,
    id: string,
    revision: string,
    choice: 'external' | 'staged'
  ): Promise<void> {
    await this.store.resolveRecovery(owner, projectId, id, revision, choice);
    await this.observe(owner);
    this.options.onChanged?.(owner);
  }
  async repair(owner: string, id: string, revision: string, markdown: string): Promise<SessionNote> {
    const entries = (await this.store.list(owner)).filter((candidate) => candidate.id === id);
    if (entries.length > 1) throw new Error('Ambiguous notebook identity');
    const entry = entries[0];
    const binding =
      (await this.bindings.list(owner)).find((candidate) => candidate.id === id) ??
      (await this.store.retainedNote(owner, id))?.metadata;
    if (!entry || !binding) throw new SessionNotesNotFoundError('Trusted notebook provenance unavailable');
    const result = await this.store.repair(
      owner,
      { metadata: { ...binding, projectId: entry.projectId }, markdown: '', revision: '' },
      revision,
      markdown
    );
    await this.bindings.observe(owner, result, [], true);
    await this.observe(owner);
    return result;
  }
  async complete(owner: string, id: string, revision: string, line: number, checked: boolean): Promise<SessionNote> {
    const note = await this.atRevision(owner, id, revision);
    return (await this.save(owner, id, revision, setChecklistItem(note.markdown, line, checked)))!;
  }
  private async atRevision(owner: string, id: string, revision: string): Promise<SessionNote> {
    const note = await this.read(owner, id);
    if (note.revision !== revision) throw new SessionNotesConflictError('Note changed on disk', note);
    return note;
  }
  /** Native notifications prompt a canonical scan; periodic scans cover missed notifications and new directories. */
  private async observe(owner: string, entries?: SessionNoteEntry[]): Promise<void> {
    if (this.closed || !this.options.onChanged) return;
    const current = entries ?? (await this.store.list(owner));
    if (this.closed) return;
    const signature = JSON.stringify(current);
    let observer = this.observers.get(owner);
    if (!observer) {
      const timer = setInterval(() => {
        void this.rescan(owner);
      }, this.options.pollInterval ?? 2000);
      timer.unref();
      observer = { signature, timer, watchers: new Map(), scanning: false };
      this.observers.set(owner, observer);
    } else if (observer.signature !== signature) {
      observer.signature = signature;
      this.options.onChanged(owner);
    }
    for (const path of [
      join(this.root, owner),
      join(this.root, owner, 'projects'),
      ...current.map((entry) => join(this.root, owner, 'projects', entry.projectId)),
    ]) {
      if (observer.watchers.has(path)) continue;
      try {
        const watcher = watch(path, { persistent: false }, (_event, filename) => {
          if (path === join(this.root, owner) && filename?.toString() !== 'projects') return;
          void this.rescan(owner);
        });
        watcher.on('error', () => {
          watcher.close();
          observer!.watchers.delete(path);
        });
        observer.watchers.set(path, watcher);
      } catch {
        /* Missing directories are discovered on the next canonical scan. */
      }
    }
  }
  private async rescan(owner: string): Promise<void> {
    const observer = this.observers.get(owner);
    if (!observer || observer.scanning || this.closed) return;
    observer.scanning = true;
    try {
      await this.observe(owner);
    } catch {
      if (!this.closed) this.options.onChanged?.(owner);
    } finally {
      observer.scanning = false;
    }
  }
  close(): void {
    this.closed = true;
    for (const observer of this.observers.values()) {
      clearInterval(observer.timer);
      for (const watcher of observer.watchers.values()) watcher.close();
    }
    this.observers.clear();
  }
}
