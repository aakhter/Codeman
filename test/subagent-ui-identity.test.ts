// @vitest-environment jsdom
/** @fileoverview COD-350 browser coverage for opaque subagent identity. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = join(process.cwd(), 'src/web/public');
let CodemanApp: { prototype: Record<string, any> };

beforeAll(() => {
  const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');
  const source =
    'var MobileDetection = {}, KeyboardHandler = {}, SwipeHandler = {}, VoiceInput = {}, ' +
    'DeepgramProvider = {}, NotificationManager = function(){};\n' +
    read('constants.js') +
    '\n' +
    read('app.js') +
    '\n' +
    read('settings-ui.js') +
    '\n' +
    read('panels-ui.js') +
    '\n' +
    read('subagent-windows.js') +
    '\n' +
    read('entrance-animations.js') +
    '\n' +
    read('ultracode-panel.js') +
    '\n' +
    read('ultracode-windows.js') +
    '\n;globalThis.__SubagentIdentityApp = CodemanApp;';
  const previousInterval = window.setInterval;
  window.setInterval = (() => 0) as typeof window.setInterval;
  (0, eval)(source);
  window.setInterval = previousInterval;
  CodemanApp = (globalThis as any).__SubagentIdentityApp;
});

function agent(agentKey: string, overrides: Record<string, unknown> = {}) {
  return {
    agentKey,
    agentId: 'same-id',
    sessionId: 'claude-session',
    status: 'active',
    startedAt: Date.now(),
    toolCallCount: 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeApp() {
  const app = Object.create(CodemanApp.prototype) as Record<string, any>;
  app.subagents = new Map();
  app.subagentActivity = new Map();
  app.subagentToolResults = new Map();
  app.subagentWindows = new Map();
  app.subagentParentMap = new Map();
  app.minimizedSubagents = new Map();
  app.teammateTerminals = new Map();
  app._subagentEventVersions = new Map();
  app._subagentEventClock = 0;
  app._subagentPersistenceQueues = new Map();
  app._subagentPersistenceGenerations = new Map();
  app._subagentClearGeneration = 0;
  app._initGeneration = 1;
  app.sessions = new Map([
    ['tab-a', { id: 'tab-a', claudeSessionId: 'claude-session', name: 'A' }],
    ['tab-b', { id: 'tab-b', claudeSessionId: 'other-session', name: 'B' }],
  ]);
  app.activeSessionId = 'tab-a';
  app.renderSubagentPanel = vi.fn();
  app.updateSubagentWindows = vi.fn();
  app.renderSessionTabs = vi.fn();
  app.updateConnectionLines = vi.fn();
  app.updateSubagentWindowVisibility = vi.fn();
  app.saveSubagentParentMap = vi.fn();
  app.saveSubagentWindowStates = vi.fn();
  app.renderSubagentWindowContent = vi.fn();
  app.updateSubagentWindowHeader = vi.fn();
  app.scheduleSubagentWindowRender = vi.fn();
  app._notifySession = vi.fn();
  app.getSessionName = (session: { name: string }) => session.name;
  app.forceCloseSubagentWindow = vi.fn((key: string) => app.subagentWindows.delete(key));
  return app;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('opaque subagent event identity', () => {
  it('ignores unkeyed init and reconnect records instead of synthesizing bare-ID identity', () => {
    const app = makeApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    app._replaceSubagentSnapshot([
      agent('opaque-first'),
      { agentId: 'legacy-unique', status: 'active' },
      { agentId: 'collision', status: 'active' },
      { agentId: 'collision', status: 'idle' },
    ]);
    app._replaceSubagentSnapshot([{ agentId: 'legacy-unique', status: 'active' }]);

    expect([...app.subagents.keys()]).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps colliding bare agent IDs independent across maps, updates, completion, and reparenting', async () => {
    const app = makeApp();
    const first = agent('opaque-first', { description: 'First' });
    const second = agent('opaque-second', { description: 'Second', sessionId: 'other-session' });

    app._onSubagentDiscovered(first);
    app._onSubagentDiscovered(second);

    expect([...app.subagents.keys()]).toEqual(['opaque-first', 'opaque-second']);
    expect([...app.subagentActivity.keys()]).toEqual(['opaque-first', 'opaque-second']);
    expect(app.subagentParentMap.get('opaque-first')).toBe('tab-a');
    expect(app.subagentParentMap.get('opaque-second')).toBe('tab-b');

    app._onSubagentToolResult({
      agentKey: 'opaque-first',
      agentId: 'same-id',
      toolUseId: 'tool-first',
      preview: '',
    });
    app._onSubagentToolResult({
      agentKey: 'opaque-second',
      agentId: 'same-id',
      toolUseId: 'tool-second',
      preview: '',
    });
    expect([...app.subagentToolResults.keys()]).toEqual(['opaque-first', 'opaque-second']);

    app._onSubagentUpdated({ ...first, description: 'First updated' });
    await app._onSubagentCompleted({ agentKey: 'opaque-first', agentId: 'same-id', sessionId: 'claude-session' });

    expect(app.subagents.get('opaque-first')).toMatchObject({ description: 'First updated', status: 'completed' });
    expect(app.subagents.get('opaque-second')).toMatchObject({ description: 'Second', status: 'active' });
    expect(app.subagentParentMap.get('opaque-second')).toBe('tab-b');

    app.subagents.get('opaque-first').sessionId = 'other-session';
    app.subagents.get('opaque-second').sessionId = 'claude-session';
    app.recheckOrphanSubagents();
    expect(app.subagentParentMap.get('opaque-first')).toBe('tab-b');
    expect(app.subagentParentMap.get('opaque-second')).toBe('tab-a');
  });

  it('ignores missing or invalid keys and bounds diagnostics per event kind', () => {
    const app = makeApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (let index = 0; index < 20; index += 1) {
      app._onSubagentDiscovered({ agentId: 'same-id', status: 'active' });
      app._onSubagentUpdated({ agentKey: '', agentId: 'same-id', status: 'idle' });
      app._onSubagentToolCall({ agentId: 'same-id', tool: 'Read' });
      app._onSubagentCompleted({ agentKey: null, agentId: 'same-id' });
    }

    expect(app.subagents.size).toBe(0);
    expect(warn.mock.calls.length).toBeGreaterThan(0);
    expect(warn.mock.calls.length).toBeLessThanOrEqual(4);
  });
});

describe('opaque subagent actions and browser identities', () => {
  it('does not let a clear snapshot revive an agent killed after the clear began', async () => {
    const app = makeApp();
    const clearResponse = deferred<Response>();
    const killResponse = deferred<{ json: () => Promise<{ success: boolean }> }>();
    app.subagents.set('clear-trigger', agent('clear-trigger', { status: 'completed' }));
    app.subagents.set('opaque-killed', agent('opaque-killed', { status: 'active' }));
    app.showToast = vi.fn();
    app.renderSubagentDetail = vi.fn();
    app.renderMonitorSubagents = vi.fn();
    app.updateSubagentBadge = vi.fn();
    app._apiDelete = vi.fn().mockReturnValue(killResponse.promise);
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    vi.spyOn(globalThis, 'fetch').mockReturnValue(clearResponse.promise);

    const clear = app.clearAllSubagents();
    await Promise.resolve();
    const kill = app.killSubagent('opaque-killed');
    killResponse.resolve({ json: async () => ({ success: true }) });
    await kill;
    clearResponse.resolve({
      json: async () => ({
        success: true,
        data: { cleared: 1, remaining: [agent('opaque-killed', { status: 'active' })] },
      }),
    } as Response);
    await clear;

    expect(app.subagents.get('opaque-killed')?.status).toBe('completed');
    app._onSubagentDiscovered(agent('opaque-killed', { status: 'active', description: 'authoritative restart' }));
    expect(app.subagents.get('opaque-killed')).toMatchObject({
      status: 'active',
      description: 'authoritative restart',
    });
  });

  it('encodes the selected key for mutations and transcript reads while displaying the bare ID', async () => {
    const app = makeApp();
    const key = 'opaque/key?one';
    const record = agent(key);
    app.subagents.set(key, record);
    app.subagents.set('opaque-second', agent('opaque-second'));
    app.renderSubagentDetail = vi.fn();
    app.showToast = vi.fn();
    app._apiDelete = vi.fn().mockResolvedValue({ json: async () => ({ success: true }) });

    await app.killSubagent(key);
    expect(app._apiDelete).toHaveBeenCalledWith('/api/subagents/opaque%2Fkey%3Fone');
    expect(app.showToast).toHaveBeenCalledWith('Subagent same-id killed', 'success');
    expect(app.subagents.get(key).status).toBe('completed');
    expect(app.subagents.get('opaque-second').status).toBe('active');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({ success: false, error: 'expected stop' }),
    } as Response);
    await app.viewSubagentTranscript(key);
    expect(fetchSpy).toHaveBeenCalledWith('/api/subagents/opaque%2Fkey%3Fone/transcript?format=formatted');
  });

  it('renders colliding agents with distinct opaque action and DOM identities', () => {
    const app = makeApp();
    document.body.innerHTML = '<div id="subagentList"></div>';
    app.$ = (id: string) => document.getElementById(id);
    app.subagentPanelVisible = true;
    app.renderMonitorSubagents = vi.fn();
    app.updateSubagentBadge = vi.fn();
    app.getTeammateInfo = () => null;
    app.getTeammateBadgeHtml = () => '';
    app.getToolIcon = () => '';
    app.subagents.set('opaque-first', agent('opaque-first', { description: 'First' }));
    app.subagents.set('opaque-second', agent('opaque-second', { description: 'Second' }));

    app._renderSubagentPanelImmediate();

    const items = [...document.querySelectorAll<HTMLElement>('.subagent-item')];
    expect(items.map((item) => item.dataset.agentKey)).toEqual(['opaque-first', 'opaque-second']);
    expect(items[0].getAttribute('onclick')).toContain('opaque-first');
    expect(items[1].getAttribute('onclick')).toContain('opaque-second');
    expect(items.map((item) => item.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('First'), expect.stringContaining('Second')])
    );
  });

  it('keys floating window DOM and close actions by agentKey while showing agentId', () => {
    const app = makeApp();
    app.subagentWindowZIndex = 100;
    app.loadAppSettingsFromStorage = () => ({ subagentActiveTabOnly: false });
    app.getTeammateInfo = () => null;
    app.makeWindowDraggable = () => ({});
    app.applyWindowEntrance = vi.fn();
    app.markConnectionLineEntering = vi.fn();
    app.relayoutMobileSubagentWindows = vi.fn();
    app.teammatePanesByName = new Map();
    (globalThis as any).MobileDetection.getDeviceType = () => 'desktop';
    (globalThis as any).ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    app.subagents.set('opaque-first', agent('opaque-first', { description: null }));
    app.subagents.set('opaque-second', agent('opaque-second', { description: null }));
    app.subagentParentMap.set('opaque-first', 'tab-a');
    app.subagentParentMap.set('opaque-second', 'tab-a');

    app.openSubagentWindow('opaque-first');
    app.openSubagentWindow('opaque-second');

    const windows = [...document.querySelectorAll<HTMLElement>('.subagent-window')];
    expect(windows.map((win) => win.dataset.agentKey)).toEqual(['opaque-first', 'opaque-second']);
    expect(windows.map((win) => win.dataset.agentId)).toEqual([undefined, undefined]);
    expect(windows.map((win) => win.querySelector('.subagent-window-title .id')?.textContent)).toEqual([
      'same-id',
      'same-id',
    ]);
    expect(windows[0].querySelector('button')?.getAttribute('onclick')).toContain('opaque-first');
    expect(windows[1].querySelector('button')?.getAttribute('onclick')).toContain('opaque-second');

    app.closeSubagentWindow('opaque-first');
    app.closeSubagentWindow('opaque-second');
    expect(app.minimizedSubagents.get('tab-a')).toEqual(new Set(['opaque-first', 'opaque-second']));
  });

  it('uses display metadata or neutral copy for minimized agents without leaking opaque keys', () => {
    const app = makeApp();
    app.subagents.set('opaque-first-secret', agent('opaque-first-secret', { description: null }));
    app.subagents.set('opaque-no-display-secret', { agentKey: 'opaque-no-display-secret', status: 'idle' });

    const html = app.renderSubagentTabBadge('tab-a', new Set(['opaque-first-secret', 'opaque-no-display-secret']));
    const host = document.createElement('div');
    host.innerHTML = html;

    expect(host.textContent).toContain('same-id');
    expect(host.textContent).toContain('Agent');
    expect(host.textContent).not.toContain('opaque-first-secret');
    expect(host.textContent).not.toContain('opaque-no-display-secret');
  });

  it('completion cleanup and render timers are isolated by key', async () => {
    vi.useFakeTimers();
    const app = makeApp();
    app._subagentWindowRenderTimeouts = new Map();
    app.subagents.set('opaque-first', agent('opaque-first'));
    app.subagents.set('opaque-second', agent('opaque-second'));
    app.subagentActivity.set('opaque-first', [{ type: 'message' }]);
    app.subagentActivity.set('opaque-second', [{ type: 'message' }]);
    app.subagentToolResults.set('opaque-first', new Map());
    app.subagentToolResults.set('opaque-second', new Map());
    app.scheduleSubagentWindowRender = CodemanApp.prototype.scheduleSubagentWindowRender;

    app.scheduleSubagentWindowRender('opaque-first');
    app.scheduleSubagentWindowRender('opaque-second');
    expect([...app._subagentWindowRenderTimeouts.keys()]).toEqual(['opaque-first', 'opaque-second']);

    await app._onSubagentCompleted({ agentKey: 'opaque-first', agentId: 'same-id' });
    expect([...app._subagentCompletionTimers.keys()]).toEqual(['opaque-first']);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(app.subagentActivity.has('opaque-first')).toBe(false);
    expect(app.subagentActivity.has('opaque-second')).toBe(true);
  });
});

describe('persisted opaque identity and legacy migration', () => {
  it('keeps opaque parent keys and drops ambiguous or absent legacy bare IDs', async () => {
    const app = makeApp();
    app.subagents.set('opaque-first', agent('opaque-first'));
    app.subagents.set('opaque-second', agent('opaque-second'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { 'opaque-first': 'tab-a', 'same-id': 'tab-b', absent: 'tab-a' } }),
    } as Response);

    await app.loadSubagentParentMap();

    expect(Object.fromEntries(app.subagentParentMap)).toEqual({ 'opaque-first': 'tab-a' });
  });

  it('migrates a legacy bare-ID parent only when exactly one current record matches', async () => {
    const app = makeApp();
    app.subagents.set('opaque-first', agent('opaque-first'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { 'same-id': 'tab-a' } }),
    } as Response);

    await app.loadSubagentParentMap();

    expect(Object.fromEntries(app.subagentParentMap)).toEqual({ 'opaque-first': 'tab-a' });
  });

  it('migrates minimized/open geometry by unique legacy match and drops ambiguous records', async () => {
    const app = makeApp();
    app.subagents.set('opaque-first', agent('opaque-first'));
    app.loadSubagentWindowStates = vi.fn().mockResolvedValue({
      minimized: { 'tab-a': ['same-id'] },
      open: [{ agentId: 'same-id', position: { left: '80px', top: '90px' } }],
    });
    app.openSubagentWindow = vi.fn((key: string) => {
      const element = document.createElement('div');
      app.subagentWindows.set(key, { element, minimized: false });
    });

    await app.restoreSubagentWindowStates();

    expect(app.minimizedSubagents.get('tab-a')).toEqual(new Set(['opaque-first']));
    expect(app.openSubagentWindow).toHaveBeenCalledWith('opaque-first');
    expect(app.subagentWindows.get('opaque-first').position).toEqual({ left: '80px', top: '90px' });

    const ambiguous = makeApp();
    ambiguous.subagents.set('opaque-first', agent('opaque-first'));
    ambiguous.subagents.set('opaque-second', agent('opaque-second'));
    ambiguous.loadSubagentWindowStates = app.loadSubagentWindowStates;
    ambiguous.openSubagentWindow = vi.fn();
    await ambiguous.restoreSubagentWindowStates();
    expect(ambiguous.minimizedSubagents.size).toBe(0);
    expect(ambiguous.openSubagentWindow).not.toHaveBeenCalled();
  });
});

describe('manual completed-history clear', () => {
  it('does not let a stale clear response overwrite newer completion or discovery events', async () => {
    const app = makeApp();
    const completedRequest = deferred<Response>();
    const discoveryRequest = deferred<Response>();
    app.subagents.set('trigger', agent('trigger', { status: 'completed' }));
    app.subagents.set('completion-race', agent('completion-race', { status: 'active', description: 'before' }));
    app.showToast = vi.fn();
    app.renderMonitorSubagents = vi.fn();
    app.updateSubagentBadge = vi.fn();
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(completedRequest.promise)
      .mockReturnValueOnce(discoveryRequest.promise);

    const firstClear = app.clearAllSubagents();
    await Promise.resolve();
    await app._onSubagentCompleted({ agentKey: 'completion-race', agentId: 'same-id' });
    completedRequest.resolve({
      json: async () => ({
        success: true,
        data: { cleared: 1, remaining: [agent('completion-race', { status: 'active', description: 'stale' })] },
      }),
    } as Response);
    await firstClear;
    expect(app.subagents.get('completion-race')).toMatchObject({ status: 'completed', description: 'before' });

    app.subagents.set('trigger-2', agent('trigger-2', { status: 'completed' }));
    const secondClear = app.clearAllSubagents();
    await Promise.resolve();
    app._onSubagentDiscovered(agent('completion-race', { status: 'active', description: 'new discovery' }));
    discoveryRequest.resolve({
      json: async () => ({
        success: true,
        data: { cleared: 1, remaining: [agent('completion-race', { status: 'idle', description: 'stale again' })] },
      }),
    } as Response);
    await secondClear;
    expect(app.subagents.get('completion-race')).toMatchObject({ status: 'active', description: 'new discovery' });
  });

  it('counts completed history and atomically reconciles the canonical live snapshot', async () => {
    const app = makeApp();
    const liveObject = agent('opaque-live', { description: 'Before' });
    app.subagents.set('opaque-live', liveObject);
    app.subagents.set('opaque-done', agent('opaque-done', { agentId: 'done-id', status: 'completed' }));
    app.subagentActivity.set('opaque-live', [{ type: 'message', text: 'keep' }]);
    app.subagentActivity.set('opaque-done', [{ type: 'message', text: 'drop' }]);
    app.subagentParentMap.set('opaque-live', 'tab-a');
    app.subagentParentMap.set('opaque-done', 'tab-a');
    app.subagentWindows.set('opaque-live', { element: document.createElement('div'), minimized: false });
    app.subagentWindows.set('opaque-done', { element: document.createElement('div'), minimized: true });
    app.minimizedSubagents.set('tab-a', new Set(['opaque-done']));
    app.renderMonitorSubagents = vi.fn();
    app.updateSubagentBadge = vi.fn();
    app.showToast = vi.fn();
    app._subagentWindowRenderTimeouts = new Map([['opaque-done', setTimeout(() => {}, 60_000)]]);
    app._subagentCompletionTimers = new Map([['opaque-done', [setTimeout(() => {}, 60_000)]]]);
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({
        success: true,
        data: {
          cleared: 1,
          remaining: [{ ...liveObject, description: 'After', status: 'idle' }],
        },
      }),
    } as Response);

    await app.clearAllSubagents();

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('1 completed'));
    expect(confirmSpy).toHaveBeenCalledWith(expect.not.stringContaining('running processes'));
    expect([...app.subagents.keys()]).toEqual(['opaque-live']);
    expect(app.subagents.get('opaque-live')).toBe(liveObject);
    expect(liveObject).toMatchObject({ description: 'After', status: 'idle' });
    expect(app.subagentActivity.get('opaque-live')).toEqual([{ type: 'message', text: 'keep' }]);
    expect(app.subagentWindows.has('opaque-live')).toBe(true);
    expect(app.subagentParentMap.get('opaque-live')).toBe('tab-a');
    expect(app.subagentActivity.has('opaque-done')).toBe(false);
    expect(app.subagentWindows.has('opaque-done')).toBe(false);
    expect(app.subagentParentMap.has('opaque-done')).toBe(false);
    expect(app.minimizedSubagents.size).toBe(0);
    expect(app._subagentWindowRenderTimeouts.has('opaque-done')).toBe(false);
    expect(app._subagentCompletionTimers.has('opaque-done')).toBe(false);
    expect(app.showToast).toHaveBeenCalledWith('Cleared 1 completed subagent', 'success');
  });

  it('does not offer to clear when only live agents remain', async () => {
    const app = makeApp();
    app.subagents.set('opaque-live', agent('opaque-live'));
    app.showToast = vi.fn();
    const confirmSpy = vi.spyOn(globalThis, 'confirm');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await app.clearAllSubagents();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(app.showToast).toHaveBeenCalledWith('No completed subagent history to clear', 'info');
  });

  it('preserves absent active and idle records while removing absent completed history', () => {
    const app = makeApp();
    app.subagents.set('opaque-active', agent('opaque-active', { status: 'active' }));
    app.subagents.set('opaque-idle', agent('opaque-idle', { status: 'idle' }));
    app.subagents.set('opaque-done', agent('opaque-done', { status: 'completed' }));
    for (const key of app.subagents.keys()) {
      app.subagentActivity.set(key, [{ key }]);
      app.subagentParentMap.set(key, 'tab-a');
      app.subagentWindows.set(key, { element: document.createElement('div') });
    }

    app._reconcileSubagentSnapshot([]);

    expect([...app.subagents.keys()]).toEqual(['opaque-active', 'opaque-idle']);
    expect([...app.subagentActivity.keys()]).toEqual(['opaque-active', 'opaque-idle']);
    expect([...app.subagentParentMap.keys()]).toEqual(['opaque-active', 'opaque-idle']);
    expect([...app.subagentWindows.keys()]).toEqual(['opaque-active', 'opaque-idle']);
  });

  it('ignores an older clear response that resolves after a newer clear', async () => {
    const app = makeApp();
    const older = deferred<Response>();
    const newer = deferred<Response>();
    app.subagents.set('done', agent('done', { status: 'completed' }));
    app.showToast = vi.fn();
    app.renderMonitorSubagents = vi.fn();
    app.updateSubagentBadge = vi.fn();
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    const first = app.clearAllSubagents();
    const second = app.clearAllSubagents();
    newer.resolve({
      json: async () => ({ success: true, data: { cleared: 1, remaining: [agent('new-live')] } }),
    } as Response);
    await second;
    older.resolve({
      json: async () => ({ success: true, data: { cleared: 1, remaining: [agent('old-live')] } }),
    } as Response);
    await first;

    expect([...app.subagents.keys()]).toEqual(['new-live']);
  });
});

describe('subagent reconnect generations and persistence', () => {
  it('normalizes corrupt persisted window shapes and recovers from malformed cache JSON', async () => {
    const app = makeApp();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            minimized: {
              'tab-a': [null, 42, '', 'opaque-first'],
              'tab-b': null,
            },
            open: {},
          },
        }),
      } as Response)
      .mockRejectedValueOnce(new Error('offline'));

    expect(await app.loadSubagentWindowStates(1)).toEqual({
      minimized: { 'tab-a': ['opaque-first'] },
      open: [],
    });
    expect(
      app._normalizeSubagentWindowStates({
        minimized: null,
        open: [null, 7, {}, { agentKey: '' }, { agentKey: 'opaque-first', position: null }],
      })
    ).toEqual({ minimized: {}, open: [{ agentKey: 'opaque-first', position: null }] });

    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('{not-json');
    expect(await app.loadSubagentWindowStates(1)).toEqual({ minimized: {}, open: [] });
    expect(error).toHaveBeenCalled();
  });

  it('bounds restore-chain failures and allows a later init generation to recover', async () => {
    const app = makeApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    app.loadSubagentParentMap = vi.fn().mockResolvedValue(undefined);
    app.restoreSubagentWindowStates = vi
      .fn()
      .mockRejectedValueOnce(new Error('corrupt dependency'))
      .mockResolvedValueOnce(undefined);

    app._initGeneration = 1;
    await expect(app._restoreSubagentStateForInit(1)).resolves.toBeUndefined();
    app._initGeneration = 2;
    await expect(app._restoreSubagentStateForInit(2)).resolves.toBeUndefined();

    const staleFailure = deferred<never>();
    app.restoreSubagentWindowStates.mockReturnValueOnce(staleFailure.promise);
    app._initGeneration = 3;
    const staleRestore = app._restoreSubagentStateForInit(3);
    await Promise.resolve();
    app._initGeneration = 4;
    staleFailure.reject(new Error('superseded failure'));
    await expect(staleRestore).resolves.toBeUndefined();

    expect(app.restoreSubagentWindowStates).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rejects stale parent and window restore fetches after a newer init generation', async () => {
    const app = makeApp();
    app.subagents.set('opaque-first', agent('opaque-first'));
    app.subagents.set('opaque-second', agent('opaque-second'));
    const oldParent = deferred<Response>();
    const newParent = deferred<Response>();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(oldParent.promise)
      .mockReturnValueOnce(newParent.promise);
    const storageSet = vi.spyOn(Storage.prototype, 'setItem');

    app._initGeneration = 1;
    const firstParentLoad = app.loadSubagentParentMap(1);
    app._initGeneration = 2;
    app.subagentParentMap.clear();
    const secondParentLoad = app.loadSubagentParentMap(2);
    newParent.resolve({
      ok: true,
      json: async () => ({ success: true, data: { 'opaque-second': 'tab-b' } }),
    } as Response);
    await secondParentLoad;
    oldParent.resolve({
      ok: true,
      json: async () => ({ success: true, data: { 'opaque-first': 'tab-a' } }),
    } as Response);
    await firstParentLoad;
    expect(Object.fromEntries(app.subagentParentMap)).toEqual({ 'opaque-second': 'tab-b' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const parentCacheWrites = storageSet.mock.calls.filter(([key]) => key === 'codeman-subagent-parents');
    expect(parentCacheWrites).toHaveLength(1);
    expect(parentCacheWrites[0]?.[1]).toContain('opaque-second');
    expect(parentCacheWrites[0]?.[1]).not.toContain('opaque-first');

    const oldWindows = deferred<Record<string, unknown>>();
    const newWindows = deferred<Record<string, unknown>>();
    app.loadSubagentWindowStates = vi
      .fn()
      .mockReturnValueOnce(oldWindows.promise)
      .mockReturnValueOnce(newWindows.promise);
    app.openSubagentWindow = vi.fn();
    app._initGeneration = 3;
    const firstRestore = app.restoreSubagentWindowStates(3);
    app._initGeneration = 4;
    const secondRestore = app.restoreSubagentWindowStates(4);
    newWindows.resolve({ minimized: {}, open: [{ agentKey: 'opaque-second' }] });
    await secondRestore;
    oldWindows.resolve({ minimized: {}, open: [{ agentKey: 'opaque-first' }] });
    await firstRestore;
    expect(app.openSubagentWindow).toHaveBeenCalledTimes(1);
    expect(app.openSubagentWindow).toHaveBeenCalledWith('opaque-second');
    expect(app.saveSubagentWindowStates).toHaveBeenCalledTimes(1);
  });

  it('serializes persistence, isolates storage failures, and leaves the newest snapshot last', async () => {
    const app = makeApp();
    app.saveSubagentWindowStates = CodemanApp.prototype.saveSubagentWindowStates;
    const firstPut = deferred<unknown>();
    const put = vi.fn().mockReturnValueOnce(firstPut.promise).mockRejectedValueOnce(new Error('server unavailable'));
    app._apiPut = put;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });

    app.subagentWindows.set('opaque-first', { minimized: false, position: { left: '1px' } });
    const first = app.saveSubagentWindowStates();
    await Promise.resolve();
    app.subagentWindows.clear();
    app.subagentWindows.set('opaque-second', { minimized: false, position: { left: '2px' } });
    const second = app.saveSubagentWindowStates();
    firstPut.resolve(undefined);
    await Promise.all([first, second]);

    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1][1].open).toEqual([{ agentKey: 'opaque-second', position: { left: '2px' } }]);
    expect(warn.mock.calls.length).toBeGreaterThan(0);
    expect(warn.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe('secondary opaque identity consumers', () => {
  it('attaches line entrance animation to the exact keyed connection path', () => {
    const app = makeApp();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const first = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const second = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    first.dataset.agentKey = 'opaque-first';
    second.dataset.agentKey = 'opaque-second';
    first.getTotalLength = () => 10;
    second.getTotalLength = () => 20;
    svg.append(first, second);
    app._lineAnimStyle = 'draw';
    app._lineEnterActive = new Map([['opaque-second', { startTs: performance.now() }]]);
    app._lineAnimDuration = () => 1000;
    (globalThis as any).CSS = { escape: (value: string) => value };

    app._applyLineEntrances(svg);

    expect(first.classList.contains('line-enter')).toBe(false);
    expect(second.classList.contains('line-enter')).toBe(true);
  });

  it('uses encoded workflow agentKey URLs and keeps colliding display IDs independent', async () => {
    const app = makeApp();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({ success: true, data: { formatted: ['ok'], entryCount: 1 } }),
    } as Response);

    await app._fetchWorkflowAgentTranscript('opaque/key?first');
    await app._fetchWorkflowAgentTranscript('opaque/key?second');
    const firstHtml = app._workflowAgentCardHtml(
      { agentKey: 'opaque/key?first', agentId: 'same-id', label: 'First', state: 'progress' },
      'run-1'
    );
    const secondHtml = app._workflowAgentCardHtml(
      { agentKey: 'opaque/key?second', agentId: 'same-id', label: 'Second', state: 'progress' },
      'run-1'
    );

    expect(fetchSpy).toHaveBeenNthCalledWith(1, '/api/subagents/opaque%2Fkey%3Ffirst/transcript?format=formatted');
    expect(fetchSpy).toHaveBeenNthCalledWith(2, '/api/subagents/opaque%2Fkey%3Fsecond/transcript?format=formatted');
    expect(firstHtml).toContain('opaque/key?first');
    expect(firstHtml).not.toContain('opaque/key?second');
    expect(secondHtml).toContain('opaque/key?second');
    expect(secondHtml).not.toContain('opaque/key?first');
  });

  it('keeps workflow cards without agentKey inert with bounded diagnostics', () => {
    const app = makeApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let html = '';
    for (let index = 0; index < 20; index += 1) {
      html = app._workflowAgentCardHtml({ agentId: 'same-id', label: 'Agent', state: 'progress' }, 'run-1');
    }
    expect(html).not.toContain('openUltracodeAgentWindow');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('resolves colliding ultracode window and minimized labels by exact key without key leakage', () => {
    const app = makeApp();
    app.workflowRunDetails = new Map([
      [
        'run-1',
        {
          agents: [
            { agentKey: 'opaque-first-secret', agentId: 'same-id', label: 'First label' },
            { agentKey: 'opaque-second-secret', agentId: 'same-id', name: 'Second name' },
            { agentKey: 'opaque-display-secret', agentId: 'display-id' },
            { agentKey: 'opaque-neutral-secret' },
          ],
        },
      ],
    ]);
    app.workflowRuns = new Map([['run-1', { runId: 'run-1', sessionUuid: 'claude-session' }]]);
    app.makeWindowDraggable = () => ({});
    app.applyWindowEntrance = vi.fn();
    app._fullRenderSessionTabs = vi.fn();

    for (const key of [
      'opaque-first-secret',
      'opaque-second-secret',
      'opaque-display-secret',
      'opaque-neutral-secret',
    ]) {
      app.createUltracodeAgentWindow(key, 'run-1');
    }

    expect([...document.querySelectorAll('.ultracode-agent-window .uw-name')].map((node) => node.textContent)).toEqual([
      'First label',
      'Second name',
      'display-id',
      'Agent',
    ]);

    for (const key of [...app.ultracodeAgentWindows.keys()]) app.minimizeUltracodeAgentWindowToTab(key);
    const host = document.createElement('div');
    host.innerHTML = app.renderUltracodeTabBadge('tab-a');
    expect(host.textContent).toContain('First label');
    expect(host.textContent).toContain('Second name');
    expect(host.textContent).toContain('display-id');
    expect(host.textContent).toContain('Agent');
    expect(host.textContent).not.toContain('opaque-first-secret');
    expect(host.textContent).not.toContain('opaque-neutral-secret');
  });
});
