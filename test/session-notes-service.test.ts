import { mkdtemp, rm, writeFile, readFile, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionNotesService } from '../src/session-notes-service.js';
import { SessionNotesConflictError, SessionNotesStore } from '../src/session-notes-store.js';
import { noteRevision } from '../src/session-notes-markdown.js';

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
    await expect(first.save('alice', a.metadata.id, '', 'draft')).rejects.toThrow('disk failure');
    const retry = await service().read('alice', a.metadata.id);
    expect(retry.metadata.sessionId).toBe(source.id);
    const saved = await service().save('alice', a.metadata.id, retry.revision, 'remember');
    expect(saved!.markdown).toBe('remember');
    await expect(service().save('alice', b.metadata.id, '', 'other tab')).rejects.toBeInstanceOf(
      SessionNotesConflictError
    );
    await expect(service().read('bob', a.metadata.id)).rejects.toThrow();
  });
  it('uses launch case before cwd inference and retains reassignment when reopened through new trusted aliases', async () => {
    const s = service();
    const draft = await s.open('alice', { ...source, notesLaunchCase: cases[0] }, cases);
    const projects = await s.projects.list('alice');
    expect(projects.find((p) => p.id === draft.metadata.projectId)!.name).toBe('Repo');
    const saved = (await s.save('alice', draft.metadata.id, '', '- [ ] todo'))!;
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
    await s.reassign('alice', draft.metadata.id, '', other.id);
    const renamed = await s.save('alice', draft.metadata.id, '', '', 'Custom');
    expect(renamed!.metadata.title).toBe('Custom');
    const reloaded = await service().read('alice', draft.metadata.id);
    expect(reloaded.metadata.projectId).toBe(other.id);
    expect(reloaded.metadata.title).toBe('Custom');
    expect(await s.store.list('alice')).toEqual([]);
  });
  it('rebuilds title/body search from disk, combines filters, edits checklists at revision, and lists malformed files', async () => {
    const s = service();
    const draft = await s.open('alice', source, cases);
    const saved = (await s.save('alice', draft.metadata.id, '', '- [ ] alpha\r\n', 'Roadmap'))!;
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
    const saved = (await s.save('alice', draft.metadata.id, '', 'before'))!;
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
    await s.save('alice', a.metadata.id, '', 'first');
    const b = await s.open('alice', { ...source, id: 'session2', sessionAliases: [] }, cases);
    await s.save('alice', b.metadata.id, '', 'second');
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
    await s.save('alice', draft.metadata.id, '', 'quiet');
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
});
