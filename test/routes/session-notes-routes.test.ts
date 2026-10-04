import Fastify from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionNotesService } from '../../src/session-notes-service.js';
import { sessionNotesOwnerKey } from '../../src/session-notes-projects.js';
import { registerSessionNotesRoutes } from '../../src/web/routes/session-notes-routes.js';

describe('notebook API real filesystem', () => {
  let root: string;
  let notes: SessionNotesService;
  const apps: ReturnType<typeof Fastify>[] = [];
  const source = { id: 'session1', owner: 'alice', workingDir: '/repo', name: 'Session' };
  let available = true;
  async function harness(username = 'alice', role = 'user') {
    const app = Fastify();
    apps.push(app);
    app.addHook('onRequest', async (req) => {
      req.authUser = { username, role } as never;
    });
    registerSessionNotesRoutes(app, {
      sessionNotes: notes,
      getNotesSource: async (_id, owner) => (available && source.owner === owner ? source : null),
      listNotesCases: async () => [
        { name: 'Repo', path: '/repo', hasClaudeMd: false },
        { name: 'Other', path: '/other', hasClaudeMd: false },
      ],
    });
    return app;
  }
  beforeEach(async () => {
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    available = true;
    root = await mkdtemp(join(tmpdir(), 'notes-api-'));
    notes = new SessionNotesService({ root });
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    notes.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  it('returns an opaque stable context scoped to instance and authenticated owner', async () => {
    const app = await harness();
    const context = (await app.inject('/api/session-notes/context')).json().data;
    expect(context.ownerKey).toBe(sessionNotesOwnerKey('alice'));
    expect(context.instanceKey).toMatch(/^[a-f0-9]{64}$/);
    expect((await app.inject('/api/session-notes/context')).json().data).toEqual(context);
    const bob = await harness('bob');
    expect((await bob.inject('/api/session-notes/context')).json().data.ownerKey).not.toBe(context.ownerKey);
    const second = new SessionNotesService({ root: join(root, 'other-instance') });
    expect((await second.context(sessionNotesOwnerKey('alice'))).instanceKey).not.toBe(context.instanceKey);
    second.close();
  });
  it('opens once, rejects forged provenance and owner fields, saves historical notes, and returns current bytes on stale saves', async () => {
    const app = await harness();
    const open = await app.inject({
      method: 'POST',
      url: '/api/session-notes/open',
      payload: { sessionId: 'session1' },
    });
    expect(open.statusCode).toBe(200);
    const draft = open.json().data;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/session-notes/open',
          payload: { sessionId: 'session1', owner: 'bob' },
        })
      ).statusCode
    ).toBe(400);
    const url = '/api/session-notes/' + draft.metadata.id;
    expect(
      (
        await app.inject({
          method: 'PUT',
          url,
          payload: { revision: '', markdown: 'x', metadata: { ownerKey: 'bob' } },
        })
      ).statusCode
    ).toBe(400);
    available = false;
    const saved = await app.inject({
      method: 'PUT',
      url,
      payload: { revision: '', markdown: '- [ ] task\r\n', title: 'Roadmap' },
    });
    expect(saved.statusCode).toBe(200);
    const note = saved.json().data;
    const conflict = await app.inject({ method: 'PUT', url, payload: { revision: '', markdown: 'overwrite' } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().data.current).toEqual(note);
    expect((await app.inject(url)).json().data).toEqual(note);
    expect((await app.inject(url + '/export')).body).toBe('- [ ] task\r\n');
    expect(
      (await app.inject('/api/session-notes?q=roadmap&unfinished=true&sessionId=session1')).json().data
    ).toHaveLength(1);
    const checked = await app.inject({
      method: 'PATCH',
      url: url + '/checklist',
      payload: { revision: note.revision, line: 1, checked: true },
    });
    expect(checked.json().data.markdown).toBe('- [x] task\r\n');
    const projects = (await app.inject('/api/session-notes/projects')).json().data;
    const target = projects.find((p: { name: string }) => p.name === 'Other');
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/session-notes/projects/' + target.id,
          payload: { name: 'Renamed' },
        })
      ).json().data.name
    ).toBe('Renamed');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: url + '/reassign',
          payload: { revision: checked.json().data.revision, projectId: target.id },
        })
      ).json().data.metadata.projectId
    ).toBe(target.id);
    const bob = await harness('bob');
    const admin = await harness('root', 'admin');
    for (const other of [bob, admin]) {
      expect((await other.inject(url)).statusCode).toBe(404);
      expect((await other.inject('/api/session-notes?owner=alice')).json().data).toEqual([]);
      available = true;
      expect(
        (await other.inject({ method: 'POST', url: '/api/session-notes/open', payload: { sessionId: source.id } }))
          .statusCode
      ).toBe(404);
    }
  });
  it('exposes malformed bytes and revision, allowing an explicit repair with trusted retained provenance', async () => {
    const app = await harness();
    const draft = (
      await app.inject({ method: 'POST', url: '/api/session-notes/open', payload: { sessionId: source.id } })
    ).json().data;
    const url = '/api/session-notes/' + draft.metadata.id;
    await app.inject({ method: 'PUT', url, payload: { revision: '', markdown: 'first' } });
    await writeFile(
      join(root, sessionNotesOwnerKey('alice'), 'projects', draft.metadata.projectId, draft.metadata.id + '.md'),
      'broken'
    );
    const malformed = await app.inject(url);
    expect(malformed.statusCode).toBe(422);
    expect(malformed.json().data.raw).toBe('broken');
    expect((await app.inject('/api/session-notes')).json().data[0].repairable).toBe(true);
    const repaired = await app.inject({
      method: 'POST',
      url: url + '/repair',
      payload: { revision: malformed.json().data.revision, markdown: 'repaired' },
    });
    expect(repaired.statusCode).toBe(200);
    expect(repaired.json().data.metadata.sessionId).toBe(source.id);
    expect((await app.inject('/api/session-notes/recovery')).json().data).toEqual([]);
  });
  it('returns input/not-found errors for nonexistent checklist markers and project identities', async () => {
    const app = await harness();
    const draft = (
      await app.inject({ method: 'POST', url: '/api/session-notes/open', payload: { sessionId: source.id } })
    ).json().data;
    const url = '/api/session-notes/' + draft.metadata.id;
    const note = (await app.inject({ method: 'PUT', url, payload: { revision: '', markdown: '- [ ] task' } })).json()
      .data;
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: url + '/checklist',
          payload: { revision: note.revision, line: 2, checked: true },
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: url + '/reassign',
          payload: { revision: note.revision, projectId: 'missing' },
        })
      ).statusCode
    ).toBe(404);
    expect(
      (await app.inject({ method: 'PATCH', url: '/api/session-notes/projects/missing', payload: { name: 'Title' } }))
        .statusCode
    ).toBe(404);
  });
});
