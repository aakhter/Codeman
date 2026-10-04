// Port: none (pure logic in a vm context: no browser, no server).
//
// COD-467 (iPhone, Chrome = WebKit, Claude tab): "sometimes the keyboard does
// not open unless I switch sessions and back" and "sometimes when the keyboard
// is closed the terminal window does not resize". Both are STALE keyboard
// state, from opposite sides:
//
//  1. Stale FOCUS: the terminal's hidden textarea keeps focus while the
//     keyboard is gone (iOS hides it on an app/tab switch or lock and never
//     brings it back). Then a prompt-row tap calls focus() on the element that
//     already has it, which WebKit ignores, and a transcript tap reads
//     "keyboard up" and runs the tap-to-close toggle. Switching sessions fixed
//     it only because handleSessionTabClick blurs the active element.
//  2. Stale FLAG: KeyboardHandler.keyboardVisible stays true after the
//     keyboard closed, because hiding needed the visual viewport back within
//     100px of a baseline taken before it opened, and Chrome's own toolbars
//     move it further than that. throttledResize and the mobile resize retry
//     skip while the flag is set, so the terminal never resizes back.
//
// Lives outside test/mobile/ on purpose: that Playwright suite is excluded from
// the CI gate, and headless Chromium does not apply WebKit's keyboard rules.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const MOBILE = readFileSync(resolve(PUBLIC, 'mobile-handlers.js'), 'utf8');

interface Handler {
  init(): void;
  cleanup(): void;
  handleViewportResize(): void;
  keyboardVisible: boolean;
  initialViewportHeight: number;
}

type FakeEl = {
  tagName: string;
  classList: { contains(c: string): boolean };
  closest(): null;
  blur(): void;
  id?: string;
  isContentEditable?: boolean;
};

/** iPhone 15 Pro in Chrome (CSS px). Chrome's toolbars collapsed → expanded costs ~110px. */
const FULL = 750;
const TOOLBARS = 110;
const KEYBOARD = 330;
const WIDTH = 393;

function loadKeyboardHandler() {
  const viewport = {
    width: WIDTH,
    height: FULL,
    offsetTop: 0,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const layout = { height: FULL };
  const docListeners = new Map<string, Array<(ev?: unknown) => void>>();
  const timers: Array<{ fn: () => void; at: number }> = [];
  let now = 0;
  const bodyClasses = new Set<string>();
  const hides: number[] = [];
  const doc = {
    activeElement: null as FakeEl | null,
    visibilityState: 'visible',
    body: { classList: { add: (c: string) => bodyClasses.add(c), remove: (c: string) => bodyClasses.delete(c) } },
    documentElement: { style: { setProperty: () => {} } },
    addEventListener: (type: string, fn: (ev?: unknown) => void) => {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type)!.push(fn);
    },
    removeEventListener: (type: string, fn: (ev?: unknown) => void) => {
      docListeners.set(
        type,
        (docListeners.get(type) || []).filter((f) => f !== fn)
      );
    },
    getElementById: () => null,
    querySelector: () => null,
  };
  const context = vm.createContext({
    console,
    app: { relayoutMobileSubagentWindows: () => {} },
    navigator: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/130 Mobile/15E148',
      maxTouchPoints: 5,
    },
    window: {
      get innerWidth() {
        return viewport.width;
      },
      get innerHeight() {
        return layout.height;
      },
      visualViewport: viewport,
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: () => ({ matches: true }),
      scrollTo: () => {},
    },
    document: doc,
    setTimeout: (fn: () => void, ms = 0) => timers.push({ fn, at: now + ms }),
    clearTimeout: () => {},
  });
  vm.runInContext(`${MOBILE}\nglobalThis.__KH = KeyboardHandler;`, context, { filename: 'mobile-handlers.js' });
  const handler = (context as unknown as { __KH: Handler & { onKeyboardHide(): void } }).__KH;
  const realHide = handler.onKeyboardHide.bind(handler);
  handler.onKeyboardHide = () => {
    hides.push(now);
    realHide();
  };
  handler.init();
  const resize = (visual: number, layoutHeight: number) => {
    viewport.height = visual;
    layout.height = layoutHeight;
    handler.handleViewportResize();
  };
  const fire = (type: string) => (docListeners.get(type) || []).forEach((fn) => fn({ type }));
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) {
      if (t.at <= now) t.fn();
      else timers.push(t);
    }
  };
  return { handler, resize, fire, advance, doc, bodyClasses, hides };
}

