// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const publicDir = join(process.cwd(), 'src/web/public');

let CodemanApp: { new (): any };
let app: any;
let clipboardWrite: ReturnType<typeof vi.fn>;

class TestClipboardItem {
  data: Record<string, Blob>;

  constructor(data: Record<string, Blob>) {
    this.data = data;
  }
}

beforeAll(() => {
  const read = (file: string) => readFileSync(join(publicDir, file), 'utf8');
  // The REAL markdown pipeline, not a stub: `_renderMarkdown` no-ops unless
  // `marked.parse` exists, and `_sanitizeHtml` fails CLOSED (escapes everything)
  // unless `window.sanitizeMarkdownHtml` is wired. With either missing, markdown
  // never becomes a <blockquote> and the wrapping assertions below test nothing.
  // Both vendor bundles are committed, so this works in CI too.
  const combined =
    'var MobileDetection = {}, KeyboardHandler = {}, SwipeHandler = {}, ' +
    'VoiceInput = {}, DeepgramProvider = {}, NotificationManager = function(){};\n' +
    read('vendor/marked.min.js') +
    '\n' +
    read('vendor/dompurify.min.js') +
    '\n' +
    read('sanitize-html.js') +
    '\n' +
    read('constants.js') +
    '\n' +
    read('app.js') +
    '\n;globalThis.__CodemanApp = CodemanApp;';
  (0, eval)(combined);
  CodemanApp = (globalThis as any).__CodemanApp as { new (): any };
});

beforeEach(() => {
  document.body.innerHTML = `
    <button id="responseViewerCopy"></button>
    <div id="responseViewerBody">
      <h2 class="rv-heading">Summary</h2>
      <p>Use <strong>rich text</strong>.</p>
      <div class="rv-table-wrap"><table><tbody><tr><td>Cell</td></tr></tbody></table></div>
      <div class="rv-code-wrap">
        <div class="rv-code-actions"><button class="rv-copy-btn">Copy code</button></div>
        <pre class="rv-diagram"><code>const answer = 42;</code></pre>
      </div>
    </div>`;

  clipboardWrite = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { write: clipboardWrite, writeText: vi.fn(async () => undefined) },
  });
  vi.stubGlobal('ClipboardItem', TestClipboardItem);

  app = Object.create(CodemanApp.prototype);
  app.showToast = vi.fn();
});

describe('response viewer rich copy', () => {
  it('builds portable HTML without Codeman controls or classes', () => {
    const body = document.getElementById('responseViewerBody');
    const payload = app._prepareResponseViewerClipboard(body);

    expect(payload.html).toContain('<h2>Summary</h2>');
    expect(payload.html).toContain('<strong>rich text</strong>');
    expect(payload.html).toContain('<table');
    expect(payload.html).toContain('<pre');
    expect(payload.html).not.toContain('rv-');
    expect(payload.html).not.toContain('<button');
    expect(payload.text).toContain('Summary');
    expect(payload.text).toContain('const answer = 42;');
  });

  it('preserves ordered-list markers in the plain-text clipboard representation', () => {
    const body = document.getElementById('responseViewerBody');
    if (!body) throw new Error('missing response viewer body');
    body.innerHTML =
      '<p>Priorities:</p><ol start="3"><li>Fix the copy path</li><li>Preserve <strong>all</strong> list content</li></ol><p>Then verify it.</p>';

    const payload = app._prepareResponseViewerClipboard(body);

    expect(payload?.text).toContain('Priorities:\n3. Fix the copy path\n4. Preserve all list content\nThen verify it.');
  });

  it('preserves a zero-based ordered-list start in the plain-text clipboard representation', () => {
    const body = document.getElementById('responseViewerBody');
    if (!body) throw new Error('missing response viewer body');
    body.innerHTML = '<ol start="0"><li>Zero</li><li>One</li></ol>';

    const payload = app._prepareResponseViewerClipboard(body);

    expect(payload?.text).toContain('0. Zero\n1. One');
  });

  it('preserves unordered-list markers in the plain-text clipboard representation', () => {
    const body = document.getElementById('responseViewerBody');
    if (!body) throw new Error('missing response viewer body');
    body.innerHTML =
      '<ul><li>COD-219 is complete and marked Done.<ul><li>Fixed ordered-list numbers.</li><li>Production was not deployed.</li></ul></li></ul>';

    const payload = app._prepareResponseViewerClipboard(body);

    expect(payload?.text).toContain(
      '• COD-219 is complete and marked Done.\n• Fixed ordered-list numbers.\n• Production was not deployed.'
    );
  });

  it('keeps nested ordered lists on a separate plain-text line', () => {
    const body = document.getElementById('responseViewerBody');
    if (!body) throw new Error('missing response viewer body');
    body.innerHTML = '<ol><li>Parent<ol><li>Child</li></ol></li></ol>';

    const payload = app._prepareResponseViewerClipboard(body);

    expect(payload?.text).toContain('1. Parent\n1. Child');
  });

  it('separates table cells in the plain-text clipboard representation', () => {
    const body = document.getElementById('responseViewerBody');
    if (!body) throw new Error('missing response viewer body');
    body.innerHTML = '<table><tr><th>Key</th><th>Value</th></tr><tr><td>A</td><td>B</td></tr></table>';

    const payload = app._prepareResponseViewerClipboard(body);

    expect(payload?.text).toContain('Key\tValue\nA\tB');
  });

  it('preserves boundaries around raw block elements in plain-text copies', () => {
    const body = document.getElementById('responseViewerBody');
    if (!body) throw new Error('missing response viewer body');
    body.innerHTML = '<div>First block</div><hr><div>Second block</div>';

    const payload = app._prepareResponseViewerClipboard(body);

    expect(payload?.text).toContain('First block\n\nSecond block');
  });

  it('writes text/html and text/plain representations in one clipboard item', async () => {
    await app.copyResponseViewerRichText();

    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    const [items] = clipboardWrite.mock.calls[0];
    const item = items[0] as TestClipboardItem;
    expect(Object.keys(item.data).sort()).toEqual(['text/html', 'text/plain']);
    expect(app.showToast).toHaveBeenCalledWith('Copied response as rich text', 'success');
    expect(document.getElementById('responseViewerCopy')?.classList.contains('rv-copied')).toBe(true);
  });

  it('falls back to plain text and reports reduced fidelity', async () => {
    clipboardWrite.mockRejectedValueOnce(new Error('denied'));
    app._copyText = vi.fn(async () => true);

    await app.copyResponseViewerRichText();

    expect(app._copyText).toHaveBeenCalledWith(expect.stringContaining('Summary'));
    expect(app.showToast).toHaveBeenCalledWith('Rich clipboard unavailable; copied plain text', 'warning');
  });

  it('exposes the copy control in the response viewer header', () => {
    const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
    expect(html).toContain('id="responseViewerCopy"');
    expect(html).toContain('onclick="app.copyResponseViewerRichText()"');
    expect(html).toContain('id="responseViewerCopyMarkdown"');
    expect(html).toContain('onclick="app.copyResponseViewerMarkdown()"');
    expect(html).toContain('>Copy Markdown</button>');
  });
});

