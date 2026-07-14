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

  describe('Escape-to-close and focus restoration (COD-229)', () => {
    const openViewer = () => {
      document.getElementById('responseViewer')?.classList.add('visible');
      document.getElementById('responseViewerBackdrop')?.classList.add('visible');
    };
    const makeEscapeEvent = () => ({
      key: 'Escape',
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    it('closes the viewer and backdrop when Escape is pressed with Last Response open', () => {
      openViewer();
      app.terminal = { focus: vi.fn() };

      const consumed = app._maybeCloseResponseViewerOnEscape(makeEscapeEvent());

      expect(consumed).toBe(true);
      expect(document.getElementById('responseViewer')?.classList.contains('visible')).toBe(false);
      expect(document.getElementById('responseViewerBackdrop')?.classList.contains('visible')).toBe(false);
    });

    it('closes the viewer when the expanded More transcript is showing', () => {
      // The More view differs only in title/content; close is visibility-based.
      const title = document.getElementById('responseViewerTitle');
      if (title) title.textContent = 'Transcript (4 blocks)';
      openViewer();
      app.terminal = { focus: vi.fn() };

      const consumed = app._maybeCloseResponseViewerOnEscape(makeEscapeEvent());

      expect(consumed).toBe(true);
      expect(document.getElementById('responseViewer')?.classList.contains('visible')).toBe(false);
    });

    it('consumes the Escape key (preventDefault + stopPropagation) so it never reaches the CLI', () => {
      openViewer();
      app.terminal = { focus: vi.fn() };
      const e = makeEscapeEvent();

      app._maybeCloseResponseViewerOnEscape(e);

      expect(e.preventDefault).toHaveBeenCalledTimes(1);
      expect(e.stopPropagation).toHaveBeenCalledTimes(1);
    });

    it('restores focus to the active terminal on close', () => {
      openViewer();
      const focus = vi.fn();
      app.terminal = { focus };

      app.closeResponseViewer();

      expect(focus).toHaveBeenCalledTimes(1);
    });

    it('does nothing viewer-specific and does not consume Escape when the viewer is already closed', () => {
      // beforeEach leaves the viewer without the "visible" class.
      app.terminal = { focus: vi.fn() };
      const e = makeEscapeEvent();

      const consumed = app._maybeCloseResponseViewerOnEscape(e);

      expect(consumed).toBe(false);
      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(e.stopPropagation).not.toHaveBeenCalled();
      expect(app.terminal.focus).not.toHaveBeenCalled();
    });

    it('closeResponseViewer returns false when the viewer is already closed', () => {
      expect(app.closeResponseViewer()).toBe(false);
    });

    it('closes cleanly via the × button / backdrop path (closeResponseViewer) without a keyboard event', () => {
      openViewer();
      app.terminal = { focus: vi.fn() };

      const closed = app.closeResponseViewer();

      expect(closed).toBe(true);
      expect(document.getElementById('responseViewer')?.classList.contains('visible')).toBe(false);
      expect(document.getElementById('responseViewerBackdrop')?.classList.contains('visible')).toBe(false);
    });
  });

  describe('transcript content filters (COD-225)', () => {
    const MESSAGES = [
      { kind: 'prompt', label: 'Prompt', text: 'ask something' },
      { kind: 'status', label: 'Status', text: 'ready' },
      { kind: 'tool', label: 'Tool', text: 'ran a tool' },
      { kind: 'response', label: 'Response', text: 'the answer' },
    ];
    const btn = (cat: string) => document.querySelector(`.rv-filter-btn[data-rv-filter="${cat}"]`);
    const setupTranscript = () => {
      const bar = document.createElement('div');
      bar.id = 'responseViewerFilters';
      bar.hidden = true;
      for (const cat of ['user', 'tool', 'response']) {
        const b = document.createElement('button');
        b.className = 'rv-filter-btn';
        b.setAttribute('data-rv-filter', cat);
        b.setAttribute('aria-pressed', 'true');
        bar.appendChild(b);
      }
      document.body.appendChild(bar);
      const body = document.getElementById('responseViewerBody');
      if (!body) throw new Error('missing body');
      app._renderResponseViewerMessages(body, MESSAGES);
      app._showResponseFilters();
      return body;
    };

    it('shows the filter bar with every category visible by default', () => {
      const body = setupTranscript();
      expect(document.getElementById('responseViewerFilters')?.hidden).toBe(false);
      expect(body.classList.contains('rv-hide-user')).toBe(false);
      expect(body.classList.contains('rv-hide-tool')).toBe(false);
      expect(body.classList.contains('rv-hide-response')).toBe(false);
      expect(btn('user')?.getAttribute('aria-pressed')).toBe('true');
      expect(body.querySelectorAll('.rv-message')).toHaveLength(4);
    });

    it('hides user prompts (and only those) when the User filter is toggled off', () => {
      const body = setupTranscript();
      app.toggleTranscriptFilter('user', btn('user'));
      expect(body.classList.contains('rv-hide-user')).toBe(true);
      expect(btn('user')?.getAttribute('aria-pressed')).toBe('false');
      expect(btn('user')?.classList.contains('rv-filter-off')).toBe(true);
      expect(body.classList.contains('rv-hide-tool')).toBe(false);
      expect(body.classList.contains('rv-hide-response')).toBe(false);
    });

    it('maps both tool and status blocks to the Tools filter', () => {
      const body = setupTranscript();
      expect(body.querySelector('.rv-msg-tool')).not.toBeNull();
      expect(body.querySelector('.rv-msg-status')).not.toBeNull();
      app.toggleTranscriptFilter('tool', btn('tool'));
      expect(body.classList.contains('rv-hide-tool')).toBe(true);
    });

    it('hides responses when the Responses filter is toggled off', () => {
      const body = setupTranscript();
      app.toggleTranscriptFilter('response', btn('response'));
      expect(body.classList.contains('rv-hide-response')).toBe(true);
      expect(btn('response')?.getAttribute('aria-pressed')).toBe('false');
    });

    it('toggles a filter independently back on to restore visibility', () => {
      const body = setupTranscript();
      app.toggleTranscriptFilter('user', btn('user'));
      app.toggleTranscriptFilter('user', btn('user'));
      expect(body.classList.contains('rv-hide-user')).toBe(false);
      expect(btn('user')?.getAttribute('aria-pressed')).toBe('true');
    });

    it('shows a filtered-empty state when every category is toggled off', () => {
      const body = setupTranscript();
      app.toggleTranscriptFilter('user', btn('user'));
      app.toggleTranscriptFilter('tool', btn('tool'));
      app.toggleTranscriptFilter('response', btn('response'));
      const empty = body.querySelector('.response-viewer-filter-empty');
      expect(empty).not.toBeNull();
      expect(empty?.hidden).toBe(false);
      expect(empty?.textContent).toContain('No transcript blocks match');
    });

    it('clears the filtered-empty state once a category is re-enabled', () => {
      const body = setupTranscript();
      app.toggleTranscriptFilter('user', btn('user'));
      app.toggleTranscriptFilter('tool', btn('tool'));
      app.toggleTranscriptFilter('response', btn('response'));
      expect(body.querySelector('.response-viewer-filter-empty')?.hidden).toBe(false);
      app.toggleTranscriptFilter('response', btn('response'));
      expect(body.querySelector('.response-viewer-filter-empty')?.hidden).toBe(true);
    });

    it('resets to all-visible when the transcript is re-rendered (predictable reopen default)', () => {
      const body = setupTranscript();
      app.toggleTranscriptFilter('user', btn('user'));
      expect(body.classList.contains('rv-hide-user')).toBe(true);
      app._renderResponseViewerMessages(body, MESSAGES);
      app._showResponseFilters();
      expect(body.classList.contains('rv-hide-user')).toBe(false);
      expect(btn('user')?.getAttribute('aria-pressed')).toBe('true');
    });

    it('hides the filter bar and clears hide classes for the Last Response view', () => {
      const body = setupTranscript();
      app.toggleTranscriptFilter('user', btn('user'));
      expect(document.getElementById('responseViewerFilters')?.hidden).toBe(false);
      app._hideResponseFilters();
      expect(document.getElementById('responseViewerFilters')?.hidden).toBe(true);
      expect(body.classList.contains('rv-hide-user')).toBe(false);
    });
  });
});
