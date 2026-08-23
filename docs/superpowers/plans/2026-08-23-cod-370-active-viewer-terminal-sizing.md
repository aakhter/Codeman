# COD-370 Active-Viewer Terminal Sizing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the actively used browser control one shared OpenCode terminal's geometry so an idle connected desktop cannot leave an iPhone rendering a short, oversized prompt/status layout.

**Architecture:** Replace the 90-second desktop claim with a connection-scoped, explicit active-viewer owner. Browser foreground/focus/touch events send one activation frame with fitted dimensions; input implicitly activates as a fallback, passive resize frames only update remembered dimensions, and the current owner alone may resize. OpenCode mobile uses an independent 8px font preference before fitting, while a latest-wins tmux queue ensures rapid handoffs finish at the newest geometry.

**Tech Stack:** TypeScript ESM, Fastify WebSockets, Node PTY/tmux, plain browser JavaScript, xterm.js FitAddon, Vitest, Playwright/Chromium.

---

## File map

- Create `src/terminal-sizing-ownership.ts`: pure connection-token ownership and remembered-dimension state.
- Create `test/terminal-sizing-ownership.test.ts`: deterministic ownership/generation/release contracts.
- Modify `src/session.ts`: expose viewer activation, remembered resize, owner-only resize, and input fallback APIs.
- Modify `test/session-resize-arbitration.test.ts`: replace timeout claims with active-viewer handoff coverage.
- Modify `src/tmux-manager.ts`: serialize fire-and-forget resize commands and retain only the latest pending dimensions.
- Modify `test/tmux-manager.test.ts`: prove a superseded pending resize cannot finish last.
- Modify `src/web/routes/ws-routes.ts`: add `va` activation frames, remember passive `z` frames, activate on input, and release on close.
- Modify `test/routes/ws-routes.test.ts`: route-level ownership, background, reconnect, and exact-input assertions.
- Create `src/web/public/terminal-viewer-activity.js`: focused browser activity detection and activation-frame construction.
- Create `test/terminal-viewer-activity.test.ts`: browser-independent listener/rate-limit/visibility contracts.
- Modify `src/web/public/index.html`: load the viewer activity module before application startup.
- Modify `src/web/public/app.js`: install/cleanup the controller and activate after the intended session WebSocket opens.
- Modify `src/web/public/terminal-ui.js`: mode/device-aware font persistence, 8px OpenCode mobile default, and activation dimension helpers.
- Modify `src/web/public/mobile-handlers.js`: stop restoring OpenCode mobile to 10px and reuse the mode-aware font policy.
- Create `test/opencode-mobile-font.test.ts`: mobile/desktop/mode/font-key contracts.
- Replace `test/mobile/opencode-e2e.test.ts`: real disposable OpenCode two-viewer geometry and performance coverage.
- Add `.changeset/cod-370-active-viewer-terminal-sizing.md`: user-visible fix note.

### Task 1: Pure sizing ownership and Session integration

**Files:**

- Create: `src/terminal-sizing-ownership.ts`
- Create: `test/terminal-sizing-ownership.test.ts`
- Modify: `src/session.ts:4185-4295`
- Modify: `test/session-resize-arbitration.test.ts`
- Modify: `test/session-resized-event.test.ts`

- [x] **Step 1: Write the failing pure ownership tests**

Create tests that define the token, dimension, and generation contract:

```ts
import { describe, expect, it } from 'vitest';
import { TerminalSizingOwnership } from '../src/terminal-sizing-ownership.js';

const desktop = Symbol('desktop');
const mobile = Symbol('mobile');
const desktopDims = { cols: 140, rows: 44, viewportType: 'desktop' as const };
const mobileDims = { cols: 75, rows: 62, viewportType: 'mobile' as const };

it('lets the latest explicit activation own sizing while retaining every viewer dimensions', () => {
  const ownership = new TerminalSizingOwnership();
  ownership.remember(desktop, desktopDims);
  ownership.activate(desktop);
  ownership.remember(mobile, mobileDims);
  const handoff = ownership.activate(mobile);

  expect(handoff).toMatchObject({ generation: 2, dimensions: mobileDims });
  expect(ownership.isOwner(mobile)).toBe(true);
  expect(ownership.dimensionsFor(desktop)).toEqual(desktopDims);
});

it('only clears ownership when the current connection token is released', () => {
  const ownership = new TerminalSizingOwnership();
  ownership.activate(desktop, desktopDims);
  ownership.activate(mobile, mobileDims);
  ownership.release(desktop);
  expect(ownership.isOwner(mobile)).toBe(true);
  ownership.release(mobile);
  expect(ownership.ownerToken).toBeNull();
});
```