/**
 * COD-263 — quote/comment blocks get the same one-click copy affordance as code
 * blocks. Behavioral: drives the real _renderMarkdown post-pass and the real
 * _quoteBlockText, not a source grep.
 *
 * The "No such built-in module: node:" failure this file used to carry a warning
 * about was NOT environmental and was never CI-only: Vitest 4 runs a jsdom file
 * under Vite's CLIENT environment, which browser-externalized the `node:*`
 * imports here and in test/setup.ts. Every jsdom file in the repo died at env
 * setup, on every machine, having never run once. Fixed by the
 * `codeman:node-builtins-in-client` plugin in config/vitest.config.ts.
 */
describe('COD-263 quote/comment copy', () => {
  function render(md: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = app._renderMarkdown(md);
    return host;
  }

  it('wraps a quote block and gives it a copy button', () => {
    const host = render('> quoted passage\n');
    expect(host.querySelectorAll('.rv-quote-wrap').length).toBe(1);
    const btn = host.querySelector('.rv-quote-wrap .rv-copy-btn');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('aria-label')).toBe('Copy quote');
    // The blockquote must survive INSIDE the wrapper — the styling hangs off it.
    expect(host.querySelector('.rv-quote-wrap > blockquote')?.textContent).toContain('quoted passage');
  });

  it('wraps only TOP-LEVEL quotes, so a nested quote adds no second button', () => {
    const host = render('> outer\n>\n> > inner\n');
    expect(host.querySelectorAll('blockquote').length).toBeGreaterThan(1);
    expect(host.querySelectorAll('.rv-quote-wrap').length).toBe(1);
    expect(host.querySelectorAll('.rv-copy-btn').length).toBe(1);
  });

  it('leaves prose without quotes untouched', () => {
    const host = render('just a paragraph\n');
    expect(host.querySelectorAll('.rv-quote-wrap').length).toBe(0);
  });

  it('_quoteBlockText separates paragraphs with a blank line', () => {
    // textContent would concatenate them into one run-on line — that is the
    // whole reason this helper exists.
    const host = render('> first para\n>\n> second para\n');
    const bq = host.querySelector('.rv-quote-wrap > blockquote') as HTMLElement;
    expect(app._quoteBlockText(bq)).toBe('first para\n\nsecond para');
  });

  it('_quoteBlockText falls back to textContent for an inline-only quote', () => {
    const bq = document.createElement('blockquote');
    bq.textContent = '  inline only  ';
    expect(app._quoteBlockText(bq)).toBe('inline only');
  });
});
