# COD-368 Mobile IME Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make fast typing on iPhone Chrome appear immediately without sending provisional Apple IME text to the PTY or changing Codeman's reliable input bytes.

**Architecture:** Add a small browser controller that observes xterm composition events, collapses arbitrary update bursts into one latest-state animation-frame preview, and tags only xterm's canonical committed `onData` value. Extend the predictive-echo addon with an all-or-nothing text-run API so a committed IME word appears atomically while existing authoritative-output reconciliation removes it. Terminal wiring remains fail-open and the existing xterm/reliable-delivery path stays byte-identical.

**Tech Stack:** Plain browser JavaScript, TypeScript xterm addon, xterm.js 6, Vitest, Playwright/Chromium, esbuild, CSS.

---

## File Map

- Create `src/web/public/mobile-ime-preview.js`: composition state machine, latest-state frame scheduling, exact commit handoff, lifecycle cleanup, and iOS/WebKit touch eligibility.
- Create `test/mobile-ime-preview.test.ts`: deterministic controller and lifecycle contracts with injected frame/timer functions.
- Modify `packages/xterm-zerolag-input/src/predictive-echo-addon.ts`: add atomic `predictText(text)` visual API without changing `predictChar` or wire behavior.
- Modify `packages/xterm-zerolag-input/test/predictive-echo-addon.test.ts`: all-or-nothing text-run, reconciliation, Unicode, bounds, and failure tests.
- Modify `src/web/public/index.html`: load the controller before `terminal-ui.js`.
- Modify `scripts/build.mjs`: minify and fingerprint the new browser asset.
- Modify `src/web/public/terminal-ui.js`: create/destroy the controller, render its preview, tag exact composition commits, and call `predictText` only for tagged commits.
- Modify `src/web/public/styles.css`: scoped provisional/committed preview presentation and native composition-view suppression only while the owned preview is active.
- Create `test/mobile-ime-preview-structure.test.ts`: load order, build inclusion, CSS scoping, and fail-open wiring contracts.
- Modify `test/terminal-input-performance.browser.test.ts`: real browser/server/PTY coverage for held composition, burst updates, exact commit, and cleanup.
- Create `.changeset/cod-368-mobile-ime-preview.md`: user-visible fix note after the implementation passes acceptance.

### Task 1: Latest-state composition controller

**Files:**

- Create: `src/web/public/mobile-ime-preview.js`
- Create: `test/mobile-ime-preview.test.ts`

- [ ] **Step 1: Write the controller contract tests**

Create a harness with a fake textarea event target, injected `scheduleFrame`, `cancelFrame`, `setTimer`, and `clearTimer`, and spies for `render`, `clear`, and `onCommit`. Cover these exact contracts:

```ts
it('collapses 500 composition updates into one render of the latest value', () => {
  const h = createHarness();
  h.fire('compositionstart');
  for (let i = 1; i <= 500; i++) h.fire('compositionupdate', { data: `value-${i}` });

  expect(h.frames).toHaveLength(1);
  h.runFrame();
  expect(h.render).toHaveBeenCalledTimes(1);
  expect(h.render).toHaveBeenLastCalledWith({ text: 'value-500', phase: 'provisional' });
});

it('does not send provisional values and hands off only xterm onData', () => {
  const h = createHarness();
  h.fire('compositionstart');
  h.fire('compositionupdate', { data: 'teh' });
  h.fire('compositionupdate', { data: 'the' });
  h.fire('compositionend');

  expect(h.onCommit).not.toHaveBeenCalled();
  expect(h.controller.consumeTerminalData('the')).toBe(true);
  expect(h.onCommit).toHaveBeenCalledOnce();
  expect(h.onCommit).toHaveBeenCalledWith('the');
});

it('invalidates old frames, timers and commits on reset or destroy', () => {
  const h = createHarness();
  h.fire('compositionstart');
  h.fire('compositionupdate', { data: 'old' });
  h.controller.reset();
  h.runAllScheduledWork();
  expect(h.render).not.toHaveBeenCalled();
  expect(h.controller.consumeTerminalData('old')).toBe(false);

  h.controller.destroy();
  expect(h.listenerCount()).toBe(0);
  expect(h.liveFrames()).toBe(0);
  expect(h.liveTimers()).toBe(0);
});
```

