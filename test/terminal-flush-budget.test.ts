import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadTerminalUiHarness(mode: string) {
  const CodemanApp = function CodemanApp(this: any) {};
  const context = vm.createContext({
    window: {},
    CodemanApp,
    console: { warn: vi.fn(), log: vi.fn() },
    _crashDiag: { log: vi.fn() },
    performance: { now: () => 0 },
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
  });

  const code = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'terminal-ui.js' });

  const app = new (CodemanApp as any)();
  const writes: string[] = [];
  app.activeSessionId = 'session-1';
  app.sessions = new Map([['session-1', { mode }]]);
  app.pendingWrites = [];
  app.writeFrameScheduled = false;
  app._wasAtBottomBeforeWrite = false;
  app._workerYield = () => {};
  app.terminal = {
    write: (data: string) => writes.push(data),
    scrollToBottom: () => {},
  };

  return { app, writes };
}

describe('terminal flush budget', () => {
  it('uses a smaller first-frame write budget for Codex output to reduce renderer stalls', () => {
    const { app, writes } = loadTerminalUiHarness('codex');
    app.pendingWrites.push('x'.repeat(96 * 1024));

    app.flushPendingWrites();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(32 * 1024);
    expect(app.pendingWrites.join('')).toHaveLength(64 * 1024);
  });

  it('keeps the larger first-frame write budget for non-Codex terminal output', () => {
    const { app, writes } = loadTerminalUiHarness('claude');
    app.pendingWrites.push('x'.repeat(96 * 1024));

    app.flushPendingWrites();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(64 * 1024);
    expect(app.pendingWrites.join('')).toHaveLength(32 * 1024);
  });
});
