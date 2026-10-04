import { mkdtemp, rm, writeFile, readFile, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionNotesService } from '../src/session-notes-service.js';
import {
  SessionNotesConflictError,
  SessionNotesMalformedError,
  SessionNotesStore,
} from '../src/session-notes-store.js';
import { noteRevision, serializeSessionNote } from '../src/session-notes-markdown.js';

describe('notebook service canonical files and durable bindings', () => {
  let root: string;
  const services: SessionNotesService[] = [];
  const source = { id: 'session1', workingDir: '/repo/sub', name: 'Session', sessionAliases: ['native1'] };
  const cases = [
    { name: 'Repo', path: '/repo', hasClaudeMd: false },
    { name: 'Sub', path: '/repo/sub', hasClaudeMd: false },
  ];
  const service = (store?: SessionNotesStore) => {
    const value = new SessionNotesService({ root, store });
    services.push(value);
    return value;
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'notes-service-'));
  });
  afterEach(async () => {
    services.forEach((s) => s.close());
    services.length = 0;
    await rm(root, { recursive: true, force: true });
  });
  it('allocates one metadata-only draft across simultaneous opens, reloads, source removal and failed saves', async () => {
    const store = new SessionNotesStore(root, {
      checkpoint: () => {
        throw new Error('disk failure');
      },
    });
    const first = service(store);
    const [a, b] = await Promise.all([first.open('alice', source, cases), service().open('alice', source, cases)]);
    expect(a.metadata.id).toBe(b.metadata.id);
    expect(await store.list('alice')).toEqual([]);
    await expect(first.save('alice', a.metadata.id, a.revision, 'draft')).rejects.toThrow('disk failure');
    const retry = await service().read('alice', a.metadata.id);
    expect(retry.metadata.sessionId).toBe(source.id);
    const saved = await service().save('alice', a.metadata.id, retry.revision, 'remember');
    expect(saved!.markdown).toBe('remember');
    await expect(service().save('alice', b.metadata.id, b.revision, 'other tab')).rejects.toBeInstanceOf(
      SessionNotesConflictError
    );
    await expect(service().read('bob', a.metadata.id)).rejects.toThrow();
  });
  it('uses launch case before cwd inference and retains reassignment when reopened through new trusted aliases', async () => {
    const s = service();
    const draft = await s.open('alice', { ...source, notesLaunchCase: cases[0] }, cases);
    const projects = await s.projects.list('alice');
    expect(projects.find((p) => p.id === draft.metadata.projectId)!.name).toBe('Repo');
    const saved = (await s.save('alice', draft.metadata.id, draft.revision, '- [ ] todo'))!;
    const other = projects.find((p) => p.name === 'Sub')!;
    const moved = await s.reassign('alice', saved.metadata.id, saved.revision, other.id);
    await s.open('alice', { ...source, sessionAliases: ['native1', 'native2'] }, cases);
    const recovered = await service().open('alice', { ...source, id: 'recovered', sessionAliases: ['native2'] }, cases);
    expect(recovered.metadata.id).toBe(saved.metadata.id);
    expect(recovered.metadata.projectId).toBe(moved.metadata.projectId);
  });
  it('persists title and project edits on metadata-only drafts through reload', async () => {
    const s = service();
    const draft = await s.open('alice', source, cases);
    const projects = await s.projects.list('alice');
    const other = projects.find((p) => p.id !== draft.metadata.projectId)!;
    const moved = await s.reassign('alice', draft.metadata.id, draft.revision, other.id);
    const renamed = await s.save('alice', draft.metadata.id, moved.revision, '', 'Custom');
    expect(renamed!.metadata.title).toBe('Custom');
    const reloaded = await service().read('alice', draft.metadata.id);
    expect(reloaded.metadata.projectId).toBe(other.id);
    expect(reloaded.metadata.title).toBe('Custom');
    expect(await s.store.list('alice')).toEqual([]);
  });
  it('rejects stale draft metadata revisions across competing service instances', async () => {
    const first = service();
    const second = service();
    const draft = await first.open('alice', source, cases);
    const renamed = (await first.save('alice', draft.metadata.id, draft.revision, '', 'Title A'))!;
    await expect(second.save('alice', draft.metadata.id, draft.revision, '', 'Stale Title B')).rejects.toMatchObject({
      current: { revision: renamed.revision, metadata: { title: 'Title A' } },
    });
    expect(renamed.revision).not.toBe(draft.revision);
    expect((await second.read('alice', draft.metadata.id)).metadata.title).toBe('Title A');
    const restored = await second.save('alice', draft.metadata.id, renamed.revision, '', draft.metadata.title);
    expect(restored!.revision).not.toBe(draft.revision);
    await expect(first.save('alice', draft.metadata.id, draft.revision, 'stale original body')).rejects.toBeInstanceOf(
      SessionNotesConflictError
    );
  });
  it('holds one filesystem transaction from draft revision check through first save and binding updates', async () => {
    const first = service();
    const second = service();
    const draft = await first.open('alice', source, cases);
    const other = (await first.projects.list('alice')).find((project) => project.id !== draft.metadata.projectId)!;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = first.store.save.bind(first.store);
    vi.spyOn(first.store, 'save').mockImplementation(async (...args) => {
      reached();
      await gate;
      return original(...args);
    });
    const saving = first.save('alice', draft.metadata.id, draft.revision, 'first body');
    await paused;
    let moveFinished = false;
    const moving = second.reassign('alice', draft.metadata.id, draft.revision, other.id);
    void moving.then(
      () => {
        moveFinished = true;
      },
      () => {
        moveFinished = true;
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const movedBeforeRelease = moveFinished;
    release();
    const [saved, moved] = await Promise.allSettled([saving, moving]);
    expect(movedBeforeRelease).toBe(false);
    expect(saved.status).toBe('fulfilled');
    expect(moved.status).toBe('rejected');
    const current = await second.read('alice', draft.metadata.id);
    const retried = await second.reassign('alice', draft.metadata.id, current.revision, other.id);
    expect(retried.metadata.projectId).toBe(other.id);
    expect((await first.read('alice', draft.metadata.id)).metadata.projectId).toBe(other.id);
  });
  it('rejects a stale first save after an acknowledged draft reassignment', async () => {
    const first = service();
    const second = service();
    const draft = await first.open('alice', source, cases);
    const target = (await first.projects.list('alice')).find((project) => project.id !== draft.metadata.projectId)!;
    const moved = await second.reassign('alice', draft.metadata.id, draft.revision, target.id);
    await expect(first.save('alice', draft.metadata.id, draft.revision, 'stale first body')).rejects.toMatchObject({
      current: { revision: moved.revision, metadata: { projectId: target.id } },
    });
    expect(await first.store.list('alice')).toEqual([]);
    const saved = await first.save('alice', draft.metadata.id, moved.revision, 'retained body');
    expect(saved!.metadata.projectId).toBe(target.id);
    expect(saved!.revision).toMatch(/^[a-f0-9]{64}$/);
  });
  it('requires asynchronous descendants to reacquire the filesystem lock after their inherited lease expires', async () => {
    const first = new SessionNotesStore(root);
    const second = new SessionNotesStore(root);
    let entered = false;
    let child!: Promise<void>;
    let scheduled!: () => void;
    const started = new Promise<void>((resolve) => {
      scheduled = resolve;
    });
    await first.transaction('alice', async () => {
      setTimeout(() => {
        child = first.transaction('alice', async () => {
          entered = true;
        });
        scheduled();
      }, 25);
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held!: () => void;
    const acquired = new Promise<void>((resolve) => {
      held = resolve;
    });
    const blocker = second.transaction('alice', async () => {
      held();
      await gate;
    });
    await acquired;
    await started;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const enteredWhileBlocked = entered;
    release();
    await blocker;
    await child;
    expect(enteredWhileBlocked).toBe(false);
    expect(entered).toBe(true);
  });
  it('rebuilds title/body search from disk, combines filters, edits checklists at revision, and lists malformed files', async () => {
    const s = service();
    const draft = await s.open('alice', source, cases);
    const saved = (await s.save('alice', draft.metadata.id, draft.revision, '- [ ] alpha\r\n', 'Roadmap'))!;
    expect(
      (
        await service().list('alice', {
          q: 'roadmap',
          projectId: saved.metadata.projectId,
          sessionId: source.id,
          unfinished: true,
        })
      ).length
    ).toBe(1);
    expect(await s.list('alice', { q: 'missing' })).toEqual([]);
    const checked = await s.complete('alice', saved.metadata.id, saved.revision, 1, true);
    expect(checked.markdown).toBe('- [x] alpha\r\n');
    await expect(s.complete('alice', saved.metadata.id, saved.revision, 1, false)).rejects.toBeInstanceOf(
      SessionNotesConflictError
    );
    const path = join(root, 'alice', 'projects', saved.metadata.projectId, saved.metadata.id + '.md');
    await writeFile(path, (await readFile(path, 'utf8')).replace('alpha', 'external'));
    expect((await s.list('alice', { q: 'external' })).length).toBe(1);
    await writeFile(path, 'broken front matter');
    expect(await s.list('alice')).toMatchObject([{ repairable: true, raw: 'broken front matter' }]);
  });
  it('rescans external changes and notifies only the observed owner, then closes all watchers', async () => {
    const events: string[] = [];
    const s = new SessionNotesService({ root, pollInterval: 20, onChanged: (owner) => events.push(owner) });
    services.push(s);
    const draft = await s.open('alice', source, cases);
    const saved = (await s.save('alice', draft.metadata.id, draft.revision, 'before'))!;
    await s.list('alice');
    events.length = 0;
    const path = join(root, 'alice', 'projects', saved.metadata.projectId, saved.metadata.id + '.md');
    await writeFile(path, (await readFile(path, 'utf8')).replace('before', 'after'));
    await expect.poll(() => events, { timeout: 2000 }).toContain('alice');
    expect(events.every((owner) => owner === 'alice')).toBe(true);
    s.close();
    events.length = 0;
    await writeFile(path, 'after close');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual([]);
  });
  it('orders rows by filesystem modification time and filters newly observed aliases', async () => {
    const s = service();
    const a = await s.open('alice', source, cases);
    await s.save('alice', a.metadata.id, a.revision, 'first');
    const b = await s.open('alice', { ...source, id: 'session2', sessionAliases: [] }, cases);
    await s.save('alice', b.metadata.id, b.revision, 'second');
    await s.open('alice', { ...source, sessionAliases: ['native1', 'later'] }, cases);
    expect(await s.list('alice', { sessionId: 'later' })).toHaveLength(1);
    const path = join(root, 'alice', 'projects', a.metadata.projectId, a.metadata.id + '.md');
    await utimes(path, new Date(), new Date(Date.now() + 10000));
    const list = await s.list('alice');
    expect(list[0].id).toBe(a.metadata.id);
    expect(list[0].lastModified).toBeGreaterThan(list[1].lastModified!);
  });
  it('does not recursively rescan its own owner lock filesystem notifications', async () => {
    const s = new SessionNotesService({ root, pollInterval: 1000, onChanged: () => {} });
    services.push(s);
    const draft = await s.open('alice', source, cases);
    await s.save('alice', draft.metadata.id, draft.revision, 'quiet');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const scans = vi.spyOn(s.store, 'list');
    await s.list('alice');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(scans.mock.calls.length).toBeLessThan(5);
  });
  it('repairs malformed legacy notebooks from retained trusted history without a live source or prior binding', async () => {
    const s = service();
    const store = new SessionNotesStore(root);
    const draft = store.create('alice', {
      id: 'legacy',
      projectId: 'project',
      sessionId: 'removed',
      sessionAliases: [],
      sessionTitle: 'Old',
      title: 'Old notes',
      workingDir: '/old',
      executionLocation: 'local',
    });
    await store.save('alice', draft, 'original');
    await writeFile(join(root, 'alice/projects/project/legacy.md'), 'broken');
    const repaired = await s.repair('alice', 'legacy', noteRevision(Buffer.from('broken')), 'repaired');
    expect(repaired.metadata.sessionId).toBe('removed');
    expect(repaired.markdown).toBe('repaired');
    const history = join(root, 'alice/.history');
    const backups = await Promise.all(
      (await readdir(history))
        .filter((name) => name.endsWith('.md'))
        .map((name) => readFile(join(history, name), 'utf8'))
    );
    expect(backups).toContain('broken');
  });
  it.each(['session', 'alias'])(
    'does not adopt externally forged %s identity or retain false aliases after restoration',
    async (tamper) => {
      const s = service();
      const draft = await s.open('alice', source, cases);
      const saved = (await s.save('alice', draft.metadata.id, draft.revision, 'A private content'))!;
      const path = join(root, 'alice', 'projects', saved.metadata.projectId, saved.metadata.id + '.md');
      const original = await readFile(path);
      const forged = serializeSessionNote(
        tamper === 'session'
          ? { ...saved.metadata, sessionId: 'sessionB', sessionAliases: ['falseAlias'] }
          : { ...saved.metadata, sessionAliases: [...saved.metadata.sessionAliases, 'sessionB', 'falseAlias'] },
        saved.markdown
      );
      await writeFile(path, forged);
      const b = await s.open('alice', { ...source, id: 'sessionB', sessionAliases: [] }, cases);
      expect(b.metadata.id).not.toBe(saved.metadata.id);
      expect(b.markdown).toBe('');
      await expect(s.open('alice', source, cases)).rejects.toMatchObject({
        revision: noteRevision(forged),
        identity: { id: saved.metadata.id, projectId: saved.metadata.projectId },
      });
      expect((await s.list('alice')).find((entry) => entry.id === saved.metadata.id)).toMatchObject({
        repairable: true,
        raw: forged.toString('utf8'),
        revision: noteRevision(forged),
      });
      await expect(s.save('alice', saved.metadata.id, noteRevision(forged), 'overwrite')).rejects.toBeInstanceOf(
        SessionNotesMalformedError
      );
      expect(await readFile(path)).toEqual(forged);
      await writeFile(path, original);
      const recoveredA = await s.open('alice', source, cases);
      const recoveredB = await s.open('alice', { ...source, id: 'sessionB', sessionAliases: [] }, cases);
      expect(recoveredA.metadata.id).toBe(saved.metadata.id);
      expect(recoveredB.metadata.id).toBe(b.metadata.id);
      expect(await s.list('alice', { sessionId: 'falseAlias' })).toEqual([]);
    }
  );
  it('preserves external body/title edits and explicitly repairs provenance using the original binding', async () => {
    const s = service();
    const draft = await s.open('alice', source, cases);
    const saved = (await s.save('alice', draft.metadata.id, draft.revision, 'body'))!;
    let path = join(root, 'alice', 'projects', saved.metadata.projectId, saved.metadata.id + '.md');
    const edited = serializeSessionNote({ ...saved.metadata, title: 'External title' }, 'External body');
    await writeFile(path, edited);
    let valid = await s.read('alice', saved.metadata.id);
    expect(valid.metadata.title).toBe('External title');
    expect(valid.markdown).toBe('External body');
    const target = (await s.projects.list('alice')).find((project) => project.id !== valid.metadata.projectId)!;
    await s.store.reassign('alice', valid, target.id);
    valid = await s.read('alice', saved.metadata.id);
    expect(valid.metadata.projectId).toBe(target.id);
    path = join(root, 'alice', 'projects', target.id, saved.metadata.id + '.md');
    const forged = serializeSessionNote(
      { ...valid.metadata, workingDir: '/forged', sessionTitle: 'Forged origin' },
      valid.markdown
    );
    await writeFile(path, forged);
    await expect(s.read('alice', saved.metadata.id)).rejects.toBeInstanceOf(SessionNotesMalformedError);
    const repaired = await s.repair('alice', saved.metadata.id, noteRevision(forged), valid.markdown);
    expect(repaired.metadata.workingDir).toBe(source.workingDir);
    expect(repaired.metadata.sessionTitle).toBe(source.name);
    expect(repaired.metadata.title).toBe('External title');
    expect(repaired.markdown).toBe('External body');
  });
});