Also test replacement/backspace latest-state behavior, `keydown` composition finalization before `compositionend`, control/multiline rejection, stale-generation isolation, timeout cleanup, blur/reset behavior, and fail-open callback exceptions.
Test `completeCommit({ predicted: true })` transferring ownership away from the dedicated preview immediately, while
`completeCommit({ predicted: false })` retains the committed fallback until `noteAuthoritativeOutput()` or TTL cleanup.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm test -- test/mobile-ime-preview.test.ts
```

Expected: FAIL because `src/web/public/mobile-ime-preview.js` does not exist.

- [ ] **Step 3: Implement the minimal controller**

Create an IIFE global with an injected, independently testable controller:

```js
const MobileImePreview = (() => {
  const COMMITTED_TTL_MS = 2_000;
  const MAX_PREVIEW_CHARS = 2_048;

  function isIosWebKitTouch(nav = navigator) {
    const ua = nav.userAgent || '';
    const platform = nav.platform || '';
    const ios = /iPhone|iPad|iPod/.test(ua) || (platform === 'MacIntel' && nav.maxTouchPoints > 1);
    return ios && /AppleWebKit/.test(ua) && nav.maxTouchPoints > 0;
  }

  function create(options) {
    const textarea = options.textarea;
    const scheduleFrame = options.scheduleFrame || requestAnimationFrame;
    const cancelFrame = options.cancelFrame || cancelAnimationFrame;
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    let generation = 0;
    let composing = false;
    let awaitingCommit = false;
    let committed = false;
    let latest = '';
    let frame = null;
    let ttl = null;
    let destroyed = false;

    const safe = (fn, ...args) => {
      try {
        return fn?.(...args);
      } catch {
        return undefined;
      }
    };
    const clearVisual = () => safe(options.clear);
    const cancelWork = () => {
      if (frame !== null) cancelFrame(frame);
      if (ttl !== null) clearTimer(ttl);
      frame = null;
      ttl = null;
    };
    const queueRender = (phase) => {
      if (frame !== null || destroyed) return;
      const owner = generation;
      frame = scheduleFrame(() => {
        frame = null;
        if (destroyed || owner !== generation) return;
        safe(options.render, { text: latest.slice(0, MAX_PREVIEW_CHARS), phase });
      });
    };
    const update = (value) => {
      if (!composing || destroyed) return;
      latest = String(value || '');
      queueRender('provisional');
    };
    const onStart = () => {
      cancelWork();
      generation++;
      composing = true;
      awaitingCommit = false;
      committed = false;
      latest = '';
      clearVisual();
    };
    const onUpdate = (event) => update(event.data);
    const onInput = (event) => {
      if (event.isComposing) update(event.data ?? textarea.value);
    };
    const armCommit = () => {
      composing = false;
      awaitingCommit = true;
      committed = false;
    };

    const listeners = [
      ['compositionstart', onStart],
      ['compositionupdate', onUpdate],
      ['input', onInput],
      ['compositionend', armCommit],
    ];
    for (const [name, fn] of listeners) textarea.addEventListener(name, fn);

    const reset = () => {
      generation++;
      composing = false;
      awaitingCommit = false;
      committed = false;
      latest = '';
      cancelWork();
      clearVisual();
    };

    return {
      consumeTerminalData(data) {
        if (!awaitingCommit || typeof data !== 'string' || !data || /[\r\n\x00-\x1f\x7f]/.test(data)) return false;
        awaitingCommit = false;
        committed = true;
        latest = data;
        safe(options.onCommit, data);
        queueRender('committed');
        ttl = setTimer(reset, COMMITTED_TTL_MS);
        return true;
      },
      completeCommit({ predicted }) {
        if (committed && predicted) reset();
      },
      noteAuthoritativeOutput() {
        if (committed) reset();
      },
      reset,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        reset();
        for (const [name, fn] of listeners) textarea.removeEventListener(name, fn);
      },
      get state() {
        return { generation, composing, awaitingCommit, committed, latest, framePending: frame !== null };
      },
    };
  }

  return { create, isIosWebKitTouch };
})();
```

Add the required `keydown` finalization and blur behavior proven by the tests. Do not mutate textarea values or dispatch synthetic input.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npm test -- test/mobile-ime-preview.test.ts
```

