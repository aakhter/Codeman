/**
 * COD-464 — desktop wheel on Claude/Codex tabs, paced to the CLI's own transcript.
 *
 * Measured before the fix (isolated real Claude 2.1.286 + Codex 0.159.3, desktop
 * Chromium): live-mirror tabs have no local scrollback, so every wheel event fell
 * through to the PageUp fallback — nothing moved until ~500px of travel (629 ms /
 * 513 ms to first movement for five notches), then the CLI jumped half a screen,
 * and a 240px trackpad gesture moved NOTHING. Both CLIs scroll by whole rows per
 * SGR wheel report in 5-12 ms (Claude 1 row, Codex 3), so the wheel now goes to
 * the CLI as paced reports: the first one immediately, the rest one eased batch
 * per animation frame.
 *
 * These drive the shipped methods in a VM with a controllable rAF + clock.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const UP = '\x1b[<64;';
const DOWN = '\x1b[<65;';

type WheelSpec = { mode: string; minVersion?: string; rows: number; reversalDeadReports?: number };
// Default: no reversal debounce, so the arithmetic tests below read cleanly; the
// Claude debounce has its own tests. Modes as stock.ts declares them.
const SPECS: Record<string, WheelSpec> = {
  claude: { mode: 'version-gated', minVersion: '2.1.187', rows: 1 },
  codex: { mode: 'mouse-tracking', rows: 3 },
};

function harness(
  opts: { mode?: string; cliMouseTracking?: boolean; cliVersion?: string; rows?: Record<string, WheelSpec> | null } = {}
) {
  const frames: Array<() => void> = [];
  let now = 10_000;
  const windowRef: Record<string, unknown> = {};
  if (opts.rows !== null) windowRef.__codemanWheelForward = opts.rows ?? SPECS;
  const CodemanApp = function CodemanApp(this: unknown) {};
  const context = vm.createContext({
    window: windowRef,
    CodemanApp,
    console: { warn: vi.fn(), log: vi.fn() },
    _crashDiag: { log: vi.fn() },
    performance: { now: () => now },
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    setTimeout: () => 1,
    Blob: function Blob() {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    Worker: function Worker(this: { postMessage: () => void }) {
      this.postMessage = () => {};
    },
    MobileDetection: { isTouchDevice: () => false },
    DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
  });
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8'), context, {
    filename: 'terminal-ui.js',
  });
  const app = new (CodemanApp as unknown as new () => Record<string, any>)();
  const sent: Array<{ id: string; data: string }> = [];
  app.activeSessionId = 'sess-1';
  app._viewMode = 'live';
  app.sessions = new Map([
    [
      'sess-1',
      {
        mode: opts.mode ?? 'claude',
        cliMouseTracking: opts.cliMouseTracking ?? true,
        cliVersion: opts.cliVersion ?? '2.1.286',
      },
    ],
    ['sess-2', { mode: opts.mode ?? 'claude', cliMouseTracking: true, cliVersion: '2.1.286' }],
  ]);
  app._sendInputEphemeral = (id: string, data: string) => sent.push({ id, data });
  app._clientPointToCell = () => ({ col: 40, row: 10 });
  app._terminalViewportAtBottom = () => true;
  app.terminal = {
    cols: 80,
    rows: 40,
    modes: { mouseTrackingMode: 'none' },
    buffer: { active: { type: 'normal', viewportY: 0, baseY: 0 } },
    scrollToBottom: vi.fn(),
  };
  const count = (needle: string) => sent.reduce((n, s) => n + s.data.split(needle).length - 1, 0);
  const runFrame = () => {
    const due = frames.splice(0);
    for (const fn of due) fn();
    return due.length;
  };
  const drain = () => {
    let guard = 0;
    while (frames.length && guard++ < 1000) runFrame();
  };
  return {
    app,
    sent,
    count,
    runFrame,
    drain,
    frames,
    advance: (ms: number) => {
      now += ms;
    },
    wheel: (deltaY: number, extra: Record<string, unknown> = {}) => ({
      deltaY,
      deltaX: 0,
      deltaMode: 0,
      shiftKey: false,
      clientX: 500,
      clientY: 300,
      ...extra,
    }),
  };
}

describe('COD-464 routing: which wheel events are paced to the CLI', () => {
  it('claims Claude (version-gated) and Codex (mouse-tracking) tabs', () => {
    for (const mode of ['claude', 'codex']) {
      const h = harness({ mode });
      expect(h.app._shouldPaceWheelToCli(h.wheel(-100)), mode).toBe(true);
    }
  });

  it("'mouse-tracking' leaves a pane that never asked for mouse reports on the fallback (e.g. remote wrappers)", () => {
    const h = harness({ mode: 'codex', cliMouseTracking: false });
    expect(h.app._shouldPaceWheelToCli(h.wheel(-100))).toBe(false);
  });

  it("'version-gated' needs the probed version: unknown or older keeps the fallback", () => {
    expect(harness({ cliVersion: '2.1.186' }).app._wheelReportsFor('sess-1')).toBeNull();
    const unknown = harness();
    unknown.app.sessions.get('sess-1').cliVersion = undefined;
    expect(unknown.app._wheelReportsFor('sess-1')).toBeNull();
    expect(harness({ cliVersion: '2.1.187' }).app._wheelReportsFor('sess-1')).toEqual({
      rows: 1,
      reversalDeadReports: 0,
    });
  });

  it("'never' and a forwarding mode without measured rows are never paced", () => {
    const never = harness({ rows: { claude: { mode: 'never', rows: 1 } } });
    expect(never.app._shouldPaceWheelToCli(never.wheel(-100))).toBe(false);
    const noRows = harness({ rows: { claude: { mode: 'version-gated', minVersion: '2.1.187' } as WheelSpec } });
    expect(noRows.app._shouldPaceWheelToCli(noRows.wheel(-100))).toBe(false);
  });

  it('needs the capability: a CLI absent from the injected map is never paced', () => {
    expect(harness({ mode: 'gemini' }).app._shouldPaceWheelToCli({ deltaY: -100 })).toBe(false);
    const noMap = harness({ rows: null });
    expect(noMap.app._shouldPaceWheelToCli(noMap.wheel(-100))).toBe(false);
  });

  it('keeps Shift+wheel, the local-history opt-out, the history view and xterm-owned mouse modes', () => {
    const h = harness();
    expect(h.app._shouldPaceWheelToCli(h.wheel(-100, { shiftKey: true }))).toBe(false);

    h.app.loadAppSettingsFromStorage = () => ({ terminalWheelLocalScrollback: true });
    expect(h.app._shouldPaceWheelToCli(h.wheel(-100))).toBe(false);
    h.app.loadAppSettingsFromStorage = () => ({});

    h.app._viewMode = 'history';
    expect(h.app._shouldPaceWheelToCli(h.wheel(-100))).toBe(false);
    h.app._viewMode = 'live';

    h.app.terminal.modes.mouseTrackingMode = 'any';
    expect(h.app._shouldPaceWheelToCli(h.wheel(-100))).toBe(false);
    h.app.terminal.modes.mouseTrackingMode = 'none';

    h.app.terminal.buffer.active.type = 'alternate';
    expect(h.app._shouldPaceWheelToCli(h.wheel(-100))).toBe(false);
  });

  it('is consulted in the wheel listener BEFORE the PageUp fallback and the mirror history funnel', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
    const listener = src.slice(src.indexOf("container.addEventListener(\n      'wheel',"));
    const paced = listener.indexOf('this._shouldPaceWheelToCli(ev)');
    expect(paced).toBeGreaterThan(-1);
    expect(paced).toBeLessThan(listener.indexOf('this._maybePageCliTranscript(ev, lines)'));
    expect(paced).toBeLessThan(listener.indexOf('this._handleUserScrollIntent(lines);\n          return;'));
    expect(paced).toBeLessThan(listener.indexOf("this._logScrollRouting('forward-sgr');"));
  });
});

describe('COD-464 pacing: immediate start, row-by-row drain', () => {
  it('sends the first report of a gesture synchronously, before any animation frame', () => {
    const h = harness();
    h.app._paceWheelToCli(500, 300, -4); // one Chrome notch = 100px = 4 lines
    expect(h.count(UP)).toBe(1);
    expect(h.sent[0]).toEqual({ id: 'sess-1', data: '\x1b[<64;40;10M' });
  });

  it('drains the rest one report per frame for a single notch (no burst, no jump)', () => {
    const h = harness();
    h.app._paceWheelToCli(500, 300, -4);
    const perFrame: number[] = [];
    while (h.frames.length) {
      const before = h.count(UP);
      h.runFrame();
      perFrame.push(h.count(UP) - before);
    }
    expect(perFrame).toEqual([1, 1, 1]);
    expect(h.count(UP)).toBe(4);
    expect(h.count(DOWN)).toBe(0);
  });

  it("converts lines to reports at the CLI's declared rows per report, carrying the remainder", () => {
    const h = harness({ mode: 'codex' }); // 3 rows per report
    h.app._paceWheelToCli(500, 300, -4); // 4 lines → 1 report, 1/3 carried
    h.drain();
    expect(h.count(UP)).toBe(1);
    h.advance(50);
    h.app._paceWheelToCli(500, 300, -4); // 1/3 + 4/3 → 1 report, 2/3 carried
    h.drain();
    expect(h.count(UP)).toBe(2);
    h.advance(50);
    h.app._paceWheelToCli(500, 300, -4); // 2/3 + 4/3 = 2 → 2 reports
    h.drain();
    expect(h.count(UP)).toBe(4); // 12 lines of travel = 4 reports x 3 rows
  });

  it('moves on the FIRST event of a slow trackpad gesture, and the whole gesture tracks the finger', () => {
    const h = harness();
    // macOS trackpad: 60 events of 4px = 240px = 9.6 lines, 16ms apart.
    h.app._paceWheelToCli(500, 300, -0.16);
    expect(h.count(UP)).toBe(1); // before the PageUp route moved nothing for this whole gesture
    for (let i = 1; i < 60; i++) {
      h.advance(16);
      h.app._paceWheelToCli(500, 300, -0.16);
      h.drain();
    }
    // The first report was pre-paid, not added: 9.6 lines → 9 whole reports.
    expect(h.count(UP)).toBe(9);
  });

  it('ignores sub-line jitter at gesture start', () => {
    const h = harness();
    h.app._paceWheelToCli(500, 300, -0.05);
    h.drain();
    expect(h.sent).toEqual([]);
  });

  it('a new gesture after a pause starts fresh: no stale carry, immediate report', () => {
    const h = harness({ mode: 'codex' });
    h.app._paceWheelToCli(500, 300, -1); // gesture A: pre-pays one report for 1/3
    h.drain();
    expect(h.count(UP)).toBe(1);
    h.advance(500);
    h.app._paceWheelToCli(500, 300, 1); // gesture B, downward
    expect(h.count(DOWN)).toBe(1);
  });

  it('eases a fast flick: several reports per frame, capped, and bounded to about a screen', () => {
    const h = harness();
    for (let i = 0; i < 20; i++) h.app._paceWheelToCli(500, 300, -12); // 240 lines requested
    const perFrame: number[] = [];
    while (h.frames.length) {
      const before = h.count(UP);
      h.runFrame();
      perFrame.push(h.count(UP) - before);
    }
    expect(Math.max(...perFrame)).toBe(4);
    expect(perFrame.at(-1)).toBe(1);
    // Backlog capped at one screen (40 rows / 1 row per report) plus the reports
    // already on the wire, never the full 240.
    expect(h.count(UP)).toBeLessThanOrEqual(44);
  });

  it('a direction reversal cancels pending travel instead of finishing it', () => {
    const h = harness();
    h.app._paceWheelToCli(500, 300, -8); // first eased batch (2) sent now, 6 pending
    expect(h.count(UP)).toBe(2);
    h.advance(16);
    h.app._paceWheelToCli(500, 300, 8); // cancels the 6 pending, nets +2
    h.drain();
    // Only the batch already on the wire went up; the gesture nets to zero.
    expect(h.count(UP)).toBe(2);
    expect(h.count(DOWN)).toBe(2);
  });

  it('never carries travel onto the tab the user switched to', () => {
    const h = harness();
    h.app._paceWheelToCli(500, 300, -8);
    const onWire = h.count(UP);
    h.app.activeSessionId = 'sess-2';
    h.drain();
    expect(h.sent.every((s) => s.id === 'sess-1')).toBe(true);
    expect(h.count(UP)).toBe(onWire); // the pending remainder was dropped, not sent anywhere
  });

  it('addresses reports at the pointer cell, falling back to mid-screen', () => {
    const h = harness();
    h.app._clientPointToCell = () => null;
    h.app._paceWheelToCli(Number.NaN, Number.NaN, -1);
    expect(h.sent[0].data).toBe('\x1b[<64;40;20M');
  });
});

describe('COD-464 reversal debounce (Claude ignores the report that reverses its direction)', () => {
  const claude = { claude: { mode: 'version-gated', minVersion: '2.1.187', rows: 1, reversalDeadReports: 1 } };

  it('primes the first up-gesture: the dead report rides on top of the first batch', () => {
    const h = harness({ rows: claude });
    h.app._paceWheelToCli(500, 300, -1);
    expect(h.count(UP)).toBe(2); // 1 for the user's line + 1 the CLI swallows
  });

  it('does not pay again while the direction holds, across gestures', () => {
    const h = harness({ rows: claude });
    h.app._paceWheelToCli(500, 300, -1);
    h.advance(500);
    h.app._paceWheelToCli(500, 300, -1);
    h.drain();
    expect(h.count(UP)).toBe(3);
  });

  it('pays once per reversal, in each direction', () => {
    const h = harness({ rows: claude });
    h.app._paceWheelToCli(500, 300, -1); // up: 1 + 1 dead
    h.advance(500);
    h.app._paceWheelToCli(500, 300, 1); // down: 1 + 1 dead
    h.advance(500);
    h.app._paceWheelToCli(500, 300, 1); // down again: 1
    h.drain();
    expect(h.count(UP)).toBe(2);
    expect(h.count(DOWN)).toBe(3);
  });

  it('remembers the CLI direction per session across a tab switch', () => {
    const h = harness({ rows: claude });
    h.app._paceWheelToCli(500, 300, -1); // sess-1 now "up"
    h.app.activeSessionId = 'sess-2';
    h.app._paceWheelToCli(500, 300, -1); // sess-2 first up: primed
    h.app.activeSessionId = 'sess-1';
    h.advance(500);
    h.app._paceWheelToCli(500, 300, -1); // sess-1 still up: no prime
    h.drain();
    expect(h.sent.filter((s) => s.id === 'sess-1').reduce((n, s) => n + s.data.split(UP).length - 1, 0)).toBe(3);
    expect(h.sent.filter((s) => s.id === 'sess-2').reduce((n, s) => n + s.data.split(UP).length - 1, 0)).toBe(2);
  });

  it('a CLI without the debounce (Codex) never gets an extra report', () => {
    const h = harness({ mode: 'codex', rows: { codex: { mode: 'mouse-tracking', rows: 3, reversalDeadReports: 0 } } });
    h.app._paceWheelToCli(500, 300, -3);
    h.advance(500);
    h.app._paceWheelToCli(500, 300, 3);
    h.drain();
    expect(h.count(UP)).toBe(1);
    expect(h.count(DOWN)).toBe(1);
  });
});
