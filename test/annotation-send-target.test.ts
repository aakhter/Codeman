// @vitest-environment jsdom
/**
 * COD-528 — Preview comments "Send as prompt" went to the wrong session.
 *
 * A preview belongs to the session it was opened for (`filePreviewState.sessionId`).
 * The attachment card stack is global, so a card from a BACKGROUND session opened a
 * preview owned by that session, and its comments were sent there while the user was
 * looking at another tab. The tray now names its target, defaults to the tab on
 * screen when the owner is not visible, pins what it shows, and lets the user pick.
 *
 * Drives the EXACT shipping artifacts under jsdom (constants.js + app.js + panels-ui.js).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const publicDir = join(process.cwd(), 'src/web/public');

let CodemanApp: { new (): any };
let app: any;
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(() => {
  const read = (file: string) => readFileSync(join(publicDir, file), 'utf8');
  const combined =
    'var marked, MobileDetection = {}, KeyboardHandler = {}, SwipeHandler = {}, ' +
    'VoiceInput = {}, DeepgramProvider = {}, NotificationManager = function(){};\n' +
    read('constants.js') +
    '\n' +
    read('app.js') +
    '\n' +
    read('panels-ui.js') +
    '\n;globalThis.__CodemanApp = CodemanApp;';
  (0, eval)(combined);
  CodemanApp = (globalThis as any).__CodemanApp as { new (): any };
});

function makeApp(): any {
  const a = Object.create(CodemanApp.prototype);
  a._elemCache = {};
  a._annotations = [];
  a._annotationTargetSessionId = null;
  a.toasts = [] as string[];
  a.showToast = (msg: string) => a.toasts.push(msg);
  a.closeFilePreview = () => {};
  a.sessions = new Map([
    ['sess-a', { id: 'sess-a', name: 'w1-alpha', workingDir: '/cases/alpha' }],
    ['sess-b', { id: 'sess-b', name: 'w2-beta', workingDir: '/cases/beta/' }],
    ['sess-c', { id: 'sess-c', name: 'w3-gamma', workingDir: '/cases/gamma' }],
  ]);
  return a;
}

function openPreview(ownerId: string, filePath: string, extra: Record<string, unknown> = {}) {
  app.filePreviewState = { sessionId: ownerId, filePath, attachmentId: null, displayPath: filePath, ...extra };
  app._annotations = [{ id: 'c1', passage: 'the quick fox', note: 'tighten', anchor: { quote: 'the quick fox' } }];
}

/** The input POSTs made, as { sessionId, input }. */
function inputPosts() {
  return fetchMock.mock.calls
    .filter(([url]) => /\/input$/.test(String(url)))
    .map(([url, init]) => ({
      sessionId: String(url).split('/')[3],
      input: JSON.parse((init as RequestInit).body as string).input as string,
    }));
}

beforeEach(() => {
  document.body.innerHTML = '';
  app = makeApp();
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith('/documents/review')) {
      return { ok: true, json: async () => ({ success: true, data: { path: 'docs/report.review.md' } }) };
    }
    return { ok: true, json: async () => ({ success: true }) };
  });
  (globalThis as any).fetch = fetchMock;
});

afterEach(() => {
  delete (globalThis as any).fetch;
});