Expected: all controller tests PASS with no leaked frame, timer, or listener.

- [ ] **Step 5: Commit the controller**

```bash
git add src/web/public/mobile-ime-preview.js test/mobile-ime-preview.test.ts
git commit -m "feat(input): COD-368 add mobile IME preview controller"
```

### Task 2: Atomic predictive text runs

**Files:**

- Modify: `packages/xterm-zerolag-input/src/predictive-echo-addon.ts`
- Modify: `packages/xterm-zerolag-input/test/predictive-echo-addon.test.ts`

- [ ] **Step 1: Add failing all-or-nothing text-run tests**

Add tests that prove one validated operation creates the whole run and invalid input leaves the prior state unchanged:

```ts
it('predictText paints a committed IME run atomically', () => {
  expect(addon.predictText('hello')).toBe(true);
  expect(containerText()).toBe('hello');
  expect(addon.debugState.outstanding).toBe(5);
});

it.each(['a\nb', '\x1b[A', ''])('predictText rejects unsafe text without partial spans: %j', (text) => {
  addon.predictChar('x');
  const before = containerHtml();
  expect(addon.predictText(text)).toBe(false);
  expect(containerHtml()).toBe(before);
});

it('predictText validates maxPending and edge margin before mutation', () => {
  setCursor(78, 0);
  expect(addon.predictText('abc')).toBe(false);
  expect(containerText()).toBe('');
});
```

Cover ASCII, emoji/wide CJK, `predictWhen:false`, anchor hold, missing cell dimensions, reconciliation against authoritative output, TTL cleanup, and thrown DOM/buffer reads.

- [ ] **Step 2: Run addon tests and verify RED**

Run:

```bash
npm test -- packages/xterm-zerolag-input/test/predictive-echo-addon.test.ts
```

Expected: FAIL because `predictText` is not defined.

- [ ] **Step 3: Implement atomic validation then mutation**

Add `predictText(text: string): boolean` next to `predictChar`. It must:

1. perform the same terminal, viewport, cursor, `predictWhen`, and anchor-hold gates as `predictChar`;
2. convert the complete string with `Array.from`;
3. reject controls, unsupported widths, max-pending overflow, and edge overflow before creating any record or span;
4. snapshot every target cell before mutating `_outstanding`;
5. append records/spans only after the entire candidate validates;
6. arm TTL once and return `true`;
7. catch failures and return `false` without partial mutation.

Use a local candidate array before the commit loop:

```ts
const candidates = codepoints.map((char, index) => ({
  char,
  width: charCellWidth(t, char),
  offsetCells: baseOffset + widthsBefore(index),
  snapshot: this._readCell(anchor.row, anchor.col + baseOffset + widthsBefore(index)),
}));

if (!candidates.every(validCandidate)) return false;
for (const candidate of candidates) this._appendPrediction(candidate, dims, anchor);
this._armTtl();
return true;
```

Extract only the smallest private helper needed to share record/span creation with `predictChar`; do not change existing single-character semantics.

- [ ] **Step 4: Run addon and fuzz/replay regressions**

Run:

```bash
npm test -- packages/xterm-zerolag-input/test/predictive-echo-addon.test.ts packages/xterm-zerolag-input/test/predictive-echo-fuzz.test.ts packages/xterm-zerolag-input/test/codex-replay.test.ts
```

Expected: all tests PASS; existing `predictChar`, backspace, anchor-hold, and convergence behavior remains unchanged.

- [ ] **Step 5: Commit the addon API**

