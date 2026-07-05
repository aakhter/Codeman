import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadTerminalUiHarness() {
  const CodemanApp = function CodemanApp(this: any) {};
  class MockMouseEvent {
    type: string;
    bubbles = false;
    cancelable = false;
    view: unknown;
    clientX = 0;
    clientY = 0;
    screenX = 0;
    screenY = 0;
    button = 0;
    buttons = 0;
    detail = 0;
    isTrusted = false;

    constructor(type: string, options: Record<string, unknown> = {}) {
      this.type = type;
      Object.assign(this, options);
    }
  }

  let now = 1_000;
  const context = vm.createContext({
    window: {},
    CodemanApp,
    MouseEvent: MockMouseEvent,
    console: { warn: vi.fn(), log: vi.fn() },
    _crashDiag: { log: vi.fn() },
    performance: { now: () => now },
    requestAnimationFrame: (_fn: () => void) => 1,
    setTimeout: (_fn: () => void) => 1,
    Blob: function Blob() {},
    URL: {
      createObjectURL: () => 'blob:yield',
      revokeObjectURL: () => {},
    },
    Worker: function Worker(this: any) {
      this.postMessage = () => {};
    },
    MobileDetection: {
      isTouchDevice: () => true,
    },
    DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
  });

  const code = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'terminal-ui.js' });

  const app = new (CodemanApp as any)();
  return {
    app,
    setNow: (value: number) => {
      now = value;
    },
  };
}

function createElementHarness() {
  const listeners = new Map<string, Array<(ev: any) => void>>();
  return {
    element: {
      addEventListener: vi.fn((type: string, listener: (ev: any) => void) => {
        const bucket = listeners.get(type) || [];
        bucket.push(listener);
        listeners.set(type, bucket);
      }),
      dispatchEvent: vi.fn((event: { type: string }) => {
        for (const listener of listeners.get(event.type) || []) {
          listener(event);
        }
        return true;
      }),
    },
    dispatch(type: string, event: any) {
      for (const listener of listeners.get(type) || []) {
        listener(event);
      }
    },
    listeners,
  };
}

describe('terminal touch tap mouse guard', () => {
  it('suppresses browser trusted compatibility mouse events during the tap window', () => {
    const { app } = loadTerminalUiHarness();
    const { element, dispatch } = createElementHarness();
    app.terminal = { element };

    app._installMobileTapMouseGuard();
    app._suppressTrustedTapMouseEvents();

    const event = {
      isTrusted: true,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    dispatch('mousedown', event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it('allows the app synthetic mouse event through the tap window', () => {
    const { app } = loadTerminalUiHarness();
    const { element, dispatch } = createElementHarness();
    app.terminal = { element };

    app._installMobileTapMouseGuard();
    app._suppressTrustedTapMouseEvents();

    const event = {
      isTrusted: false,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    dispatch('mousedown', event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it('allows trusted mouse events after the tap window expires', () => {
    const { app, setNow } = loadTerminalUiHarness();
    const { element, dispatch } = createElementHarness();
    app.terminal = { element };

    app._installMobileTapMouseGuard();
    app._suppressTrustedTapMouseEvents();
    setNow(2_000);

    const event = {
      isTrusted: true,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    dispatch('mousedown', event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it('dispatches a synthetic press/release pair when OpenCode tap flow has mouse tracking enabled', () => {
    const { app } = loadTerminalUiHarness();
    const { element } = createElementHarness();

    app.terminal = {
      element,
      modes: {
        mouseTrackingMode: '1000',
      },
    };

    app._dispatchSyntheticTerminalClick(120, 84);

    expect(element.dispatchEvent).toHaveBeenCalledTimes(2);

    const first = element.dispatchEvent.mock.calls[0]?.[0] as { [key: string]: unknown };
    const second = element.dispatchEvent.mock.calls[1]?.[0] as { [key: string]: unknown };

    expect(first).toMatchObject({
      type: 'mousedown',
      buttons: 1,
      clientX: 120,
      clientY: 84,
      detail: 1,
      button: 0,
      bubbles: true,
      cancelable: true,
    });
    expect(second).toMatchObject({
      type: 'mouseup',
      buttons: 0,
      clientX: 120,
      clientY: 84,
      detail: 1,
      button: 0,
      bubbles: true,
      cancelable: true,
    });
  });

  it('retains trusted tap-mouse suppression for OpenCode-targeted synthetic tap flow', () => {
    const { app } = loadTerminalUiHarness();
    const { element, dispatch } = createElementHarness();
    app.terminal = {
      element,
      modes: {
        mouseTrackingMode: '1000',
      },
    };

    app._installMobileTapMouseGuard();
    app._suppressTrustedTapMouseEvents();

    app._dispatchSyntheticTerminalClick(15, 25);

    const trustedDown = {
      isTrusted: true,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    const trustedUp = {
      isTrusted: true,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };

    dispatch('mousedown', trustedDown);
    dispatch('mouseup', trustedUp);

    expect(trustedDown.preventDefault).toHaveBeenCalledOnce();
    expect(trustedDown.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(trustedUp.preventDefault).toHaveBeenCalledOnce();
    expect(trustedUp.stopImmediatePropagation).toHaveBeenCalledOnce();
  });
});
