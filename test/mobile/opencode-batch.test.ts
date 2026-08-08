import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

function loadHarness(opts: { isMobile: boolean; mode: string }) {
  let now = 1000;
  const CodemanApp = function CodemanApp(this: any) {};
  const ctx = vm.createContext({
    window: {},
    CodemanApp,
    MouseEvent: class {},
    document: { getElementById: () => null },
    console: { warn: vi.fn(), log: vi.fn() },
    _crashDiag: { log: vi.fn() },
    performance: { now: () => now },
    requestAnimationFrame: (fn: any) => 1,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    location: { search: '' },
    URLSearchParams: globalThis.URLSearchParams,
    Blob: function Blob() {},
    URL: { createObjectURL: () => 'x', revokeObjectURL: () => {} },
    Worker: function Worker(this: any) {
      this.postMessage = () => {};
    },
    MobileDetection: {
      isMobile: () => opts.isMobile,
      getDeviceType: () => (opts.isMobile ? 'mobile' : 'desktop'),
      isTouchDevice: () => true,
    },
    DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
  });
  const code = readFileSync(resolve(import.meta.dirname, '../../src/web/public/terminal-ui.js'), 'utf8');
  vm.runInContext(code, ctx, { filename: 'terminal-ui.js' });
  const app = new (CodemanApp as any)();
  app.sessions = new Map([['sess-1', { mode: opts.mode }]]);
  app.activeSessionId = 'sess-1';
  app._viewMode = 'live';
  const screen = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400, right: 800, bottom: 400 }),
  };
  app.terminal = {
    cols: 80,
    rows: 24,
    element: { querySelector: (s: string) => (s === '.xterm-screen' ? screen : null) },
    _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 13 } } } } },
  };
  app._sendInputAsync = vi.fn();
  return app;
}

describe('COD-283 batch SGR forwarding', () => {
  beforeEach(() => vi.useFakeTimers());
  it('batches SGR wheel events for opencode on mobile within 16ms', async () => {
    const app = loadHarness({ isMobile: true, mode: 'opencode' });
    app._sendForegroundTuiWheel(10, 10, 10);
    app._sendForegroundTuiWheel(10, 10, 10);
    app._sendForegroundTuiWheel(10, 10, 10);
    expect(app._sendInputAsync).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16);
    const calls = (app._sendInputAsync as any).mock.calls.length;
    expect(calls).toBe(2);
    const seq = (app._sendInputAsync as any).mock.calls[0][1];
    expect(seq).toBe('\x1b[<65;2;1M');
  });
  it('does not batch for non-mobile (immediate threshold)', () => {
    const app = loadHarness({ isMobile: false, mode: 'opencode' });
    app._sendForegroundTuiWheel(60, 10, 10);
    expect(app._sendInputAsync).toHaveBeenCalledTimes(1);
  });
});
