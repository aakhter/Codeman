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

function makeApp() {
  const app = Object.create(CodemanApp.prototype) as Record<string, any>;
  app.subagents = new Map();
  app.subagentActivity = new Map();
  app.subagentToolResults = new Map();
  app.subagentWindows = new Map();
  app.subagentParentMap = new Map();
  app.minimizedSubagents = new Map();
  app.teammateTerminals = new Map();
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
});
