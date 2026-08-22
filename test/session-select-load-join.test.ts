// @vitest-environment jsdom

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const publicDir = join(process.cwd(), 'src/web/public');
const readPublic = (file: string) => readFileSync(join(publicDir, file), 'utf8');

let CodemanApp: { new (): any };

beforeAll(() => {
  const combined =
    'var marked, MobileDetection = { isMobile: function(){ return false; }, isTouchDevice: function(){ return false; }, getDeviceType: function(){ return "desktop"; } }, ' +
    'KeyboardHandler = {}, KeyboardAccessoryBar = undefined, SwipeHandler = {}, VoiceInput = { cleanup: function(){} }, DeepgramProvider = {}, ' +
    'NotificationManager = function(){}, FocusTrap = function(){ return { activate(){}, deactivate(){} }; };\n' +
    readPublic('constants.js') +
    '\n' +
    readPublic('app.js') +
    '\n' +
    readPublic('terminal-ui.js') +
    '\n;globalThis.__Cod356LoadJoinApp = CodemanApp;';
  (0, eval)(combined);
  CodemanApp = (globalThis as any).__Cod356LoadJoinApp;
});

function makeRefreshHarness(sessionId: string) {
  const writes: string[] = [];
  const app = Object.create(CodemanApp.prototype);
  Object.assign(app, {
    activeSessionId: sessionId,
    sessions: new Map([[sessionId, { id: sessionId, mode: 'codex', status: 'idle' }]]),
    terminal: {
      clear: vi.fn(),
      reset: vi.fn(),
      scrollToBottom: vi.fn(),
      scrollToLine: vi.fn(),
      buffer: { active: { baseY: 0, viewportY: 0 } },
    },
    _selectGeneration: 7,
    _isLoadingBuffer: false,
    _viewMode: 'live',
    _isMirrorSession: vi.fn(() => false),
    _replayWouldShrinkBuffer: vi.fn(() => false),
    _setHistoryTruncation: vi.fn(),
    _localEchoOverlay: null,
    sendResize: vi.fn(),
    chunkedTerminalWrite: vi.fn(async (data: string) => {
      writes.push(data);
    }),
    _applySessionActivityEvent: vi.fn(),
    batchTerminalWrite: vi.fn((data: string) => writes.push(data)),
    pendingWrites: [],
    flickerFilterBuffer: '',
    _reliableSend: vi.fn(),
    _terminalInputGenerations: new Map([[sessionId, 0]]),
    _terminalOutputGenerations: new Map([[sessionId, 0]]),
    _terminalSelectionInputBaselines: new Map([[sessionId, 0]]),
    _terminalStartupRefreshSeen: new Map(),
  });
  return { app, writes };
}

