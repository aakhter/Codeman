import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

type Listener = (event?: Record<string, unknown>) => void;
type ListenerOptions = boolean | { capture?: boolean; passive?: boolean };
type RegisteredListener = { listener: Listener; capture: boolean; options?: ListenerOptions };

class FakeTarget {
  private listeners = new Map<string, RegisteredListener[]>();
  private removals = new Map<string, (ListenerOptions | undefined)[]>();

  addEventListener(type: string, listener: Listener, options?: ListenerOptions) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, capture: options === true || options?.capture === true, options });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener, options?: ListenerOptions) {
    const removals = this.removals.get(type) ?? [];
    removals.push(options);
    this.removals.set(type, removals);
    const capture = options === true || options?.capture === true;
    const listeners = this.listeners.get(type) ?? [];
    const index = listeners.findIndex(
      (registered) => registered.listener === listener && registered.capture === capture
    );
    if (index >= 0) listeners.splice(index, 1);
  }

  dispatch(type: string, event: Record<string, unknown> = {}) {
    for (const registered of [...(this.listeners.get(type) ?? [])]) registered.listener(event);
  }

  listenerCount(type?: string) {
    if (type) return this.listeners.get(type)?.length ?? 0;
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.length, 0);
  }

  listenerOptions(type: string) {
    return (this.listeners.get(type) ?? []).map((registered) => registered.options);
  }

  listenersFor(type: string) {
    return (this.listeners.get(type) ?? []).map((registered) => registered.listener);
  }

  removedListenerOptions(type: string) {
    return this.removals.get(type) ?? [];
  }
}

type Dimensions = { cols: number; rows: number; viewportType: string } | null;

function loadApi(globals: Record<string, unknown> = {}) {
  const source = readFileSync(new URL('../src/web/public/terminal-viewer-activity.js', import.meta.url), 'utf8');
  const context = vm.createContext(globals);
  vm.runInContext(source, context, { filename: 'terminal-viewer-activity.js' });
  return vm.runInContext('CodemanTerminalViewerActivity', context) as {
    create: (deps: Record<string, unknown>) => {
      activate: (reason: string) => boolean;
      flushPending: (reason: string) => boolean;
      hasPending: (sessionId?: string | null) => boolean;
      runWithoutActivation: <T>(callback: () => T) => T;
      destroy: () => void;
    };
  };
}

