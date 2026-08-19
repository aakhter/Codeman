# Codex Input-Needed Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Codex sessions from emitting input-needed alerts until their rendered pane positively shows an input-ready state.

**Architecture:** Add a pure rendered-frame classifier next to the existing Codex working detectors. Use it at the external-CLI quiet-timer boundary so Codex emits `idle` only for a visible composer or recognized choice dialog; working and unknown frames remain busy and are rechecked. Keep every non-Codex path unchanged.

**Tech Stack:** TypeScript ESM, Node.js timers, tmux pane captures, Vitest fake timers.

---

### Task 1: Reproduce and classify Codex rendered states

**Files:**
- Modify: `src/session.ts`
- Test: `test/codex-working-detection.test.ts`

- [ ] **Step 1: Add failing pure-classifier tests**

Import `classifyCodexRenderedState` and assert these exact cases:

```ts
expect(classifyCodexRenderedState('• Working (31)\n› retained prompt')).toBe('working');
expect(classifyCodexRenderedState('› Type your next prompt')).toBe('input-ready');
expect(classifyCodexRenderedState('Allow this command?\n› 1. Yes\n  2. No')).toBe('input-ready');
expect(classifyCodexRenderedState('tool output with no current Codex UI')).toBe('unknown');
expect(classifyCodexRenderedState(null)).toBe('unknown');
```

- [ ] **Step 2: Run the focused tests and observe RED**

Run: `npm test -- test/codex-working-detection.test.ts`

Expected: FAIL because `classifyCodexRenderedState` is not exported.

- [ ] **Step 3: Add the minimal pure classifier**

In `src/session.ts`, normalize absolute tmux row starts and ANSI, then classify with working precedence:

```ts
export type CodexRenderedState = 'working' | 'input-ready' | 'unknown';

export function classifyCodexRenderedState(frame: string | null | undefined): CodexRenderedState {
  if (!frame) return 'unknown';
  const plain = frame.replace(TMUX_ABSOLUTE_ROW_START_PATTERN, '\n').replace(ANSI_ESCAPE_PATTERN_FULL, '');
  if (detectCodexCheckpointWorkingFrame(plain)) return 'working';
  if (/^\s*›(?:\s|$)/m.test(plain)) return 'input-ready';
  if (/^\s*[›❯]\s*1[.)]\s+.+\n(?:[^\n]*\n){0,3}\s*2[.)]\s+/m.test(plain)) return 'input-ready';
  return 'unknown';
}
```

- [ ] **Step 4: Run the focused tests and observe GREEN**

Run: `npm test -- test/codex-working-detection.test.ts`

Expected: all tests in the file pass.

### Task 2: Gate the Codex idle transition on positive rendered evidence

**Files:**
- Modify: `src/session.ts`
- Test: `test/codex-working-detection.test.ts`

- [ ] **Step 1: Add failing timer-boundary regression tests**

Extend the existing `COD-181 remote working-frame poller` fixture with assertions that:

```ts
// A broader current Codex working layout must survive quiet-timer expiry.
frame = '• Working (2s • esc to interrupt)';
vi.advanceTimersByTime(2_100);
frame = '• Working (31)\n› retained prompt';
vi.advanceTimersByTime(12_000);
expect(session.isWorking).toBe(true);
expect(idleEvents).toEqual([]);

// An unknown frame is inconclusive and must not emit idle.
frame = 'tool output with no current Codex UI';
vi.advanceTimersByTime(12_000);
expect(session.isWorking).toBe(true);
expect(idleEvents).toEqual([]);

// A recognized input prompt completes the turn exactly once.
frame = '› Type your next prompt';
vi.advanceTimersByTime(7_000);
expect(session.isWorking).toBe(false);
expect(idleEvents).toEqual([{ reason: 'turn-end' }]);
```

Add the equivalent recognized numbered-choice assertion. Preserve the existing non-Codex quiet-window test.
Update the older stream-only turn-end test to install a recognized Codex composer before advancing through the quiet window;
an absent pane is now intentionally `unknown` rather than proof of idle.

- [ ] **Step 2: Run the focused tests and observe RED**

Run: `npm test -- test/codex-working-detection.test.ts`

Expected: the working/unknown cases fail because the current timer emits idle after silence.

- [ ] **Step 3: Gate `_armExternalCliIdleTimer()` for Codex**

At timer expiry, capture the active rendered pane and classify it before changing state:

```ts
if (this.mode === 'codex' && wasWorking) {
  const muxName = this._muxSession?.muxName;
  const frame = muxName ? (this._mux?.captureActivePaneBuffer?.(muxName) ?? null) : null;
  const renderedState = classifyCodexRenderedState(frame);
  if (renderedState !== 'input-ready') {
    this._armExternalCliIdleTimer();
    return;
  }
}
```

Leave startup `initial-ready` handling and other external CLI modes unchanged.

- [ ] **Step 4: Run focused verification**

Run: `npm test -- test/codex-working-detection.test.ts`

Expected: all tests pass, including working, composer, dialog, unknown, initial-ready, and non-Codex cases.

- [ ] **Step 5: Run repository quality gates**

Run:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run build
```

Expected: every command exits 0.

- [ ] **Step 6: Commit the implementation**

```bash
git add -- src/session.ts test/codex-working-detection.test.ts docs/superpowers/plans/2026-08-19-codex-input-needed-detection.md
git commit -m "fix(codex): COD-337 require input-ready pane evidence"
```