- [x] **Step 2: Run the pure test to verify RED**

Run:

```bash
npm test -- test/terminal-sizing-ownership.test.ts
```

Expected: FAIL because `src/terminal-sizing-ownership.ts` does not exist.

- [x] **Step 3: Implement the pure coordinator**

Create the focused module:

```ts
export type TerminalViewportType = 'mobile' | 'tablet' | 'desktop';

export interface TerminalViewerDimensions {
  cols: number;
  rows: number;
  viewportType: TerminalViewportType;
}

export interface TerminalSizingActivation {
  generation: number;
  changedOwner: boolean;
  dimensions: TerminalViewerDimensions | null;
}

export class TerminalSizingOwnership {
  private owner: symbol | null = null;
  private generation = 0;
  private readonly dimensions = new Map<symbol, TerminalViewerDimensions>();

  get ownerToken(): symbol | null {
    return this.owner;
  }

  remember(token: symbol, dimensions: TerminalViewerDimensions): void {
    this.dimensions.set(token, dimensions);
  }

  dimensionsFor(token: symbol): TerminalViewerDimensions | null {
    return this.dimensions.get(token) ?? null;
  }

  activate(token: symbol, dimensions?: TerminalViewerDimensions): TerminalSizingActivation {
    if (dimensions) this.remember(token, dimensions);
    const changedOwner = this.owner !== token;
    if (changedOwner) {
      this.owner = token;
      this.generation += 1;
    }
    return {
      generation: this.generation,
      changedOwner,
      dimensions: this.dimensionsFor(token),
    };
  }

  isOwner(token: symbol): boolean {
    return this.owner === token;
  }

  release(token: symbol): void {
    this.dimensions.delete(token);
    if (this.owner === token) {
      this.owner = null;
      this.generation += 1;
    }
  }
}
```

- [x] **Step 4: Add failing Session handoff tests**

Replace timeout-based desktop claims with explicit connection behavior:

```ts
it('immediately hands an idle connected desktop pane to an explicitly active phone', () => {
  const session = new Session({ workingDir: '/tmp', mode: 'opencode' });
  const resize = attachFakePty(session, 140, 44);
  const desktop = Symbol('desktop');
  const phone = Symbol('phone');

  session.rememberTerminalViewerSize(desktop, 140, 44, 'desktop');
  session.activateTerminalViewer(desktop);
  session.rememberTerminalViewerSize(phone, 75, 62, 'mobile');
  session.activateTerminalViewer(phone);

  expect(resize).toHaveBeenLastCalledWith(75, 62);
});

it('ignores passive resize frames and restores desktop dimensions on desktop input', () => {
  const session = new Session({ workingDir: '/tmp', mode: 'opencode' });
  const resize = attachFakePty(session, 140, 44);
  const desktop = Symbol('desktop');
  const phone = Symbol('phone');
  session.rememberTerminalViewerSize(desktop, 140, 44, 'desktop');
  session.activateTerminalViewer(phone, { cols: 75, rows: 62, viewportType: 'mobile' });

  expect(session.resizeFromTerminalViewer(desktop, 160, 48, 'desktop')).toBe(false);
  session.activateTerminalViewer(desktop);
  expect(resize).toHaveBeenLastCalledWith(160, 48);
});
```

- [x] **Step 5: Implement the Session viewer API and delete the 90-second claim state**

Compose `TerminalSizingOwnership` in `Session` and add these public methods:

```ts
rememberTerminalViewerSize(
  token: symbol,
  cols: number,
  rows: number,
  viewportType: TerminalViewportType
): void {
  this._terminalSizing.remember(token, { cols, rows, viewportType });
}

activateTerminalViewer(token: symbol, dimensions?: TerminalViewerDimensions): number {
  const activation = this._terminalSizing.activate(token, dimensions);
  if (activation.dimensions) {
    const { cols, rows, viewportType } = activation.dimensions;
    this.resize(cols, rows, { viewportType });
  }
  return activation.generation;
}

resizeFromTerminalViewer(
  token: symbol,
  cols: number,
  rows: number,
  viewportType: TerminalViewportType,
  force = false
): boolean {
  this.rememberTerminalViewerSize(token, cols, rows, viewportType);
  if (!this._terminalSizing.isOwner(token)) return false;
  this.resize(cols, rows, { viewportType, force });
  return true;
}

releaseTerminalViewer(token: symbol): void {
  this._terminalSizing.release(token);
}
```

