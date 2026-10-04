/** COD-481: shipping index/mixins with real Fastify routes and isolated Markdown files; no mux/server runtime. */
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterEach, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { SessionNotesService } from '../src/session-notes-service.js';
import { sessionNotesOwnerKey } from '../src/session-notes-projects.js';
import { serializeSessionNote } from '../src/session-notes-markdown.js';
import { registerSessionNotesRoutes } from '../src/web/routes/session-notes-routes.js';
const publicDir = join(process.cwd(), 'src/web/public');
const read = (file: string) => readFileSync(join(publicDir, file), 'utf8');
let browser: Browser;
let page: Page;
let root: string;
let notes: SessionNotesService;
let api: ReturnType<typeof Fastify>;
let failSave = false;
let available = true;
let savedId: string;
const owner = sessionNotesOwnerKey();
const source = { id: 'session1', workingDir: '/repo', name: 'Retained source' };
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  await mkdir('/tmp/cod477-ui-review', { recursive: true });
});
afterAll(async () => {
  await browser?.close();
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cod481-browser-'));
  notes = new SessionNotesService({ root });
  failSave = false;
  available = true;
  api = Fastify();
  registerSessionNotesRoutes(api, {
    sessionNotes: notes,
    getNotesSource: async () => (available ? source : null),
    listNotesCases: async () => [
      { name: 'Repo', path: '/repo', hasClaudeMd: false },
      { name: 'Other', path: '/other', hasClaudeMd: false },
    ],
  });
  page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  await page.route('http://notes.test/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/session-notes')) {
      if (failSave && request.method() === 'PUT') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'disk full' }),
        });
        return;
      }
      const response = await api.inject({
        method: request.method() as any,
        url: url.pathname + url.search,
        ...(request.postData() ? { payload: request.postData(), headers: { 'content-type': 'application/json' } } : {}),
      });
      await route.fulfill({
        status: response.statusCode,
        contentType: response.headers['content-type'] as string,
        body: response.body,
      });
      return;
    }
    if (url.pathname === '/api/sessions/unified') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ sessions: [] }) });
      return;
    }
    if (url.pathname === '/') {
      // Use actual shipping markup, retaining header action and terminal container.
      const html = read('index.html')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
        .replace(/<link\b[^>]*>/g, '');
      await route.fulfill({ contentType: 'text/html', body: html });
      return;
    }
    await route.fulfill({ status: 404, body: '' });
  });
  await boot();
});
afterEach(async () => {
  await page?.close();
  await api?.close();
  notes?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
async function boot() {
  await page.goto('http://notes.test/', { waitUntil: 'domcontentloaded' });
  // Match safe shell initialization: dismiss loading skeleton without constructing runtime/PTY controllers.
  await page.evaluate(() => document.body.classList.add('app-loaded'));
  await page.addStyleTag({ content: read('styles.css') + '\n' + read('session-notes.css') });
  const bootstrap =
    "document.addEventListener('DOMContentLoaded', () => {\n  app = new CodemanApp();\n  window.app = app;\n});";
  const appSource = read('app.js').replace(bootstrap, '');
  const focusSource = read('keyboard-accessory.js').slice(read('keyboard-accessory.js').indexOf('class FocusTrap'));
  await page.addScriptTag({
    content:
      'var MobileDetection = {}, KeyboardHandler = {}, SwipeHandler = {}, VoiceInput = {}, DeepgramProvider = {}, NotificationManager = function(){};\n' +
      read('constants.js') +
      '\n' +
      appSource +
      '\n' +
      focusSource +
      '\n' +
      read('vendor/marked.min.js') +
      '\n' +
      read('vendor/dompurify.min.js') +
      '\n' +
      read('sanitize-html.js') +
      '\n' +
      read('session-notes-editor.js') +
      '\n' +
      read('session-notes-ui.js') +
      '\napp = Object.create(CodemanApp.prototype); app.activeSessionId = "session1"; app.showToast = () => {}; window.app = app;',
  });
}
async function sessionEditor() {
  await page.evaluate(() => (window as any).app.openSessionNotes('session1'));
  await page.locator('textarea[aria-label="Markdown notes"]').waitFor();
  savedId = await page.evaluate(() => (window as any).app._notesController.current.id);
}
async function saveText(text: string) {
  await page.locator('textarea[aria-label="Markdown notes"]').fill(text);
  await page.getByRole('button', { name: 'Save now / Retry', exact: true }).click();
  await page.waitForFunction(() => (window as any).app._notesController.current.status === 'Saved');
}
async function external(text: string) {
  const current = await notes.read(owner, savedId);
  await writeFile(
    join(root, owner, 'projects', current.metadata.projectId, savedId + '.md'),
    serializeSessionNote(current.metadata, text)
  );
  await page.evaluate((ownerKey) => (window as any).app._onNotesChanged({ ownerKey }), owner);
}
it('desktop panel resizes, saves, exports, browses the same retained notebook and completes canonical tasks', async () => {
  await sessionEditor();
  const separator = page.getByRole('separator', { name: 'Resize notes panel' });
  const before = await page.locator('.session-notes-panel').boundingBox();
  await separator.focus();
  await page.keyboard.press('ArrowLeft');
  const after = await page.locator('.session-notes-panel').boundingBox();
  expect(after!.width).toBeGreaterThan(before!.width);
  const terminal = await page.locator('#terminalContainer').boundingBox();
  expect(terminal!.width).toBeGreaterThan(350);
  await saveText('# Durable notes\n- [ ] Follow up\n');
  const exported = await api.inject('/api/session-notes/' + savedId + '/export');
  expect(exported.body).toContain('Follow up');
  available = false;
  await page.getByRole('button', { name: 'Back to session', exact: true }).click();
  await page.getByRole('button', { name: 'Open notes browser' }).click();
  await page.getByRole('button', { name: 'Retained source notes', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Retained source notes', exact: true }).click();
  expect(await page.locator('textarea[aria-label="Markdown notes"]').inputValue()).toContain('Follow up');
  await page.getByRole('checkbox', { name: 'Complete Follow up' }).check();
  await page.waitForFunction(() => document.querySelector('.notes-list')?.textContent?.includes('0 unfinished'));
  expect((await notes.read(owner, savedId)).markdown).toContain('- [x] Follow up');
  await page.getByRole('button', { name: 'Source session', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.notes-source-summary')?.textContent?.includes('history unavailable')
  );
  await page.screenshot({ path: '/tmp/cod477-ui-review/desktop-browser.png' });
});
it('real API conflicts retain both versions; clean notifications reload and dirty notifications compare', async () => {
  await sessionEditor();
  await saveText('baseline');
  await external('external clean');
  expect(await page.locator('textarea[aria-label="Markdown notes"]').inputValue()).toBe('external clean');
  await page.locator('textarea[aria-label="Markdown notes"]').fill('my draft');
  await external('external dirty');
  expect(await page.locator('.notes-conflict').textContent()).toContain('external dirty');
  expect(await page.locator('textarea[aria-label="Markdown notes"]').inputValue()).toBe('my draft');
  await page.getByRole('button', { name: 'Combine current and draft', exact: true }).click();
  await page.getByRole('button', { name: 'Save now / Retry', exact: true }).click();
  await page.waitForFunction(() => (window as any).app._notesController.current.status === 'Saved');
  expect((await notes.read(owner, savedId)).markdown).toContain('external dirty\n\nmy draft');
  await page.locator('textarea[aria-label="Markdown notes"]').fill('stale draft');
  const current = await notes.read(owner, savedId);
  await notes.save(owner, savedId, current.revision, 'other browser');
  await page.getByRole('button', { name: 'Save now / Retry', exact: true }).click();
  await page.locator('.notes-conflict').waitFor();
  expect(await page.locator('.notes-conflict').textContent()).toContain('other browser');
  await page.screenshot({ path: '/tmp/cod477-ui-review/desktop-conflict.png' });
});
it('failed first save keeps scoped drafts through reload, retries same ID and sanitizes preview', async () => {
  await sessionEditor();
  failSave = true;
  await page
    .locator('textarea[aria-label="Markdown notes"]')
    .fill(
      '<img src=x onerror="window.notesPwned=1">\n<script>window.notesPwned=2</script>\n[bad](javascript:alert(1))'
    );
  await page.getByRole('button', { name: 'Save now / Retry', exact: true }).click();
  await page.waitForFunction(() => (window as any).app._notesController.current.status === 'Save failed');
  const id = savedId;
  await boot();
  await sessionEditor();
  expect(savedId).toBe(id);
  expect(await page.locator('textarea[aria-label="Markdown notes"]').inputValue()).toContain('onerror');
  failSave = false;
  await page.getByRole('button', { name: 'Save now / Retry', exact: true }).click();
  await page.waitForFunction(() => (window as any).app._notesController.current.status === 'Saved');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  expect(
    await page.locator('.notes-preview script,.notes-preview [onerror],.notes-preview a[href^="javascript:"]').count()
  ).toBe(0);
  expect(await page.evaluate(() => (window as any).notesPwned)).toBeUndefined();
});
it('mobile panel fits viewport, traps Tab, restores focus and returns with Escape', async () => {
  await page.setViewportSize({ width: 393, height: 740 });
  await sessionEditor();
  const panel = await page.locator('.session-notes-panel').boundingBox();
  expect(panel!.width).toBe(393);
  expect(panel!.height).toBe(740);
  const markdown = page.locator('textarea[aria-label="Markdown notes"]');
  await markdown.focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Back to session');
  await saveText('mobile');
  await page.screenshot({ path: '/tmp/cod477-ui-review/mobile-panel.png' });
  await page.keyboard.press('Escape');
  expect(await page.locator('.session-notes-panel').count()).toBe(0);
});
it('search and project/session/unfinished filters compose; reassignment preserves content and notebook identity', async () => {
  await sessionEditor();
  await saveText('Unique body needle\n- [ ] unfinished marker');
  await page.getByRole('button', { name: 'Back to session', exact: true }).click();
  await page.getByRole('button', { name: 'Open notes browser' }).click();
  await page.getByRole('button', { name: 'Retained source notes', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Repo', exact: true }).click();
  await page.getByRole('textbox', { name: 'Filter by originating session' }).fill('session1');
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('needle');
  await page.getByRole('checkbox', { name: 'Only unfinished items' }).check();
  await page.waitForFunction(() => document.querySelectorAll('.notes-list-row').length === 1);
  await page.getByRole('button', { name: 'Retained source notes', exact: true }).click();
  const projects = await notes.projects.list(owner);
  const other = projects.find((project) => project.name === 'Other')!;
  await page.getByRole('combobox', { name: 'Reassign notebook project' }).selectOption(other.id);
  await page.waitForFunction(
    (id) => (window as any).app._notesController.current.note.metadata.projectId === id,
    other.id
  );
  expect((await notes.read(owner, savedId)).markdown).toContain('Unique body needle');
  expect((await notes.read(owner, savedId)).metadata.sessionId).toBe('session1');
  await page.getByRole('button', { name: 'All projects', exact: true }).click();
  await page.getByRole('button', { name: 'Retained source notes', exact: true }).waitFor();
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('absent');
  await page.getByText('No matching notebooks', { exact: true }).waitFor();
});
it('malformed canonical bytes remain visible and require an explicit repair action', async () => {
  await sessionEditor();
  await saveText('original');
  const current = await notes.read(owner, savedId);
  await writeFile(
    join(root, owner, 'projects', current.metadata.projectId, savedId + '.md'),
    '<img src=x onerror="window.notesPwned=1">\nbroken frontmatter'
  );
  await page.evaluate((ownerKey) => (window as any).app._onNotesChanged({ ownerKey }), owner);
  await page.getByRole('heading', { name: 'Notebook requires repair' }).waitFor();
  expect(await page.locator('.notes-editor pre').textContent()).toContain('broken frontmatter');
  expect(await page.locator('.notes-editor img').count()).toBe(0);
  expect(await page.getByRole('button', { name: 'Save now / Retry' }).count()).toBe(0);
  await page.getByRole('textbox', { name: 'Repaired Markdown notes', exact: true }).fill('repaired body');
  await page.getByRole('button', { name: 'Repair notebook', exact: true }).click();
  await page.locator('textarea[aria-label="Markdown notes"]').waitFor();
  expect((await notes.read(owner, savedId)).markdown).toBe('repaired body');
});
