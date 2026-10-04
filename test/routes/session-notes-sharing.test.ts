import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionNotesService } from '../../src/session-notes-service.js';
import { registerSessionNotesRoutes } from '../../src/web/routes/session-notes-routes.js';
let root: string;
let notes: SessionNotesService;
let app: ReturnType<typeof Fastify>;
let username = 'alice';
let destinationOwner = 'alice';
let live = true;
const input = vi.fn(async (_id: string, owner?: string) => ({
  delivery: live && owner === destinationOwner ? 'submitted' : 'failed',
}));
const source = { id: 'origin', owner: 'alice', workingDir: '/repo', name: 'Source title' };
beforeEach(async () => {
  vi.stubEnv('CODEMAN_MULTIUSER', '1');
  username = destinationOwner = 'alice';
  live = true;
  input.mockClear();
  root = await mkdtemp(join(tmpdir(), 'notes-sharing-'));
  notes = new SessionNotesService({ root });
  app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.authUser = { username, role: 'admin' } as never;
  });
  registerSessionNotesRoutes(app, {
    sessionNotes: notes,
    getNotesSource: async (id, owner) => (id === source.id && owner === source.owner ? source : null),
    listNotesCases: async () => [],
    listNotesDestinations: async (owner) =>
      live && owner === destinationOwner ? [{ id: 'destination', name: 'Live destination' }] : [],
    sendNotesInput: input,
  } as any);
});
afterEach(async () => {
  await app.close();
  notes.close();
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function notebook() {
  const opened = (
    await app.inject({ method: 'POST', url: '/api/session-notes/open', payload: { sessionId: source.id } })
  ).json().data;
  return (
    await app.inject({
      method: 'PUT',
      url: '/api/session-notes/' + opened.metadata.id,
      payload: { revision: opened.revision, markdown: 'preserve\r\n\r\n' },
    })
  ).json().data;
}
it('keeps ordinary notes private and confirms exactly previewed text once to a live chosen destination', async () => {
  const note = await notebook();
  const url = '/api/session-notes/' + note.metadata.id;
  await app.inject(url);
  await app.inject('/api/session-notes');
  expect(input).not.toHaveBeenCalled();
  const preview = await app.inject({
    method: 'POST',
    url: url + '/send-preview',
    payload: { destinationId: 'destination', text: 'selected draft only' },
  });
  expect(preview.statusCode).toBe(200);
  expect(input).not.toHaveBeenCalled();
  expect(preview.json().data).toMatchObject({ text: 'selected draft only', destination: { id: 'destination' } });
  const confirm = () =>
    app.inject({ method: 'POST', url: url + '/send', payload: { token: preview.json().data.token } });
  const results = await Promise.all([confirm(), confirm()]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  expect(input).toHaveBeenCalledTimes(1);
  expect(input).toHaveBeenCalledWith('destination', 'alice', 'selected draft only');
  expect((await app.inject(url)).json().data.markdown).toBe(note.markdown);
});
it('rejects foreign notebook and destination even for admins and rechecks destination at dispatch', async () => {
  const note = await notebook();
  const url = '/api/session-notes/' + note.metadata.id;
  username = 'root';
  expect((await app.inject('/api/session-notes/destinations')).json().data).toEqual([]);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: url + '/send-preview',
        payload: { destinationId: 'destination', text: 'x' },
      })
    ).statusCode
  ).toBe(404);
  username = 'alice';
  const preview = (
    await app.inject({
      method: 'POST',
      url: url + '/send-preview',
      payload: { destinationId: 'destination', text: 'x' },
    })
  ).json().data;
  live = false;
  const sent = await app.inject({ method: 'POST', url: url + '/send', payload: { token: preview.token } });
  expect(sent.json().data.delivery).toBe('failed');
  expect((await app.inject({ method: 'POST', url: url + '/send', payload: { token: preview.token } })).statusCode).toBe(
    400
  );
});
it('appends selected response with trusted server timestamp/source and preserves existing bytes with concurrent revision checks', async () => {
  const note = await notebook();
  const url = '/api/session-notes/' + note.metadata.id;
  const payload = { revision: note.revision, sourceSessionId: source.id, text: 'selected response' };
  const results = await Promise.all(
    [0, 1].map(() => app.inject({ method: 'POST', url: url + '/append-response', payload }))
  );
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  const saved = results.find((r) => r.statusCode === 200)!.json().data;
  expect(saved.markdown.startsWith(note.markdown)).toBe(true);
  expect(saved.markdown).toMatch(/\d{4}-\d\d-\d\dT.*Z/);
  expect(saved.markdown).toContain('origin');
  expect(saved.markdown).toContain('selected response');
  expect(input).not.toHaveBeenCalled();
  expect(
    (
      await app.inject({
        method: 'POST',
        url: url + '/append-response',
        payload: { ...payload, sourceSessionId: 'foreign' },
      })
    ).statusCode
  ).toBe(404);
  expect(
    (await app.inject({ method: 'POST', url: url + '/append-response', payload: { ...payload, timestamp: 'forged' } }))
      .statusCode
  ).toBe(400);
});

