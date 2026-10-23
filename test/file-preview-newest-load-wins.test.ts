/**
 * @fileoverview COD-543: the File Viewer keeps the NEWEST preview when an older
 * load finishes late.
 *
 * Opening file A (slow) and then file B (fast) must leave B on screen: A's late
 * answer may not overwrite B's body, footer or title, start a live-refresh poller,
 * or reveal attachment navigation for A. Every await in openFilePreview that later
 * writes the DOM is driven late here:
 *   1. the metadata fetch (file-content / attachments/:id),
 *   2. the raw text fetch inside _renderFilePreviewBody,
 *   3. the HTML page mint (/html-view),
 *   4. a folder-grid file's raw text fetch,
 *   5. the attachment-history navigation fetch,
 *   6. back/forward: stepping back to a slow file and forward again,
 *   7. a late metadata FAILURE (its error branch must not paint either).
 *
 * Loaded via `vm` against a stub app, same harness style as
 * document-preview-render-state.test.ts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Proto = Record<string, (...args: never[]) => unknown>;
type El = {
  innerHTML: string;
  textContent: string;
  hidden?: boolean;
  disabled?: boolean;
  querySelector: ReturnType<typeof vi.fn>;
  classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean };
};

function el(): El {
  const classes = new Set<string>();
  return {
    innerHTML: '',
    textContent: '',
    querySelector: vi.fn(() => null),
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

type FetchRoute = (url: string) => Promise<unknown> | unknown;

function setup(opts: { route: FetchRoute; rendersAsPage?: (p: string) => boolean }) {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');
  const fetchMock = vi.fn((url: string) => Promise.resolve(opts.route(String(url))));
  const context = vm.createContext({
    console: { ...console, error: vi.fn(), warn: vi.fn() },
    CodemanApp: class CodemanApp {},
    escapeHtml: (value: unknown) => String(value ?? ''),
    CodemanBase: { base: '', url: (p: string) => p },
    fetch: fetchMock,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    AbortController,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: { addEventListener: vi.fn(), removeEventListener: vi.fn(), getElementById: () => null, hidden: false },
    window: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      innerWidth: 1200,
      innerHeight: 900,
      CodemanFilePaths: { rendersAsPage: opts.rendersAsPage ?? (() => false) },
    },
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  const proto = (context as unknown as { __proto: Proto }).__proto;

  const body = el();
  const footer = el();
  const title = el();
  const overlay = el();
  const nav = el();
  const app = Object.create(proto) as Record<string, any>;
  app.sessions = new Map([['s1', { workingDir: '/work' }]]);
  app.filePreviewState = null;
  app._annotations = [];
  app.formatFileSize = () => '1 KB';
  app._restorePreviewSize = vi.fn();
  app._closeAnnotationTray = vi.fn();
  app._startFilePreviewPolling = vi.fn();
  app._filePreviewPref = (k: string) => k === 'htmlRendered';
  const els: Record<string, El> = {
    filePreviewBody: body,
    filePreviewFooter: footer,
    filePreviewTitle: title,
    filePreviewOverlay: overlay,
    filePreviewNavigation: nav,
  };
  nav.hidden = true;
  app.$ = vi.fn((id: string) => els[id] ?? null);
  return { app, body, footer, title, nav, fetchMock };
}

const json = (data: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
});
const text = (t: string) => ({ ok: true, status: 200, json: async () => ({}), text: async () => t });
const imageMeta = (name: string) =>
  json({ success: true, data: { type: 'image', extension: 'png', size: 10, mtimeMs: 1, url: `/raw/${name}` } });
const noNav = () => json({ success: true, data: { items: [] } });

function expectShowsB(h: ReturnType<typeof setup>) {
  expect(h.title.textContent).toBe('b.png');
  expect(h.body.innerHTML).toContain('/raw/b.png');
  expect(h.body.innerHTML).not.toContain('a-text');
  expect(h.body.innerHTML).not.toContain('Error');
  expect(h.app.filePreviewState.filePath).toBe('b.png');
}

describe('COD-543 newest file preview wins over a late older load', () => {
  it('a late metadata response for A does not replace B', async () => {
    const slowA = deferred<unknown>();
    const h = setup({
      route: (url) => {
        if (url.includes('file-content') && url.includes('a.png')) return slowA.promise;
        if (url.includes('file-content')) return imageMeta('b.png');
        return noNav();
      },
    });
    h.app._fetchFilePreviewMetadata = async (url: string) => {
      const res = (await (h.fetchMock as any)(url)) as { json: () => Promise<{ data: unknown }> };
      return (await res.json()).data;
    };
    const openA = h.app.openFilePreview('a.png', 's1');
    await h.app.openFilePreview('b.png', 's1');
    expectShowsB(h);
    const polls = h.app._startFilePreviewPolling.mock.calls.length;
    slowA.resolve(imageMeta('a.png'));
    await openA;
    await flush();
    expectShowsB(h);
    expect(h.body.innerHTML).not.toContain('/raw/a.png');
    expect(h.app._startFilePreviewPolling.mock.calls.length).toBe(polls);
  });

  it('a late metadata FAILURE for A does not paint its error over B', async () => {
    const slowA = deferred<unknown>();
    const h = setup({ route: () => noNav() });
    h.app._fetchFilePreviewMetadata = async (url: string) =>
      url.includes('a.png') ? slowA.promise : ((await imageMeta('b.png').json()) as any).data;
    const openA = h.app.openFilePreview('a.png', 's1');
    await h.app.openFilePreview('b.png', 's1');
    slowA.reject(new Error('A blew up'));
    await openA;
    await flush();
    expectShowsB(h);
  });

  it('a late raw-text fetch for A (inside the body render) does not replace B', async () => {
    const slowText = deferred<unknown>();
    const h = setup({
      route: (url) => (url.includes('/raw/a.txt') ? slowText.promise : noNav()),
    });
    h.app._fetchFilePreviewMetadata = async (url: string) =>
      url.includes('a.txt')
        ? { type: 'text', extension: 'txt', size: 5, mtimeMs: 1, url: '/raw/a.txt' }
        : ((await imageMeta('b.png').json()) as any).data;
    const openA = h.app.openFilePreview('a.txt', 's1');
    await flush();
    await h.app.openFilePreview('b.png', 's1');
    slowText.resolve(text('a-text'));
    await openA;
    await flush();
    expectShowsB(h);
    expect(h.app.filePreviewContent).not.toBe('a-text');
  });

  it('a late HTML page mint for A does not replace B', async () => {
    const slowMint = deferred<string | null>();
    const h = setup({ route: () => noNav(), rendersAsPage: (p) => p.endsWith('.html') });
    h.app._mintHtmlViewUrl = vi.fn(() => slowMint.promise);
    h.app._fetchFilePreviewMetadata = async () => ((await imageMeta('b.png').json()) as any).data;
    const openA = h.app.openFilePreview('a.html', 's1');
    await h.app.openFilePreview('b.png', 's1');
    slowMint.resolve('/html-view/a');
    await openA;
    await flush();
    expectShowsB(h);
    expect(h.body.innerHTML).not.toContain('<iframe');
    expect(h.app.filePreviewPage).toBeNull();
    expect(h.footer.textContent).not.toBe('HTML');
  });

  it('a late folder-grid file fetch for A does not replace B', async () => {
    const slowRaw = deferred<unknown>();
    const h = setup({ route: (url) => (url.includes('/files/a.txt/raw') ? slowRaw.promise : noNav()) });
    h.app._renderFilePreviewText = vi.fn(() => {
      h.body.innerHTML = `<pre>${h.app.filePreviewContent}</pre>`;
    });
    h.app._fetchFilePreviewMetadata = async () => ((await imageMeta('b.png').json()) as any).data;
    const openA = h.app.openFilePreview('/dir/a.txt', 's1', null, {
      folderFile: { folderId: 'f1', name: 'a.txt', attachmentType: 'text' },
    });
    await h.app.openFilePreview('b.png', 's1');
    slowRaw.resolve(text('a-text'));
    await openA;
    await flush();
    expectShowsB(h);
    expect(h.app._renderFilePreviewText).not.toHaveBeenCalled();
  });

  it("a late attachment-history navigation answer for A does not reveal A's list on B", async () => {
    const slowNavA = deferred<unknown>();
    let navCalls = 0;
    const h = setup({
      route: (url) => {
        if (!url.endsWith('/attachments')) return noNav();
        navCalls += 1;
        return navCalls === 1 ? slowNavA.promise : noNav();
      },
    });
    h.app._fetchFilePreviewMetadata = async (url: string) =>
      ((await imageMeta(url.includes('a.png') ? 'a.png' : 'b.png').json()) as any).data;
    const openA = h.app.openFilePreview('a.png', 's1');
    await openA;
    await h.app.openFilePreview('b.png', 's1');
    slowNavA.resolve(
      json({
        success: true,
        data: {
          items: [
            { relativePath: 'a.png', fileName: 'a.png', attachmentId: 'x' },
            { relativePath: 'c.png', fileName: 'c.png', attachmentId: 'y' },
          ],
        },
      })
    );
    await flush();
    expectShowsB(h);
    expect(h.nav.hidden).toBe(true);
    expect(h.app.filePreviewState.navigationItems).toBeUndefined();
  });

  it('back to a slow file then forward again keeps the forward file', async () => {
    const slow = new Map<string, ReturnType<typeof deferred<unknown>>>();
    let slowArmed = false;
    const h = setup({ route: () => noNav() });
    h.app._fetchFilePreviewMetadata = async (url: string) => {
      const name = url.includes('a.png') ? 'a.png' : 'b.png';
      if (slowArmed && name === 'a.png') {
        const d = deferred<unknown>();
        slow.set(name, d);
        return d.promise;
      }
      return ((await imageMeta(name).json()) as any).data;
    };
    await h.app.openFilePreview('a.png', 's1');
    await h.app.openFilePreview('b.png', 's1');
    slowArmed = true;
    const back = h.app.stepFilePreviewHistory(-1);
    await flush();
    expect(h.title.textContent).toBe('a.png');
    await h.app.stepFilePreviewHistory(1);
    slow.get('a.png')!.resolve(((await imageMeta('a.png').json()) as any).data);
    await back;
    await flush();
    expectShowsB(h);
  });
});