describe('startup canonical refresh lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  it('discards a tagged startup replay when input and live output advance during its fetch', async () => {
    const sessionId = 'startup-refresh-active-client';
    const { app, writes } = makeRefreshHarness(sessionId);
    let resolveFetch!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          })
      )
    );

    const refresh = app._onSessionNeedsRefresh({ id: sessionId, reason: 'initial-ready', generation: 3 });
    await Promise.resolve();
    app._sendInputAsync(sessionId, 'x');
    app._onSessionTerminal({ id: sessionId, data: 'LIVE' });
    resolveFetch(new Response(JSON.stringify({ data: { terminalBuffer: 'HISTORY\nLIVE' } })));
    await refresh;

    expect(writes).toEqual(['LIVE']);
    expect(app.terminal.clear).not.toHaveBeenCalled();
    expect(app.terminal.reset).not.toHaveBeenCalled();
    expect(app.chunkedTerminalWrite).not.toHaveBeenCalled();
  });

  it('applies one tagged startup replay for a passive client with no input or live advance', async () => {
    const sessionId = 'startup-refresh-passive-client';
    const { app, writes } = makeRefreshHarness(sessionId);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: { terminalBuffer: 'HISTORY' } })))
    );

    await app._onSessionNeedsRefresh({ id: sessionId, reason: 'initial-ready', generation: 3 });

    expect(writes).toEqual(['HISTORY']);
    expect(app.terminal.clear).toHaveBeenCalledOnce();
    expect(app.terminal.reset).toHaveBeenCalledOnce();

    await app._onSessionNeedsRefresh({ id: sessionId, reason: 'initial-ready', generation: 3 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('skips a tagged startup fetch when this client sent input after canonical selection', async () => {
    const sessionId = 'startup-refresh-input-before-event';
    const { app } = makeRefreshHarness(sessionId);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    app._sendInputAsync(sessionId, 'first prompt');
    await app._onSessionNeedsRefresh({ id: sessionId, reason: 'initial-ready', generation: 3 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(app.terminal.reset).not.toHaveBeenCalled();
  });

  it('fences active and passive clients independently for the same startup generation', async () => {
    const sessionId = 'startup-refresh-two-clients';
    const active = makeRefreshHarness(sessionId);
    const passive = makeRefreshHarness(sessionId);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { terminalBuffer: 'HISTORY' } })));
    vi.stubGlobal('fetch', fetchMock);

    active.app._sendInputAsync(sessionId, 'client-a prompt');
    await Promise.all([
      active.app._onSessionNeedsRefresh({ id: sessionId, reason: 'initial-ready', generation: 3 }),
      passive.app._onSessionNeedsRefresh({ id: sessionId, reason: 'initial-ready', generation: 3 }),
    ]);

    expect(active.writes).toEqual([]);
    expect(active.app.terminal.reset).not.toHaveBeenCalled();
    expect(passive.writes).toEqual(['HISTORY']);
    expect(passive.app.terminal.reset).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('allows a new tab-selection generation to apply the current startup replay', async () => {
    const sessionId = 'startup-refresh-new-selection';
    const { app, writes } = makeRefreshHarness(sessionId);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: { terminalBuffer: 'HISTORY' } })))
    );

    app._sendInputAsync(sessionId, 'input before reselect');
    app._selectGeneration += 1;
    app._terminalSelectionInputBaselines.set(sessionId, app._terminalInputGenerations.get(sessionId));
    await app._onSessionNeedsRefresh({ id: sessionId, reason: 'initial-ready', generation: 3 });

    expect(writes).toEqual(['HISTORY']);
    expect(app.terminal.reset).toHaveBeenCalledOnce();
  });

  it('keeps legacy backpressure refresh unconditional when live output advances', async () => {
    const sessionId = 'legacy-refresh-active-client';
    const { app, writes } = makeRefreshHarness(sessionId);
    let resolveFetch!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          })
      )
    );

    const refresh = app._onSessionNeedsRefresh({ id: sessionId });
    await Promise.resolve();
    app._onSessionTerminal({ id: sessionId, data: 'LIVE' });
    resolveFetch(new Response(JSON.stringify({ data: { terminalBuffer: 'RECOVERED' } })));
    await refresh;

    expect(writes).toEqual(['LIVE', 'RECOVERED']);
    expect(app.chunkedTerminalWrite).toHaveBeenCalledOnce();
  });

  it('fences a tagged startup response from a stale tab selection generation', async () => {
    const sessionId = 'startup-refresh-stale-selection';
    const { app } = makeRefreshHarness(sessionId);
    let resolveFetch!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          })
      )
    );

    const refresh = app._onSessionNeedsRefresh({ id: sessionId, reason: 'initial-ready', generation: 3 });
    await Promise.resolve();
    app._selectGeneration += 1;
    app.activeSessionId = 'another-session';
    resolveFetch(new Response(JSON.stringify({ data: { terminalBuffer: 'STALE' } })));
    await refresh;

    expect(app.chunkedTerminalWrite).not.toHaveBeenCalled();
    expect(app.terminal.reset).not.toHaveBeenCalled();
  });
});
