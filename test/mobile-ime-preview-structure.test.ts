import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const read = (path: string) => readFileSync(resolve(import.meta.dirname, '..', path), 'utf8');
const indexSource = read('src/web/public/index.html');
const buildSource = read('scripts/build.mjs');
const terminalSource = read('src/web/public/terminal-ui.js');
const appSource = read('src/web/public/app.js');
const cssSource = read('src/web/public/styles.css');
const repositoryRoot = resolve(import.meta.dirname, '..');

function loadMixin(globals: Record<string, unknown> = {}) {
  const FakeCodemanApp = function () {} as unknown as { prototype: Record<string, unknown> };
  const windowStub = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    CodemanTerminalInput: { classifyPredictInput: (data: string) => (data.length > 1 ? 'text' : 'char') },
    ...(globals.window as object),
  };
  const context = vm.createContext({
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    cancelAnimationFrame: vi.fn(),
    URLSearchParams,
    location: { search: '' },
    localStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    document: { addEventListener: vi.fn(), createElement: vi.fn() },
    MobileDetection: { isTouchDevice: () => false },
    CodemanApp: FakeCodemanApp,
    window: windowStub,
    ...globals,
  });
  vm.runInContext(terminalSource, context, { filename: 'terminal-ui.js' });
  return { mixin: FakeCodemanApp.prototype, context, windowStub };
}

function fakeClassList() {
  const values = new Set<string>();
  return {
    add: vi.fn((value: string) => values.add(value)),
    remove: vi.fn((value: string) => values.delete(value)),
    toggle: vi.fn((value: string, force?: boolean) => {
      const enabled = force === undefined ? !values.has(value) : force;
      if (enabled) values.add(value);
      else values.delete(value);
      return enabled;
    }),
    contains: (value: string) => values.has(value),
  };
}

function createPreviewHarness(
  options: {
    eligible?: boolean;
    createThrows?: boolean;
    omitGlobal?: boolean;
    themeForeground?: string;
    themeGetterThrows?: boolean;
  } = {}
) {
  const compositionView = {
    style: {
      fontFamily: '"Fira Code"',
      fontSize: '10px',
      fontWeight: '500',
      fontStyle: 'italic',
      lineHeight: '12px',
      height: '12px',
      color: 'rgb(255, 255, 255)',
    },
  };
  const helpers = {
    classList: fakeClassList(),
    children: [] as Array<Record<string, unknown>>,
    querySelector: (selector: string) => (selector === '.composition-view' ? compositionView : null),
    appendChild(node: Record<string, unknown>) {
      this.children.push(node);
    },
  };
  const textarea = {};
  const createdControllers: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
  const previewNodes: Array<Record<string, unknown>> = [];
  const documentStub = {
    addEventListener: vi.fn(),
    createElement: vi.fn(() => {
      const node = {
        className: '',
        hidden: false,
        textContent: '',
        dataset: {} as Record<string, string>,
        style: {} as Record<string, string>,
        attributes: {} as Record<string, string>,
        setAttribute(name: string, value: string) {
          this.attributes[name] = value;
        },
        remove: vi.fn(),
      };
      previewNodes.push(node);
      return node;
    }),
  };
  const mobileImePreview = options.omitGlobal
    ? undefined
    : {
        isIosWebKitTouch: vi.fn(() => options.eligible ?? true),
        create: vi.fn((callbacks: Record<string, (...args: never[]) => void>) => {
          if (options.createThrows) throw new Error('controller unavailable');
          const controller = {
            destroy: vi.fn(),
            reset: vi.fn(),
            consumeTerminalData: vi.fn(() => false),
            completeCommit: vi.fn(),
            noteAuthoritativeOutput: vi.fn(),
            callbacks,
          };
          createdControllers.push(controller);
          return controller;
        }),
      };
  const { mixin, windowStub } = loadMixin({
    document: documentStub,
    MobileImePreview: mobileImePreview,
    getComputedStyle: (node: { style: Record<string, string> }) => node.style,
  });
  windowStub.codemanCurrentXtermTheme = () => {
    if (options.themeGetterThrows) throw new Error('theme unavailable');
    return { foreground: '#334455' };
  };
  const app = Object.assign(Object.create(mixin), {
    terminal: {
      textarea,
      options: {
        fontSize: 10,
        lineHeight: 1.2,
        theme: options.themeForeground ? { foreground: options.themeForeground } : undefined,
      },
      element: { querySelector: (selector: string) => (selector === '.xterm-helpers' ? helpers : null) },
    },
    activeSessionId: 'session-a',
  }) as Record<string, unknown>;
  return { app, helpers, compositionView, previewNodes, createdControllers, mobileImePreview };
}

