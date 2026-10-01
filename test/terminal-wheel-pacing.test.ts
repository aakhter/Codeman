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
  const sent: Array<{ id: string; data: string; at: number }> = [];
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
  app._sendInputEphemeral = (id: string, data: string) => sent.push({ id, data, at: now });
  app._clientPointToCell = () => ({ col: 40, row: 10 });
  app._terminalViewportAtBottom = () => true;
  app.terminal = {
    cols: 80,
    rows: 40,
    modes: { mouseTrackingMode: 'none' },
    buffer: { active: { type: 'normal', viewportY: 0, baseY: 0 } },
    scrollToBottom: vi.fn(),
    _core: { _renderService: { dimensions: { css: { cell: { height: 21 } } } } },
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
      streak: null,
    });
  });

  it("#498: claude's inline renderer (right version, no mouse tracking) is never paced", () => {
    const h = harness({ cliMouseTracking: false });
    expect(h.app._wheelReportsFor('sess-1')).toBeNull();
    expect(h.app._shouldPaceWheelToCli(h.wheel(-100))).toBe(false);
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

describe('COD-464 pacing: rows owed, immediate start, no trailing glide', () => {
  const perFrame = (h: ReturnType<typeof harness>, needle: string) => {
    const out: number[] = [];
    while (h.frames.length) {
      const before = h.count(needle);
      h.runFrame();
      out.push(h.count(needle) - before);
    }
    return out;
  };

  it('sends the first batch of a gesture synchronously, before any animation frame', () => {
    const h = harness();
    h.app._paceWheelToCli(500, 300, -4.8); // one Chrome notch: 100px / 21px rows
    expect(h.count(UP)).toBeGreaterThanOrEqual(1);
    expect(h.sent[0].data.startsWith('\x1b[<64;40;10M')).toBe(true);
  });

  it('a mouse notch lands as a short halving glide and nets the rounded distance', () => {
    const h = harness();
    h.app._paceWheelToCli(500, 300, -4.8);
    const sync = h.count(UP);
    const frames = perFrame(h, UP);
    expect(sync).toBe(2); // half of 4.8, rounded down to whole reports
    expect(frames).toEqual([1, 1, 1]);
    expect(h.count(UP)).toBe(5); // 4.8 rows → 5, never the old 4 (0.84x)
  });

  it('a coarse-step CLI rounds to the nearest step and keeps the rest as credit', () => {
    const h = harness({ mode: 'codex' }); // 3 rows per report
    for (let i = 0; i < 5; i++) {
      h.app._paceWheelToCli(500, 300, -4.8); // 5 notches, 120 ms apart = 24 rows
      h.drain();
      h.advance(120);
    }
    expect(Math.abs(h.count(UP) * 3 - 24)).toBeLessThanOrEqual(1.5);
    expect(h.count(DOWN)).toBe(0);
  });

  it('overshoot from a coarse step is credit, never a report the other way', () => {
    const h = harness({ mode: 'codex' });
    h.app._paceWheelToCli(500, 300, -2); // gesture start: one 3-row report for 2 rows
    h.drain();
    h.advance(16);
    h.app._paceWheelToCli(500, 300, -1); // still 0 owed after the 1-row credit: nothing
    h.drain();
    expect(h.count(UP)).toBe(1);
    expect(h.count(DOWN)).toBe(0);
  });

  it('moves on the FIRST event of a slow trackpad gesture and tracks it 1:1', () => {
    const h = harness();
    // 60 events of 4.2px (0.2 rows at 21px) 16 ms apart = 12 rows.
    h.app._paceWheelToCli(500, 300, -0.2);
    expect(h.count(UP)).toBe(1);
    for (let i = 1; i < 60; i++) {
      h.advance(16);
      h.app._paceWheelToCli(500, 300, -0.2);
      h.drain();
    }
    expect(h.count(UP)).toBe(12); // the pre-paid first report is owed back, not added
  });

  it('ignores sub-row jitter at gesture start', () => {
    const h = harness();
    h.app._paceWheelToCli(500, 300, -0.05);
    h.drain();
    expect(h.sent).toEqual([]);
  });

  it('a new gesture after a pause starts fresh: no stale carry, immediate report', () => {
    const h = harness({ mode: 'codex' });
    h.app._paceWheelToCli(500, 300, -1);
    h.drain();
    expect(h.count(UP)).toBe(1);
    h.advance(500);
    h.app._paceWheelToCli(500, 300, 1);
    expect(h.count(DOWN)).toBe(1);
  });

  it('caps the backlog at one screen and sends at most 6 reports a frame', () => {
    const h = harness();
    for (let i = 0; i < 20; i++) h.app._paceWheelToCli(500, 300, -12); // 240 rows asked
    const frames = perFrame(h, UP);
    expect(Math.max(...frames)).toBeLessThanOrEqual(6);
    // One screen of backlog (terminal is 40 rows) on top of the first batch already
    // on the wire (6), never the 240 asked for.
    expect(h.count(UP)).toBeLessThanOrEqual(46);
  });

  it('a direction reversal cancels pending travel instead of finishing it', () => {
    const h = harness();
    h.app._paceWheelToCli(500, 300, -8); // first batch (half) sent now
    const up = h.count(UP);
    h.advance(16);
    h.app._paceWheelToCli(500, 300, 8);
    h.drain();
    expect(h.count(UP)).toBe(up); // the pending rest of the up-travel never went out
    expect(h.count(DOWN)).toBe(up); // and the gesture nets to zero
  });

  it('never carries travel onto the tab the user switched to', () => {
    const h = harness();
    h.app._paceWheelToCli(500, 300, -8);
    const onWire = h.count(UP);
    h.app.activeSessionId = 'sess-2';
    h.drain();
    expect(h.sent.every((s) => s.id === 'sess-1')).toBe(true);
    expect(h.count(UP)).toBe(onWire);
  });

  it('addresses reports at the pointer cell, falling back to mid-screen', () => {
    const h = harness();
    h.app._clientPointToCell = () => null;
    h.app._paceWheelToCli(Number.NaN, Number.NaN, -1);
    expect(h.sent[0].data).toBe('\x1b[<64;40;20M');
  });
});

describe('COD-464 streak linearizer (Claude accelerates inside a streak of reports)', () => {
  // Measured on Claude 2.1.286: the k-th report of a streak moves STEPS[k] rows
  // (last repeats); a pause of 40 ms resets the streak, 30 ms does not.
  const STEPS = [1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5, 6];
  const claudeStreak = {
    claude: { mode: 'version-gated', minVersion: '2.1.187', rows: 1, streak: { resetMs: 35, steps: STEPS } },
  };
  /** Replay what was sent through a simulated Claude: rows it would really move. */
  const claudeRows = (sent: Array<{ data: string; at: number }>, resetAfterMs: number) => {
    let k = 0;
    let last = -Infinity;
    let rows = 0;
    for (const s of sent) {
      if (s.at - last >= resetAfterMs) k = 0;
      last = s.at;
      const n = s.data.split(UP).length - 1;
      for (let i = 0; i < n; i++) rows += STEPS[Math.min(k++, STEPS.length - 1)];
    }
    return rows;
  };

  it('sustained fast scrolling stays linear instead of running away', () => {
    const h = harness({ rows: claudeStreak });
    for (let i = 0; i < 60; i++) {
      h.app._paceWheelToCli(500, 300, -1.5); // 90 rows over ~1 s at 60 fps
      h.drain();
      h.advance(16);
    }
    h.advance(200);
    h.drain();
    // Without the model every frame's report continues the streak: ~300 rows.
    for (const reset of [35, 40, 60])
      expect(Math.abs(claudeRows(h.sent, reset) - 90), String(reset)).toBeLessThanOrEqual(6);
  });

  it('slow scrolling lets the streak lapse, so every report is a single row', () => {
    const h = harness({ rows: claudeStreak });
    for (let i = 0; i < 10; i++) {
      h.app._paceWheelToCli(500, 300, -1);
      h.drain();
      h.advance(100);
    }
    expect(h.count(UP)).toBe(10);
    expect(claudeRows(h.sent, 35)).toBe(10);
  });

  it('never sends inside the ambiguous gap band: waits for a sure reset instead', () => {
    const h = harness({ rows: claudeStreak });
    for (let i = 0; i < 6; i++) {
      // build a streak (k=6, next step 2)
      h.app._paceWheelToCli(500, 300, -1);
      h.drain();
      h.advance(16);
    }
    const before = h.sent.length;
    h.advance(20); // 36 ms since the last report: ambiguous
    h.app._paceWheelToCli(500, 300, -1); // 1 row owed < next step 2
    h.runFrame();
    expect(h.sent.length).toBe(before);
    h.advance(60); // past resetMs + reset margin
    h.drain();
    expect(h.sent.length).toBe(before + 1);
    const lastGap = h.sent.at(-1)!.at - h.sent.at(-2)!.at;
    expect(lastGap).toBeGreaterThanOrEqual(35 + 35);
  });
});

describe('COD-464 1:1 distance and touch hold', () => {
  const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');

  it('converts wheel pixels to rows at the real row height, not 25px per line', () => {
    const h = harness();
    expect(h.app._wheelRowsFloat({ deltaY: -105, deltaMode: 0 })).toBeCloseTo(-5, 5); // 21px rows
    expect(h.app._wheelRowsFloat({ deltaY: 3, deltaMode: 1 })).toBe(3);
    expect(h.app._wheelRowsFloat({ deltaY: 1, deltaMode: 2 })).toBe(40);
    h.app.terminal._core = undefined;
    expect(h.app._wheelRowsFloat({ deltaY: -50, deltaMode: 0 })).toBe(-2); // fallback 25px
  });

  it('the wheel listener feeds rows (1:1), not lines, to the pacer', () => {
    expect(src).toContain('this._paceWheelToCli(ev.clientX, ev.clientY, this._wheelRowsFloat(ev));');
  });

  it('lifting after holding still does not fling on the paced route', () => {
    const touchend = src.slice(src.indexOf("'touchend',"));
    const hold = touchend.indexOf(
      'performance.now() - lastMoveAt > window.CodemanTerminalInput.TOUCH_HOLD_NO_FLING_MS'
    );
    expect(hold).toBeGreaterThan(-1);
    expect(hold).toBeLessThan(touchend.indexOf('scrollFrame = requestAnimationFrame(scrollLoop);'));
    expect(src).toContain('velocity = delta * 1.2;\n            lastMoveAt = performance.now();');
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

describe('COD-464 touch: phone swipes take the same paced route', () => {
  // Measured on iPhone 15 Pro emulation with real CLIs: a swipe on a Claude/Codex
  // mirror tab opened the frozen history view, which holds ONE screen for these
  // CLIs, so nothing older than MARK-122 of 150 was reachable with any number of
  // drags. Through the paced route both reach MARK-1.
  const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');

  it('touchmove consults the paced route after the tap threshold and before opencode/mirror routing', () => {
    const threshold = src.indexOf('if (Math.abs(pixelAccum) < getThreshold()) return;');
    expect(threshold).toBeGreaterThan(-1);
    const after = src.slice(threshold);
    const paced = after.indexOf('if (this._shouldPaceWheelToCli({ shiftKey: false })) {');
    expect(paced).toBeGreaterThan(-1);
    expect(paced).toBeLessThan(after.indexOf('if (getIsOpencodeMobile()) {'));
    expect(paced).toBeLessThan(after.indexOf('intent = this._handleUserScrollIntent(lines);'));
    // The finger's own travel, NOT pixelAccum (which this path increments twice per move).
    expect(after.slice(paced, paced + 300)).toContain(
      'this._paceWheelToCli(touchLastX, touchLastY, delta / cellHeight());'
    );
  });

  it('flick momentum feeds the paced route before the mirror/forward/page branches', () => {
    const momentum = src.indexOf('// Momentum phase — convert pixel velocity to lines');
    const block = src.slice(momentum - 600, momentum + 900);
    const paced = block.indexOf('this._paceWheelToCli(touchLastX, touchLastY, velocity / cellHeight());');
    expect(paced).toBeGreaterThan(-1);
    expect(paced).toBeLessThan(block.indexOf('const intent = this._handleUserScrollIntent(lines);'));
  });

  it('per-move fractional touch travel adds up to whole reports (finger tracking)', () => {
    const h = harness({ mode: 'codex' }); // 3 rows per report
    // 20 moves of 6px on a 17px row: 120px ≈ 7.06 lines ≈ 2.35 reports.
    for (let i = 0; i < 20; i++) {
      h.advance(16);
      h.app._paceWheelToCli(200, 300, -6 / 17);
      h.drain();
    }
    expect(h.count(UP)).toBe(2);
  });
});
