import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const read = (path: string) => readFileSync(resolve(import.meta.dirname, '..', path), 'utf8');
const terminalSource = read('src/web/public/terminal-ui.js');
const constantsSource = read('src/web/public/constants.js');
const appSource = read('src/web/public/app.js');
const mobileSource = read('src/web/public/mobile-handlers.js');

function createStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: unknown) => values.set(key, String(value))),
    values,
  };
}

function fontStorageWrites(store: ReturnType<typeof createStore>) {
  return store.setItem.mock.calls.filter(([key]) => String(key).startsWith('codeman-font-size'));
}

function loadTerminalPolicy({
  deviceType = 'mobile',
  deviceState,
  store = createStore(),
}: {
  deviceType?: string;
  deviceState?: { current: string };
  store?: ReturnType<typeof createStore>;
} = {}) {
  const FakeCodemanApp = function () {} as unknown as { prototype: Record<string, any> };
  const fontDisplay = { textContent: '' };
  const fetchMock = vi.fn();
  const windowStub: Record<string, any> = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    CodemanTerminalInput: { classifyPredictInput: vi.fn() },
    CodemanTerminalFont: { resolve: (value: unknown) => value || 'default-font' },
  };
  const context = vm.createContext({
    console,
    performance,
    URLSearchParams,
    location: { search: '' },
    window: windowStub,
    fetch: fetchMock,
    localStorage: store,
    document: {
      addEventListener: vi.fn(),
      getElementById: vi.fn((id: string) => (id === 'fontSizeDisplay' ? fontDisplay : null)),
    },
    MobileDetection: {
      getDeviceType: () => deviceState?.current ?? deviceType,
      isMobile: () => (deviceState?.current ?? deviceType) === 'mobile',
      isTouchDevice: () => (deviceState?.current ?? deviceType) !== 'desktop',
    },
    CodemanApp: FakeCodemanApp,
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    cancelAnimationFrame: vi.fn(),
  });
  vm.runInContext(terminalSource, context, { filename: 'terminal-ui.js' });
  return {
    font: windowStub.CodemanTerminalFont as {
      resolveSize: (input: { deviceType?: string; mode?: string; stored?: unknown; performanceFallback?: boolean }) => {
        size: number;
        key: string;
        min: number;
      };
    },
    mixin: FakeCodemanApp.prototype,
    store,
    fontDisplay,
    fetchMock,
  };
}

class FakeTarget {
  private listeners = new Map<string, Array<(...args: any[]) => void>>();

  addEventListener(type: string, listener: (...args: any[]) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (...args: any[]) => void) {
    const listeners = this.listeners.get(type) ?? [];
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  }

  dispatch(type: string) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type });
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.length ?? 0;
  }
}

