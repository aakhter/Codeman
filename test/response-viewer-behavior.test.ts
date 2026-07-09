// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const publicDir = join(process.cwd(), 'src/web/public');

let CodemanApp: { new (): any };
let app: any;

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
    <div id="responseViewer" class="response-viewer">
      <div id="responseViewerTitle"></div>
      <button id="responseViewerMore"></button>
      <button id="responseViewerCopy"></button>
      <button id="responseViewerCopyMarkdown"></button>
      <div id="responseViewerBody"></div>
    </div>
    <div id="responseViewerBackdrop"></div>
  `;

  app = Object.create(CodemanApp.prototype);
  app.showToast = vi.fn();
  app._copyText = vi.fn(async () => true);
  app.sessions = new Map();
});

describe('response viewer behavior', () => {
  it('does not wrap ordinary prose mentioning box-drawing separators into a code block', () => {
    const prepared = app._preprocessAsciiArt(
      [
        '- the COD transcript included separator lines like ────────────────...',
        '- it also included the completion banner ─ Worked for 1m 51s ─',
        '- my parser left those inside the last-response block',
      ].join('\n')
    );

    expect(prepared).not.toContain('```');
    expect(prepared).toContain('Worked for 1m 51s');
  });

  it('shows More for COD sessions when the server reports transcript context', async () => {
    app.activeSessionId = 's1';
    app.sessions.set('s1', { mode: 'codex' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({
          data: {
            text: 'Final polished answer',
            hasContext: true,
          },
        }),
      })) as unknown as typeof fetch
    );

    await app.toggleResponseViewer();

    expect(document.getElementById('responseViewerBody')?.textContent).toContain('Final polished answer');
    expect(document.getElementById('responseViewerMore')?.style.display).toBe('');
    expect(app._responseViewerMarkdown).toBe('Final polished answer');
  });

  it('renders COD transcript blocks with labels for prompt, response, status, and tool', async () => {
    app.activeSessionId = 's1';
    const responseMarkdown =
      '## Final update\n\n- **Preserve** syntax\n- [Open docs](https://example.com)\n\n```ts\nconst ready = true;\n```';

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({
          data: {
            messages: [
              { kind: 'prompt', label: 'Prompt', text: 'Ask for naming recommendation' },
              { kind: 'status', label: 'Status', text: 'gpt-5.4 medium · kb · main · Ready · Context 92% left' },
              { kind: 'tool', label: 'Tool', text: '• Explored\n  └ Read SKILL.md' },
              { kind: 'response', label: 'Response', text: responseMarkdown },
            ],
          },
        }),
      })) as unknown as typeof fetch
    );

    await app.loadFullContext();

    expect(document.getElementById('responseViewerTitle')?.textContent).toBe('Transcript (4 blocks)');
    expect(document.querySelector('.rv-role-prompt')?.textContent).toBe('Prompt');
    expect(document.querySelector('.rv-role-status')?.textContent).toBe('Status');
    expect(document.querySelector('.rv-role-tool')?.textContent).toBe('Tool');
    expect(document.querySelector('.rv-role-response')?.textContent).toBe('Response');
    expect(document.querySelector('.rv-message.rv-msg-tool .rv-text')?.textContent).toContain('Read SKILL.md');
    expect(document.querySelectorAll('.rv-message-copy')).toHaveLength(4);
    expect(app._responseViewerMarkdown).toBe(responseMarkdown);
  });

  it('copies raw Markdown from the latest response with success feedback', async () => {
    const markdown =
      '## Update\n\n- **Preserve** the syntax\n- [Open docs](https://example.com)\n\n```ts\nconst ready = true;\n```';
    app._responseViewerMarkdown = markdown;

    await app.copyResponseViewerMarkdown();

    expect(app._copyText).toHaveBeenCalledWith(markdown);
    expect(app.showToast).toHaveBeenCalledWith('Copied response as Markdown', 'success');
    expect(document.getElementById('responseViewerCopyMarkdown')?.classList.contains('rv-copied')).toBe(true);
  });

  it('reports a Markdown copy failure', async () => {
    app._responseViewerMarkdown = '# Update';
    app._copyText.mockResolvedValueOnce(false);

    await app.copyResponseViewerMarkdown();

    expect(app.showToast).toHaveBeenCalledWith('Failed to copy response as Markdown', 'error');
    expect(document.getElementById('responseViewerCopyMarkdown')?.classList.contains('rv-copy-failed')).toBe(true);
  });

  it('copies only the last response block when transcript view is showing', () => {
    const body = document.getElementById('responseViewerBody');
    if (!body) throw new Error('missing body');
    body.innerHTML = `
      <div class="rv-message rv-msg-prompt"><div class="rv-text">User prompt</div></div>
      <div class="rv-message rv-msg-response" data-copy-role="response"><div class="rv-text">Earlier answer</div></div>
      <div class="rv-message rv-msg-status"><div class="rv-text">Ready</div></div>
      <div class="rv-message rv-msg-response" data-copy-role="response"><div class="rv-text">Final answer</div></div>
    `;

    const source = app._getResponseViewerCopySource(body);
    const payload = app._prepareResponseViewerClipboard(source);

    expect(payload?.text).toContain('Final answer');
    expect(payload?.text).not.toContain('Earlier answer');
    expect(payload?.text).not.toContain('User prompt');
  });

  it('copies a specific transcript block as rich text', async () => {
    document.body.innerHTML = `
      <button id="responseViewerCopy"></button>
      <div id="responseViewerBody">
        <div class="rv-message rv-msg-prompt">
          <div class="rv-message-actions"><button class="rv-message-copy" type="button"></button></div>
          <div class="rv-role rv-role-prompt">Prompt</div>
          <div class="rv-text"><p>User prompt</p></div>
        </div>
        <div class="rv-message rv-msg-response">
          <div class="rv-message-actions"><button class="rv-message-copy" type="button"></button></div>
          <div class="rv-role rv-role-response">Response</div>
          <div class="rv-text"><p>Final answer</p><pre><code>const x = 1;</code></pre></div>
        </div>
      </div>
    `;
    app._bindResponseViewerInteractions(document.getElementById('responseViewerBody'));
    const clipboardWrite = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: clipboardWrite, writeText: vi.fn(async () => undefined) },
    });
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(data) {
          this.data = data;
        }
      }
    );

    const responseCopyBtn = document.querySelectorAll('.rv-message-copy')[1];
    responseCopyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    const [items] = clipboardWrite.mock.calls[0];
    const item = items[0];
    expect(Object.keys(item.data).sort()).toEqual(['text/html', 'text/plain']);
    expect(item.data['text/plain']).toBeTruthy();
    expect(item.data['text/html']).toBeTruthy();
    expect(app.showToast).toHaveBeenCalledWith('Copied section as rich text', 'success');
    expect(responseCopyBtn.classList.contains('rv-copied')).toBe(true);
  });
});
