import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadTerminalUiHarness() {
  const CodemanApp = function CodemanApp(this: any) {};
  const timers: Array<() => void> = [];
  const context = vm.createContext({
    window: {},
    CodemanApp,
    console: { warn: vi.fn(), log: vi.fn(), error: vi.fn() },
    _crashDiag: { log: vi.fn() },
    performance: { now: () => 1_000 },
    requestAnimationFrame: (_fn: () => void) => 1,
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: vi.fn(),
    Blob: function Blob() {},
    URL: {
      createObjectURL: () => 'blob:yield',
      revokeObjectURL: () => {},
    },
    Worker: function Worker(this: any) {
      this.postMessage = () => {};
    },
    MobileDetection: {
      getDeviceType: () => 'desktop',
      isTouchDevice: () => false,
    },
    Terminal: function Terminal() {},
    FitAddon: { FitAddon: function FitAddon() {} },
    DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
    navigator: { clipboard: { writeText: vi.fn() } },
    document: {
      getElementById: vi.fn(() => ({ addEventListener: vi.fn() })),
      createElement: vi.fn(() => ({ style: {}, setAttribute: vi.fn(), select: vi.fn() })),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      execCommand: vi.fn(() => true),
    },
  });

  const code = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'terminal-ui.js' });

  const app = new (CodemanApp as any)();
  return {
    app,
    flushLatestTimer: () => timers.pop()?.(),
  };
}

function createTerminal(selectionRef: { value: string }) {
  const listeners: Array<() => void> = [];
  return {
    getSelection: vi.fn(() => selectionRef.value),
    onSelectionChange: vi.fn((listener: () => void) => {
      listeners.push(listener);
      return { dispose: vi.fn() };
    }),
    fireSelectionChange: () => {
      for (const listener of listeners) listener();
    },
  };
}

describe('terminal selection auto-copy', () => {
  it('copies a non-empty terminal selection through the app clipboard helper', async () => {
    const { app, flushLatestTimer } = loadTerminalUiHarness();
    const selection = { value: 'selected text' };
    app.terminal = createTerminal(selection);
    app._copyText = vi.fn(async () => true);

    app._installTerminalSelectionAutoCopy();
    app.terminal.fireSelectionChange();
    flushLatestTimer();
    await Promise.resolve();

    expect(app._copyText).toHaveBeenCalledWith('selected text');
  });

  it('ignores empty terminal selections', () => {
    const { app, flushLatestTimer } = loadTerminalUiHarness();
    const selection = { value: '' };
    app.terminal = createTerminal(selection);
    app._copyText = vi.fn(async () => true);

    app._installTerminalSelectionAutoCopy();
    app.terminal.fireSelectionChange();
    flushLatestTimer();

    expect(app._copyText).not.toHaveBeenCalled();
  });

  it('does not copy the same selection twice', async () => {
    const { app, flushLatestTimer } = loadTerminalUiHarness();
    const selection = { value: 'same text' };
    app.terminal = createTerminal(selection);
    app._copyText = vi.fn(async () => true);

    app._installTerminalSelectionAutoCopy();
    app.terminal.fireSelectionChange();
    flushLatestTimer();
    await Promise.resolve();
    app.terminal.fireSelectionChange();
    flushLatestTimer();
    await Promise.resolve();

    expect(app._copyText).toHaveBeenCalledTimes(1);
  });

  it('copies only the latest rapid selection change', async () => {
    const { app, flushLatestTimer } = loadTerminalUiHarness();
    const selection = { value: 'first' };
    app.terminal = createTerminal(selection);
    app._copyText = vi.fn(async () => true);

    app._installTerminalSelectionAutoCopy();
    app.terminal.fireSelectionChange();
    selection.value = 'second';
    app.terminal.fireSelectionChange();
    flushLatestTimer();
    await Promise.resolve();

    expect(app._copyText).toHaveBeenCalledTimes(1);
    expect(app._copyText).toHaveBeenCalledWith('second');
  });

  it('swallows clipboard write failures', async () => {
    const { app, flushLatestTimer } = loadTerminalUiHarness();
    const selection = { value: 'selected text' };
    app.terminal = createTerminal(selection);
    app._copyText = vi.fn(async () => {
      throw new Error('denied');
    });

    app._installTerminalSelectionAutoCopy();
    app.terminal.fireSelectionChange();
    flushLatestTimer();
    await Promise.resolve();

    expect(app._copyText).toHaveBeenCalledWith('selected text');
  });
});