const terminalTextarea = (onBlur = () => {}): FakeEl => ({
  tagName: 'TEXTAREA',
  classList: { contains: (c: string) => c === 'xterm-helper-textarea' },
  closest: () => null,
  blur: onBlur,
});

describe('COD-467 stale keyboard FLAG: the terminal resizes back when the keyboard closes', () => {
  it('detects the close even when Chrome toolbars leave the viewport >100px from the old baseline', () => {
    const { handler, resize, bodyClasses } = loadKeyboardHandler();
    // Keyboard opens over a page whose toolbars were collapsed (baseline 750).
    resize(FULL - KEYBOARD, FULL);
    expect(handler.keyboardVisible).toBe(true);
    // Keyboard closes and Chrome brings its toolbars back: 640, i.e. 110px
    // short of the baseline. The old rule (within 100px) never cleared.
    resize(FULL - TOOLBARS, FULL - TOOLBARS);
    expect(handler.keyboardVisible).toBe(false);
    expect(bodyClasses.has('keyboard-visible')).toBe(false);
  });

  it('a keyboard that merely changes size (predictive bar, emoji) stays a keyboard', () => {
    const { handler, resize } = loadKeyboardHandler();
    resize(FULL - KEYBOARD, FULL);
    resize(FULL - KEYBOARD + 45, FULL); // predictive bar hidden
    resize(FULL - KEYBOARD - 60, FULL); // taller emoji keyboard
    expect(handler.keyboardVisible).toBe(true);
  });

  it('clears the flag once nothing editable has focus (a phone keyboard cannot be up then)', () => {
    const { handler, resize, fire, advance, doc, hides } = loadKeyboardHandler();
    doc.activeElement = terminalTextarea();
    resize(FULL - KEYBOARD, FULL);
    expect(handler.keyboardVisible).toBe(true);
    // The keyboard is dismissed by blurring the input, but the closing resize
    // never satisfies the detector (here: no resize event at all).
    doc.activeElement = null;
    fire('focusout');
    advance(500);
    expect(handler.keyboardVisible).toBe(false);
    expect(hides).toHaveLength(1);
  });

  it('does not clear it when focus just moves to another editable element', () => {
    const { handler, resize, fire, advance, doc } = loadKeyboardHandler();
    doc.activeElement = terminalTextarea();
    resize(FULL - KEYBOARD, FULL);
    fire('focusout');
    doc.activeElement = terminalTextarea(); // e.g. the accessory bar refocused the terminal
    advance(500);
    expect(handler.keyboardVisible).toBe(true);
  });
});

describe('COD-467 stale FOCUS: coming back to the page releases the hidden textarea', () => {
  it('blurs the focused terminal input and clears the keyboard state on return', () => {
    const { handler, resize, fire, doc } = loadKeyboardHandler();
    const blur = vi.fn(() => {
      doc.activeElement = null;
    });
    doc.activeElement = terminalTextarea(blur);
    resize(FULL - KEYBOARD, FULL);
    // App switch: iOS hides the keyboard; the textarea keeps focus.
    doc.visibilityState = 'hidden';
    fire('visibilitychange');
    doc.visibilityState = 'visible';
    fire('visibilitychange');
    expect(blur).toHaveBeenCalledTimes(1);
    expect(handler.keyboardVisible).toBe(false);
  });

  it('leaves an unrelated focused field alone', () => {
    const { fire, doc } = loadKeyboardHandler();
    const blur = vi.fn();
    doc.activeElement = {
      tagName: 'INPUT',
      classList: { contains: () => false },
      closest: () => null,
      blur,
      id: 'renameInput',
    };
    fire('visibilitychange');
    expect(blur).not.toHaveBeenCalled();
  });

  it('registers its listeners once even though init() runs twice', () => {
    const { handler, resize, fire, doc } = loadKeyboardHandler();
    handler.init();
    const blur = vi.fn(() => {
      doc.activeElement = null;
    });
    doc.activeElement = terminalTextarea(blur);
    resize(FULL - KEYBOARD, FULL);
    fire('visibilitychange');
    expect(blur).toHaveBeenCalledTimes(1);
  });
});

