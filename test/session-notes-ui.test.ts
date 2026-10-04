// @vitest-environment jsdom
import { readFileSync, existsSync } from 'node:fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const path = 'src/web/public/session-notes-editor.js';
let Editor: any;
const note = (id = 'one', revision = 'r1', markdown = '') => ({
  metadata: { id, title: id, sessionId: 'source', projectId: 'project' },
  revision,
  markdown,
});
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  if (existsSync(path)) (0, eval)(readFileSync(path, 'utf8'));
  Editor = (window as any).SessionNotesEditor;
});
afterEach(() => vi.useRealTimers());
function create(request = vi.fn(async (_path, body) => note('one', 'r2', body.markdown))) {
  expect(Editor, 'shipping notes controller exists').toBeTypeOf('function');
  return new Editor({ scope: { instanceKey: 'instance', ownerKey: 'owner' }, storage: localStorage, request });
}
it('debounces for 750ms and reports persisted state only after success', async () => {
  const request = vi.fn(async (_path, body) => note('one', 'r2', body.markdown));
  const e = create(request);
  e.load(note());
  e.edit('hello', 'Title');
  expect(e.current.status).toBe('Unsaved');
  await vi.advanceTimersByTimeAsync(749);
  expect(request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(request).toHaveBeenCalledTimes(1);
  expect(e.current.status).toBe('Saved');
  expect(localStorage.length).toBe(0);
});
it('retains first-save draft and identity on failure then retries', async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error('disk full'))
    .mockResolvedValueOnce(note('one', 'r2', 'draft'));
  const e = create(request);
  e.load(note('one', 'draft-token'));
  e.edit('draft', 'one');
  await e.flush();
  expect(e.current.status).toBe('Save failed');
  expect(localStorage.length).toBe(1);
  const restored = create(request);
  restored.load(note('one', 'draft-token'));
  expect(restored.current.markdown).toBe('draft');
  await restored.flush();
  expect(restored.current.status).toBe('Saved');
  expect(request.mock.calls[1][0]).toContain('/one');
});
it('scopes drafts to instance owner and notebook and compares stale restored drafts', () => {
  const e = create();
  e.load(note());
  e.edit('private', 'one');
  const other = new Editor({
    scope: { instanceKey: 'other', ownerKey: 'owner' },
    storage: localStorage,
    request: vi.fn(),
  });
  other.load(note());
  expect(other.current.markdown).toBe('');
  const restored = create();
  restored.load(note('one', 'external', 'external'));
  expect(restored.current.markdown).toBe('private');
  expect(restored.current.conflict.markdown).toBe('external');
});
it('never applies an old save response to another notebook or erases newer edits', async () => {
  let finish: any;
  const e = create(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  e.load(note());
  e.edit('sent', 'one');
  const saving = e.flush();
  expect(e.current.status).toBe('Saving');
  e.edit('newer', 'one');
  e.load(note('two'));
  finish(note('one', 'r2', 'sent'));
  await saving;
  expect(e.current.id).toBe('two');
  e.load(note('one', 'r2', 'sent'));
  expect(e.current.markdown).toBe('newer');
  expect(e.current.revision).toBe('r2');
  expect(localStorage.length).toBe(1);
});
it('reloads clean external changes and preserves dirty conflicts with explicit resolution', async () => {
  const e = create();
  e.load(note());
  e.external(note('one', 'r2', 'external'));
  expect(e.current.markdown).toBe('external');
  e.edit('mine', 'one');
  e.external(note('one', 'r3', 'theirs'));
  expect(e.current.markdown).toBe('mine');
  expect(e.current.conflict.markdown).toBe('theirs');
  e.resolve('combine');
  expect(e.current.markdown).toContain('mine');
  expect(e.current.markdown).toContain('theirs');
  expect(e.current.revision).toBe('r3');
});
it('a revision conflict keeps both versions without automatic overwrite', async () => {
  const e = create(vi.fn().mockRejectedValue({ status: 409, current: note('one', 'r3', 'theirs') }));
  e.load(note());
  e.edit('mine', 'one');
  await e.flush();
  expect(e.current.conflict.markdown).toBe('theirs');
  expect(e.current.markdown).toBe('mine');
  expect(localStorage.length).toBe(1);
});
it('shipping UI opens a side editor and a canonical global browser without resuming sessions', async () => {
  const uiPath = 'src/web/public/session-notes-ui.js';
  (window as any).CodemanApp = function () {};
  if (existsSync(uiPath)) (0, eval)('var CodemanApp = window.CodemanApp;\n' + readFileSync(uiPath, 'utf8'));
  const app = Object.create((window as any).CodemanApp.prototype);
  expect(app.openSessionNotes, 'session Notes action exists').toBeTypeOf('function');
  document.body.innerHTML = '<div class="terminal-wrap"><div id="terminalContainer"></div></div>';
  app._notesRequest = vi.fn(async (path: string) =>
    path === '/context'
      ? { ownerKey: 'owner', instanceKey: 'instance' }
      : path === '/projects'
        ? [{ id: 'project', name: 'Project' }]
        : path.startsWith('?') || path === ''
          ? [{ id: 'one', projectId: 'project', note: note(), unfinishedCount: 0 }]
          : path === '/recovery'
            ? []
            : note()
  );
  app.resumeHistorySession = vi.fn();
  await app.openSessionNotes('source');
  expect(document.querySelector('.session-notes-panel')).not.toBeNull();
  expect(document.querySelector('textarea[aria-label="Markdown notes"]')).not.toBeNull();
  await app.openNotesBrowser();
  expect(document.querySelector('[aria-label="Search notes"]')).not.toBeNull();
  expect(document.body.textContent).toContain('All projects');
  expect(app.resumeHistorySession).not.toHaveBeenCalled();
});
it('inflight external notifications wait for save then read canonical content', async () => {
  const uiPath = 'src/web/public/session-notes-ui.js';
  (window as any).CodemanApp = function () {};
  (0, eval)('var CodemanApp = window.CodemanApp;\n' + readFileSync(uiPath, 'utf8'));
  const app = Object.create((window as any).CodemanApp.prototype);
  let finish: any;
  const saving = new Promise((resolve) => {
    finish = resolve;
  });
  app._notesScope = { ownerKey: 'owner' };
  app._notesShell = {};
  app._notesEditorElements = {};
  const current = { id: 'one', revision: 'before', saving };
  app._notesController = { current, external: vi.fn() };
  app._notesRequest = vi.fn(async () => note('one', 'after', 'latest canonical'));
  app._refreshNotesList = vi.fn();
  const pending = app._onNotesChanged({ ownerKey: 'owner' });
  expect(app._notesRequest).not.toHaveBeenCalled();
  finish(null);
  await pending;
  expect(app._notesController.external).toHaveBeenCalledWith(note('one', 'after', 'latest canonical'));
});
it('does not clear a newer stored draft when an older save succeeds while editing', async () => {
  let finish: any;
  const e = create(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  e.load(note());
  e.edit('first', 'one');
  const saving = e.flush();
  e.edit('second', 'two');
  finish(note('one', 'r2', 'first'));
  await saving;
  const draft = JSON.parse(localStorage.getItem(e.key('one'))!);
  expect(draft).toEqual({ revision: 'r2', markdown: 'second', title: 'two' });
  expect(e.current.status).toBe('Unsaved');
});
it('blocks automatic saves when a 409 returns malformed current bytes', async () => {
  const request = vi
    .fn()
    .mockRejectedValue({ status: 409, current: { raw: 'broken frontmatter', revision: 'changed', repairable: true } });
  const e = create(request);
  e.load(note());
  e.edit('mine', 'one');
  await e.flush();
  expect(e.current.conflict.raw).toBe('broken frontmatter');
  e.edit('still mine', 'one');
  await vi.advanceTimersByTimeAsync(750);
  expect(request).toHaveBeenCalledTimes(1);
  expect(e.current.markdown).toBe('still mine');
});
it('reload resolution explicitly discards only its corresponding draft', () => {
  const e = create();
  e.load(note());
  e.edit('private', 'one');
  e.external(note('one', 'r2', 'current'));
  e.resolve('reload');
  expect(e.current.markdown).toBe('current');
  expect(e.current.status).toBe('Saved');
  expect(localStorage.length).toBe(0);
});
it('recovery actions use a canonical notebook revision when the list entry has no separate raw revision', async () => {
  (window as any).CodemanApp = function () {};
  (0, eval)('var CodemanApp = window.CodemanApp;\n' + readFileSync('src/web/public/session-notes-ui.js', 'utf8'));
  const app = Object.create((window as any).CodemanApp.prototype);
  app._notesRequest = vi.fn(async () => null);
  app._refreshNotesList = vi.fn();
  app._notesError = vi.fn();
  await app._resolveNotesRecovery({ id: 'one', projectId: 'project', note: note('one', 'canonical') }, 'external');
  expect(app._notesRequest).toHaveBeenCalledWith(
    '/one/resolve-recovery',
    { revision: 'canonical', projectId: 'project', choice: 'external' },
    'POST'
  );
});
function repairingApp() {
  (window as any).CodemanApp = function () {};
  (0, eval)('var CodemanApp = window.CodemanApp;\n' + readFileSync('src/web/public/session-notes-ui.js', 'utf8'));
  document.body.innerHTML = '<div class="terminal-wrap"><div id="terminalContainer"></div></div>';
  const app = Object.create((window as any).CodemanApp.prototype);
  app._notesProjects = [];
  app._notesController = create();
  app._notesController.changed = (state: any) => app._renderNotesState(state);
  app._refreshNotesList = vi.fn();
  app._createNotesShell('browser');
  app._mountNotesRepair({ id: 'one', raw: 'broken', revision: 'r1', repairable: true });
  let resolve: any, reject: any;
  const deferred = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  app._notesRequest = vi.fn(async (path: string) =>
    path.endsWith('/repair') ? deferred : note('two', 'r2', 'second notebook')
  );
  const button = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Repair notebook')!;
  button.click();
  return { app, resolve, reject };
}
it('a deferred repair cannot replace a second notebook selected while repair is pending', async () => {
  const { app, resolve } = repairingApp();
  await app.openNotesNotebook('two');
  resolve(note('one', 'repaired', 'repaired first'));
  await vi.advanceTimersByTimeAsync(0);
  expect(app._notesController.current.id).toBe('two');
  expect(app._notesEditorElements.markdown.value).toBe('second notebook');
});
it('a deferred repair cannot mount into a closed and reopened notes shell', async () => {
  const { app, resolve } = repairingApp();
  app.closeSessionNotes();
  app._createNotesShell('browser');
  app._mountNotesEditor(note('two', 'r2', 'second notebook'));
  resolve(note('one', 'repaired', 'repaired first'));
  await vi.advanceTimersByTimeAsync(0);
  expect(app._notesController.current.id).toBe('two');
  expect(app._notesEditorElements.markdown.value).toBe('second notebook');
});
it('a deferred repair failure cannot render an error on a subsequently selected notebook', async () => {
  const { app, reject } = repairingApp();
  await app.openNotesNotebook('two');
  reject(new Error('failure from old repair'));
  await vi.advanceTimersByTimeAsync(0);
  expect(app._notesErrorElement.textContent).toBe('');
  expect(app._notesController.current.id).toBe('two');
});
for (const status of [422, 500]) {
  for (const navigation of ['switch', 'reopen']) {
    it(`ignores a deferred SSE ${status} failure after ${navigation} without presenting stale content or errors`, async () => {
      const { app } = repairingApp();
      app._mountNotesEditor(note('one', 'r1', 'first notebook'));
      app._notesScope = { ownerKey: 'owner' };
      let reject: any;
      const request = new Promise((_resolve, rejectRequest) => {
        reject = rejectRequest;
      });
      app._notesRequest = vi.fn((path: string) =>
        path === '/one' ? request : Promise.resolve(note('two', 'r2', 'second notebook'))
      );
      const notification = app._onNotesChanged({ ownerKey: 'owner' });
      if (navigation === 'switch') await app.openNotesNotebook('two');
      else {
        app.closeSessionNotes();
        app._createNotesShell('browser');
      }
      reject(
        Object.assign(new Error('stale failed read'), {
          status,
          data: { id: 'one', raw: 'stale broken bytes', revision: 'bad', repairable: true },
        })
      );
      await notification;
      expect(app._notesErrorElement.textContent).toBe('');
      expect(app._notesEditorHost.textContent).not.toContain('stale broken bytes');
      expect(app._refreshNotesList).not.toHaveBeenCalled();
      if (navigation === 'switch') expect(app._notesController.current.id).toBe('two');
      app._notesRequest = vi.fn(async () => note(app._notesController.current.id, 'fresh', 'current owner update'));
      await app._onNotesChanged({ ownerKey: 'owner' });
      expect(app._refreshNotesList).toHaveBeenCalledTimes(1);
      if (navigation === 'switch') expect(app._notesEditorElements.markdown.value).toBe('current owner update');
    });
  }
}
it('successful save clears only its own snapshot and preserves another controller failed draft', async () => {
  let finish: any;
  const a = create(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const b = create(vi.fn().mockRejectedValue(new Error('failed B')));
  a.load(note());
  b.load(note());
  a.edit('draft A', 'one');
  const saving = a.flush();
  b.edit('private failed B', 'one');
  await b.flush();
  finish(note('one', 'r2', 'draft A'));
  await saving;
  const restored = create();
  restored.load(note('one', 'r2', 'draft A'));
  expect(restored.current.markdown).toBe('private failed B');
  expect(b.current.status).toBe('Save failed');
});
it('reload resolution clears only its own stored draft, preserving another controller draft', () => {
  const a = create(),
    b = create();
  a.load(note());
  b.load(note());
  a.edit('draft A', 'one');
  a.external(note('one', 'r2', 'external'));
  b.edit('draft B', 'one');
  a.resolve('reload');
  const restored = create();
  restored.load(note('one', 'r2', 'external'));
  expect(restored.current.markdown).toBe('draft B');
});
it('a deferred failed save cannot overwrite another controller newer stored draft', async () => {
  let reject: any;
  const a = create(
    () =>
      new Promise((_resolve, failure) => {
        reject = failure;
      })
  );
  const b = create();
  a.load(note());
  b.load(note());
  a.edit('draft A', 'one');
  const saving = a.flush();
  b.edit('draft B', 'one');
  reject(new Error('failed A'));
  await saving;
  const restored = create();
  restored.load(note());
  expect(restored.current.markdown).toBe('draft B');
});
it('successful inflight save bookkeeping cannot replace another controller newer stored draft', async () => {
  let finish: any;
  const a = create(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const b = create();
  a.load(note());
  b.load(note());
  a.edit('sent A', 'one');
  const saving = a.flush();
  a.edit('newer A', 'one');
  b.edit('newer B', 'one');
  finish(note('one', 'r2', 'sent A'));
  await saving;
  const restored = create();
  restored.load(note('one', 'r2', 'sent A'));
  expect(restored.current.markdown).toBe('newer B');
  expect(a.current.markdown).toBe('newer A');
});
it('a stale list failure cannot display an error in a reopened browser', async () => {
  const { app } = repairingApp();
  app._mountNotesBrowser();
  delete app._refreshNotesList;
  let reject: any;
  const request = new Promise((_resolve, failure) => {
    reject = failure;
  });
  app._notesRequest = vi.fn(() => request);
  const pending = app._refreshNotesList();
  app.closeSessionNotes();
  app._createNotesShell('browser');
  reject(new Error('stale list failure'));
  await pending;
  expect(app._notesErrorElement.textContent).toBe('');
});
it('a stale recovery failure cannot display an error in a reopened browser', async () => {
  const { app } = repairingApp();
  let reject: any;
  app._notesRequest = vi.fn(
    () =>
      new Promise((_resolve, failure) => {
        reject = failure;
      })
  );
  const pending = app._resolveNotesRecovery({ id: 'one', projectId: 'project', note: note() }, 'external');
  app.closeSessionNotes();
  app._createNotesShell('browser');
  reject(new Error('stale recovery failure'));
  await pending;
  expect(app._notesErrorElement.textContent).toBe('');
});
it('a stale project rename failure cannot display an error in a reopened browser', async () => {
  const { app } = repairingApp();
  app._notesProjects = [{ id: 'project', name: 'Project' }];
  app._mountNotesBrowser();
  let reject: any;
  app._notesRequest = vi.fn(
    () =>
      new Promise((_resolve, failure) => {
        reject = failure;
      })
  );
  const prompt = vi.spyOn(window, 'prompt').mockReturnValue('Renamed');
  (document.querySelector('[aria-label="Rename project Project"]') as HTMLButtonElement).click();
  app.closeSessionNotes();
  app._createNotesShell('browser');
  reject(new Error('stale rename failure'));
  await vi.advanceTimersByTimeAsync(0);
  prompt.mockRestore();
  expect(app._notesErrorElement.textContent).toBe('');
});
it('a stale project reassignment failure cannot display an error in a reopened browser', async () => {
  const { app } = repairingApp();
  app._notesProjects = [
    { id: 'project', name: 'Project' },
    { id: 'other', name: 'Other' },
  ];
  app._mountNotesEditor(note());
  let reject: any;
  app._notesRequest = vi.fn(
    () =>
      new Promise((_resolve, failure) => {
        reject = failure;
      })
  );
  app._notesEditorElements.project.value = 'other';
  app._notesEditorElements.project.dispatchEvent(new Event('change'));
  await vi.advanceTimersByTimeAsync(0);
  app.closeSessionNotes();
  app._createNotesShell('browser');
  reject(new Error('stale move failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(app._notesErrorElement.textContent).toBe('');
});
it('a stale checklist failure cannot display an error in a reopened browser', async () => {
  const { app } = repairingApp();
  app._mountNotesBrowser();
  delete app._refreshNotesList;
  app._notesRequest = vi.fn(async (path: string) =>
    path === '/recovery'
      ? []
      : [{ id: 'one', projectId: 'project', note: note(), checklist: [{ line: 1, checked: false, text: 'task' }] }]
  );
  await app._refreshNotesList();
  let reject: any;
  app._notesRequest = vi.fn(
    () =>
      new Promise((_resolve, failure) => {
        reject = failure;
      })
  );
  (document.querySelector('[aria-label="Complete task"]') as HTMLInputElement).dispatchEvent(new Event('change'));
  app.closeSessionNotes();
  app._createNotesShell('browser');
  reject(new Error('stale checklist failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(app._notesErrorElement.textContent).toBe('');
});