describe('COD-528 comment target', () => {
  it('sends to the preview session when it is the active tab, naming the file only', async () => {
    app.activeSessionId = 'sess-a';
    openPreview('sess-a', 'docs/report.md');
    app._renderAnnotationTray();

    const target = document.querySelector('.annotation-tray-target');
    expect(target?.textContent).toContain('w1-alpha');
    expect(document.querySelector('.annotation-tray-target-select')).toBeNull();

    await app.sendAnnotationsAsPrompt();
    const posts = inputPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0].sessionId).toBe('sess-a');
    expect(posts[0].input).toContain('apply these edits to report.md:');
  });

  it('a card from a background session defaults to the tab on screen, with the full document path', async () => {
    app.activeSessionId = 'sess-a';
    openPreview('sess-b', 'docs/report.md');
    app._renderAnnotationTray();

    const select = document.querySelector('.annotation-tray-target-select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.value).toBe('sess-a');
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels).toEqual(['w2-beta (opened from)', 'w1-alpha (current tab)']);

    await app.sendAnnotationsAsPrompt();
    const posts = inputPosts();
    expect(posts.map((p) => p.sessionId)).toEqual(['sess-a']);
    // The other agent cannot resolve the owner's relative name, so it gets the absolute path.
    expect(posts[0].input).toContain('apply these edits to /cases/beta/docs/report.md:');
    expect(app.toasts.at(-1)).toContain('w1-alpha');
  });

  it('keeps the owning session as default when it is on screen (split Pane B)', async () => {
    app.activeSessionId = 'sess-a';
    app._splitPane = {};
    app._splitSessionId = 'sess-b';
    openPreview('sess-b', 'docs/report.md');
    app._renderAnnotationTray();

    expect((document.querySelector('.annotation-tray-target-select') as HTMLSelectElement).value).toBe('sess-b');
    await app.sendAnnotationsAsPrompt();
    expect(inputPosts()[0]).toMatchObject({ sessionId: 'sess-b' });
    expect(inputPosts()[0].input).toContain('apply these edits to report.md:');
  });

  it('keeps the owning session as default when it is a visible tile', async () => {
    app.activeSessionId = 'sess-a';
    app._tileGrid = {
      open: true,
      tiles: new Map([
        ['sess-a', {}],
        ['sess-b', {}],
      ]),
    };
    openPreview('sess-b', 'docs/report.md');
    expect(app._resolveAnnotationTarget()).toBe('sess-b');
  });

  it('honours an explicit pick of the owning session', async () => {
    app.activeSessionId = 'sess-a';
    openPreview('sess-b', 'docs/report.md');
    app._renderAnnotationTray();
    const select = document.querySelector('.annotation-tray-target-select') as HTMLSelectElement;
    select.value = 'sess-b';
    // jsdom runs inline handlers in its own realm (no `app` global there), so pin the
    // wiring and invoke what it names.
    expect(select.getAttribute('onchange')).toBe('app.setAnnotationTarget(this.value)');
    app.setAnnotationTarget(select.value);

    await app.sendAnnotationsAsPrompt();
    expect(inputPosts()[0].sessionId).toBe('sess-b');
  });

  it('pins the target the tray showed, so a later tab switch cannot move the send', async () => {
    app.activeSessionId = 'sess-a';
    openPreview('sess-b', 'docs/report.md');
    app._renderAnnotationTray();
    app.activeSessionId = 'sess-c';

    await app.sendAnnotationsAsPrompt();
    expect(inputPosts()[0].sessionId).toBe('sess-a');
  });

  it('falls back to the owner when the pinned session is gone', async () => {
    app.activeSessionId = 'sess-a';
    openPreview('sess-b', 'docs/report.md');
    app._renderAnnotationTray();
    app.sessions.delete('sess-a');
    app.activeSessionId = null;

    await app.sendAnnotationsAsPrompt();
    expect(inputPosts()[0].sessionId).toBe('sess-b');
  });

  it('an attachment opened by id keeps a bare name (no relative path to absolutize)', () => {
    app.activeSessionId = 'sess-a';
    openPreview('sess-b', 'report.md', { attachmentId: 'att-1' });
    expect(app._annotationDocumentRef('sess-a')).toBe('report.md');
  });

  it('writes the review file in the owning workspace and prompts the target with absolute paths', async () => {
    app.activeSessionId = 'sess-a';
    openPreview('sess-b', 'docs/report.md');
    app._renderAnnotationTray();

    await app.saveAnnotationsToReviewFile();
    const reviewCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/documents/review'));
    expect(String(reviewCall?.[0])).toBe('/api/sessions/sess-b/documents/review');
    const posts = inputPosts();
    expect(posts.map((p) => p.sessionId)).toEqual(['sess-a']);
    expect(posts[0].input).toBe(
      'Please apply the review comments in /cases/beta/docs/report.review.md to /cases/beta/docs/report.md.'
    );
  });

  it('a fresh preview drops the previous pick and comments', () => {
    const src = readFileSync(join(publicDir, 'panels-ui.js'), 'utf8');
    const open = src.slice(src.indexOf('async openFilePreview('), src.indexOf('async openFilePreview(') + 6000);
    expect(open).toMatch(/this\._annotations = \[\];\s*this\._annotationTargetSessionId = null;/);
  });
});