it('retains malformed append target and rejects blank/control text, forged owner and altered confirmation payload', async () => {
  const note = await notebook();
  const url = '/api/session-notes/' + note.metadata.id;
  for (const text of ['', '   ', '\u001b[201~unwanted']) {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: url + '/send-preview',
          payload: { destinationId: 'destination', text },
        })
      ).statusCode
    ).toBe(400);
  }
  expect(
    (
      await app.inject({
        method: 'POST',
        url: url + '/send-preview',
        payload: { destinationId: 'destination', text: 'x', owner: 'bob' },
      })
    ).statusCode
  ).toBe(400);
  const preview = (
    await app.inject({
      method: 'POST',
      url: url + '/send-preview',
      payload: { destinationId: 'destination', text: 'preview' },
    })
  ).json().data;
  expect(
    (await app.inject({ method: 'POST', url: url + '/send', payload: { token: preview.token, text: 'replacement' } }))
      .statusCode
  ).toBe(400);
  username = 'root';
  expect(
    (
      await app.inject({
        method: 'POST',
        url: url + '/append-response',
        payload: { revision: note.revision, sourceSessionId: source.id, text: 'capture' },
      })
    ).statusCode
  ).toBe(404);
  username = 'alice';
  const { writeFile } = await import('node:fs/promises');
  const { sessionNotesOwnerKey } = await import('../../src/session-notes-projects.js');
  const file = join(root, sessionNotesOwnerKey('alice'), 'projects', note.metadata.projectId, note.metadata.id + '.md');
  await writeFile(file, 'malformed retained bytes');
  const result = await app.inject({
    method: 'POST',
    url: url + '/append-response',
    payload: { revision: note.revision, sourceSessionId: source.id, text: 'capture' },
  });
  expect(result.statusCode).toBe(422);
  expect(result.json().data.raw).toBe('malformed retained bytes');
  expect(input).not.toHaveBeenCalled();
});

it('fails closed for expired previews without retaining an unbounded replay ledger', async () => {
  const note = await notebook();
  const url = '/api/session-notes/' + note.metadata.id;
  const preview = (
    await app.inject({
      method: 'POST',
      url: url + '/send-preview',
      payload: { destinationId: 'destination', text: 'preview' },
    })
  ).json().data;
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300001);
  try {
    expect(
      (await app.inject({ method: 'POST', url: url + '/send', payload: { token: preview.token } })).statusCode
    ).toBe(400);
    expect(input).not.toHaveBeenCalled();
  } finally {
    now.mockRestore();
  }
});

it('keeps an append within the editable notebook size limit without changing the existing body', async () => {
  const note = await notebook();
  const url = '/api/session-notes/' + note.metadata.id;
  const full = (
    await app.inject({ method: 'PUT', url, payload: { revision: note.revision, markdown: 'x'.repeat(1024 * 1024) } })
  ).json().data;
  const result = await app.inject({
    method: 'POST',
    url: url + '/append-response',
    payload: { revision: full.revision, sourceSessionId: source.id, text: 'capture' },
  });
  expect(result.statusCode).toBe(400);
  expect((await app.inject(url)).json().data.revision).toBe(full.revision);
});

it('appends a human-readable trusted source reference with Markdown punctuation escaped', async () => {
  const note = await notebook();
  const url = '/api/session-notes/' + note.metadata.id;
  const previous = source.name;
  source.name = '<Source> [x] *title*\nnext';
  try {
    const result = await app.inject({
      method: 'POST',
      url: url + '/append-response',
      payload: { revision: note.revision, sourceSessionId: source.id, text: 'response' },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().data.markdown).toContain('Source session: \\<Source\\> \\[x\\] \\*title\\* next · origin');
    expect(result.json().data.markdown).not.toContain('sessionTitle');
  } finally {
    source.name = previous;
  }
});
