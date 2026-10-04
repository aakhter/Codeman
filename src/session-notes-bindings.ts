/** @fileoverview Durable metadata-only drafts and append-only trusted session identity observations. */
import { createHash, randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionNotesFilesystem, isNotesMissing, safeNotesId } from './session-notes-filesystem.js';
import { parseSessionNote, serializeSessionNote, sessionNoteProvenanceMatches } from './session-notes-markdown.js';
import type { SessionNote, SessionNoteMetadata } from './types/session-notes.js';

export class SessionNotesBindings extends SessionNotesFilesystem {
  async context(owner: string): Promise<{ ownerKey: string; instanceKey: string }> {
    return this.withOwnerLock(owner, async () => ({
      ownerKey: owner,
      instanceKey: createHash('sha256').update(this.root).digest('hex'),
    }));
  }
  async list(owner: string): Promise<SessionNoteMetadata[]> {
    return this.withOwnerLock(owner, () => this.load(owner));
  }
  async update(
    owner: string,
    id: string,
    change: { title?: string; projectId?: string }
  ): Promise<SessionNoteMetadata> {
    return this.withOwnerLock(owner, async () => {
      const bindings = await this.load(owner);
      const binding = bindings.find((candidate) => candidate.id === id);
      if (!binding) throw new Error('Notes binding not found');
      if (change.title !== undefined) binding.title = change.title;
      if (change.projectId !== undefined) binding.projectId = safeNotesId(change.projectId);
      // A monotonic persisted stamp prevents an old token becoming valid again after an edit is undone.
      binding.updatedAt = Math.max(Date.now(), binding.updatedAt + 1);
      await this.persist(owner, bindings);
      return binding;
    });
  }
  /** Caller supplies server-observed aliases and metadata, never a browser note object. */
  async observe(owner: string, draft: SessionNote, aliases: string[], canonical = false): Promise<SessionNoteMetadata> {
    return this.withOwnerLock(owner, async () => {
      const bindings = await this.load(owner);
      const wanted = new Set(canonical ? aliases : [draft.metadata.sessionId, ...aliases]);
      const matches = bindings.filter(
        (binding) =>
          binding.id === draft.metadata.id ||
          [binding.sessionId, ...binding.sessionAliases].some((alias) => wanted.has(alias))
      );
      if (matches.length > 1) throw new Error('Ambiguous session notebook association');
      if (canonical && matches[0] && matches[0].id !== draft.metadata.id)
        throw new Error('Ambiguous session notebook association');
      const binding = matches[0] ?? { ...draft.metadata };
      if (matches[0] && !sessionNoteProvenanceMatches(draft.metadata, binding))
        throw new Error('Notebook provenance differs from retained binding');
      const previous = JSON.stringify(binding);
      if (canonical) {
        binding.title = draft.metadata.title;
        binding.projectId = draft.metadata.projectId;
      }
      if (!matches.length) bindings.push(binding);
      binding.sessionAliases = [...new Set([...binding.sessionAliases, ...aliases])].filter(
        (alias) => alias !== binding.sessionId
      );
      if (matches.length && JSON.stringify(binding) !== previous)
        binding.updatedAt = Math.max(Date.now(), binding.updatedAt + 1);
      await this.persist(owner, bindings);
      return binding;
    });
  }
  private async load(owner: string): Promise<SessionNoteMetadata[]> {
    let raw: Buffer;
    try {
      raw = await this.bytes(join(this.ownerPath(owner), 'bindings.json'));
    } catch (error) {
      if (isNotesMissing(error)) return [];
      throw error;
    }
    const bindings: unknown = JSON.parse(raw.toString('utf8'));
    if (!Array.isArray(bindings)) throw new Error('Notes bindings require repair');
    const ids = new Set<string>();
    for (const metadata of bindings as SessionNoteMetadata[]) {
      const note = parseSessionNote(serializeSessionNote(metadata, ''));
      if (note.metadata.ownerKey !== owner || ids.has(note.metadata.id)) throw new Error('Invalid notes binding');
      safeNotesId(metadata.id);
      safeNotesId(metadata.projectId);
      ids.add(metadata.id);
    }
    return bindings as SessionNoteMetadata[];
  }
  private async persist(owner: string, bindings: SessionNoteMetadata[]): Promise<void> {
    const dir = this.ownerPath(owner);
    const history = join(dir, '.binding-history');
    await this.directory(history);
    const path = join(history, `${randomUUID()}.json`);
    await this.writePrivate(path, Buffer.from(JSON.stringify(bindings) + '\n'));
    await this.syncDirectory(history);
    const target = join(dir, 'bindings.json');
    await this.guard(target, true);
    await rename(path, target);
    await this.syncDirectory(dir);
  }
}