function loadRegisteredOnDataHandler(globals: Record<string, unknown> = {}) {
  // COD-388 extracted the onData body into `handleTerminalData` so the keyCode-229
  // recovery path can re-enter it (`emitRecovered`), and registration became a
  // one-line delegate. This used to slice from `this.terminal.onData((data) => {`,
  // which no longer exists — the whole file then read as an empty handler and
  // every case here failed with "registration not found" rather than an
  // assertion. Anchor on the extracted function instead, which is what actually
  // holds the routing logic under test.
  const marker = 'const handleTerminalData = (data, { recovered = false } = {}) => {';
  const start = terminalSource.indexOf(marker);
  if (start < 0) throw new Error('terminal handleTerminalData definition not found');
  const bodyStart = start + marker.length;
  const end = terminalSource.indexOf('\n    };', bodyStart);
  if (end < 0) throw new Error('terminal handleTerminalData boundary not found');
  const timers: Array<() => void> = [];
  const context = vm.createContext({
    console,
    performance,
    setTimeout: (callback: () => void) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: vi.fn(),
    document: { activeElement: null, getElementById: vi.fn(() => null) },
    window: {
      cjkActive: false,
      CodemanTerminalInput: {
        BRACKETED_PASTE_START: '\x1b[200~',
        shouldSuppressTerminalQueryResponse: () => false,
        isTerminalFocusOrMouseReport: () => false,
        isComposerNavKey: () => false,
      },
    },
    _crashDiag: { log: vi.fn() },
    ...globals,
  });
  // `recovered` is the second parameter COD-388 added; the slice references it,
  // so the reconstructed function has to declare it or the body throws
  // ReferenceError before any assertion runs.
  const handler = vm.runInContext(
    `(function (data, recovered = false) {${terminalSource.slice(bodyStart, end)}\n})`,
    context
  ) as (this: Record<string, unknown>, data: string) => void;
  return { handler, timers, context };
}