Remove `_desktopSizeClaims`, `DESKTOP_CLAIM_IDLE_MS`, `_lastDesktopActivityAt`, `_lastDesktopDims`, `_mobileSizeOverride`, `claimDesktopSizing`, `releaseDesktopSizing`, and `noteDesktopActivity`. Keep `resize()` as the low-level trusted/recovery operation and keep its existing no-op and `resized` event behavior.

- [x] **Step 6: Run the focused server tests GREEN**

Run:

```bash
npm test -- test/terminal-sizing-ownership.test.ts test/session-resize-arbitration.test.ts test/session-resized-event.test.ts
```

Expected: all focused tests pass; no timers are required for ownership.

- [x] **Step 7: Commit Task 1**

```bash
git add src/terminal-sizing-ownership.ts src/session.ts test/terminal-sizing-ownership.test.ts test/session-resize-arbitration.test.ts test/session-resized-event.test.ts
git commit -m "feat(terminal): COD-370 track active sizing viewer"
```

### Task 2: Make tmux resize completion latest-wins

**Files:**

- Modify: `src/tmux-manager.ts:4297-4323`
- Modify: `test/tmux-manager.test.ts:294-310`

- [x] **Step 1: Write the failing coalescing test**

Capture `exec` callbacks and prove only the newest queued resize runs after the active command:

```ts
it('coalesces pending window resizes and finishes on the latest dimensions', () => {
  const callbacks: Array<(error: Error | null) => void> = [];
  mockedExec.mockImplementation((_cmd, _options, callback) => {
    callbacks.push(callback as (error: Error | null) => void);
    return {} as never;
  });

  manager.resizeWindow('codeman-abc12345', 140, 42);
  manager.resizeWindow('codeman-abc12345', 75, 62);
  manager.resizeWindow('codeman-abc12345', 160, 48);
  expect(mockedExec).toHaveBeenCalledTimes(1);

  callbacks.shift()!(null);
  expect(mockedExec).toHaveBeenCalledTimes(2);
  expect(mockedExec.mock.calls[1][0]).toContain('-x 160 -y 48');
});
```

- [x] **Step 2: Run the tmux test RED**

Run:

```bash
npm test -- test/tmux-manager.test.ts -t "coalesces pending window resizes"
```

Expected: FAIL because three commands start immediately.

- [x] **Step 3: Implement a per-window non-blocking drain**

Add a map keyed by mux name:

```ts
private readonly pendingWindowResizes = new Map<
  string,
  { running: boolean; pending: { cols: number; rows: number } | null }
>();

resizeWindow(muxName: string, cols: number, rows: number): boolean {
  // Keep existing validation first.
  const state = this.pendingWindowResizes.get(muxName) ?? { running: false, pending: null };
  state.pending = { cols, rows };
  this.pendingWindowResizes.set(muxName, state);
  if (!state.running) this.drainWindowResize(muxName, state);
  return true;
}

private drainWindowResize(
  muxName: string,
  state: { running: boolean; pending: { cols: number; rows: number } | null }
): void {
  const next = state.pending;
  if (!next) {
    this.pendingWindowResizes.delete(muxName);
    return;
  }
  state.pending = null;
  state.running = true;
  exec(
    `${this.tmux()} resize-window -t ${shellescape(muxName)} -x ${next.cols} -y ${next.rows}`,
    { timeout: EXEC_TIMEOUT_MS },
    (error) => {
      state.running = false;
      if (error) console.error('[TmuxManager] Failed to resize tmux window:', error);
      this.drainWindowResize(muxName, state);
    }
  );
}
```

- [x] **Step 4: Run tmux tests GREEN**

Run:

```bash
npm test -- test/tmux-manager.test.ts
```

Expected: the existing non-blocking contract and new latest-wins test pass.

- [x] **Step 5: Commit Task 2**

```bash
git add src/tmux-manager.ts test/tmux-manager.test.ts
git commit -m "fix(tmux): COD-370 coalesce terminal resizes"
```

### Task 3: Wire viewer activation through the terminal WebSocket

**Files:**

- Modify: `src/web/routes/ws-routes.ts:150-235,306-316`
- Modify: `test/routes/ws-routes.test.ts:380-455`

- [x] **Step 1: Add failing WebSocket route tests**

Cover explicit activation, passive resize, input fallback, and close identity:

