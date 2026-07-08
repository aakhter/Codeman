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
  const combined =
    'var marked, MobileDetection = {}, KeyboardHandler = {}, SwipeHandler = {}, ' +
    'VoiceInput = {}, DeepgramProvider = {}, NotificationManager = function(){};\n' +
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
  });
});
