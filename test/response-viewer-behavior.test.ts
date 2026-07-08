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
      <div id="responseViewerBody"></div>
    </div>
    <div id="responseViewerBackdrop"></div>
  `;

  app = Object.create(CodemanApp.prototype);
  app.showToast = vi.fn();
  app._copyText = vi.fn(async () => true);
  app._bindResponseViewerInteractions = vi.fn();
  app.sessions = new Map();
});

describe('response viewer behavior', () => {
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
  });

  it('renders COD transcript blocks with labels for prompt, response, status, and tool', async () => {
    app.activeSessionId = 's1';

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({
          data: {
            messages: [
              { kind: 'prompt', label: 'Prompt', text: 'Ask for naming recommendation' },
              { kind: 'status', label: 'Status', text: 'gpt-5.4 medium · kb · main · Ready · Context 92% left' },
              { kind: 'tool', label: 'Tool', text: '• Explored\n  └ Read SKILL.md' },
              { kind: 'response', label: 'Response', text: 'Final polished answer' },
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
});