```ts
it('hands sizing to a phone activation while the desktop socket stays connected', async () => {
  const desktop = await connectWs('/ws/sessions/ws-test-session/terminal?cid=desktop');
  const phone = await connectWs('/ws/sessions/ws-test-session/terminal?cid=phone');
  try {
    desktop.send(JSON.stringify({ t: 'va', c: 140, r: 44, v: 'desktop' }));
    phone.send(JSON.stringify({ t: 'z', c: 75, r: 62, v: 'mobile' }));
    phone.send(JSON.stringify({ t: 'va', c: 75, r: 62, v: 'mobile' }));
    desktop.send(JSON.stringify({ t: 'z', c: 160, r: 48, v: 'desktop' }));

    await vi.waitFor(() => {
      expect(ctx._session.activateTerminalViewer).toHaveBeenCalledTimes(2);
      expect(ctx._session.resizeFromTerminalViewer).toHaveLastReturnedWith(false);
    });
  } finally {
    desktop.close();
    phone.close();
  }
});

it('activates remembered desktop dimensions before forwarding desktop input', async () => {
  const ws = await connectWs('/ws/sessions/ws-test-session/terminal?cid=desktop');
  ws.send(JSON.stringify({ t: 'z', c: 160, r: 48, v: 'desktop' }));
  ws.send(JSON.stringify({ t: 'i', d: 'x', cid: 'client', seq: 1 }));
  await vi.waitFor(() => {
    expect(ctx._session.activateTerminalViewer).toHaveBeenCalledBefore(ctx._session.write);
    expect(ctx._session.write).toHaveBeenCalledWith('x');
  });
  ws.close();
});
```

- [x] **Step 2: Run the route tests RED**

Run:

```bash
npm test -- test/routes/ws-routes.test.ts -t "sizing|activation|desktop input"
```

Expected: FAIL because `va` is ignored and route mocks lack the new Session API.

- [x] **Step 3: Implement the route protocol**

Use one `Symbol('ws-terminal-viewer')` per socket. For validated `z` frames, call `resizeFromTerminalViewer()` so every viewer's dimensions are remembered but only the owner applies them. For validated `va` frames, call `activateTerminalViewer()` with the frame dimensions. Immediately before applying an input frame, call `activateTerminalViewer(sizingToken)`; this restores remembered dimensions but does not create another control message.

The dispatch shape is:

```ts
const sizingToken = Symbol('ws-terminal-viewer');

if (msg.t === 'i' && typeof msg.d === 'string') {
  session.activateTerminalViewer(sizingToken);
  // Preserve the existing reliable input/deduplication body unchanged.
} else if (isValidViewerDimensions(msg) && msg.t === 'va') {
  session.activateTerminalViewer(sizingToken, {
    cols: msg.c,
    rows: msg.r,
    viewportType: msg.v,
  });
} else if (isValidViewerDimensions(msg) && msg.t === 'z') {
  session.resizeFromTerminalViewer(sizingToken, msg.c, msg.r, msg.v, msg.f === true);
}
```

On close, call `releaseTerminalViewer(sizingToken)`. Delete the desktop-only claim variables and calls. Keep malformed-frame handling and exact input ACK behavior unchanged.

- [x] **Step 4: Run route and input regression tests GREEN**

Run:

```bash
npm test -- test/routes/ws-routes.test.ts test/reliable-input-dedup.test.ts test/terminal-input-classifier.test.ts test/terminal-input-filter.test.ts
```

Expected: activation tests and all exact delivery/deduplication tests pass.

- [x] **Step 5: Commit Task 3**

```bash
git add src/web/routes/ws-routes.ts test/routes/ws-routes.test.ts
git commit -m "feat(web): COD-370 activate terminal sizing by viewer"
```

### Task 4: Detect explicit foreground interaction in the browser

**Files:**

- Create: `src/web/public/terminal-viewer-activity.js`
- Create: `test/terminal-viewer-activity.test.ts`
- Modify: `src/web/public/index.html:3740-3765`
- Modify: `src/web/public/app.js:4028-4075,4195-4230,8438-8465`
- Modify: `src/web/public/terminal-ui.js:6685-6755`

- [x] **Step 1: Write failing controller tests**

Build the controller around injected functions so Node tests do not require a browser:

```ts
it('activates once when a visible phone is foregrounded and ignores hidden/background resize noise', () => {
  const sent: unknown[] = [];
  const controller = createTerminalViewerActivity({
    isVisible: () => true,
    isFocused: () => true,
    activeSessionId: () => 's1',
    dimensions: () => ({ cols: 75, rows: 62, viewportType: 'mobile' }),
    send: (frame) => sent.push(frame),
    now: () => 1_000,
  });

  controller.activate('visibility');
  controller.activate('focus');
  expect(sent).toEqual([{ t: 'va', c: 75, r: 62, v: 'mobile' }]);
});

it('does not activate from install, resize, or reconnect while the document is hidden', () => {
  // isVisible=false; assert send is never called.
});
```

- [x] **Step 2: Run controller tests RED**