// ── terminal-ui.js: the tap decision ──────────────────────────────────────
function loadTapApp(opts: { keyboardVisible: boolean }) {
  const CodemanApp = function CodemanApp(this: unknown) {};
  const calls: string[] = [];
  const textarea = terminalTextarea(() => {
    calls.push('blur');
    doc.activeElement = null;
  });
  const doc = { activeElement: textarea as FakeEl | null, getElementById: () => null, querySelector: () => null };
  const context = vm.createContext({
    window: {},
    CodemanApp,
    console,
    document: doc,
    performance: { now: () => 1000 },
    requestAnimationFrame: () => 1,
    setTimeout: () => 1,
    MobileDetection: { isTouchDevice: () => true, isMobile: () => true },
    KeyboardHandler: { keyboardVisible: opts.keyboardVisible },
    DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
    Blob: function Blob() {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    Worker: function Worker(this: { postMessage: () => void }) {
      this.postMessage = () => {};
    },
    _crashDiag: { log: () => {} },
  });
  vm.runInContext(readFileSync(resolve(PUBLIC, 'terminal-ui.js'), 'utf8'), context, { filename: 'terminal-ui.js' });
  const app = new (CodemanApp as unknown as new () => Record<string, any>)();
  app.terminal = {
    textarea,
    modes: { mouseTrackingMode: 'none' },
    focus: () => {
      calls.push('focus');
      doc.activeElement = textarea;
    },
  };
  app._syncMobileHelperTextareaToCursor = () => {};
  app._isActionableMobileTerminalTap = () => false;
  app._tapIsOnCaretLine = () => true;
  app._activateTerminalLinkAtPoint = () => false;
  app._shouldReportMouseToCli = () => false;
  return { app, calls, doc };
}

describe('COD-467 stale FOCUS: a tap opens the keyboard when the textarea is focused but the keyboard is gone', () => {
  const touch = { clientX: 100, clientY: 600 };

  it('"keyboard up" for the tap toggle means focused AND visible, not just focused', () => {
    expect(loadTapApp({ keyboardVisible: false }).app._mobileKeyboardIsUp()).toBe(false);
    expect(loadTapApp({ keyboardVisible: true }).app._mobileKeyboardIsUp()).toBe(true);
  });

  it('prompt-row tap: re-focus is blur THEN focus, so WebKit shows the keyboard', () => {
    const { app, calls } = loadTapApp({ keyboardVisible: false });
    app._handleMobileTerminalTap(touch, app._mobileKeyboardIsUp(), 'input');
    expect(calls).toEqual(['blur', 'focus']);
  });

  it('transcript tap with stale focus opens the keyboard instead of running the close toggle', () => {
    const { app, calls } = loadTapApp({ keyboardVisible: false });
    app._blurMobileTerminalInput(); // what touchstart does for a 'content' tap
    calls.length = 0;
    app._handleMobileTerminalTap(touch, false, 'content');
    expect(calls).toEqual(['focus']);
  });

  it('with the keyboard really up, a transcript tap still closes it, and a prompt tap does not bounce it', () => {
    const up = loadTapApp({ keyboardVisible: true });
    up.app._handleMobileTerminalTap(touch, up.app._mobileKeyboardIsUp(), 'content');
    expect(up.calls).toEqual(['blur']);
    const prompt = loadTapApp({ keyboardVisible: true });
    prompt.app._handleMobileTerminalTap(touch, false, 'input');
    expect(prompt.calls).toEqual(['focus']); // no blur/refocus flicker while the keyboard is up
  });

  it('touchstart records "keyboard up", not mere focus, for the tap decision', () => {
    const src = readFileSync(resolve(PUBLIC, 'terminal-ui.js'), 'utf8');
    expect(src).toContain('tapStartedWithTerminalFocus = this._mobileKeyboardIsUp();');
    expect(src).not.toContain('tapStartedWithTerminalFocus = this._isMobileTerminalInputFocused();');
  });
});
