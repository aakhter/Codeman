import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, symlink, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionNotesStore,
  SessionNotesConflictError,
  SessionNotesMalformedError,
  SessionNotesNotFoundError,
} from '../src/session-notes-store.js';

describe('SessionNotesStore real filesystem', () => {
  let root: string;
  const input = {
    id: 'note1',
    projectId: 'project1',
    sessionId: 'session1',
    sessionAliases: [],
    sessionTitle: 'Session',
    title: 'Notes',
    workingDir: '/work',
    executionLocation: 'local',
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'notes-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const path = () => join(root, 'alice/projects/project1/note1.md');
  async function persisted(store = new SessionNotesStore(root)) {
    const draft = store.create('alice', input);
    return (await store.save('alice', draft, '# hello\r\n\n  exact  \n'))!;
  }
  it('creates only on first nonempty save and roundtrips without any live session', async () => {
    const store = new SessionNotesStore(root);
    const draft = store.create('alice', input);
    expect(await store.save('alice', draft, '  \n')).toBeNull();
    expect(await store.list('alice')).toEqual([]);
    const note = await persisted(store);
    expect(await new SessionNotesStore(root).read('alice', 'project1', 'note1')).toEqual(note);
    expect(await store.export('alice', 'project1', 'note1')).toBe('# hello\r\n\n  exact  \n');
    expect((await stat(path())).mode & 0o777).toBe(0o600);
  });
  it('isolates owners for every operation', async () => {
    const store = new SessionNotesStore(root);
    const note = await persisted(store);
    await expect(store.read('bob', 'project1', 'note1')).rejects.toBeInstanceOf(SessionNotesNotFoundError);
    await expect(store.save('bob', note, 'stolen')).rejects.toThrow();
    await expect(store.reassign('bob', note, 'project2')).rejects.toThrow();
    expect(await store.list('bob')).toEqual([]);
  });
  it('detects external body edits and refreshes list from disk', async () => {
    const store = new SessionNotesStore(root);
    const note = await persisted(store);
    await writeFile(path(), (await readFile(path(), 'utf8')).replace('# hello', '# external'));
    await expect(store.save('alice', note, 'overwrite')).rejects.toMatchObject({
      current: { markdown: '# external\r\n\n  exact  \n' },
    });
    expect((await store.list('alice'))[0].note?.markdown).toContain('external');
  });
  it('serializes competing independent stores and preserves displaced bytes', async () => {
    const note = await persisted();
    const original = await readFile(path());
    const results = await Promise.allSettled([
      new SessionNotesStore(root).save('alice', note, 'one'),
      new SessionNotesStore(root).save('alice', note, 'two'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(SessionNotesConflictError);
    const history = join(root, 'alice/.history');
    const files = await readdir(history);
    expect(await readFile(join(history, files.find((f) => f.endsWith('.md'))!))).toEqual(original);
  });
  it('preserves malformed files as repairable entries', async () => {
    await persisted();
    await writeFile(path(), '---\n{}\n---\nraw');
    const store = new SessionNotesStore(root);
    await expect(store.read('alice', 'project1', 'note1')).rejects.toBeInstanceOf(SessionNotesMalformedError);
    expect((await store.list('alice'))[0]).toMatchObject({ id: 'note1', repairable: true, raw: '---\n{}\n---\nraw' });
    expect(await readFile(path(), 'utf8')).toBe('---\n{}\n---\nraw');
  });
  it('rejects traversal and symlink directories and files', async () => {
    const store = new SessionNotesStore(root);
    expect(() => store.create('../alice', input)).toThrow();
    expect(() => store.create('alice', { ...input, projectId: '../bad' })).toThrow();
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'alice'));
    await expect(persisted(store)).rejects.toThrow();
    await rm(join(root, 'alice'));
    await persisted(store);
    await rm(path());
    await symlink(join(outside, 'secret'), path());
    await expect(store.read('alice', 'project1', 'note1')).rejects.toThrow();
  });
  it('reassigns project with same note identity and one canonical notebook', async () => {
    const store = new SessionNotesStore(root);
    const note = await persisted(store);
    const moved = await store.reassign('alice', note, 'project2');
    expect(moved.metadata.id).toBe(note.metadata.id);
    expect(moved.metadata.projectId).toBe('project2');
    await expect(store.read('alice', 'project1', 'note1')).rejects.toBeInstanceOf(SessionNotesNotFoundError);
    expect(await new SessionNotesStore(root).list('alice')).toHaveLength(1);
  });
  it('recovers interrupted save and move while retaining exact original bytes', async () => {
    const note = await persisted();
    const original = await readFile(path());
    const broken = new SessionNotesStore(root, {
      checkpoint: (stage) => {
        if (stage === 'displaced') throw new Error('power loss');
      },
    });
    await expect(broken.save('alice', note, 'saved')).rejects.toThrow('power loss');
    const fresh = new SessionNotesStore(root);
    const saved = await fresh.read('alice', 'project1', 'note1');
    expect(saved.markdown).toBe('saved');
    await expect(broken.reassign('alice', saved, 'project2')).rejects.toThrow('power loss');
    const entries = await new SessionNotesStore(root).list('alice');
    expect(entries).toHaveLength(1);
    expect(entries[0].projectId).toBe('project2');
    const history = join(root, 'alice/.history');
    const bytes = await Promise.all(
      (await readdir(history)).filter((f) => f.endsWith('.md')).map((f) => readFile(join(history, f)))
    );
    expect(bytes.some((b) => b.equals(original))).toBe(true);
  });
  it('accepts aliased configured roots and keeps saved history independent of external in-place edits', async () => {
    const alias = join(root, 'alias');
    const actual = join(root, 'actual');
    await mkdir(actual);
    await symlink(actual, alias);
    const store = new SessionNotesStore(join(alias, 'notes'));
    const note = await persisted(store);
    const canonical = join(actual, 'notes/alice/projects/project1/note1.md');
    const saved = (await store.save('alice', note, 'saved snapshot'))!;
    await writeFile(canonical, (await readFile(canonical, 'utf8')).replace('saved snapshot', 'external mutation'));
    const history = join(actual, 'notes/alice/.history');
    const versions = await Promise.all(
      (await readdir(history)).filter((f) => f.endsWith('.staged')).map((f) => readFile(join(history, f), 'utf8'))
    );
    expect(versions.some((raw) => raw.endsWith(saved.markdown))).toBe(true);
  });
  it('preserves immutable persisted metadata and updates title deliberately', async () => {
    const store = new SessionNotesStore(root);
    const note = await persisted(store);
    const forged = { ...note, metadata: { ...note.metadata, sessionId: 'forged', createdAt: 0, title: 'forged' } };
    const saved = (await store.save('alice', forged, 'new body', { title: 'New title' }))!;
    expect(saved.metadata.sessionId).toBe('session1');
    expect(saved.metadata.createdAt).toBe(note.metadata.createdAt);
    expect(saved.metadata.title).toBe('New title');
    const moved = await store.reassign('alice', { ...saved, markdown: 'forged body' }, 'project2');
    expect(moved.markdown).toBe('new body');
  });
  it('rejects an external replacement racing displacement and retains actual displaced bytes', async () => {
    const note = await persisted();
    let external: Buffer;
    const store = new SessionNotesStore(root, {
      checkpoint: async (stage) => {
        if (stage === 'prepared') {
          external = Buffer.from((await readFile(path(), 'utf8')).replace('# hello', '# raced'));
          await writeFile(path(), external);
        }
      },
    });
    await expect(store.save('alice', note, 'ours')).rejects.toBeInstanceOf(SessionNotesConflictError);
    expect(await readFile(path())).toEqual(external!);
    const history = join(root, 'alice/.history');
    const versions = await Promise.all(
      (await readdir(history)).filter((f) => f.endsWith('.md')).map((f) => readFile(join(history, f)))
    );
    expect(versions.some((b) => b.equals(external!))).toBe(true);
  });
  it('recovers prepared moves and preserves a recreated source until explicitly resolved', async () => {
    const note = await persisted();
    const prepared = new SessionNotesStore(root, {
      checkpoint: (stage) => {
        if (stage === 'prepared') throw new Error('interrupted');
      },
    });
    await expect(prepared.reassign('alice', note, 'project2')).rejects.toThrow();
    const fresh = new SessionNotesStore(root);
    const moved = await fresh.read('alice', 'project2', 'note1');
    const displaced = new SessionNotesStore(root, {
      checkpoint: async (stage) => {
        if (stage === 'displaced') {
          await writeFile(join(root, 'alice/projects/project2/note1.md'), 'recreated source');
          throw new Error('interrupted');
        }
      },
    });
    await expect(displaced.reassign('alice', moved, 'project3')).rejects.toThrow();
    const conflicts = await fresh.list('alice');
    expect(conflicts.some((entry) => entry.projectId === 'project2' && entry.conflict)).toBe(true);
    let revision = '';
    try {
      await fresh.read('alice', 'project2', 'note1');
    } catch (error) {
      revision = (error as SessionNotesConflictError).current!.revision;
    }
    await fresh.resolveRecovery('alice', 'project2', 'note1', revision, 'external');
    await expect(fresh.read('alice', 'project2', 'note1')).rejects.toBeInstanceOf(SessionNotesMalformedError);
    expect((await fresh.list('alice')).filter((entry) => entry.conflict)).toHaveLength(0);
  });
  it('scopes recovery conflicts to a notebook and resolves with a checked external revision', async () => {
    const store = new SessionNotesStore(root);
    const note = await persisted(store);
    const other = (await store.save('alice', store.create('alice', { ...input, id: 'note2' }), 'other'))!;
    const broken = new SessionNotesStore(root, {
      checkpoint: async (stage) => {
        if (stage === 'displaced') {
          await writeFile(path(), 'external writer');
          throw new Error('power loss');
        }
      },
    });
    await expect(broken.save('alice', note, 'ours')).rejects.toThrow();
    const fresh = new SessionNotesStore(root);
    expect((await fresh.read('alice', 'project1', 'note2')).markdown).toBe('other');
    expect((await fresh.list('alice')).find((entry) => entry.id === 'note1')?.conflict).toBeDefined();
    expect((await fresh.save('alice', other, 'still works'))?.markdown).toBe('still works');
    let revision = '';
    try {
      await fresh.read('alice', 'project1', 'note1');
    } catch (error) {
      revision = (error as SessionNotesConflictError).current!.revision;
    }
    await expect(fresh.resolveRecovery('alice', 'project1', 'note1', 'stale', 'staged')).rejects.toBeInstanceOf(
      SessionNotesConflictError
    );
    await fresh.resolveRecovery('alice', 'project1', 'note1', revision, 'staged');
    expect((await fresh.read('alice', 'project1', 'note1')).markdown).toBe('ours');
  });
  it('retains both versions and surfaces recovery conflict if an external target appears', async () => {
    const note = await persisted();
    const broken = new SessionNotesStore(root, {
      checkpoint: async (stage) => {
        if (stage === 'displaced') {
          await writeFile(path(), 'external writer');
          throw new Error('power loss');
        }
      },
    });
    await expect(broken.save('alice', note, 'ours')).rejects.toThrow();
    await expect(new SessionNotesStore(root).read('alice', 'project1', 'note1')).rejects.toBeInstanceOf(
      SessionNotesConflictError
    );
    expect(await readFile(path(), 'utf8')).toBe('external writer');
  });
});