```bash
git add packages/xterm-zerolag-input/src/predictive-echo-addon.ts packages/xterm-zerolag-input/test/predictive-echo-addon.test.ts
git commit -m "feat(input): COD-368 predict committed IME text atomically"
```

### Task 3: Terminal wiring, build graph, and scoped presentation

**Files:**

- Modify: `src/web/public/index.html`
- Modify: `scripts/build.mjs`
- Modify: `src/web/public/terminal-ui.js`
- Modify: `src/web/public/styles.css`
- Create: `test/mobile-ime-preview-structure.test.ts`

- [ ] **Step 1: Write failing structural and wiring tests**

Assert:

```ts
expect(indexOfScript('mobile-ime-preview.js')).toBeLessThan(indexOfScript('terminal-ui.js'));
expect(buildSource).toContain("'mobile-ime-preview.js'");
expect(terminalUiSource).toContain('MobileImePreview.isIosWebKitTouch');
expect(terminalUiSource).toContain('consumeTerminalData(data)');
expect(terminalUiSource).toContain('predictText(data)');
expect(cssSource).toContain('.codeman-ime-preview[data-phase="provisional"]');
expect(cssSource).toContain('.codeman-ime-preview-owned .composition-view.active');
```

Add a VM wiring test where `MobileImePreview.create` throws and prove terminal initialization/onData continues without throwing or suppressing `_sendInputAsync`.

- [ ] **Step 2: Run structural tests and verify RED**

Run:

```bash
npm test -- test/mobile-ime-preview-structure.test.ts
```

Expected: FAIL because the asset is not loaded/built/wired and the scoped CSS is absent.

- [ ] **Step 3: Add the asset to source and build order**

Load `mobile-ime-preview.js` after xterm and before `terminal-ui.js`. Add it to the build's copied/minified browser sources and hashed-reference rewrite list, following `input-cjk.js` exactly.

- [ ] **Step 4: Wire controller lifecycle into terminal initialization**

During terminal initialization:

```js
this._mobileImePreview?.destroy?.();
this._mobileImePreview = null;
try {
  const textarea = this.terminal?.textarea;
  const enabled = textarea && MobileImePreview?.isIosWebKitTouch?.();
  if (enabled) {
    const helpers = this.terminal.element?.querySelector('.xterm-helpers');
    const preview = document.createElement('span');
    preview.className = 'codeman-ime-preview';
    preview.hidden = true;
    helpers?.appendChild(preview);
    this._mobileImePreview = MobileImePreview.create({
      textarea,
      render: ({ text, phase }) => {
        preview.textContent = text;
        preview.dataset.phase = phase;
        preview.hidden = !text;
        helpers?.classList.add('codeman-ime-preview-owned');
      },
      clear: () => {
        preview.hidden = true;
        preview.textContent = '';
        delete preview.dataset.phase;
        helpers?.classList.remove('codeman-ime-preview-owned');
      },
      onCommit: (text) => {
        this._pendingImeCommit = text;
      },
    });
  }
} catch {
  this._mobileImePreview = null;
}
```

Use the existing helper-textarea cursor CSS variables for positioning. Destroy/reset the controller on terminal replacement, session switch, disconnect cleanup, and app destruction.

- [ ] **Step 5: Tag only exact composition commits in `onData`**

Before the predictive hook, call:

```js
const isImeCommit = this._mobileImePreview?.consumeTerminalData(data) === true;
this._predictHookOnData(data, { isImeCommit });
```

Change the visual hook without changing the send path:

```js
_predictHookOnData(data, { isImeCommit = false } = {}) {
  if (this._localEchoPolicy !== 'predict' || !this._predictiveEcho) return;
  try {
    const kind = window.CodemanTerminalInput.classifyPredictInput(data);
    let ok = false;
    if (isImeCommit && kind === 'text') ok = this._predictiveEcho.predictText(data);
    else if (kind === 'char') ok = this._predictiveEcho.predictChar(data);
    else if (kind === 'backspace') ok = this._predictiveEcho.predictBackspace();
    else this._predictiveEcho.clearPredictions();
    this._mobileImePreview?.completeCommit?.({ predicted: ok });
  } catch {
    // Visual prediction must never block the unchanged wire path.
  }
}
```