function loadAppClass(globals: Record<string, unknown> = {}) {
  const constants = read('src/web/public/constants.js');
  const context = vm.createContext({
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: vi.fn(),
    location: { protocol: 'https:', host: 'test.local' },
    document: { addEventListener: vi.fn() },
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: { cleanup: vi.fn(), init: vi.fn() },
    KeyboardHandler: { cleanup: vi.fn(), init: vi.fn() },
    ...globals,
  });
  vm.runInContext(`${constants}\n${appSource}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  return (context as { __CodemanApp: new () => unknown }).__CodemanApp;
}

describe('mobile IME preview delivery graph', () => {
  it('loads the controller before terminal wiring and includes it in minify/hash output', () => {
    expect(indexSource.indexOf('mobile-ime-preview.js')).toBeGreaterThan(indexSource.indexOf('vendor/xterm'));
    expect(indexSource.indexOf('mobile-ime-preview.js')).toBeLessThan(indexSource.indexOf('terminal-ui.js'));
    expect(buildSource).toContain("'minify mobile-ime-preview.js'");
    expect(buildSource).toContain("'mobile-ime-preview.js'");
  });

  it('emits the exact hashed controller referenced by built HTML', () => {
    execFileSync('npm', ['run', 'build'], { cwd: repositoryRoot, stdio: 'pipe', timeout: 120_000 });
    const builtHtml = read('dist/web/public/index.html');
    const match = builtHtml.match(/mobile-ime-preview\.([a-f0-9]{8})\.js/);
    expect(match).not.toBeNull();
    expect(existsSync(resolve(import.meta.dirname, '../dist/web/public', match![0]))).toBe(true);
  });

  it('scopes preview presentation and native composition suppression to touch ownership', () => {
    expect(cssSource).toContain('.xterm-helpers .codeman-ime-preview');
    expect(cssSource).toContain(".codeman-ime-preview[data-phase='provisional']");
    expect(cssSource).toContain('.touch-device .xterm-helpers.codeman-ime-preview-owned .composition-view.active');
    expect(cssSource).toContain('left: var(--xterm-helper-left, 0px)');
    expect(cssSource).toContain('top: var(--xterm-helper-top, 0px)');
  });
});

describe('mobile IME preview lifecycle', () => {
  it('fails open when the global is absent or eligibility/create throws', () => {
    for (const options of [{ omitGlobal: true }, { createThrows: true }]) {
      const { app } = createPreviewHarness(options);
      expect(() => (app._initMobileImePreview as () => void).call(app)).not.toThrow();
      expect(app._mobileImePreview).toBeNull();
    }
  });

  it('does not create a controller on unsupported desktop input', () => {
    const { app, mobileImePreview, previewNodes } = createPreviewHarness({ eligible: false });
    (app._initMobileImePreview as () => void).call(app);
    expect(mobileImePreview?.create).not.toHaveBeenCalled();
    expect(previewNodes).toHaveLength(0);
  });

  it('destroys prior ownership on repeated initialization and keeps one active controller', () => {
    const { app, createdControllers, previewNodes } = createPreviewHarness();
    (app._initMobileImePreview as () => void).call(app);
    const first = createdControllers[0];
    (app._initMobileImePreview as () => void).call(app);
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(previewNodes[0].remove).toHaveBeenCalledOnce();
    expect(createdControllers).toHaveLength(2);
    expect(app._mobileImePreview).toBe(createdControllers[1]);
  });

  it('resets the controller exactly once when the active session changes', () => {
    const { app, createdControllers } = createPreviewHarness();
    (app._initMobileImePreview as () => void).call(app);
    app.activeSessionId = 'session-b';
    app.loadAppSettingsFromStorage = () => ({ localEchoEnabled: false });
    app.sessions = new Map();
    (app._updateLocalEchoState as () => void).call(app);
    (app._updateLocalEchoState as () => void).call(app);
    expect(createdControllers[0].reset).toHaveBeenCalledOnce();
  });

  it('renders and clears owned preview state without geometry work', () => {
    const { app, helpers, previewNodes, createdControllers } = createPreviewHarness();
    (app._initMobileImePreview as () => void).call(app);
    const callbacks = createdControllers[0].callbacks as unknown as {
      render(value: { text: string; phase: string }): void;
      clear(): void;
    };
    callbacks.render({ text: '你好', phase: 'provisional' });
    expect(previewNodes[0]).toMatchObject({ textContent: '你好', hidden: false, dataset: { phase: 'provisional' } });
    expect(helpers.classList.contains('codeman-ime-preview-owned')).toBe(true);
    callbacks.clear();
    expect(previewNodes[0]).toMatchObject({ textContent: '', hidden: true, dataset: {} });
    expect(helpers.classList.contains('codeman-ime-preview-owned')).toBe(false);
  });

  it('uses the active light terminal foreground while mirroring native composition font metrics', () => {
    const { app, compositionView, previewNodes, createdControllers } = createPreviewHarness({
      themeForeground: '#1f2328',
    });
    (app._initMobileImePreview as () => void).call(app);
    const preview = previewNodes[0] as {
      attributes: Record<string, string>;
      style: Record<string, string>;
    };
    const callbacks = createdControllers[0].callbacks as unknown as {
      render(value: { text: string; phase: string }): void;
    };

    callbacks.render({ text: '入力', phase: 'provisional' });

    expect(preview.attributes['aria-hidden']).toBe('true');
    expect(preview.style).toMatchObject({
      fontFamily: compositionView.style.fontFamily,
      fontSize: compositionView.style.fontSize,
      fontWeight: compositionView.style.fontWeight,
      fontStyle: compositionView.style.fontStyle,
      lineHeight: compositionView.style.lineHeight,
      height: compositionView.style.height,
      color: '#1f2328',
    });
    expect(preview.style.color).not.toBe(compositionView.style.color);
  });

  it('keeps rendering with a safe foreground when the theme getter throws', () => {
    const { app, previewNodes, createdControllers } = createPreviewHarness({ themeGetterThrows: true });
    (app._initMobileImePreview as () => void).call(app);
    const preview = previewNodes[0] as { textContent: string; style: Record<string, string> };
    const callbacks = createdControllers[0].callbacks as unknown as {
      render(value: { text: string; phase: string }): void;
    };
    expect(() => callbacks.render({ text: '安全', phase: 'provisional' })).not.toThrow();
    expect(preview.textContent).toBe('安全');
    expect(preview.style.color).toBe('#e0e0e0');
  });

  it.each(['query', 'create', 'append', 'className', 'hidden'] as const)(
    'removes partial DOM ownership when %s fails',
    (failure) => {
      const removed = vi.fn();
      const owner = fakeClassList();
      const preview = new Proxy(
        { dataset: {}, remove: removed },
        {
          set(target, property, value) {
            if (property === failure) throw new Error(`${failure} failed`);
            return Reflect.set(target, property, value);
          },
        }
      );
      const helpers = {
        classList: owner,
        appendChild:
          failure === 'append'
            ? () => {
                throw new Error('append failed');
              }
            : vi.fn(),
      };
      const documentStub = {
        addEventListener: vi.fn(),
        createElement:
          failure === 'create'
            ? () => {
                throw new Error('create failed');
              }
            : () => preview,
      };
      const MobileImePreview = { isIosWebKitTouch: () => true, create: vi.fn() };
      const { mixin } = loadMixin({ document: documentStub, MobileImePreview });
      const app = Object.assign(Object.create(mixin), {
        terminal: {
          textarea: {},
          element: {
            querySelector:
              failure === 'query'
                ? () => {
                    throw new Error('query failed');
                  }
                : () => helpers,
          },
        },
      });
      expect(() => app._initMobileImePreview()).not.toThrow();
      expect(app._mobileImePreview).toBeNull();
      expect(owner.contains('codeman-ime-preview-owned')).toBe(false);
      if (!['query', 'create'].includes(failure)) expect(removed).toHaveBeenCalled();
    }
  );
});

describe('mobile IME prediction wiring', () => {
  function predictionApp() {
    const { mixin } = loadMixin();
    const app = Object.assign(Object.create(mixin), {
      _localEchoPolicy: 'predict',
      _echoDebugCounts: { predictHit: 0, predictMiss: 0, totalOnData: 0 },
      _predictiveEcho: {
        predictText: vi.fn(() => true),
        predictChar: vi.fn(() => true),
        predictBackspace: vi.fn(() => true),
        clearPredictions: vi.fn(),
      },
      _mobileImePreview: { completeCommit: vi.fn(), consumeTerminalData: vi.fn(() => true) },
    });
    return app as Record<string, unknown>;
  }

  it('atomically predicts exact tagged text commits and completes the visual commit', () => {
    const app = predictionApp();
    (app._predictHookOnData as (data: string, options: { isImeCommit: boolean }) => void).call(app, '你好', {
      isImeCommit: true,
    });
    expect((app._predictiveEcho as Record<string, ReturnType<typeof vi.fn>>).predictText).toHaveBeenCalledWith('你好');
    expect((app._mobileImePreview as Record<string, ReturnType<typeof vi.fn>>).completeCommit).toHaveBeenCalledWith({
      predicted: true,
    });
  });

  it('keeps untagged multi-character input on the existing clear path', () => {
    const app = predictionApp();
    (app._predictHookOnData as (data: string) => void).call(app, 'paste');
    expect((app._predictiveEcho as Record<string, ReturnType<typeof vi.fn>>).predictText).not.toHaveBeenCalled();
    expect((app._predictiveEcho as Record<string, ReturnType<typeof vi.fn>>).clearPredictions).toHaveBeenCalledOnce();
    expect((app._mobileImePreview as Record<string, ReturnType<typeof vi.fn>>).completeCommit).not.toHaveBeenCalled();
  });

  it.each(['x', '\x7f', '\x1b[A'])('never completes an IME fallback for ordinary %j input', (data) => {
    const app = predictionApp();
    (app._predictHookOnData as (data: string) => void).call(app, data);
    expect((app._mobileImePreview as Record<string, ReturnType<typeof vi.fn>>).completeCommit).not.toHaveBeenCalled();
  });

  it('sends original bytes exactly once when consume and visual prediction throw', () => {
    const { mixin } = loadMixin();
    const sent: string[] = [];
    const original = '你好';
    const app = Object.assign(Object.create(mixin), {
      activeSessionId: 'session-a',
      _pendingInput: '',
      _inputFlushTimeout: null,
      _lastKeystrokeTime: 0,
      _viewMode: 'live',
      _localEchoEnabled: false,
      _mobileImePreview: {
        consumeTerminalData: () => {
          throw new Error('consume failed');
        },
      },
      _predictHookOnData: () => {
        throw new Error('visual failed');
      },
      _sendInputAsync: (_sessionId: string, data: string) => sent.push(data),
    });
    const actual = loadRegisteredOnDataHandler();
    (actual.context as Record<string, unknown>).flushInput = () => app._flushPendingTerminalInput();
    expect(() => actual.handler.call(app, original)).not.toThrow();
    expect(sent).toEqual([original]);
  });

  function fallbackHarness({ committed = true, generation = 3 } = {}) {
    const { mixin } = loadMixin();
    let parsed: (() => void) | undefined;
    const controller = {
      state: { committed, generation },
      noteAuthoritativeOutput: vi.fn(),
    };
    const app = Object.assign(Object.create(mixin), {
      pendingWrites: ['authoritative'],
      _pendingWriteAcceptanceEpochs: [4],
      _pendingWritesMaxAcceptanceEpoch: 4,
      _terminalOutputAcceptanceEpoch: 4,
      terminal: {
        write: vi.fn((_data: string, callback?: () => void) => {
          parsed = callback;
        }),
        buffer: { active: { viewportY: 0 } },
        scrollToBottom: vi.fn(),
      },
      activeSessionId: 'session-a',
      sessions: new Map([['session-a', { mode: 'codex' }]]),
      isTerminalAtBottom: () => true,
      _hasRecentUserScrollUp: () => false,
      _mobileImePreview: controller,
      _mobileImeCommitOwnership: {
        controller,
        generation,
        sessionId: 'session-a',
        acceptedOutputEpoch: 3,
      },
      _localEchoOverlay: null,
      _wasAtBottomBeforeWrite: false,
    });
    (app.flushPendingWrites as () => void).call(app);
    return { app, controller, parsed: () => parsed?.() };
  }

  it('clears an exact post-commit fallback only after authoritative parsing', () => {
    const { controller, parsed } = fallbackHarness();
    expect(controller.noteAuthoritativeOutput).not.toHaveBeenCalled();
    parsed?.();
    expect(controller.noteAuthoritativeOutput).toHaveBeenCalledOnce();
  });

  it('does not let queued pre-commit output clear a newer commit', () => {
    const { controller, parsed } = fallbackHarness({ committed: false, generation: 2 });
    controller.state = { committed: true, generation: 3 };
    parsed();
    expect(controller.noteAuthoritativeOutput).not.toHaveBeenCalled();
  });

  it('does not let output from a previous session or controller clear a newer commit', () => {
    const { app, controller, parsed } = fallbackHarness();
    app.activeSessionId = 'session-b';
    const newer = { state: { committed: true, generation: 1 }, noteAuthoritativeOutput: vi.fn() };
    app._mobileImePreview = newer;
    parsed();
    expect(controller.noteAuthoritativeOutput).not.toHaveBeenCalled();
    expect(newer.noteAuthoritativeOutput).not.toHaveBeenCalled();
  });

  it('does not let an older generation clear a newer commit on the same controller', () => {
    const { controller, parsed } = fallbackHarness({ generation: 3 });
    controller.state = { committed: true, generation: 4 };
    parsed();
    expect(controller.noteAuthoritativeOutput).not.toHaveBeenCalled();
  });
});

describe('mobile IME actual terminal onData routing', () => {
  function onDataApp(options: { localEcho: boolean; appendThrows?: boolean; addThrows?: boolean; tagged?: boolean }) {
    const { mixin } = loadMixin();
    const sent: string[] = [];
    const controller = {
      state: { committed: true, generation: 7 },
      consumeTerminalData: vi
        .fn()
        .mockReturnValueOnce(options.tagged ?? true)
        .mockReturnValue(false),
      completeCommit: vi.fn(),
    };
    const overlay = {
      pendingText: '',
      appendText: vi.fn((data: string) => {
        if (options.appendThrows) throw new Error('overlay failed');
        overlay.pendingText += data;
      }),
      addChar: vi.fn((data: string) => {
        if (options.addThrows) throw new Error('overlay failed');
        overlay.pendingText += data;
      }),
      clear: vi.fn(() => {
        overlay.pendingText = '';
      }),
      suppressBufferDetection: vi.fn(),
    };
    const app = Object.assign(Object.create(mixin), {
      activeSessionId: 'session-a',
      _viewMode: 'live',
      _localEchoEnabled: options.localEcho,
      _localEchoPolicy: 'predict',
      _localEchoOverlay: overlay,
      _echoPassthroughSessions: new Set(),
      _flushedOffsets: new Map(),
      _flushedTexts: new Map(),
      _pendingInput: '',
      _inputFlushTimeout: null,
      _lastKeystrokeTime: 0,
      _terminalOutputAcceptanceEpoch: 11,
      _mobileImePreview: controller,
      _predictiveEcho: {
        predictText: vi.fn(() => true),
        predictChar: vi.fn(() => true),
        predictBackspace: vi.fn(() => true),
        clearPredictions: vi.fn(),
      },
      _echoDebugCounts: { predictHit: 0, predictMiss: 0, totalOnData: 0 },
      _sendInputAsync: (_sessionId: string, data: string) => sent.push(data),
    });
    const actual = loadRegisteredOnDataHandler();
    (actual.context as Record<string, unknown>).flushInput = () => app._flushPendingTerminalInput();
    return { app, controller, overlay, sent, ...actual };
  }

  it('transfers a tagged multi-character commit into local echo and submits it only on Enter', () => {
    const { app, controller, overlay, sent, handler, timers } = onDataApp({ localEcho: true });

    handler.call(app, '你好');
    expect(controller.consumeTerminalData).toHaveBeenCalledTimes(1);
    expect(overlay.pendingText).toBe('你好');
    expect(controller.completeCommit).toHaveBeenCalledWith({ predicted: true });
    expect(sent).toEqual([]);

    handler.call(app, '\r');
    expect(sent).toEqual(['你好']);
    expect(timers).toHaveLength(1);
    timers.shift()?.();
    expect(sent).toEqual(['你好', '\r']);
  });

  it('transfers a tagged single-character commit into local echo and submits it only on Enter', () => {
    const { app, controller, overlay, sent, handler, timers } = onDataApp({ localEcho: true });

    handler.call(app, '界');
    expect(overlay.addChar).toHaveBeenCalledOnce();
    expect(overlay.addChar).toHaveBeenCalledWith('界');
    expect(overlay.pendingText).toBe('界');
    expect(controller.completeCommit).toHaveBeenCalledWith({ predicted: true });
    expect(app._mobileImeCommitOwnership).toBeNull();
    expect(sent).toEqual([]);

    handler.call(app, '\r');
    expect(sent).toEqual(['界']);
    timers.shift()?.();
    expect(sent).toEqual(['界', '\r']);
  });

  it('sends a tagged single character exactly once when local overlay transfer throws', () => {
    const { app, controller, overlay, sent, handler } = onDataApp({ localEcho: true, addThrows: true });
    expect(() => handler.call(app, '字')).not.toThrow();
    expect(overlay.addChar).toHaveBeenCalledOnce();
    expect(controller.consumeTerminalData).toHaveBeenCalledTimes(1);
    expect(controller.completeCommit).toHaveBeenCalledWith({ predicted: true });
    expect(app._mobileImeCommitOwnership).toBeNull();
    expect(sent).toEqual(['字']);
  });

  it('keeps an untagged multi-character paste on the existing local-only path', () => {
    const { app, controller, overlay, sent, handler } = onDataApp({ localEcho: true, tagged: false });
    handler.call(app, 'plain paste');
    expect(overlay.pendingText).toBe('plain paste');
    expect(controller.completeCommit).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('consumes the tag once at the registered entry and predicts/sends normal Codex input exactly once', () => {
    const { app, controller, sent, handler } = onDataApp({ localEcho: false });
    handler.call(app, '日本語');
    expect(controller.consumeTerminalData).toHaveBeenCalledTimes(1);
    expect(app._predictiveEcho.predictText).toHaveBeenCalledOnce();
    expect(app._predictiveEcho.predictText).toHaveBeenCalledWith('日本語');
    expect(sent).toEqual(['日本語']);
  });

  it('falls through with exact bytes when tagged local overlay transfer throws', () => {
    const { app, controller, sent, handler } = onDataApp({ localEcho: true, appendThrows: true });
    expect(() => handler.call(app, '失敗')).not.toThrow();
    expect(controller.consumeTerminalData).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(['失敗']);
  });
});

describe('mobile IME authoritative output acceptance ordering', () => {
  function orderingHarness() {
    const { mixin } = loadMixin({ SYNC_WAIT_TIMEOUT_MS: 50, _crashDiag: { log: vi.fn() } });
    const parsed: Array<() => void> = [];
    const controller = {
      state: { committed: false, generation: 1 },
      consumeTerminalData: vi.fn(() => {
        controller.state = { committed: true, generation: controller.state.generation + 1 };
        return true;
      }),
      completeCommit: vi.fn(),
      noteAuthoritativeOutput: vi.fn(),
    };
    const session = { mode: 'codex', flickerFilterEnabled: false };
    const app = Object.assign(Object.create(mixin), {
      activeSessionId: 'session-a',
      sessions: new Map([['session-a', session]]),
      pendingWrites: [],
      flickerFilterBuffer: '',
      flickerFilterActive: false,
      writeFrameScheduled: false,
      _pendingInput: '',
      _inputFlushTimeout: null,
      _lastKeystrokeTime: 0,
      _mobileImePreview: controller,
      _localEchoPolicy: 'predict',
      _predictiveEcho: {
        predictText: vi.fn(() => false),
        predictChar: vi.fn(() => false),
        predictBackspace: vi.fn(() => false),
        clearPredictions: vi.fn(),
      },
      _echoDebugCounts: { predictHit: 0, predictMiss: 0, totalOnData: 0 },
      _sendInputAsync: vi.fn(),
      _safeYield: vi.fn(),
      _wasAtBottomBeforeWrite: false,
      isTerminalAtBottom: () => true,
      _hasRecentUserScrollUp: () => false,
      terminal: {
        write: vi.fn((_data: string, callback?: () => void) => {
          if (callback) parsed.push(callback);
        }),
        buffer: { active: { viewportY: 0 } },
        scrollToBottom: vi.fn(),
      },
    });
    const commit = () => {
      const isImeCommit = app._consumeMobileImeTerminalData('你好');
      app._handleNormalTerminalData('你好', { isImeCommit });
    };
    const flush = () => app.flushPendingWrites();
    return { app, controller, session, parsed, commit, flush };
  }

  it('does not clear a commit with output accepted before it but parsed after it', () => {
    const { app, controller, parsed, commit, flush } = orderingHarness();
    app.batchTerminalWrite('old-output');
    commit();
    flush();
    parsed.shift()?.();
    expect(controller.noteAuthoritativeOutput).not.toHaveBeenCalled();
  });

  it('clears fallback for output accepted after the exact commit', () => {
    const { app, controller, parsed, commit, flush } = orderingHarness();
    commit();
    app.batchTerminalWrite('new-output');
    flush();
    parsed.shift()?.();
    expect(controller.noteAuthoritativeOutput).toHaveBeenCalledOnce();
  });

  it('does not apply a held post-commit flicker epoch to an older pending batch', () => {
    const { app, controller, session, parsed, commit, flush } = orderingHarness();
    app.batchTerminalWrite('old-output');
    commit();
    session.flickerFilterEnabled = true;
    app.batchTerminalWrite('\x1b[2Jnew-output');

    flush();
    parsed.shift()?.();
    expect(controller.noteAuthoritativeOutput).not.toHaveBeenCalled();

    app.flushFlickerBuffer();
    flush();
    parsed.shift()?.();
    expect(controller.noteAuthoritativeOutput).toHaveBeenCalledOnce();
    expect(app.terminal.write.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      'old-output',
      '\x1b[2Jnew-output',
    ]);
  });

  it('keeps a pre-commit deferred remainder below a later commit floor', () => {
    const { app, controller, parsed, commit, flush } = orderingHarness();
    app.batchTerminalWrite('x'.repeat(70_000));
    commit();
    flush();
    parsed.shift()?.();
    expect(controller.noteAuthoritativeOutput).not.toHaveBeenCalled();

    controller.state = { committed: false, generation: controller.state.generation + 1 };
    commit();
    flush();
    parsed.shift()?.();
    expect(controller.noteAuthoritativeOutput).not.toHaveBeenCalled();
  });

  it('preserves exact bytes and order across deferred acceptance segments', () => {
    const { app, flush } = orderingHarness();
    const first = 'a'.repeat(40_000);
    const second = 'b'.repeat(40_000);
    app.batchTerminalWrite(first);
    app.batchTerminalWrite(second);
    while (app.pendingWrites.length > 0) flush();
    const written = app.terminal.write.mock.calls.map((call: unknown[]) => call[0]).join('');
    expect(written).toBe(first + second);
  });
});

describe('mobile IME app lifecycle wiring', () => {
  function resettableApp() {
    const CodemanApp = loadAppClass();
    const preview = { reset: vi.fn() };
    const app = Object.assign(Object.create(CodemanApp.prototype), {
      _mobileImePreview: preview,
      _clearTimer: vi.fn(),
      _stopMobileResizeRetry: vi.fn(),
      _updateConnectionIndicator: vi.fn(),
      _ws: null,
      _wsState: 'connected',
    });
    return { app, preview };
  }

  it('resets preview state on an intentional WebSocket disconnect', () => {
    const { app, preview } = resettableApp();
    app._disconnectWs();
    expect(preview.reset).toHaveBeenCalledOnce();
  });

  it('resets preview state on the real WebSocket onclose path', () => {
    let socket: {
      onopen?: () => void;
      onclose?: (event: { code: number; reason: string }) => void;
      onmessage?: () => void;
      onerror?: () => void;
    } | null = null;
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 0;
      onopen?: () => void;
      onclose?: (event: { code: number; reason: string }) => void;
      constructor() {
        socket = this;
      }
      close() {}
    }
    const CodemanApp = loadAppClass({ WebSocket: FakeWebSocket });
    const preview = { reset: vi.fn() };
    const app = Object.assign(Object.create(CodemanApp.prototype), {
      _mobileImePreview: preview,
      _clearTimer: vi.fn(),
      _stopMobileResizeRetry: vi.fn(),
      _updateConnectionIndicator: vi.fn(),
      _scheduleWsCloseRefresh: vi.fn(),
      _clientId: 'client',
      _wsTabNonce: 'tab',
      _wsReconnectAttempts: 0,
      _ws: null,
      _wsState: 'disconnected',
      activeSessionId: 'session-a',
      sendResize: vi.fn(),
      _startMobileResizeRetry: vi.fn(),
      _onWsReady: vi.fn(),
      _isTuiSession: vi.fn(() => false),
    });
    app._connectWs('session-a');
    preview.reset.mockClear();
    socket!.onclose?.({ code: 4004, reason: 'gone' });
    expect(preview.reset).toHaveBeenCalledOnce();
  });

  it('reinitializes preview ownership during the real all-state reset path', () => {
    const CodemanApp = loadAppClass();
    const maps = () => new Map();
    const app = Object.assign(Object.create(CodemanApp.prototype), {
      sessions: maps(),
      ralphStates: maps(),
      terminalBuffers: maps(),
      terminalBufferCache: maps(),
      _xtermSnapshots: maps(),
      projectInsights: maps(),
      teams: maps(),
      teamTasks: maps(),
      idleTimers: maps(),
      pendingHooks: maps(),
      approvals: maps(),
      subagents: maps(),
      subagentActivity: maps(),
      subagentToolResults: maps(),
      subagentParentMap: maps(),
      _subagentEventVersions: maps(),
      minimizedSubagents: maps(),
      _subagentWindowRenderTimeouts: maps(),
      _subagentCompletionTimers: maps(),
      workflowRuns: maps(),
      workflowRunDetails: maps(),
      tabAlerts: maps(),
      attachmentHistoryCounts: maps(),
      _clearTimer: vi.fn(),
      _destroyMobileImePreview: vi.fn(),
      _initMobileImePreview: vi.fn(),
    });
    app._resetAllAppState();
    expect(app._destroyMobileImePreview).toHaveBeenCalledOnce();
    expect(app._initMobileImePreview).toHaveBeenCalledOnce();
  });
});