Run:

```bash
npm test -- test/terminal-viewer-activity.test.ts
```

Expected: FAIL because the activity module does not exist.

- [x] **Step 3: Implement the focused controller**

Expose `window.CodemanTerminalViewerActivity.create(deps)`. Install listeners for `visibilitychange`, `window.focus`, terminal `pointerdown`, `touchstart`, and `focusin`. Only send when `document.visibilityState === 'visible'`, `document.hasFocus()` is true for focus-based events, the selected session and its WebSocket match, and valid fitted dimensions exist.

Deduplicate identical activation frames for 250ms:

```js
function activate(reason) {
  if (!deps.isVisible() || !deps.activeSessionId()) return false;
  const dims = deps.dimensions();
  if (!dims) return false;
  const signature = `${deps.activeSessionId()}:${dims.viewportType}:${dims.cols}x${dims.rows}`;
  const now = deps.now();
  if (signature === lastSignature && now - lastSentAt < 250) return false;
  const sent = deps.send({ t: 'va', c: dims.cols, r: dims.rows, v: dims.viewportType });
  if (sent) {
    lastSignature = signature;
    lastSentAt = now;
    pending = false;
  } else {
    pending = true;
  }
  return sent;
}
```

`flushPending(reason)` retries `activate(reason)` only when a prior explicit event set `pending`; WebSocket open without pending activity is a no-op. Keep `reason` in local diagnostics only; never serialize it.

- [x] **Step 4: Integrate with WebSocket lifecycle**

Load the module before `app.js`. Create the controller once after terminal setup and destroy it during app cleanup. Installing the controller must not activate a viewer merely because the document is currently visible. A real `visibilitychange` to visible, `focus` transition, pointer/touch, or user-initiated session selection queues activation. On `ws.onopen`, replace unconditional `sendResize(sessionId)` with a flush of that queued explicit activation:

```js
this._terminalViewerActivity?.flushPending('ws-open');
```

When a user-initiated `selectSession()` makes the session active, apply the mode-aware font and queue activation; automatic restored-session selection does not claim ownership. Keep the existing HTTP resize during canonical buffer preparation as an explicitly foreground-gated recovery path; hidden pages must not invoke it.

The controller `send` dependency uses the current socket only:

```js
send: (frame) => {
  if (!this._wsReady || this._wsSessionId !== this.activeSessionId) return false;
  this._ws.send(JSON.stringify(frame));
  return true;
};
```

- [ ] **Step 5: Run browser-structure and frontend syntax tests GREEN**

Run:

```bash
npm test -- test/terminal-viewer-activity.test.ts test/run-mode-ui.test.ts test/codex-tab-resize.test.ts
npm run check:frontend-syntax
```

Expected: controller tests pass and all public JavaScript parses.

Gate exception confirmed against base `067cc1c`: the combined gate has 155 passed and 2 base-identical structural
assertion failures in `test/codex-tab-resize.test.ts`; Step 5 remains unchecked until that out-of-scope baseline is repaired.

- [x] **Step 6: Commit Task 4**

```bash
git add src/web/public/terminal-viewer-activity.js src/web/public/index.html src/web/public/app.js src/web/public/terminal-ui.js test/terminal-viewer-activity.test.ts
git commit -m "feat(web): COD-370 hand off sizing on viewer activity"
```

### Task 5: Apply an independent OpenCode mobile font policy

**Files:**

- Modify: `src/web/public/terminal-ui.js:748-770,6632-6685`
- Modify: `src/web/public/mobile-handlers.js:425-487`
- Create: `test/opencode-mobile-font.test.ts`

- [x] **Step 1: Write the failing font-policy tests**

Test a pure exported browser helper:

```ts
it('defaults OpenCode phone sessions to 8px without changing desktop', () => {
  expect(resolveTerminalFont({ deviceType: 'mobile', mode: 'opencode', stored: null })).toEqual({
    size: 8,
    key: 'codeman-font-size-mobile-opencode',
    min: 8,
  });
  expect(resolveTerminalFont({ deviceType: 'desktop', mode: 'opencode', stored: null }).size).toBe(14);
});

it('keeps other mobile agent modes at 10px', () => {
  expect(resolveTerminalFont({ deviceType: 'mobile', mode: 'codex', stored: null }).size).toBe(10);
});
```

- [x] **Step 2: Run the font test RED**

Run:

```bash
npm test -- test/opencode-mobile-font.test.ts
```

Expected: FAIL because mode-aware resolution does not exist and `decreaseFontSize()` clamps at 10.

- [x] **Step 3: Implement and apply the font policy before fitting**