Keep the plain statement/fall-through contract: no preview result may `return` from `onData` or gate `_sendInputAsync`.

At the existing terminal-output intake boundary, call `this._mobileImePreview?.noteAuthoritativeOutput()` only after a
post-commit terminal payload is accepted for the active session. The method is a visual fallback for cases where
`predictText` could not establish a safe composer anchor; it must not alter, delay, or consume that output.

- [ ] **Step 6: Add scoped CSS**

```css
.xterm-helpers .codeman-ime-preview {
  position: absolute;
  left: var(--xterm-helper-left, 0px);
  top: var(--xterm-helper-top, 0px);
  z-index: 6;
  pointer-events: none;
  white-space: pre;
  color: var(--terminal-foreground, #fff);
  font: inherit;
}

.xterm-helpers .codeman-ime-preview[data-phase='provisional'] {
  text-decoration: underline;
  text-decoration-style: dotted;
}

.touch-device .xterm-helpers.codeman-ime-preview-owned .composition-view.active {
  display: none;
}
```

Suppress the native xterm composition view only when the owned preview is visibly active. Clearing or failure must remove the owner class immediately.

- [ ] **Step 7: Run focused UI tests**

Run:

```bash
npm test -- test/mobile-ime-preview-structure.test.ts test/input-cjk.test.ts test/mobile-shell-keyboard.test.ts test/terminal-input-classifier.test.ts
npm run check:frontend-syntax
```

Expected: all tests PASS and every browser JS file parses.

- [ ] **Step 8: Commit the integration**

```bash
git add src/web/public/index.html scripts/build.mjs src/web/public/terminal-ui.js src/web/public/styles.css test/mobile-ime-preview-structure.test.ts
git commit -m "fix(input): COD-368 keep mobile IME typing visually current"
```

### Task 4: Real-browser delivery and performance proof

**Files:**

- Modify: `test/terminal-input-performance.browser.test.ts`

- [ ] **Step 1: Add a failing held-composition browser regression**

Use the existing real server, WebSocket/HTTP tracing, disposable tmux PTY probe, and xterm buffer observer. Dispatch a five-second composition with repeated updates and assert before commit:

```ts
expect(await page.evaluate(() => window.__cod368.logical.length)).toBe(0);
expect(await readProbeBytes()).toEqual(Buffer.alloc(0));
expect(await page.locator('.codeman-ime-preview').textContent()).toBe(latestValue);
expect(await page.locator('.codeman-ime-preview').getAttribute('data-phase')).toBe('provisional');
```

After `compositionend`, wait for the actual production `onData`/WS/PTY/xterm path and assert exactly one logical record, exact bytes, one atomic committed preview, authoritative convergence, and no remaining preview/timer/listener.

- [ ] **Step 2: Add a fast-update backlog regression**

Dispatch at least 500 sequential `compositionupdate` events faster than a frame. Record controller render counters and timestamps. Assert:

```ts
expect(metrics.maxPendingFrames).toBe(1);
expect(metrics.provisionalRenders).toBeLessThanOrEqual(2);
expect(metrics.latestPreview).toBe('value-500');
expect(metrics.previewDrainAfterLastUpdateMs).toBeLessThanOrEqual(100);
```

Repeat under Playwright 4x CPU throttling and a 390x520 keyboard-sized viewport.

- [ ] **Step 3: Run the exact browser test and verify RED**

Run:

```bash
npm run test:browser -- test/terminal-input-performance.browser.test.ts
```

Expected before final wiring: the new preview/backlog cases FAIL while existing delivery cases pass.

- [ ] **Step 4: Make the smallest integration corrections required by real events**

Correct only event ordering, generation fencing, or preview reconciliation demonstrated by the failing real-browser trace. Do not add timing-based provisional sends or weaken exact-byte assertions.

- [ ] **Step 5: Run browser and Node input regressions**

Run:

