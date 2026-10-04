import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
  it('preserves and reports malformed recovery journals without blocking unrelated notebooks', async () => {
    const store = new SessionNotesStore(root);
    await persisted(store);
    const other = (await store.save('alice', store.create('alice', { ...input, id: 'note2' }), 'other'))!;
    const history = join(root, 'alice/.history');
    const partial = join(history, '00000000-0000-0000-0000-000000000000.json');
    await writeFile(partial, '{"source":');
    const fresh = new SessionNotesStore(root);
    expect(await fresh.read('alice', 'project1', 'note2')).toEqual(other);
    expect(await fresh.list('alice')).toHaveLength(2);
    const issues = await fresh.listRecoveryIssues('alice');
    expect(issues).toHaveLength(1);
    expect(issues[0].raw).toBe('{"source":');
    expect(await readFile(issues[0].path, 'utf8')).toBe('{"source":');
    expect((await fresh.save('alice', other, 'updated'))?.markdown).toBe('updated');
  });
  it('publishes journals atomically and preserves unpublished artifacts before any displacement', async () => {
    const note = await persisted();
    const original = await readFile(path());
    const broken = new SessionNotesStore(root, {
      checkpoint: (stage) => {
        if (stage === 'journal-ready') throw new Error('crash');
      },
    });
    await expect(broken.save('alice', note, 'ours')).rejects.toThrow('crash');
    expect(await readFile(path())).toEqual(original);
    const fresh = new SessionNotesStore(root);
    expect(await fresh.read('alice', 'project1', 'note1')).toEqual(note);
    const issues = await fresh.listRecoveryIssues('alice');
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toMatch(/journal-tmp$/);
    expect((await readdir(join(root, 'alice/.history'))).filter((file) => file.endsWith('.json'))).toHaveLength(0);
  });
  it('rejects choosing a missing external move candidate before changing canonical notebooks', async () => {
    const note = await persisted();
    const target = join(root, 'alice/projects/project2/note1.md');
    const broken = new SessionNotesStore(root, {
      checkpoint: async (stage) => {
        if (stage === 'displaced') {
          await writeFile(target, 'external candidate');
          throw new Error('crash');
        }
      },
    });
    await expect(broken.reassign('alice', note, 'project2')).rejects.toThrow('crash');
    const fresh = new SessionNotesStore(root);
    await expect(fresh.resolveRecovery('alice', 'project1', 'note1', '', 'external')).rejects.toBeInstanceOf(
      SessionNotesNotFoundError
    );
    expect(await readFile(target, 'utf8')).toBe('external candidate');
    expect((await fresh.list('alice')).find((entry) => entry.projectId === 'project2')?.conflict).toBeDefined();
    let revision = '';
    try {
      await fresh.read('alice', 'project2', 'note1');
    } catch (error) {
      revision = (error as SessionNotesConflictError).current!.revision;
    }
    await fresh.resolveRecovery('alice', 'project2', 'note1', revision, 'external');
    expect(await fresh.list('alice')).toHaveLength(1);
    expect((await fresh.list('alice'))[0].repairable).toBe(true);
  });
  it('coordinates stale reclamation so delayed contenders cannot delete a replacement live lock', async () => {
    await mkdir(join(root, 'alice/.lock'), { recursive: true });
    await writeFile(join(root, 'alice/.lock/00000000-0000-0000-0000-000000000000.owner'), '99999999');
    const a = new SessionNotesStore(root);
    const b = new SessionNotesStore(root);
    type LockProbe = {
      bytes(path: string): Promise<Buffer>;
      locked(owner: string, operation: () => Promise<void>): Promise<void>;
    };
    let sawB!: () => void;
    let enteredA!: () => void;
    let releaseA!: () => void;
    let bProgress!: () => void;
    const bRead = new Promise<void>((resolve) => (sawB = resolve));
    const aEntered = new Promise<void>((resolve) => (enteredA = resolve));
    const holdA = new Promise<void>((resolve) => (releaseA = resolve));
    const bAdvanced = new Promise<void>((resolve) => (bProgress = resolve));
    for (const [store, first] of [
      [a, true],
      [b, false],
    ] as const) {
      const probe = store as unknown as LockProbe;
      const original = probe.bytes.bind(store);
      probe.bytes = async (path) => {
        const bytes = await original(path);
        if (path.includes('/.lock/') && bytes.toString() === '99999999') {
          if (first) await bRead;
          else {
            sawB();
            await aEntered;
          }
        } else if (path.includes('/.lock/') && !first) bProgress();
        return bytes;
      };
    }
    let active = 0;
    let maximum = 0;
    const pa = (a as unknown as LockProbe).locked('alice', async () => {
      active++;
      maximum = Math.max(maximum, active);
      enteredA();
      await holdA;
      active--;
    });
    const pb = (b as unknown as LockProbe).locked('alice', async () => {
      active++;
      maximum = Math.max(maximum, active);
      bProgress();
      active--;
    });
    try {
      await bAdvanced;
      expect(maximum).toBe(1);
    } finally {
      releaseA();
      await Promise.allSettled([pa, pb]);
    }
    await expect(pa).resolves.toBeUndefined();
    await expect(pb).resolves.toBeUndefined();
  });
  it('serializes saves from independent processes and recovers a crashed owner', async () => {
    const note = await persisted();
    const run = promisify(execFile);
    const moduleUrl = new URL('../src/session-notes-store.ts', import.meta.url).href;
    const script = `import { writeFile } from 'node:fs/promises'; import { SessionNotesStore } from ${JSON.stringify(moduleUrl)};
      const store = new SessionNotesStore(process.argv[2]);
      try { await store.save('alice', JSON.parse(process.argv[3]), process.argv[4]); await writeFile(process.argv[2] + '/result-' + process.argv[4], 'saved'); }
      catch (error) { if (error.constructor.name === 'SessionNotesConflictError') await writeFile(process.argv[2] + '/result-' + process.argv[4], 'conflict'); else throw error; }`;
    const worker = join(root, 'worker.mjs');
    await writeFile(worker, script);
    await Promise.all(
      ['one', 'two'].map((body) =>
        run(process.execPath, ['--import', 'tsx', worker, root, JSON.stringify(note), body], {
          env: { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE },
        })
      )
    );
    expect(
      (await Promise.all(['one', 'two'].map((body) => readFile(join(root, 'result-' + body), 'utf8')))).sort()
    ).toEqual(['conflict', 'saved']);
    const crash = `import { SessionNotesStore } from ${JSON.stringify(moduleUrl)};
      const store = new SessionNotesStore(process.argv[2]);
      await store.locked('alice', async () => { process.exit(0); });`;
    const crashWorker = join(root, 'crash.mjs');
    await writeFile(crashWorker, crash);
    await run(process.execPath, ['--import', 'tsx', crashWorker, root], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE },
    });
    const crashedMarkers = await readdir(join(root, 'alice/.lock'));
    expect(crashedMarkers).toHaveLength(1);
    const crashedPid = Number(await readFile(join(root, 'alice/.lock', crashedMarkers[0]), 'utf8'));
    expect(crashedPid).toBeGreaterThan(0);
    expect(crashedPid).not.toBe(process.pid);
    expect(() => process.kill(crashedPid, 0)).toThrow();
    expect((await new SessionNotesStore(root).read('alice', 'project1', 'note1')).markdown).toMatch(/one|two/);
    await expect(stat(join(root, 'alice/.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(join(root, 'alice/.lock'));
    expect(await new SessionNotesStore(root).list('alice')).toHaveLength(1);
  });
  it('leaves a replacement live owner and malformed legacy locks intact during release and acquisition', async () => {
    const lock = join(root, 'alice/.lock');
    await mkdir(lock, { recursive: true });
    const marker = '11111111-1111-1111-1111-111111111111.owner';
    await writeFile(join(lock, marker), String(process.pid));
    const store = new SessionNotesStore(root);
    await (store as unknown as { releaseLock(path: string, marker: string): Promise<void> }).releaseLock(
      lock,
      '00000000-0000-0000-0000-000000000000.owner'
    );
    expect(await readFile(join(lock, marker), 'utf8')).toBe(String(process.pid));
    await rm(lock, { recursive: true });
    await writeFile(lock, 'legacy file lock');
    await expect(store.list('alice')).rejects.toThrow('manual repair');
    expect(await readFile(lock, 'utf8')).toBe('legacy file lock');
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