Add `window.CodemanTerminalFont.resolveSize({ deviceType, mode, stored })` to the existing terminal-font helper surface, or a focused adjacent helper if that surface only handles families. Use:

```js
const isOpenCodePhone = deviceType === 'mobile' && mode === 'opencode';
const key = isOpenCodePhone ? 'codeman-font-size-mobile-opencode' : 'codeman-font-size';
const fallback = isOpenCodePhone ? 8 : deviceType === 'mobile' ? 10 : 14;
const min = isOpenCodePhone ? 8 : 10;
```

Before `fitAddon.fit()` and `sendResize()` in `selectSession()`, resolve the selected session's mode and set the terminal font. `setFontSize()` stores to the active policy key. `decreaseFontSize()` uses the active policy minimum. `KeyboardHandler.resetLayout()` and viewport settlement call the same policy instead of hardcoding mobile 10 / desktop 14.

- [x] **Step 4: Run font, mobile layout, and IME structure tests GREEN**

Run:

```bash
npm test -- test/opencode-mobile-font.test.ts test/mobile-ime-preview-structure.test.ts test/mobile-keyboard-layout.test.ts
npm run check:frontend-syntax
```

Expected: OpenCode mobile is 8px, other modes and desktop remain unchanged, and IME geometry still follows xterm cells.

- [x] **Step 5: Commit Task 5**

```bash
git add src/web/public/terminal-ui.js src/web/public/mobile-handlers.js test/opencode-mobile-font.test.ts
git commit -m "fix(mobile): COD-370 compact OpenCode terminal text"
```

### Task 6: Real OpenCode two-viewer correctness and performance acceptance

**Files:**

- Replace: `test/mobile/opencode-e2e.test.ts`
- Optionally create: `test/utils/cod370-opencode-fixture.ts` if the fixture exceeds 250 lines; keep lifecycle ownership there only.

- [x] **Step 1: Replace the empty-xterm test with a failing real fixture**

The fixture must own a unique loopback port, `CODEMAN_DATA_DIR`, `CODEMAN_INSTANCE`, tmux socket, working directory, server child, browser, desktop context, phone context, and created OpenCode session. It must start the session via:

```ts
const created = await api('POST', '/api/sessions', {
  name: 'COD-370 active viewer',
  mode: 'opencode',
  workingDir: scenarioRoot,
  cols: 140,
  rows: 44,
});
await api('POST', `/api/sessions/${created.id}/interactive`);
```

Open desktop at 1440x900 and phone at 390x844. Select the same session in both pages. Record the exact server PID, OpenCode child PID, tmux session name, and pane identity before handoff.

- [x] **Step 2: Add the failing handoff assertions**

Use `page.bringToFront()` plus a real terminal tap to activate phone. Read authoritative tmux dimensions with the fixture socket:

```ts
expect(await paneDimensions()).toEqual({ cols: 75, rows: expect.any(Number) });
expect((await paneDimensions()).rows).toBeGreaterThanOrEqual(45);
expect(await pageTerminalFont(phonePage)).toBe(8);
expect(await identities()).toEqual(beforeIdentities);
```

Then send a passive desktop resize and assert dimensions remain mobile. Type one deterministic prompt payload on phone and assert the logical durable frame and pane input contain exactly one copy. Bring desktop forward, click the terminal, and assert its stored dimensions return without any identity change.

- [x] **Step 3: Run the real browser test RED**

Run:

```bash
npm run test:mobile -- test/mobile/opencode-e2e.test.ts
```

Expected: FAIL on immediate mobile ownership, 8px font, or backend rows because the old desktop claim still controls sizing.

- [x] **Step 4: Add handoff timing and resize-count instrumentation**

Instrument `session:resized` events and browser performance marks without altering production behavior. Require:

```ts
expect(phoneHandoffMs).toBeLessThanOrEqual(300);
expect(desktopRestoreMs).toBeLessThanOrEqual(300);
expect(effectiveResizeEvents.phone).toBeLessThanOrEqual(1);
expect(effectiveResizeEvents.desktop).toBeLessThanOrEqual(1);
```

Do not count local FitAddon measurements; count authoritative changed-dimension events only.

- [x] **Step 5: Run the phone scenario at 1x and 4x CPU**

Use a CDP session for the phone page:

```ts
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
try {
  await runHandoffAndTypingScenario();
} finally {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
}
```

Record typing-to-visible median/p95, long tasks, WebSocket bytes, resize events, exact input bytes, and pane dimensions for both rates. Fail on any missing/duplicate/reordered byte, page error, serious console error, resize storm, or handoff above 300ms. If 8px materially regresses the accepted baseline, change only the fallback constant to 9px and rerun the complete 1x/4x scenario; never combine selective samples.