```bash
npm run test:browser -- test/terminal-input-performance.browser.test.ts test/codex-predictive-echo.test.ts
npm test -- test/mobile-ime-preview.test.ts test/mobile-ime-preview-structure.test.ts test/input-cjk.test.ts test/mobile-shell-keyboard.test.ts test/terminal-input-filter.test.ts test/terminal-input-classifier.test.ts packages/xterm-zerolag-input/test/predictive-echo-addon.test.ts packages/xterm-zerolag-input/test/predictive-echo-fuzz.test.ts packages/xterm-zerolag-input/test/codex-replay.test.ts
```

Expected: all scoped tests PASS, with zero missing, duplicate, or reordered bytes.

- [ ] **Step 6: Commit browser evidence**

```bash
git add test/terminal-input-performance.browser.test.ts
git commit -m "test(input): COD-368 cover mobile IME backlog"
```

### Task 5: Release gates and physical iPhone acceptance handoff

**Files:**

- Create: `.changeset/cod-368-mobile-ime-preview.md`
- Modify: Jira COD-368 comment/status only after evidence is available

- [ ] **Step 1: Add the changeset**

```markdown
---
'aicodeman': patch
---

Keep fast iPhone terminal typing visually current while preserving exact IME-committed input.
```

- [ ] **Step 2: Run all scoped correctness and static gates**

Run:

```bash
npm test -- test/mobile-ime-preview.test.ts test/mobile-ime-preview-structure.test.ts test/input-cjk.test.ts test/mobile-shell-keyboard.test.ts test/terminal-input-filter.test.ts test/terminal-input-classifier.test.ts packages/xterm-zerolag-input/test/predictive-echo-addon.test.ts packages/xterm-zerolag-input/test/predictive-echo-fuzz.test.ts packages/xterm-zerolag-input/test/codex-replay.test.ts
npm run test:browser -- test/terminal-input-performance.browser.test.ts test/codex-predictive-echo.test.ts
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run check:frontend-syntax
npm run check:browser-excludes
npm run build
git diff --check
```

Expected: every command exits 0. Report existing warnings separately; do not describe a warning as introduced without confirming it against the design parent.

- [ ] **Step 3: Perform disposable LAN acceptance preparation**

Build and run the feature branch on a temporary unused LAN port with a distinct data directory/instance identity. Verify loopback and advertised LAN URLs return 200, create only a disposable Codex session, and record the exact commit and asset hashes. Do not replace the current production service for this step.

- [ ] **Step 4: Run physical iPhone Chrome acceptance**

With the standard Apple keyboard, verify and record:

- fast typing preview latency at or below 50 ms;
- no character-by-character drain lasting over 100 ms after stopping;
- exact final command and one Enter submission;
- autocorrect replacement and backspace without duplicated prefixes;
- keyboard remains open and terminal focus remains stable;
- no page errors or serious console errors.

If physical acceptance fails, retain the trace and return to the smallest falsified design assumption. Do not merge, push, deploy, or mark COD-368 Done.

- [ ] **Step 5: Commit release documentation**

```bash
git add .changeset/cod-368-mobile-ime-preview.md
git commit -m "chore: COD-368 document mobile IME fix"
```

- [ ] **Step 6: Update Jira without overstating release state**

Comment on COD-368 with branch, commits, exact test counts, static/build gates, LAN URL, physical iPhone results, byte-identity evidence, and cleanup. Move the issue only to the repository's review-ready status. State explicitly that merge, push, production deployment, and production verification have not occurred unless separately authorized and completed.

## Plan Self-review

- Spec coverage: latest-state provisional rendering, exact canonical commit, atomic predictive text, fail-open lifecycle, bounded work, browser correctness, and physical iPhone acceptance all map to explicit tasks.
- Scope: browser/controller/addon/tests only; no server, transport, tmux, or unrelated refactor.
- Type/API consistency: `MobileImePreview.create`, `consumeTerminalData`, `reset`, `destroy`, `predictText`, and `isImeCommit` use the same names throughout.
- Safety: no provisional send path exists; all visual failures fall through to the unchanged wire path.
- Placeholder scan: no TBD/TODO/deferred implementation steps remain.