function harness(
  overrides: {
    visible?: boolean;
    focused?: boolean;
    sessionId?: string | null;
    dimensions?: Dimensions;
    send?: (frame: unknown) => boolean;
  } = {}
) {
  const api = loadApi();
  const documentTarget = new FakeTarget();
  const windowTarget = new FakeTarget();
  const terminalTarget = new FakeTarget();
  let visible = overrides.visible ?? true;
  let focused = overrides.focused ?? true;
  let sessionId = overrides.sessionId === undefined ? 's1' : overrides.sessionId;
  let dimensions =
    overrides.dimensions === undefined ? { cols: 75, rows: 62, viewportType: 'mobile' } : overrides.dimensions;
  let now = 1_000;
  const sent: unknown[] = [];
  const send =
    overrides.send ??
    ((frame: unknown) => {
      sent.push(frame);
      return true;
    });
  const controller = api.create({
    documentTarget,
    windowTarget,
    terminalTarget,
    isVisible: () => visible,
    isFocused: () => focused,
    activeSessionId: () => sessionId,
    dimensions: () => dimensions,
    send,
    now: () => now,
  });

  return {
    controller,
    documentTarget,
    windowTarget,
    terminalTarget,
    sent,
    setVisible: (value: boolean) => {
      visible = value;
    },
    setFocused: (value: boolean) => {
      focused = value;
    },
    setSessionId: (value: string | null) => {
      sessionId = value;
    },
    setDimensions: (value: Dimensions) => {
      dimensions = value;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send() {}
  close() {}
}

function loadAppHarness() {
  FakeWebSocket.instances = [];
  const windowTarget = Object.assign(new FakeTarget(), {
    CodemanTerminalViewerActivity: undefined as unknown,
    removeEventListener: FakeTarget.prototype.removeEventListener,
  });
  let terminalTarget: FakeTarget | null = null;
  let focused = true;
  const documentTarget = Object.assign(new FakeTarget(), {
    visibilityState: 'visible',
    hasFocus: () => focused,
    getElementById: (id: string) => (id === 'terminalContainer' ? terminalTarget : null),
    querySelector: () => null,
  });
  const context = vm.createContext({
    console: { ...console, log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: FakeWebSocket,
    location: { protocol: 'https:', host: 'test.local' },
    fetch: vi.fn(),
    document: documentTarget,
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    window: windowTarget,
    MobileDetection: { isTouchDevice: () => false },
  });
  const constants = readFileSync(new URL('../src/web/public/constants.js', import.meta.url), 'utf8');
  const appSource = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  vm.runInContext(`${constants}\n${appSource}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  const CodemanApp = (context as { __CodemanApp: { prototype: object } }).__CodemanApp;
  return {
    appSource,
    CodemanApp,
    context,
    documentTarget,
    windowTarget,
    setTerminalTarget: (target: FakeTarget | null) => {
      terminalTarget = target;
    },
    setFocused: (value: boolean) => {
      focused = value;
    },
  };
}

function makeMainSelectionApp(
  CodemanApp: { prototype: object },
  activate: ReturnType<typeof vi.fn>,
  onFit: () => void
) {
  const app = Object.create(CodemanApp.prototype) as Record<string, unknown> & {
    activeSessionId: string;
    selectSession: (id: string, options?: { auto?: boolean }) => Promise<void>;
  };
  Object.assign(app, {
    activeSessionId: 's0',
    activeWebviewId: null,
    isSoloWindow: false,
    detachedSessions: new Set(),
    sessions: new Map([
      ['s0', { id: 's0', name: 'old', pid: 1 }],
      ['s1', { id: 's1', name: 'target', pid: 2 }],
    ]),
    terminal: { options: {}, refresh: vi.fn() },
    fitAddon: { fit: vi.fn(onFit) },
    _terminalViewerActivity: { activate },
    _selectGeneration: 0,
    _shouldFocusTerminalForTabSwitch: vi.fn(() => false),
    _setTerminalLoadState: vi.fn(),
    _clearTerminalLoadState: vi.fn(),
    _isStaleSelect: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
    _cleanupPreviousSession: vi.fn(),
    _isMirrorSession: vi.fn(() => false),
    _userScrollback: vi.fn(() => 1_000),
    _renderHistoryTruncationBanner: vi.fn(),
    _updateSseSubscription: vi.fn(),
    _connectWs: vi.fn(),
    hideWelcome: vi.fn(),
    markIdleAlertSeen: vi.fn(),
    _updateActiveTabImmediate: vi.fn(),
    closeSessionSidebarOnHandheld: vi.fn(),
    renderSessionTabs: vi.fn(),
    _updateLocalEchoState: vi.fn(),
    _beginBufferLoad: vi.fn(() => 1),
    _syncTerminalTouchAction: vi.fn(),
    sendResize: vi.fn(async () => false),
    attachmentHistoryDrawerOpen: false,
  });
  return app;
}

function allowMainSelectionToComplete(
  h: ReturnType<typeof loadAppHarness>,
  app: ReturnType<typeof makeMainSelectionApp>
) {
  app._isStaleSelect = vi.fn(() => false);
  (app.sessions as Map<string, Record<string, unknown>>).get('s1')!.mode = 'shell';
  app.terminalBufferCache = new Map();
  app._sessionsLoadedSincePageOpen = new Set();
  app._fullHistoryLoaded = new Set();
  app._resetTerminalForReplay = vi.fn();
  app._isLoadingBuffer = false;
  app.scrollToLastNonEmptyLine = vi.fn();
  app._recordTerminalLoadTiming = vi.fn();
  app._scheduleTerminalRepaint = vi.fn();
  (h.context.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    json: async () => ({ data: {} }),
    headers: { get: vi.fn(() => null) },
  });
}

describe('terminal viewer activity controller', () => {
  it('installs without sending or queueing activity', () => {
    const h = harness();

    expect(h.sent).toEqual([]);
    expect(h.controller.flushPending('ws-open')).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it('suppresses nested event activation, returns values, and restores after exceptions', () => {
    const h = harness();
    const result = h.controller.runWithoutActivation(() => {
      h.terminalTarget.dispatch('pointerdown');
      return h.controller.runWithoutActivation(() => {
        h.terminalTarget.dispatch('focusin');
        return 42;
      });
    });
    expect(result).toBe(42);
    expect(h.sent).toEqual([]);
    expect(h.controller.flushPending('ws-open')).toBe(false);

    expect(() =>
      h.controller.runWithoutActivation(() => {
        h.terminalTarget.dispatch('pointerdown');
        throw new Error('focus failed');
      })
    ).toThrow('focus failed');
    expect(h.sent).toEqual([]);

    h.terminalTarget.dispatch('pointerdown');
    expect(h.sent).toEqual([{ t: 'va', c: 75, r: 62, v: 'mobile' }]);
  });

  it('sends on a visible focused transition, dedupes for 250ms, then sends again', () => {
    const h = harness({ visible: false });
    h.setVisible(true);
    h.documentTarget.dispatch('visibilitychange');
    h.windowTarget.dispatch('focus');
    expect(h.sent).toEqual([{ t: 'va', c: 75, r: 62, v: 'mobile' }]);

    h.setNow(1_249);
    h.windowTarget.dispatch('focus');
    expect(h.sent).toHaveLength(1);

    h.setNow(1_250);
    h.windowTarget.dispatch('focus');
    expect(h.sent).toHaveLength(2);
  });

  it('never deduplicates an explicit terminal-size restore ownership claim', () => {
    const h = harness();

    expect(h.controller.activate('pointerdown')).toBe(true);
    expect(h.controller.activate('restore-terminal-size')).toBe(true);
    expect(h.sent).toEqual([
      { t: 'va', c: 75, r: 62, v: 'mobile' },
      { t: 'va', c: 75, r: 62, v: 'mobile' },
    ]);
  });

  it('dedupes only finite nonnegative deltas below 250ms', () => {
    const h = harness();
    h.setNow(0);
    h.terminalTarget.dispatch('pointerdown');
    h.setNow(249);
    h.terminalTarget.dispatch('pointerdown');
    h.setNow(250);
    h.terminalTarget.dispatch('pointerdown');
    h.setNow(100);
    h.terminalTarget.dispatch('pointerdown');
    h.setNow(Number.NaN);
    h.terminalTarget.dispatch('pointerdown');
    expect(h.sent).toHaveLength(4);
  });

  it('uses a monotonic performance clock by default when available', () => {
    let clock = 0;
    const api = loadApi({ performance: { now: () => clock } });
    const terminalTarget = new FakeTarget();
    const sent: unknown[] = [];
    api.create({
      documentTarget: new FakeTarget(),
      windowTarget: new FakeTarget(),
      terminalTarget,
      isVisible: () => true,
      isFocused: () => true,
      activeSessionId: () => 's1',
      dimensions: () => ({ cols: 75, rows: 62, viewportType: 'mobile' }),
      send: (frame: unknown) => sent.push(frame),
    });

    terminalTarget.dispatch('pointerdown');
    clock = 249;
    terminalTarget.dispatch('pointerdown');
    clock = 250;
    terminalTarget.dispatch('pointerdown');
    expect(sent).toHaveLength(2);
  });

  it('installs touchstart as passive and removes it with stable listener semantics', () => {
    const h = harness();
    expect(h.terminalTarget.listenerOptions('touchstart')).toEqual([{ passive: true }]);
    h.controller.destroy();
    expect(h.terminalTarget.listenerCount('touchstart')).toBe(0);
    expect(h.terminalTarget.removedListenerOptions('touchstart')).toEqual([{ passive: true }]);
  });

  it('activates on a real visible transition without requiring document focus', () => {
    const h = harness({ visible: false, focused: false });
    h.setVisible(true);
    h.documentTarget.dispatch('visibilitychange');
    expect(h.sent).toEqual([{ t: 'va', c: 75, r: 62, v: 'mobile' }]);
  });

  it('ignores hidden interactions and never listens to resize or orientationchange', () => {
    const hidden = harness({ visible: false });
    hidden.windowTarget.dispatch('focus');
    hidden.terminalTarget.dispatch('focusin');
    hidden.terminalTarget.dispatch('pointerdown');
    hidden.terminalTarget.dispatch('touchstart');
    hidden.documentTarget.dispatch('visibilitychange');
    expect(hidden.sent).toEqual([]);

    expect(hidden.windowTarget.listenerCount('resize')).toBe(0);
    expect(hidden.windowTarget.listenerCount('orientationchange')).toBe(0);
  });

  it.each(['focus', 'focusin'])('%s requires current document focus', (type) => {
    const h = harness({ focused: false });
    if (type === 'focus') h.windowTarget.dispatch(type);
    else h.terminalTarget.dispatch(type);
    expect(h.sent).toEqual([]);
    h.setFocused(true);
    if (type === 'focus') h.windowTarget.dispatch(type);
    else h.terminalTarget.dispatch(type);
    expect(h.sent).toEqual([{ t: 'va', c: 75, r: 62, v: 'mobile' }]);
  });

  it.each(['pointerdown', 'touchstart'])('%s on the terminal does not require document focus', (type) => {
    const h = harness({ focused: false });
    h.terminalTarget.dispatch(type);
    expect(h.sent).toEqual([{ t: 'va', c: 75, r: 62, v: 'mobile' }]);
  });

  it('requires focus for user-initiated session selection', () => {
    const h = harness({ focused: false });
    expect(h.controller.activate('session-select')).toBe(false);
    expect(h.sent).toEqual([]);
    h.setFocused(true);
    expect(h.controller.activate('session-select')).toBe(true);
  });

  it('queues only failed explicit activity and retries it on ws-open until successful', () => {
    let ready = false;
    const send = vi.fn(() => ready);
    const h = harness({ send });

    expect(h.controller.flushPending('ws-open')).toBe(false);
    expect(send).not.toHaveBeenCalled();

    expect(h.controller.activate('session-select')).toBe(false);
    expect(h.controller.hasPending()).toBe(true);
    expect(h.controller.hasPending('other-session')).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.controller.flushPending('ws-open')).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);

    ready = true;
    expect(h.controller.flushPending('ws-open')).toBe(true);
    expect(h.controller.hasPending()).toBe(false);
    expect(send).toHaveBeenCalledTimes(3);
    expect(h.controller.flushPending('ws-open')).toBe(false);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('keeps a pending focus-based activation queued until focus returns', () => {
    let ready = false;
    const send = vi.fn(() => ready);
    const h = harness({ send });
    h.controller.activate('session-select');
    h.setFocused(false);
    ready = true;

    expect(h.controller.flushPending('ws-open')).toBe(false);
    expect(send).toHaveBeenCalledOnce();
    h.setFocused(true);
    h.windowTarget.dispatch('focus');
    expect(send).toHaveBeenCalledTimes(2);
    expect(h.controller.flushPending('ws-open')).toBe(false);
  });

  it('does not transfer pending activity to an automatically selected session', () => {
    let ready = false;
    const send = vi.fn(() => ready);
    const h = harness({ send });
    h.controller.activate('pointerdown');

    h.setSessionId('auto-selected');
    ready = true;
    expect(h.controller.flushPending('ws-open')).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);

    h.setSessionId('s1');
    expect(h.controller.flushPending('ws-open')).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('retries pending activity with the same session latest fitted dimensions', () => {
    let ready = false;
    const delivered: unknown[] = [];
    const h = harness({
      send: (frame) => {
        if (!ready) return false;
        delivered.push(frame);
        return true;
      },
    });
    h.controller.activate('pointerdown');
    h.setDimensions({ cols: 80, rows: 40, viewportType: 'tablet' });

    ready = true;
    expect(h.controller.flushPending('ws-open')).toBe(true);
    expect(delivered).toEqual([{ t: 'va', c: 80, r: 40, v: 'tablet' }]);
  });

  it('lets session and fitted-dimension signature changes bypass dedupe', () => {
    const h = harness();
    h.terminalTarget.dispatch('pointerdown');
    h.setSessionId('s2');
    h.terminalTarget.dispatch('pointerdown');
    h.setDimensions({ cols: 80, rows: 40, viewportType: 'desktop' });
    h.terminalTarget.dispatch('pointerdown');

    expect(h.sent).toEqual([
      { t: 'va', c: 75, r: 62, v: 'mobile' },
      { t: 'va', c: 75, r: 62, v: 'mobile' },
      { t: 'va', c: 80, r: 40, v: 'desktop' },
    ]);
  });

  it.each([
    { sessionId: null },
    { sessionId: '' },
    { dimensions: null },
    { dimensions: { cols: 0, rows: 20, viewportType: 'desktop' } },
    { dimensions: { cols: 501, rows: 20, viewportType: 'desktop' } },
    { dimensions: { cols: 80.5, rows: 20, viewportType: 'desktop' } },
    { dimensions: { cols: 80, rows: 0, viewportType: 'desktop' } },
    { dimensions: { cols: 80, rows: 201, viewportType: 'desktop' } },
    { dimensions: { cols: 80, rows: 20.5, viewportType: 'desktop' } },
    { dimensions: { cols: 80, rows: 20, viewportType: 'watch' } },
  ])('rejects missing or invalid session/dimensions: $sessionId $dimensions', (overrides) => {
    const h = harness(overrides);
    expect(h.controller.activate('session-select')).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.controller.flushPending('ws-open')).toBe(false);
  });

  it('keeps the local reason off the wire', () => {
    const h = harness();
    h.controller.activate('very-specific-local-reason');
    expect(h.sent).toEqual([{ t: 'va', c: 75, r: 62, v: 'mobile' }]);
    expect(Object.keys(h.sent[0] as object)).toEqual(['t', 'c', 'r', 'v']);
  });

  it('treats a truthy sender result as a successful send', () => {
    const delivered: unknown[] = [];
    const h = harness({ send: (frame) => delivered.push(frame) as unknown as boolean });
    expect(h.controller.activate('session-select')).toBe(true);
    expect(h.controller.flushPending('ws-open')).toBe(false);
    expect(delivered).toHaveLength(1);
  });

  it('destroy removes installed listeners, cancels pending state, and is idempotent', () => {
    const send = vi.fn(() => false);
    const h = harness({ send });
    h.terminalTarget.dispatch('pointerdown');
    expect(send).toHaveBeenCalledOnce();
    expect(h.documentTarget.listenerCount() + h.windowTarget.listenerCount() + h.terminalTarget.listenerCount()).toBe(
      5
    );

    h.controller.destroy();
    h.controller.destroy();
    expect(h.documentTarget.listenerCount() + h.windowTarget.listenerCount() + h.terminalTarget.listenerCount()).toBe(
      0
    );
    h.documentTarget.dispatch('visibilitychange');
    h.windowTarget.dispatch('focus');
    h.terminalTarget.dispatch('touchstart');
    expect(h.controller.activate('session-select')).toBe(false);
    expect(h.controller.flushPending('ws-open')).toBe(false);
    expect(send).toHaveBeenCalledOnce();
  });
});

describe('terminal viewer activity browser integration', () => {
  const appSource = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  const terminalUiSource = readFileSync(new URL('../src/web/public/terminal-ui.js', import.meta.url), 'utf8');
  const indexSource = readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');

  it('loads the controller before app.js', () => {
    const controllerScript = indexSource.indexOf('<script defer src="terminal-viewer-activity.js"');
    const appScript = indexSource.indexOf('<script defer src="app.js"');
    expect(controllerScript).toBeGreaterThan(-1);
    expect(controllerScript).toBeLessThan(appScript);
  });

  it('replaces repeated init safely and tears down only the matching controller generation', () => {
    const h = loadAppHarness();
    const first = { activate: vi.fn(), flushPending: vi.fn(), destroy: vi.fn() };
    const second = { activate: vi.fn(), flushPending: vi.fn(), destroy: vi.fn() };
    const controllers = [first, second];
    const create = vi.fn(() => controllers.shift());
    h.windowTarget.CodemanTerminalViewerActivity = { create };
    const app = Object.create(h.CodemanApp.prototype) as Record<string, unknown> & {
      _initTerminalViewerActivity: () => void;
    };
    app._terminalViewerActivity = null;
    app._terminalViewerActivityPagehideHandler = null;

    app._initTerminalViewerActivity();
    expect(create).not.toHaveBeenCalled();

    const terminalTarget = new FakeTarget();
    h.setTerminalTarget(terminalTarget);
    app._initTerminalViewerActivity();
    expect(create).toHaveBeenCalledOnce();
    expect(h.windowTarget.listenerCount('pagehide')).toBe(1);
    const stalePagehideHandler = h.windowTarget.listenersFor('pagehide')[0];
    const deps = create.mock.calls[0][0] as Record<string, () => unknown> & { terminalTarget: FakeTarget };
    expect(deps.terminalTarget).toBe(terminalTarget);
    expect(Number(deps.now())).toBeLessThan(1_000_000_000);
    h.setFocused(false);
    expect(deps.isFocused()).toBe(false);
    h.setFocused(true);
    expect(deps.isFocused()).toBe(true);

    app._initTerminalViewerActivity();
    expect(create).toHaveBeenCalledTimes(2);
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(second.destroy).not.toHaveBeenCalled();
    expect(h.windowTarget.listenerCount('pagehide')).toBe(1);

    stalePagehideHandler({ persisted: false });
    expect(second.destroy).not.toHaveBeenCalled();
    expect(h.windowTarget.listenerCount('pagehide')).toBe(1);

    h.windowTarget.dispatch('pagehide', { persisted: true });
    expect(second.destroy).not.toHaveBeenCalled();
    expect(h.windowTarget.listenerCount('pagehide')).toBe(1);
    h.windowTarget.dispatch('pagehide', { persisted: false });
    h.windowTarget.dispatch('pagehide', { persisted: false });
    expect(second.destroy).toHaveBeenCalledOnce();
    expect(h.windowTarget.listenerCount('pagehide')).toBe(0);

    const initFrame = h.appSource.slice(
      h.appSource.indexOf('requestAnimationFrame(() => {'),
      h.appSource.indexOf('this.connectSSE()', h.appSource.indexOf('requestAnimationFrame(() => {'))
    );
    expect(initFrame.indexOf('this.initTerminal()')).toBeLessThan(
      initFrame.indexOf('this._initTerminalViewerActivity()')
    );
  });

  it('sends only through the current ready socket identity and handles socket throws', () => {
    const h = loadAppHarness();
    let capturedDeps: Record<string, (...args: unknown[]) => unknown> | null = null;
    h.setTerminalTarget(new FakeTarget());
    h.windowTarget.CodemanTerminalViewerActivity = {
      create: vi.fn((deps) => {
        capturedDeps = deps;
        return { activate: vi.fn(), flushPending: vi.fn(), destroy: vi.fn() };
      }),
    };
    const app = Object.create(h.CodemanApp.prototype) as Record<string, unknown> & {
      _initTerminalViewerActivity: () => void;
    };
    Object.assign(app, {
      activeSessionId: 's1',
      _terminalViewerActivity: null,
      _terminalViewerActivityPagehideHandler: null,
      _wsReady: true,
      _wsSessionId: 's0',
      _ws: { readyState: FakeWebSocket.OPEN, send: vi.fn() },
    });
    app._initTerminalViewerActivity();
    const send = capturedDeps?.send as (frame: unknown) => boolean;

    expect(send({ t: 'va' })).toBe(false);
    expect((app._ws as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
    app._wsSessionId = 's1';
    expect(send({ t: 'va' })).toBe(true);
    expect((app._ws as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledOnce();
    app._ws = {
      readyState: FakeWebSocket.OPEN,
      send: vi.fn(() => {
        throw new Error('stale');
      }),
    };
    expect(send({ t: 'va' })).toBe(false);
  });

  it('keeps an already-active auto selection passive and fits before explicit re-selection activity', async () => {
    const h = loadAppHarness();
    const app = Object.create(h.CodemanApp.prototype) as Record<string, unknown> & {
      activeSessionId: string;
      selectSession: (id: string, options?: { auto?: boolean }) => Promise<void>;
    };
    const fit = vi.fn();
    const activate = vi.fn(() => {
      expect(app.activeSessionId).toBe('s1');
      return true;
    });
    Object.assign(app, {
      activeSessionId: 's1',
      activeWebviewId: null,
      isSoloWindow: false,
      detachedSessions: new Set(),
      closeMobileHeaderUtilities: vi.fn(),
      markIdleAlertSeen: vi.fn(),
      fitAddon: { fit },
      _terminalViewerActivity: { activate },
    });

    await app.selectSession('s1', { auto: true });
    expect(fit).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();

    await app.selectSession('s1');
    expect(fit).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith('session-select');
    expect(fit.mock.invocationCallOrder[0]).toBeLessThan(activate.mock.invocationCallOrder[0]);
  });

  it('switches the main path for auto selection without viewer activation', async () => {
    const h = loadAppHarness();
    const activate = vi.fn();
    const fit = vi.fn();
    const app = makeMainSelectionApp(h.CodemanApp, activate, fit);

    await app.selectSession('s1', { auto: true });

    expect(app.activeSessionId).toBe('s1');
    expect(fit).toHaveBeenCalledOnce();
    expect(activate).not.toHaveBeenCalled();
  });

  it('keeps the synchronous pre-switch focus when the activity controller is absent', async () => {
    const h = loadAppHarness();
    const app = makeMainSelectionApp(h.CodemanApp, vi.fn(), vi.fn());
    const focus = vi.fn();
    app._terminalViewerActivity = null;
    app._shouldFocusTerminalForTabSwitch = vi.fn(() => true);
    app.terminal = { options: {}, refresh: vi.fn(), focus };

    await app.selectSession('s1');

    expect(focus).toHaveBeenCalledOnce();
    expect(app.activeSessionId).toBe('s1');
  });

  it('does not call canonical HTTP resize during a hidden main-path selection', async () => {
    const h = loadAppHarness();
    h.documentTarget.visibilityState = 'hidden';
    const app = makeMainSelectionApp(h.CodemanApp, vi.fn(), vi.fn());

    await app.selectSession('s1', { auto: true });

    expect(app.activeSessionId).toBe('s1');
    expect(app.sendResize).not.toHaveBeenCalled();
  });

  it('keeps a visible unfocused automatic main-path selection off the resize transport', async () => {
    const h = loadAppHarness();
    h.documentTarget.visibilityState = 'visible';
    h.setFocused(false);
    const app = makeMainSelectionApp(h.CodemanApp, vi.fn(), vi.fn());

    await app.selectSession('s1', { auto: true });

    expect(app.activeSessionId).toBe('s1');
    expect(app.sendResize).not.toHaveBeenCalled();
  });

  it('switches the main path and activates a user selection exactly once after fitting s1 dimensions', async () => {
    const h = loadAppHarness();
    const order: string[] = [];
    let fittedFor = 's0';
    let fittedDimensions = { cols: 90, rows: 30, viewportType: 'desktop' };
    let app: ReturnType<typeof makeMainSelectionApp>;
    const activate = vi.fn((reason: string) => {
      order.push('activate');
      expect(reason).toBe('session-select');
      expect(app.activeSessionId).toBe('s1');
      expect(fittedFor).toBe('s1');
      expect(app.getFittedTerminalDimensions()).toEqual({ cols: 75, rows: 62, viewportType: 'mobile' });
      return true;
    });
    app = makeMainSelectionApp(h.CodemanApp, activate, () => {
      order.push('fit');
      expect(app.activeSessionId).toBe('s1');
      fittedFor = 's1';
      fittedDimensions = { cols: 75, rows: 62, viewportType: 'mobile' };
    });
    app.getFittedTerminalDimensions = () => fittedDimensions;

    await app.selectSession('s1');

    expect(app.activeSessionId).toBe('s1');
    expect(activate).toHaveBeenCalledOnce();
    expect(order).toEqual(['fit', 'activate']);
  });

  it('suppresses both app-owned bubbling focusin events and activates user-selected fitted session B once', async () => {
    const h = loadAppHarness();
    const terminalTarget = new FakeTarget();
    let dimensions = { cols: 90, rows: 30, viewportType: 'desktop' };
    let now = 1_000;
    const sent: unknown[] = [];
    let app: ReturnType<typeof makeMainSelectionApp>;
    const controller = loadApi().create({
      documentTarget: h.documentTarget,
      windowTarget: h.windowTarget,
      terminalTarget,
      isVisible: () => true,
      isFocused: () => true,
      activeSessionId: () => app.activeSessionId,
      dimensions: () => dimensions,
      send: (frame: unknown) => {
        sent.push({ sessionId: app.activeSessionId, frame });
        return true;
      },
      now: () => now,
    });
    app = makeMainSelectionApp(h.CodemanApp, vi.fn(), () => {
      expect(app.activeSessionId).toBe('s1');
      dimensions = { cols: 75, rows: 62, viewportType: 'mobile' };
    });
    allowMainSelectionToComplete(h, app);
    app._terminalViewerActivity = controller;
    app._shouldFocusTerminalForTabSwitch = vi.fn(() => true);
    let focusCount = 0;
    app.terminal = {
      options: {},
      refresh: vi.fn(),
      focus: vi.fn(() => {
        focusCount += 1;
        if (focusCount === 2) now = 2_000;
        terminalTarget.dispatch('focusin');
      }),
    };

    await app.selectSession('s1');

    expect(sent).toEqual([{ sessionId: 's1', frame: { t: 'va', c: 75, r: 62, v: 'mobile' } }]);
    expect(app.terminal.focus).toHaveBeenCalledTimes(2);
  });

  it('keeps auto selection passive across early and late bubbling focusin', async () => {
    const h = loadAppHarness();
    const terminalTarget = new FakeTarget();
    let dimensions = { cols: 90, rows: 30, viewportType: 'desktop' };
    let now = 1_000;
    const sent: unknown[] = [];
    let app: ReturnType<typeof makeMainSelectionApp>;
    const controller = loadApi().create({
      documentTarget: h.documentTarget,
      windowTarget: h.windowTarget,
      terminalTarget,
      isVisible: () => true,
      isFocused: () => true,
      activeSessionId: () => app.activeSessionId,
      dimensions: () => dimensions,
      send: (frame: unknown) => {
        sent.push({ sessionId: app.activeSessionId, frame });
        return true;
      },
      now: () => now,
    });
    app = makeMainSelectionApp(h.CodemanApp, vi.fn(), () => {
      dimensions = { cols: 75, rows: 62, viewportType: 'mobile' };
    });
    allowMainSelectionToComplete(h, app);
    app._terminalViewerActivity = controller;
    app._shouldFocusTerminalForTabSwitch = vi.fn(() => true);
    let focusCount = 0;
    app.terminal = {
      options: {},
      refresh: vi.fn(),
      focus: vi.fn(() => {
        focusCount += 1;
        if (focusCount === 2) now = 2_000;
        terminalTarget.dispatch('focusin');
      }),
    };

    await app.selectSession('s1', { auto: true });

    expect(app.activeSessionId).toBe('s1');
    expect(app.terminal.focus).toHaveBeenCalledTimes(2);
    expect(sent).toEqual([]);
  });

  it('ws open without pending activity delegates only to flush and never sends a resize claim', () => {
    const h = loadAppHarness();
    const flushPending = vi.fn(() => false);
    const app = Object.create(h.CodemanApp.prototype) as Record<string, unknown> & {
      _connectWs: (id: string) => void;
    };
    Object.assign(app, {
      _disconnectWs: vi.fn(),
      _updateConnectionIndicator: vi.fn(),
      _clientId: 'browser',
      _wsTabNonce: 'tab',
      _wsReconnectAttempts: 0,
      _isTuiSession: vi.fn(() => false),
      _terminalViewerActivity: { flushPending },
      _startMobileResizeRetry: vi.fn(),
      _onWsReady: vi.fn(),
      sendResize: vi.fn(),
    });

    app._connectWs('s1');
    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.();

    expect(flushPending).toHaveBeenCalledOnce();
    expect(flushPending).toHaveBeenCalledWith('ws-open');
    expect(app.sendResize).not.toHaveBeenCalled();
  });

  it('uses the exact current socket/session/open gate and catches send failures', () => {
    expect(appSource).toMatch(/!this\._wsReady\s*\|\|\s*this\._wsSessionId\s*!==\s*this\.activeSessionId/);
    expect(appSource).toContain('this._ws?.readyState !== WebSocket.OPEN');
    expect(appSource).toMatch(
      /try\s*\{[\s\S]*this\._ws\.send\(JSON\.stringify\(frame\)\)[\s\S]*return true;[\s\S]*\}\s*catch\s*\{[\s\S]*return false;/
    );
  });

  it('flushes pending activity on ws open without an unconditional ownership resize', () => {
    const onOpen = appSource.slice(
      appSource.indexOf('ws.onopen = () => {'),
      appSource.indexOf('ws.onmessage =', appSource.indexOf('ws.onopen = () => {'))
    );
    expect(onOpen).toContain("this._terminalViewerActivity?.flushPending('ws-open')");
    expect(onOpen).not.toContain('this.sendResize(sessionId)');
  });

  it('keeps selection resize ownership on explicit activity and never forces HTTP', () => {
    const selection = appSource.slice(
      appSource.indexOf('async selectSession('),
      appSource.indexOf('_cleanupSessionData(', appSource.indexOf('async selectSession('))
    );
    expect(selection).not.toContain('forceHttp');
    expect(selection).toMatch(/userInitiated[\s\S]*_terminalViewerActivity\?\.activate\('session-select'\)/);
    expect(selection).toContain(
      "if (userInitiated && document.visibilityState === 'visible') this.sendResize(sessionId);"
    );
  });

  it('keeps ordinary browser resize observation off the unowned HTTP endpoint', () => {
    expect(terminalUiSource).not.toMatch(/fetch\(`\/api\/sessions\/\$\{[^}]+\}\/resize`/);
  });

  it('exposes fitted dimensions without fitting or sending and cleans the controller up', () => {
    const helperStart = terminalUiSource.indexOf('getFittedTerminalDimensions()');
    const helper = terminalUiSource.slice(helperStart, terminalUiSource.indexOf('\n  },', helperStart));
    expect(helperStart).toBeGreaterThan(-1);
    expect(helper).not.toContain('.fit()');
    expect(helper).not.toContain('sendResize');
    expect(helper).toContain('viewportType');
    expect(appSource).toContain('this._terminalViewerActivity?.destroy()');
    expect(appSource).toContain("window.removeEventListener('pagehide', this._terminalViewerActivityPagehideHandler)");
  });
});