- [x] **Step 6: Make cleanup fail closed**

In `afterAll`/fixture `finally`, close both contexts and browser, DELETE only the created session, stop the exact child, verify its PID and OpenCode PID are gone, verify the exact tmux session/socket is absent, prove the port can rebind, and remove only the validated scenario root. Aggregate cleanup errors and fail the test if any resource survives.

- [x] **Step 7: Run the real browser test GREEN twice**

Run twice from a clean resource state:

```bash
npm run test:mobile -- test/mobile/opencode-e2e.test.ts
npm run test:mobile -- test/mobile/opencode-e2e.test.ts
```

Expected: both runs pass with one process/session/pane identity, exact input, bounded handoffs, and clean teardown.

- [x] **Step 8: Commit Task 6**

```bash
git add test/mobile/opencode-e2e.test.ts test/utils/cod370-opencode-fixture.ts
git commit -m "test(mobile): COD-370 exercise real OpenCode handoff"
```

Omit the optional fixture path from `git add` if the helper was not needed.

Evidence (2026-08-23): review REDs failed for omitted exact geometry, cached/replaced PID identity, duplicate composer
content, post-dispatch timing, foreground proof, mandatory DELETE/GET404, and passive desktop `va`. The final two clean
runs of the exact command each passed 10/10 tests with one API session and pane: run 1 used session `3f7135b7`, launcher
`3984960`, listener `3984974`, and live OpenCode/pane PID `3985220` at start tick `486177742`; run 2 used `98a4f261`,
`3986075`, `3986086`, and `3986321` at `486179719`. Both rates kept the same live `/proc` command/executable,
tmux-session/window/pane identity, phone `75x62` at exactly 8px, desktop `178x38`, and one authoritative changed-size
event per handoff. Exact ordered phone payloads were 10/10 logical and durable bytes with ten per-character pane and
xterm composer convergence samples; serialized WebSocket totals were `555/560` bytes in run 1 and `564/570` in run 2.
Run 1 median/p95 was `38.7/60.2ms` at 1x and `79.0/89.8ms` at 4x, worst handoff `136.9ms`, with no 1x long task and
4x tasks `50/53/73ms`. Run 2 was `59.1/214.8ms` and `81.3/168.1ms`, worst handoff `148.8ms`, with no 1x long task and
4x tasks `53/54/70ms`. Headless Chromium reported both independently owned context pages visible/focused despite
target-specific CDP focus-control attempts; the decisive passive interval proved zero desktop `va`, pointer, focus, or selection events, exactly one raw
desktop `z`, and unchanged phone-owned dimensions. Page and serious-console errors were empty. Both all-true cleanup
proofs included both desktop and phone contexts independently closed, exact authenticated DELETE then GET 404,
OpenCode/pane/launcher/listener PIDs dead, tmux target/socket absent, loopback port rebound, fixture Chromium/tagged
processes absent, and validated scenario root absent.

### Task 7: Regression gates, release note, Jira evidence, and physical handoff

**Files:**

- Create: `.changeset/cod-370-active-viewer-terminal-sizing.md`
- Modify: `docs/superpowers/plans/2026-08-23-cod-370-active-viewer-terminal-sizing.md` (checkboxes/evidence only)

- [x] **Step 1: Add the changeset**

```md
---
'aicodeman': patch
---

Let the actively used desktop or phone control a shared terminal's size, and fit OpenCode into more usable mobile rows without restarting the session.
```

- [x] **Step 2: Run the exact focused Node regression set**

Evidence: 12 files and 328 tests passed in 25.11s with `CODEMAN_MUX=1`; no bare full-suite command was used.

```bash
npm test -- \
  test/terminal-sizing-ownership.test.ts \
  test/session-resize-arbitration.test.ts \
  test/session-resized-event.test.ts \
  test/tmux-manager.test.ts \
  test/routes/ws-routes.test.ts \
  test/terminal-viewer-activity.test.ts \
  test/opencode-mobile-font.test.ts \
  test/reliable-input-dedup.test.ts \
  test/terminal-input-classifier.test.ts \
  test/terminal-input-filter.test.ts \
  test/mobile-ime-preview-structure.test.ts \
  test/mobile-keyboard-layout.test.ts
```

Expected: all selected tests pass. Do not run bare `npm test` inside the managed Codeman session.

- [x] **Step 3: Run the exact browser/mobile regressions**

