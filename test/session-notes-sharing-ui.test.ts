// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
let app: any;
const note = {
  metadata: { id: 'one', sessionId: 'origin', title: 'Notebook', projectId: 'p' },
  markdown: 'private before SELECTED private after',
  revision: 'r1',
};
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div class="terminal-wrap"></div>';
  (window as any).CodemanApp = function () {};
  (0, eval)('var CodemanApp = window.CodemanApp;\n' + readFileSync('src/web/public/session-notes-ui.js', 'utf8'));
  (0, eval)(readFileSync('src/web/public/session-notes-editor.js', 'utf8'));
  app = Object.create((window as any).CodemanApp.prototype);
  app._notesProjects = [];
  app.activeSessionId = 'live';
  app._notesController = new (window as any).SessionNotesEditor({ scope: {}, storage: localStorage, request: vi.fn() });
  app._notesController.changed = (state: any) => app._renderNotesState(state);
  app.showToast = vi.fn();
  app._initSessionNotes = vi.fn();
  app._refreshNotesList = vi.fn();
  app._createNotesShell('browser');
  app._mountNotesEditor(note);
  app._notesRequest = vi.fn(async (path: string, body: any) =>
    path === '/destinations'
      ? [{ id: 'live', name: 'Chosen live', mode: 'claude' }]
      : path.endsWith('/send-preview')
        ? { token: 'token', text: body.text, destination: { id: body.destinationId, name: 'Chosen live' } }
        : path.endsWith('/send')
          ? { delivery: 'submitted' }
          : path === ''
            ? [{ id: 'one', note }]
            : note
  );
});
afterEach(() => {
  app.closeSessionNotes();
  vi.useRealTimers();
  localStorage.clear();
});
const click = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!.click();
it('previews selected notes only, requires an explicit destination for an inactive origin, and sends once on double click', async () => {
  app._notesEditorElements.markdown.setSelectionRange(15, 23);
  await app.sendNotesToSession();
  const dialog = document.querySelector('.notes-share-dialog')!;
  expect(dialog.textContent).toContain('SELECTED');
  expect(dialog.querySelector('pre')!.textContent).toBe('SELECTED');
  const destination = dialog.querySelector('select')!;
  expect(destination.value).toBe('');
  expect(app._notesRequest.mock.calls.filter((c: any) => c[0].endsWith('/send-preview'))).toHaveLength(0);
  destination.value = 'live';
  destination.dispatchEvent(new Event('change'));
  await vi.advanceTimersByTimeAsync(0);
  click('Confirm send');
  click('Confirm send');
  await vi.advanceTimersByTimeAsync(0);
  expect(app._notesRequest.mock.calls.filter((c: any) => c[0].endsWith('/send'))).toHaveLength(1);
});
it('never silently selects whole notes when no notes selection exists', async () => {
  await app.sendNotesToSession();
  expect(document.querySelector('.notes-share-dialog pre')!.textContent).toBe('');
  expect(app._notesRequest.mock.calls.filter((c: any) => c[0].endsWith('/send-preview'))).toHaveLength(0);
  click('Use whole notebook');
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('.notes-share-dialog pre')!.textContent).toBe(note.markdown);
});
it('requires actual terminal selection and previews only cleaned selected text with source and notebook', async () => {
  app.terminal = { getSelection: vi.fn(() => '') };
  app.cleanedTerminalSelection = vi.fn((text: string) => text);
  await app.saveResponseToNotes();
  expect(app.showToast).toHaveBeenCalled();
  expect(document.querySelector('.notes-share-dialog')).toBeNull();
  app.terminal.getSelection.mockReturnValue('  selected response  ');
  await app.saveResponseToNotes();
  expect(document.querySelector('.notes-share-dialog pre')!.textContent).toBe('  selected response  ');
  click('Confirm append');
  click('Confirm append');
  await vi.advanceTimersByTimeAsync(0);
  expect(app._notesRequest).toHaveBeenCalledWith(
    '/one/append-response',
    { revision: 'r1', sourceSessionId: 'live', text: '  selected response  ' },
    'POST'
  );
  expect(app._notesRequest.mock.calls.filter((c: any) => c[0].endsWith('/append-response'))).toHaveLength(1);
});
it('retains selected response on conflict and never mounts a delayed append into a newer notebook', async () => {
  app.terminal = { getSelection: () => 'response' };
  app.cleanedTerminalSelection = (text: string) => text;
  await app.saveResponseToNotes();
  let reject: any;
  app._notesRequest = vi.fn(
    () =>
      new Promise((_, rej) => {
        reject = rej;
      })
  );
  click('Confirm append');
  reject({ status: 409, message: 'Note changed', current: { ...note, revision: 'r2', markdown: 'external' } });
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('.notes-share-dialog')!.textContent).toContain('response');
  expect(document.querySelector('.notes-share-dialog')!.textContent).toContain('external');
  app._mountNotesEditor({ ...note, metadata: { ...note.metadata, id: 'two' }, markdown: 'new view' });
  expect(app._notesEditorElements.markdown.value).toBe('new view');
});

it('refuses stale terminal selection while the active session is still loading', async () => {
  app.terminal = { getSelection: () => 'old session selection' };
  app.terminalLoadStates = new Map([['live', { phase: 'loading' }]]);
  await app.saveResponseToNotes();
  expect(document.querySelector('.notes-share-dialog')).toBeNull();
  expect(app.showToast).toHaveBeenCalled();
});
it('retains local notebook draft when selected response append succeeds and suppresses old modal completion after navigation', async () => {
  app.terminal = { getSelection: () => 'response' };
  app._notesController.edit('local draft stays', 'Notebook');
  await app.saveResponseToNotes();
  app._notesRequest = vi.fn(async () => ({ ...note, revision: 'r2', markdown: 'canonical plus response' }));
  click('Confirm append');
  await vi.advanceTimersByTimeAsync(0);
  expect(app._notesController.current.markdown).toBe('local draft stays');
  expect(app._notesController.current.conflict.markdown).toBe('canonical plus response');
  app._closeNotesSharing();
  app._notesRequest = vi.fn(async (path) => (path === '' ? [{ id: 'one', note }] : note));
  await app.saveResponseToNotes();
  // This dialog's async preview read owns its capture; a newer view closes it before completion.
  let reject: any;
  app._notesRequest = vi.fn(
    () =>
      new Promise((_, rej) => {
        reject = rej;
      })
  );
  click('Confirm append');
  app._mountNotesEditor({ ...note, metadata: { ...note.metadata, id: 'two' }, markdown: 'new notebook' });
  reject(new Error('old network failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(app._notesErrorElement.textContent).toBe('');
  expect(app._notesEditorElements.markdown.value).toBe('new notebook');
});

it('updates the selection instruction when whole notebook is explicitly chosen and uses neutral success status', async () => {
  await app.sendNotesToSession();
  expect(document.querySelector('.notes-share-dialog [role="status"]')!.textContent).toContain('Select note text');
  click('Use whole notebook');
  expect(document.querySelector('.notes-share-dialog [role="status"]')!.textContent).not.toContain('Select note text');
  app._closeNotesSharing();
  app.terminal = { getSelection: () => 'response' };
  await app.saveResponseToNotes();
  click('Confirm append');
  await vi.advanceTimersByTimeAsync(0);
  const status = document.querySelector('.notes-share-dialog [role="status"]')!;
  expect(status.textContent).toContain('Selected response appended');
  expect(status.classList.contains('notes-error')).toBe(false);
});