function loadIntegratedApp(store = createStore()) {
  const windowTarget = Object.assign(new FakeTarget(), {
    CodemanTerminalViewerActivity: undefined,
    innerWidth: 390,
  });
  const documentTarget = Object.assign(new FakeTarget(), {
    visibilityState: 'visible',
    hidden: false,
    hasFocus: () => true,
    getElementById: vi.fn((id: string) => (id === 'fontSizeDisplay' ? { textContent: '' } : null)),
    querySelector: vi.fn(() => null),
  });
  const context = vm.createContext({
    console: { ...console, log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    performance,
    URLSearchParams,
    location: { search: '', protocol: 'https:', host: 'test.local' },
    window: windowTarget,
    document: documentTarget,
    localStorage: store,
    MobileDetection: {
      getDeviceType: () => 'mobile',
      isMobile: () => true,
      isTouchDevice: () => false,
    },
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    cancelAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: class WebSocket {
      static OPEN = 1;
    },
    fetch: vi.fn(),
  });
  vm.runInContext(
    `${constantsSource}\n${appSource}\n${terminalSource}\nglobalThis.__CodemanApp = CodemanApp;`,
    context
  );
  return {
    CodemanApp: (context as any).__CodemanApp as { prototype: Record<string, any> },
    context,
    store,
  };
}

function makeSelectionApp(CodemanApp: { prototype: Record<string, any> }, order: string[], activeSessionId: string) {
  const app = Object.create(CodemanApp.prototype) as Record<string, any>;
  Object.assign(app, {
    activeSessionId,
    activeWebviewId: null,
    isSoloWindow: false,
    detachedSessions: new Set(),
    sessions: new Map([
      ['s0', { id: 's0', name: 'old', pid: 1, mode: 'codex' }],
      ['s1', { id: 's1', name: 'target', pid: 2, mode: 'opencode' }],
    ]),
    terminal: { options: { fontSize: 14 }, refresh: vi.fn() },
    fitAddon: {
      fit: vi.fn(() => order.push(`fit:${app.terminal.options.fontSize}`)),
    },
    _terminalViewerActivity: {
      activate: vi.fn(() => {
        order.push(`activate:${app.terminal.options.fontSize}`);
        return true;
      }),
    },
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
    closeMobileHeaderUtilities: vi.fn(),
    markIdleAlertSeen: vi.fn(),
    _updateActiveTabImmediate: vi.fn(),
    closeSessionSidebarOnHandheld: vi.fn(),
    renderSessionTabs: vi.fn(),
    _updateLocalEchoState: vi.fn(),
    _beginBufferLoad: vi.fn(() => 1),
    _syncTerminalTouchAction: vi.fn(),
    sendResize: vi.fn(async () => {
      order.push(`resize:${app.terminal.options.fontSize}`);
      return false;
    }),
    attachmentHistoryDrawerOpen: false,
  });
  const apply = app.applyTerminalFontPolicy.bind(app);
  app.applyTerminalFontPolicy = (mode: string) => {
    const policy = apply(mode);
    order.push(`policy:${policy.size}`);
    return policy;
  };
  return app;
}

function loadMobileBehaviorHarness(app: Record<string, any>) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
    <main class="main"></main>
    <div class="toolbar"></div>
    <div class="keyboard-accessory-bar visible"></div>
    <div id="cjkInput"></div>
  </body></html>`,
    { url: 'http://localhost/' }
  );
  const windowTarget = new FakeTarget();
  const timers: Array<() => void> = [];
  let width = 390;
  const visualViewport = Object.assign(new FakeTarget(), { offsetTop: 0, height: 544 });
  const setAppHeight = vi.fn();
  const windowStub = Object.assign(windowTarget, {
    innerHeight: 844,
    get innerWidth() {
      return width;
    },
    visualViewport,
    scrollTo: vi.fn(),
    matchMedia: vi.fn(() => ({ matches: false })),
    getComputedStyle: vi.fn(() => ({ display: '', visibility: '' })),
  });
  Object.defineProperty(dom.window.document.documentElement, 'style', {
    configurable: true,
    value: { setProperty: setAppHeight },
  });
  const fetchMock = vi.fn(() => Promise.resolve());
  const context = vm.createContext({
    console,
    URLSearchParams,
    location: { search: '' },
    navigator: { userAgent: 'iPhone', maxTouchPoints: 1, platform: 'iPhone' },
    window: windowStub,
    document: dom.window.document,
    app,
    KeyboardAccessoryBar: { show: vi.fn(), hide: vi.fn() },
    fetch: fetchMock,
    getComputedStyle: vi.fn(() => ({ getPropertyValue: vi.fn(() => '') })),
    setTimeout: vi.fn((callback: () => void) => {
      timers.push(callback);
      return timers.length;
    }),
    clearTimeout: vi.fn(),
    requestAnimationFrame: (callback: () => void) => callback(),
    Date,
  });
  vm.runInContext(
    `${mobileSource}\nglobalThis.__KeyboardHandler = KeyboardHandler; globalThis.__MobileDetection = MobileDetection;`,
    context
  );
  return {
    KeyboardHandler: (context as any).__KeyboardHandler as Record<string, any>,
    MobileDetection: (context as any).__MobileDetection as Record<string, any>,
    windowTarget,
    visualViewport,
    setAppHeight,
    fetchMock,
    setVisibility(value: 'visible' | 'hidden') {
      Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, value });
    },
    timers,
    setWidth(value: number) {
      width = value;
    },
    runLastTimer() {
      const timer = timers.pop();
      if (!timer) throw new Error('expected a pending viewport timer');
      timer();
    },
  };
}

function createApp(deviceType: string, initial: Record<string, string>, mode = 'opencode') {
  const loaded = loadTerminalPolicy({ deviceType, store: createStore(initial) });
  const fit = vi.fn();
  const app = Object.assign(Object.create(loaded.mixin), {
    activeSessionId: 'session-1',
    sessions: new Map([['session-1', { mode }]]),
    terminal: { options: { fontSize: 14 } },
    fitAddon: { fit },
    _localEchoOverlay: { refreshFont: vi.fn() },
    _predictiveEcho: { refreshFont: vi.fn() },
  });
  return { ...loaded, app, fit };
}

describe('OpenCode device-local terminal font policy', () => {
  it('defaults mobile OpenCode to 8px and permits only an explicit 9px fallback', () => {
    const { font } = loadTerminalPolicy();
    expect(font.resolveSize({ deviceType: 'mobile', mode: 'OpenCode', stored: null })).toEqual({
      size: 8,
      key: 'codeman-font-size-mobile-opencode',
      min: 8,
    });
    expect(
      font.resolveSize({ deviceType: 'mobile', mode: 'opencode', stored: null, performanceFallback: true })
    ).toEqual({ size: 9, key: 'codeman-font-size-mobile-opencode', min: 8 });
  });

  it('retains the general desktop and other-mobile defaults', () => {
    const { font } = loadTerminalPolicy();
    expect(font.resolveSize({ deviceType: 'desktop', mode: 'opencode', stored: null })).toEqual({
      size: 14,
      key: 'codeman-font-size',
      min: 10,
    });
    expect(font.resolveSize({ deviceType: 'mobile', mode: 'codex', stored: null })).toEqual({
      size: 10,
      key: 'codeman-font-size',
      min: 10,
    });
    expect(font.resolveSize({ deviceType: 'mobile', mode: undefined, stored: null }).size).toBe(10);
  });

  it('accepts only integer stored values within the active policy range', () => {
    const { font } = loadTerminalPolicy();
    for (const stored of ['8', 9, '24']) {
      expect(font.resolveSize({ deviceType: 'mobile', mode: 'opencode', stored }).size).toBe(Number(stored));
    }
    for (const stored of [null, '', 'nope', '8.5', 7, 25, NaN, Infinity]) {
      expect(font.resolveSize({ deviceType: 'mobile', mode: 'opencode', stored }).size).toBe(8);
    }
    expect(font.resolveSize({ deviceType: 'mobile', mode: 'codex', stored: '9' }).size).toBe(10);
  });

  it('stores direct and decrement changes under the active key and honors its minimum', () => {
    const openCode = createApp('mobile', {}, 'opencode');
    openCode.app.applyTerminalFontPolicyForActiveSession();
    openCode.app.decreaseFontSize();
    expect(openCode.app.terminal.options.fontSize).toBe(8);
    expect(openCode.store.setItem).toHaveBeenLastCalledWith('codeman-font-size-mobile-opencode', 8);

    const codex = createApp('mobile', {}, 'codex');
    codex.app.applyTerminalFontPolicyForActiveSession();
    codex.app.decreaseFontSize();
    expect(codex.app.terminal.options.fontSize).toBe(10);
    expect(codex.store.setItem).toHaveBeenLastCalledWith('codeman-font-size', 10);
  });

  it('keeps the applied font, fit, and echo refresh when storage writes fail', () => {
    const store = createStore();
    store.setItem.mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const harness = loadTerminalPolicy({ deviceType: 'mobile', store });
    const fit = vi.fn();
    const localRefresh = vi.fn();
    const predictiveRefresh = vi.fn();
    const app = Object.assign(Object.create(harness.mixin), {
      activeSessionId: 'session-1',
      sessions: new Map([['session-1', { mode: 'opencode' }]]),
      terminal: { options: { fontSize: 8 } },
      fitAddon: { fit },
      _localEchoOverlay: { refreshFont: localRefresh },
      _predictiveEcho: { refreshFont: predictiveRefresh },
    });

    expect(() => app.setFontSize(10)).not.toThrow();
    expect(app.terminal.options.fontSize).toBe(10);
    expect(harness.fontDisplay.textContent).toBe(10);
    expect(fit).toHaveBeenCalledOnce();
    expect(localRefresh).toHaveBeenCalledOnce();
    expect(predictiveRefresh).toHaveBeenCalledOnce();
  });

  it('falls back safely when policy storage reads fail', () => {
    const store = createStore();
    store.getItem.mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const harness = loadTerminalPolicy({ deviceType: 'mobile', store });
    const app = Object.assign(Object.create(harness.mixin), {
      activeSessionId: 'session-1',
      sessions: new Map([['session-1', { mode: 'opencode' }]]),
      terminal: { options: { fontSize: 14 } },
    });

    expect(app.applyTerminalFontPolicyForActiveSession()).toMatchObject({ size: 8 });
    expect(app.terminal.options.fontSize).toBe(8);
  });

  it('restores independent values across mobile mode switches without overwriting either key', () => {
    const harness = createApp(
      'mobile',
      { 'codeman-font-size-mobile-opencode': '9', 'codeman-font-size': '12' },
      'opencode'
    );
    harness.app.applyTerminalFontPolicyForActiveSession();
    expect(harness.app.terminal.options.fontSize).toBe(9);
    harness.app.sessions.get('session-1').mode = 'codex';
    harness.app.applyTerminalFontPolicyForActiveSession();
    expect(harness.app.terminal.options.fontSize).toBe(12);
    harness.app.sessions.get('session-1').mode = 'opencode';
    harness.app.applyTerminalFontPolicyForActiveSession();
    expect(harness.app.terminal.options.fontSize).toBe(9);
    expect(harness.store.setItem).not.toHaveBeenCalled();
  });

  it('keeps desktop and phone OpenCode values independent across browser stores', () => {
    const phone = createApp('mobile', { 'codeman-font-size-mobile-opencode': '8' });
    const desktop = createApp('desktop', { 'codeman-font-size': '14' });
    phone.app.applyTerminalFontPolicyForActiveSession();
    desktop.app.applyTerminalFontPolicyForActiveSession();
    expect(phone.app.terminal.options.fontSize).toBe(8);
    expect(desktop.app.terminal.options.fontSize).toBe(14);
  });

  it('applies idempotently without fitting, activating, resizing, or persisting', () => {
    const harness = createApp('mobile', {}, 'opencode');
    harness.app._terminalViewerActivity = { activate: vi.fn() };
    harness.app.sendResize = vi.fn();
    harness.app.applyTerminalFontPolicyForActiveSession();
    harness.app.applyTerminalFontPolicyForActiveSession();
    expect(harness.app.terminal.options.fontSize).toBe(8);
    expect(harness.fit).not.toHaveBeenCalled();
    expect(harness.app._terminalViewerActivity.activate).not.toHaveBeenCalled();
    expect(harness.app.sendResize).not.toHaveBeenCalled();
    expect(harness.store.setItem).not.toHaveBeenCalled();
    expect(harness.app._localEchoOverlay.refreshFont).toHaveBeenCalledOnce();
    expect(harness.app._predictiveEcho.refreshFont).toHaveBeenCalledOnce();
  });

  it('executes canonical resize with policy before fit and wire resize', async () => {
    const harness = createApp('mobile', {}, 'opencode');
    const order: string[] = [];
    harness.app.fitAddon = {
      fit: vi.fn(() => order.push(`fit:${harness.app.terminal.options.fontSize}`)),
      proposeDimensions: vi.fn(() => ({ cols: 75, rows: 62 })),
    };
    harness.app._wsReady = true;
    harness.app._wsSessionId = 'session-1';
    harness.app._ws = {
      send: vi.fn(() => order.push(`resize:${harness.app.terminal.options.fontSize}`)),
    };
    const apply = harness.app.applyTerminalFontPolicyForActiveSession.bind(harness.app);
    harness.app.applyTerminalFontPolicyForActiveSession = () => {
      const policy = apply();
      order.push(`policy:${policy.size}`);
      return policy;
    };

    await harness.app.sendResize('session-1');

    expect(order).toEqual(['policy:8', 'fit:8', 'resize:8']);
    expect(harness.store.setItem).not.toHaveBeenCalled();
  });

  it('rejects stale resize targets before fitting and again before sending', async () => {
    const harness = createApp('mobile', {}, 'opencode');
    const fit = vi.fn();
    const wsSend = vi.fn();
    harness.app.fitAddon = { fit, proposeDimensions: vi.fn(() => ({ cols: 75, rows: 62 })) };
    harness.app._wsReady = true;
    harness.app._wsSessionId = 'session-1';
    harness.app._ws = { send: wsSend };
    harness.app.applyTerminalFontPolicyForActiveSession = vi.fn();

    expect(await harness.app.sendResize('stale-session')).toBe(false);
    expect(fit).not.toHaveBeenCalled();
    expect(wsSend).not.toHaveBeenCalled();

    harness.app.getTerminalDimensions = vi.fn(() => {
      harness.app.activeSessionId = 'session-2';
      return { cols: 75, rows: 62 };
    });
    expect(await harness.app.sendResize('session-1')).toBe(false);
    expect(wsSend).not.toHaveBeenCalled();
  });

  it('does not bypass viewer ownership through HTTP when the sizing socket is unavailable', async () => {
    const harness = createApp('mobile', {}, 'opencode');
    harness.app.fitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 75, rows: 62 })),
    };

    expect(await harness.app.sendResize('session-1')).toBeNull();
    expect(harness.app._pendingTerminalResize?.sessionId).toBe('session-1');
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });

  it('keeps only the latest passive resize pending while the sizing socket is unavailable', async () => {
    const harness = createApp('mobile', {}, 'opencode');
    let dims = { cols: 70, rows: 50 };
    harness.app.fitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => dims),
    };

    expect(await harness.app.sendResize('session-1')).toBeNull();
    dims = { cols: 75, rows: 62 };
    expect(await harness.app.sendResize('session-1')).toBeNull();

    expect(harness.app._pendingTerminalResize).toEqual({
      sessionId: 'session-1',
      frame: { t: 'z', c: 75, r: 62, v: 'mobile' },
    });
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });

  it('queues the latest typed desktop throttle resize when WS is down or send throws', () => {
    const harness = createApp('desktop', {}, 'opencode');
    const first = { t: 'z', c: 100, r: 30, v: 'desktop' };
    const latest = { t: 'z', c: 110, r: 35, v: 'desktop' };
    harness.app._wsReady = false;
    harness.app._wsSessionId = 'session-1';

    expect(harness.app._sendOrQueueTerminalResize('session-1', first)).toBe(false);
    expect(harness.app._sendOrQueueTerminalResize('session-1', latest)).toBe(false);
    expect(harness.app._pendingTerminalResize).toEqual({ sessionId: 'session-1', frame: latest });

    harness.app._wsReady = true;
    harness.app._ws = {
      send: vi.fn(() => {
        throw new Error('socket failed');
      }),
    };
    const afterThrow = { t: 'z', c: 120, r: 40, v: 'desktop' };
    expect(harness.app._sendOrQueueTerminalResize('session-1', afterThrow)).toBe(false);
    expect(harness.app._pendingTerminalResize).toEqual({ sessionId: 'session-1', frame: afterThrow });
    expect(harness.fetchMock).not.toHaveBeenCalled();

    const resizeThrottle = terminalSource.slice(
      terminalSource.indexOf('const throttledResize = () => {'),
      terminalSource.indexOf("window.addEventListener('resize', throttledResize)")
    );
    expect(resizeThrottle).toContain('this._sendOrQueueTerminalResize');
  });

  it('restores an explicitly selected nonowner by activating before the forced resize', async () => {
    const harness = createApp('mobile', {}, 'opencode');
    harness.app.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 75, rows: 62 }));
    const frames: unknown[] = [];
    harness.app._wsReady = true;
    harness.app._wsSessionId = 'session-1';
    harness.app._ws = { send: vi.fn((raw: string) => frames.push(JSON.parse(raw))) };
    harness.app._terminalViewerActivity = {
      activate: vi.fn(() => {
        harness.app._ws.send(JSON.stringify({ t: 'va', c: 75, r: 62, v: 'mobile' }));
        return true;
      }),
    };
    harness.app.showToast = vi.fn();

    expect(await harness.app.restoreTerminalSize()).toBe(true);

    expect(frames).toEqual([
      { t: 'va', c: 75, r: 62, v: 'mobile' },
      { t: 'z', c: 75, r: 62, v: 'mobile', f: true },
    ]);
    expect(harness.app._terminalViewerActivity.activate).toHaveBeenCalledWith('restore-terminal-size');
    expect(harness.app.showToast).toHaveBeenCalledWith('Terminal restored to 75x62', 'success');
  });

  it('queues explicit restore intent during WS outage without a false success toast', async () => {
    const harness = createApp('mobile', {}, 'opencode');
    harness.app.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 75, rows: 62 }));
    harness.app._terminalViewerActivity = { activate: vi.fn(() => false) };
    harness.app.showToast = vi.fn();

    expect(await harness.app.restoreTerminalSize()).toBe(false);

    expect(harness.app._terminalViewerActivity.activate).toHaveBeenCalledWith('restore-terminal-size');
    expect(harness.app._pendingTerminalResize).toEqual({
      sessionId: 'session-1',
      frame: { t: 'z', c: 75, r: 62, v: 'mobile', f: true },
    });
    expect(harness.app.showToast).not.toHaveBeenCalledWith(expect.any(String), 'success');
    expect(harness.app.showToast).toHaveBeenCalledWith('Terminal restore queued until connection recovers', 'warning');
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });

  it('reports a ready-socket send failure as queued instead of restored', async () => {
    const harness = createApp('mobile', {}, 'opencode');
    harness.app.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 75, rows: 62 }));
    harness.app._wsReady = true;
    harness.app._wsSessionId = 'session-1';
    harness.app._ws = {
      send: vi.fn(() => {
        throw new Error('socket failed');
      }),
    };
    harness.app._terminalViewerActivity = { activate: vi.fn(() => false) };
    harness.app.showToast = vi.fn();

    expect(await harness.app.restoreTerminalSize()).toBe(false);

    expect(harness.app._pendingTerminalResize?.frame).toEqual({
      t: 'z',
      c: 75,
      r: 62,
      v: 'mobile',
      f: true,
    });
    expect(harness.app.showToast).not.toHaveBeenCalledWith(expect.any(String), 'success');
    expect(harness.app.showToast).toHaveBeenCalledWith('Terminal restore queued until connection recovers', 'warning');
  });

  it('keeps restore queued when activation fails even if the following resize frame sends', async () => {
    const harness = createApp('mobile', {}, 'opencode');
    harness.app.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 75, rows: 62 }));
    const frames: unknown[] = [];
    harness.app._wsReady = true;
    harness.app._wsSessionId = 'session-1';
    harness.app._ws = { send: vi.fn((raw: string) => frames.push(JSON.parse(raw))) };
    harness.app._terminalViewerActivity = {
      activate: vi.fn(() => false),
      hasPending: vi.fn(() => true),
    };
    harness.app.showToast = vi.fn();

    expect(await harness.app.restoreTerminalSize()).toBe(false);

    expect(frames).toEqual([{ t: 'z', c: 75, r: 62, v: 'mobile', f: true }]);
    expect(harness.app._pendingTerminalResize).toEqual({
      sessionId: 'session-1',
      frame: { t: 'z', c: 75, r: 62, v: 'mobile', f: true },
    });
    expect(harness.app.showToast).not.toHaveBeenCalledWith(expect.any(String), 'success');
    expect(harness.app.showToast).toHaveBeenCalledWith('Terminal restore queued until connection recovers', 'warning');
  });

  it('keeps a delayed hidden keyboard settle local and off every resize transport', () => {
    const harness = createApp('mobile', {}, 'opencode');
    harness.app.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 75, rows: 62 }));
    harness.app.sendResize = vi.fn();
    const mobile = loadMobileBehaviorHarness(harness.app);
    mobile.setVisibility('hidden');

    mobile.KeyboardHandler._sendTerminalResize();

    expect(harness.app.sendResize).not.toHaveBeenCalled();
    expect(mobile.fetchMock).not.toHaveBeenCalled();
  });

  it('routes a visible keyboard settle through the ownership-fenced canonical resize path', () => {
    const harness = createApp('mobile', {}, 'opencode');
    harness.app.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 75, rows: 62 }));
    harness.app.sendResize = vi.fn(async () => true);
    const mobile = loadMobileBehaviorHarness(harness.app);
    mobile.setVisibility('visible');

    mobile.KeyboardHandler._sendTerminalResize();

    expect(harness.app.sendResize).toHaveBeenCalledOnce();
    expect(harness.app.sendResize).toHaveBeenCalledWith('session-1');
    expect(mobile.fetchMock).not.toHaveBeenCalled();
  });

  it('executes the already-active selection with policy before fit and activation', async () => {
    const integrated = loadIntegratedApp();
    const order: string[] = [];
    const app = makeSelectionApp(integrated.CodemanApp, order, 's1');

    await app.selectSession('s1');

    expect(app.terminal.options.fontSize).toBe(8);
    expect(order).toEqual(['policy:8', 'fit:8', 'activate:8']);
    expect(fontStorageWrites(integrated.store)).toEqual([]);
    expect(app.sendResize).not.toHaveBeenCalled();
  });

  it('executes the main s0 to s1 selection with policy before fit, activation, and resize', async () => {
    const integrated = loadIntegratedApp();
    const order: string[] = [];
    const app = makeSelectionApp(integrated.CodemanApp, order, 's0');

    await app.selectSession('s1');

    expect(app.terminal.options.fontSize).toBe(8);
    expect(order).toEqual(['policy:8', 'fit:8', 'activate:8', 'resize:8']);
    expect(fontStorageWrites(integrated.store)).toEqual([]);
  });

  it('abandons a stale restored-session selection after its delayed attach resolves', async () => {
    const integrated = loadIntegratedApp();
    const order: string[] = [];
    const app = makeSelectionApp(integrated.CodemanApp, order, 's0');
    app.sessions = new Map([
      ['s0', { id: 's0', name: 'old', pid: 1, mode: 'codex' }],
      ['a', { id: 'a', name: 'delayed', pid: null, mode: 'opencode' }],
      ['b', { id: 'b', name: 'winner', pid: 2, mode: 'codex' }],
    ]);
    app._isStaleSelect = integrated.CodemanApp.prototype._isStaleSelect.bind(app);
    app._onSessionRestarted = vi.fn();
    app.fitAddon.fit = vi.fn(() => order.push(`fit:${app.activeSessionId}:${app.terminal.options.fontSize}`));
    app._terminalViewerActivity.activate = vi.fn(() =>
      order.push(`activate:${app.activeSessionId}:${app.terminal.options.fontSize}`)
    );
    app.sendResize = vi.fn(async (sessionId: string) => {
      order.push(`resize:${sessionId}:${app.terminal.options.fontSize}`);
      if (sessionId === 'b') app._selectGeneration += 1;
      return false;
    });
    let releaseAttach!: () => void;
    const attach = new Promise<void>((resolveAttach) => {
      releaseAttach = resolveAttach;
    });
    (integrated.context.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => attach);

    const delayedSelection = app.selectSession('a');
    expect(app.activeSessionId).toBe('a');
    await app.selectSession('b');
    expect(app.activeSessionId).toBe('b');
    expect(app.terminal.options.fontSize).toBe(10);
    const winnerOrder = order.slice();

    releaseAttach();
    await delayedSelection;

    expect(app.activeSessionId).toBe('b');
    expect(app.terminal.options.fontSize).toBe(10);
    expect(order).toEqual(winnerOrder);
    expect(app.sendResize).toHaveBeenCalledTimes(1);
    expect(app.sendResize).toHaveBeenCalledWith('b');
  });

  it('executes keyboard reset, show, hide, and settlement with the active mode policy before fit', () => {
    const order: string[] = [];
    const harness = createApp('mobile', {}, 'opencode');
    harness.app.terminal.rows = 24;
    harness.app.terminal.refresh = vi.fn();
    harness.app.terminal.buffer = { active: { viewportY: 0, baseY: 0 } };
    harness.app.terminal.scrollToBottom = vi.fn();
    harness.app.isTerminalAtBottom = vi.fn(() => true);
    harness.app._syncMobileHelperTextareaToCursor = vi.fn();
    harness.app._localEchoOverlay.rerender = vi.fn();
    harness.app.relayoutMobileSubagentWindows = vi.fn();
    harness.app.fitAddon.fit = vi.fn(() => order.push(`fit:${harness.app.terminal.options.fontSize}`));
    const apply = harness.app.applyTerminalFontPolicyForActiveSession.bind(harness.app);
    harness.app.applyTerminalFontPolicyForActiveSession = () => {
      const policy = apply();
      order.push(`policy:${policy.size}`);
      return policy;
    };
    const mobile = loadMobileBehaviorHarness(harness.app);
    mobile.KeyboardHandler._sendTerminalResize = vi.fn(() =>
      order.push(`resize:${harness.app.terminal.options.fontSize}`)
    );

    mobile.KeyboardHandler.resetLayout();
    expect(harness.app.terminal.options.fontSize).toBe(8);
    mobile.KeyboardHandler.keyboardVisible = true;
    mobile.KeyboardHandler.updateLayoutForKeyboard();
    mobile.KeyboardHandler.onKeyboardShow();
    mobile.runLastTimer();

    harness.app.sessions.get('session-1').mode = 'codex';
    mobile.KeyboardHandler.keyboardVisible = false;
    mobile.KeyboardHandler.onKeyboardHide();
    mobile.runLastTimer();

    expect(order).toEqual([
      'policy:8',
      'policy:8',
      'policy:8',
      'fit:8',
      'resize:8',
      'policy:10',
      'policy:10',
      'fit:10',
      'resize:10',
    ]);
    expect(harness.store.setItem).not.toHaveBeenCalled();
  });

  it('applies desktop and mobile OpenCode policies before normal breakpoint fit and resize', () => {
    const deviceState = { current: 'desktop' };
    const store = createStore({
      'codeman-font-size': '14',
      'codeman-font-size-mobile-opencode': '8',
    });
    const loaded = loadTerminalPolicy({ deviceState, store });
    const order: string[] = [];
    const app = Object.assign(Object.create(loaded.mixin), {
      activeSessionId: 'session-1',
      sessions: new Map([['session-1', { mode: 'opencode' }]]),
      terminal: { options: { fontSize: 14 } },
    });
    const apply = app.applyTerminalFontPolicyForActiveSession.bind(app);
    app.applyTerminalFontPolicyForActiveSession = () => {
      const policy = apply();
      order.push(`policy:${policy.size}`);
      return policy;
    };
    const mobile = loadMobileBehaviorHarness(app);
    mobile.MobileDetection.isTouchDevice = () => false;
    mobile.MobileDetection.init();
    mobile.windowTarget.addEventListener('resize', () => {
      order.push(`fit:${app.terminal.options.fontSize}`);
      order.push(`resize:${app.terminal.options.fontSize}`);
    });

    deviceState.current = 'mobile';
    mobile.setWidth(390);
    mobile.windowTarget.dispatch('resize');
    deviceState.current = 'desktop';
    mobile.setWidth(1024);
    mobile.windowTarget.dispatch('resize');

    expect(order).toEqual(['policy:8', 'fit:8', 'resize:8', 'policy:14', 'fit:14', 'resize:14']);
    expect(fontStorageWrites(store)).toEqual([]);
  });

  it('removes and replaces the exact app-height listener across mobile detection re-init', () => {
    const harness = createApp('mobile', {}, 'opencode');
    const apply = vi.spyOn(harness.app, 'applyTerminalFontPolicyForActiveSession');
    const mobile = loadMobileBehaviorHarness(harness.app);
    mobile.MobileDetection.isTouchDevice = () => false;

    mobile.MobileDetection.init();
    expect(mobile.visualViewport.listenerCount('resize')).toBe(1);
    mobile.MobileDetection.init();
    expect(mobile.visualViewport.listenerCount('resize')).toBe(1);
    mobile.MobileDetection.cleanup();
    expect(mobile.visualViewport.listenerCount('resize')).toBe(0);
    apply.mockClear();
    mobile.visualViewport.dispatch('resize');
    expect(apply).not.toHaveBeenCalled();
    mobile.MobileDetection.init();
    expect(mobile.visualViewport.listenerCount('resize')).toBe(1);

    apply.mockClear();
    mobile.setAppHeight.mockClear();
    mobile.visualViewport.dispatch('resize');
    expect(apply).toHaveBeenCalledOnce();
    expect(mobile.setAppHeight).toHaveBeenCalledOnce();
  });
});