Evidence: OpenCode mobile passed 10/10 with 75x62 phone geometry at 8px and 178x38 desktop geometry. At 1x CPU, typing median/p95 was 52.1/63.3ms and phone/desktop handoff was 204.5/96.2ms. At 4x CPU, typing median/p95 was 81.2/99.2ms and phone/desktop handoff was 113.0/91.1ms. Page errors and serious console errors were empty; every reported cleanup assertion was true. The two browser regressions passed 64/64 in 53.68s.

Font comparator evidence: exact pre-COD-370 `d080481690dc62ffc0d0d4f8e7daae2cc8bf8613` at 10px was compared with final runtime `e7b3d4d001a8ab426cc21e9eece92046040e8d40` at 8px in complete ABBA order on the same host. Each runtime/rate retained 20 unfiltered dispatch-to-visible samples. Baseline versus candidate median/p95/max was `32.2/99.0/130.0ms` versus `36.5/110.9/234.2ms` at 1x and `69.2/88.5/90.0ms` versus `75.4/94.5/95.2ms` at 4x. The defined p95 gate passed: deltas were `+11.9ms/+12.0%` and `+6.0ms/+6.8%`, respectively. One isolated candidate 1x maximum of `234.2ms` (`+104.2ms/+80.2%`) was retained and disclosed; it had no recorded long task. Geometry improved from `62x49` to `75x62`; every run had exact frame/byte/token correctness, no page or serious console errors, no typing-window resize events, and all-true cleanup. The single-phone comparator deliberately excludes active-viewer handoff because the baseline predates that protocol; the separate final-head two-viewer acceptance above covers handoff. Full report and raw evidence: `docs/reports/cod-370/font-performance-comparison.md` and `docs/reports/cod-370/raw/`.

```bash
npm run test:mobile -- test/mobile/opencode-e2e.test.ts
npm run test:browser -- test/terminal-input-performance.browser.test.ts test/codex-predictive-echo.test.ts
```

Expected: all selected real-browser tests pass with no leftover test server, browser, tmux, or fixture directory.

- [x] **Step 4: Run static and build gates**

Evidence: typecheck, format check, lockfile check, frontend syntax (41 files), browser excludes (29 browser files among 444 collected files), build, and `git diff --check` exited 0. Lint exited 0 with one pre-existing unchanged explicit-`any` warning at `src/web/server.ts:1550`; build retained the pre-existing duplicate Chinese `Idle` key warning in `i18n.js`.

Realistic-smoke evidence: the fresh temporary instance on port 41567 completed 132/132 recorded checks, including Codex, Claude, shell replay, tab switching, 100120-line history, reload recovery, no page errors, and no serious console errors/warnings. All four temporary sessions returned cleanup 200; port 41567, the temporary root, and the unique tmux socket were absent afterward. Expected already-terminated-process `ESRCH` cleanup notices were non-fatal. Artifacts: `/tmp/codeman-dev-smoke-artifacts-2026-08-23T21-28-36-629Z`.

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run check:frontend-syntax
npm run check:browser-excludes
npm run build
git diff --check
```

Expected: every command exits 0. Document but do not hide pre-existing warnings whose source lines are unchanged.

- [x] **Step 5: Commit release evidence**

```bash
git add .changeset/cod-370-active-viewer-terminal-sizing.md docs/superpowers/plans/2026-08-23-cod-370-active-viewer-terminal-sizing.md
git commit -m "chore: COD-370 document active-viewer sizing"
```

- [ ] **Step 6: Request spec and quality review**

Review must explicitly verify:

- one OpenCode process/session/pane across both viewers;
- passive desktop cannot reclaim sizing;
- input fallback activation preserves exact reliable delivery;
- latest-wins tmux resize finishes on newest dimensions;
- HTTP recovery cannot be triggered by a hidden/background page;
- 8px/9px decision is backed by the complete 1x/4x evidence;
- all exact resources are absent after tests.

Resolve every Critical or Important finding with a focused RED/GREEN cycle before release.

- [ ] **Step 7: Update COD-370 and prepare physical iPhone Chrome acceptance**

Post branch, commits, exact commands/counts, 1x/4x metrics, cleanup proof, and review verdicts to COD-370. Expose a disposable authenticated LAN instance only after all automated gates pass. On the physical iPhone:

1. Leave the same session open but idle on desktop.
2. Open/foreground it on iPhone Chrome.
3. Verify text size, at least 45 backend rows, and prompt/status region proportion.
4. Type and submit exact text once; verify no character loss or duplication.
5. Return to desktop and verify geometry restores within 300ms.
6. Rotate phone and repeat one handoff.

Delete the disposable session and stop the LAN instance after the result. Do not merge, push, or deploy production until the user separately authorizes those release actions.
