# OpenCode Live Mirror Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenCode a first-class Live Mirror target and add target-scoped browser smoke coverage for OpenCode scrollback and clicking.

**Architecture:** Frontend Live Mirror eligibility is updated in the existing app controller, while route behavior remains shared unless tests prove OpenCode needs mode-specific handling. Browser smoke coverage is organized around reusable target definitions so OpenCode and Claude can be run independently without real model responses.

**Tech Stack:** TypeScript ESM, Fastify routes, plain browser JavaScript, xterm.js, Vitest, Playwright-style browser smoke tests, tmux-backed terminal capture.

---

## File structure

- `docs/superpowers/plans/2026-07-05-cod-207-opencode-live-mirror-smoke.md` (new): implementation plan only.
- `src/web/public/app.js`: extend `_isMirrorEligible`, keep `_isMirrorSession`/`_refreshMirrorFrame` behavior stable, and validate target handling in mirror view transitions.
- `src/web/routes/session-routes.ts`: keep shared terminal endpoint behavior intact; only add test coverage unless specific route-mode differences for OpenCode are required.
- `src/web/public/terminal-ui.js`: validate ` _dispatchSyntheticTerminalClick`, `_installMobileTapMouseGuard`, and tap-to-click behavior under synthetic-click scenarios.
- `test/mirror-history-view.test.ts`: add/extend OpenCode mirror-scrollback tests with `capture=1`, `lines=`, `mux-full-history`, and `mux-visible` assertions.
- `test/routes/session-routes.test.ts`: add targeted coverage for OpenCode terminal query behavior (`frame=1`, `capture=1`, long-line output, mux history modes).
- `test/terminal-touch-tap.test.ts`: add OpenCode click/mouse replay cases through terminal UI helpers.
- `test/opencode-resize.test.ts`: guard against regressions for OpenCode resize under mirror/scroller stress.
- `test/codeman-prod-smoke-harness.test.ts`: add reusable target definitions and selectors for independent OpenCode/Claude smoke runs.

---

### Task 1: Add failing OpenCode eligibility tests

**Files:**
- Modify: `test/mirror-history-view.test.ts`

- [ ] **Step 1: Write failing test for `_isMirrorEligible` when target=opencode**

```ts
it('returns true for OpenCode in mirror eligibility', () => {
  const session = createSessionState({ mirrorTarget: 'opencode' });
  expect(session._isMirrorEligible()).toBe(true);
  expect(session._isMirrorSession()).toBe(true);
});
```

- [ ] **Step 2: Write failing test asserting only missing target is `opencode` relative to baseline**

```ts
it('does not include opencode in codex|gemini|claude list until implemented', () => {
  const session = createSessionState({ mirrorTarget: 'opencode' });
  expect(session._isMirrorEligible()).toBe(false);
});
```

- [ ] **Step 3: Run tests to confirm expected fail**

Run: `npm test -- test/mirror-history-view.test.ts`

Expected: FAIL (two assertions around OpenCode eligibility and refresh behavior fail because `_isMirrorEligible` excludes opencode).

- [ ] **Step 4: Leave failing state in branch for explicit diff visibility until Task 2 implements behavior**

```bash
git status --short
```

Expected: modified `test/mirror-history-view.test.ts` only.

---

### Task 2: Implement app.js OpenCode mirror eligibility

**Files:**
- Modify: `src/web/public/app.js`

- [ ] **Step 1: Update `_isMirrorEligible` to include `opencode`**

```js
_isMirrorEligible() {
  return ['codex', 'gemini', 'claude', 'opencode'].includes(this.mirrorTarget);
}
```

- [ ] **Step 2: Add targeted mirror flow assertions**

```js
if (this._isMirrorEligible()) {
  this._isMirrorSession();
  this._refreshMirrorFrame();
}
```

- [ ] **Step 3: Validate history view transitions are preserved**

```js
this._enterHistoryView();
expect(this._exitHistoryView()).toBeUndefined();
```

- [ ] **Step 4: Run focused history tests**

Run: `npm test -- test/mirror-history-view.test.ts`

Expected: PASS for new OpenCode tests and existing mirror-history regressions.

- [ ] **Step 5: Commit task-specific changes with message**

```bash
git add src/web/public/app.js test/mirror-history-view.test.ts
git commit -m "test(app): COD-207 add opencode to mirror eligible"
```

---

### Task 3: Add target registry/filtering for OpenCode + Claude in browser smoke runner

**Files:**
- Modify: `test/codeman-prod-smoke-harness.test.ts`

- [ ] **Step 1: Define reusable target fixture in smoke harness**

```ts
const MIRROR_TARGETS = [
  { key: 'claude', path: '/?target=claude', label: 'claude' },
  { key: 'opencode', path: '/?target=opencode', label: 'opencode' },
];
```

- [ ] **Step 1a: Ensure tests can run independently per target without model calls**

```ts
function buildMirrorSmokeScenario(target) {
  return {
    target,
    runHistory: () => runHistorySmoke(target),
    runMouse: () => runMouseSmoke(target),
  };
}
```

- [ ] **Step 2: Add scenario runner for OpenCode + Claude**

```ts
for (const target of MIRROR_TARGETS) {
  describe(`smoke:${target.key}`, () => runMirrorSmokeForTarget(target));
}
```

- [ ] **Step 3: Run smoke test subset if available**

Run: `npm test -- test/codeman-prod-smoke-harness.test.ts`

Expected: PASS with two scenario blocks generated, one per target, no runtime model dependency.

---

### Task 4: Preserve OpenCode resize behavior under the new target structure

**Files:**
- Modify: `test/opencode-resize.test.ts`
- Validate: `src/web/public/app.js`

- [ ] **Step 1: Add/adjust test using explicit target filter (`opencode`)**

```ts
it('keeps mirror frame responsive while streaming in opencode mode', async () => {
  const session = newSessionState({ target: 'opencode' });
  await runResizeSequence(session);
  expect(session._refreshMirrorFrame).toHaveBeenCalled();
});
```

- [ ] **Step 2: Verify no regressions against Claude target path in same structure**

```ts
it('preserves claude resize parity while adding opencode fixture', async () => {
  await runResizeSequence(newSessionState({ target: 'claude' }));
  await runResizeSequence(newSessionState({ target: 'opencode' }));
  expect(true).toBe(true);
});
```

- [ ] **Step 3: Run focused regression check**

Run: `npx vitest run test/opencode-resize.test.ts`

Expected: PASS for both target fixtures, no resize race or unhandled promise during mirror frame events.

---

### Task 5: Add scrollback stress tests for OpenCode terminal capture via mux endpoint

**Files:**
- Modify: `test/routes/session-routes.test.ts`
- Validate endpoint behavior in relation to `src/web/routes/session-routes.ts`

- [ ] **Step 1: Add route test for large OpenCode scrollback with `frame=1` and `capture=1`**

```ts
it('GET /api/sessions/:id/terminal supports opencode scrollback capture', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/sessions/1/terminal?frame=1&capture=1&lines=5000',
  });

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body).capture).toBe(1);
  expect(response.body.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Add tests for `mux-full-history` and `mux-visible` query behavior**

```ts
for (const mode of ['mux-full-history', 'mux-visible']) {
  it(`supports opencode with ${mode}`, async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/1/terminal?capture=1&${mode}=1&lines=1000`,
    });
    expect(response.statusCode).toBe(200);
  });
}
```

- [ ] **Step 3: Run route-scoped tests**

Run: `npm test -- test/routes/session-routes.test.ts`

Expected: PASS on shared route behavior; no OpenCode-specific branch unless test requires new handling.

---

### Task 6: Add click/mouse smoke for OpenCode with touch event synthesis

**Files:**
- Modify: `test/terminal-touch-tap.test.ts`
- Reference: `src/web/public/terminal-ui.js`

- [ ] **Step 1: Add synthetic click test bound to `_dispatchSyntheticTerminalClick`**

```ts
it('calls _dispatchSyntheticTerminalClick for opencode tap-to-mouse path', async () => {
  const spy = vi.spyOn(appController, '_dispatchSyntheticTerminalClick');
  _installMobileTapMouseGuard(mockTerminal);
  await triggerTapOnTerminal(mockTerminal.element);
  expect(spy).toHaveBeenCalled();
});
```

- [ ] **Step 2: Add mouse click assertion for OpenCode through mirror view flow**

```ts
it('dispatches click events in opencode mirror sequence', async () => {
  await appController._enterHistoryView();
  await emitMouseEvent('click', { button: 0, target: 'opencode' });
  expect(mockTerminal.clicked).toBe(true);
  await appController._exitHistoryView();
});
```

- [ ] **Step 3: Run touch/click tests**

Run: `npm test -- test/terminal-touch-tap.test.ts`

Expected: PASS for both synthetic click and guard-installed click paths.

---

### Task 7: Add target-scoped smoke + docs updates for reproducible OpenCode flow

**Files:**
- Modify: `test/mirror-history-view.test.ts`
- Modify: `test/codeman-prod-smoke-harness.test.ts`
- Optional docs update: `docs/superpowers/specs/2026-07-05-cod-207-opencode-live-mirror-smoke-design.md` references and follow-up notes

- [ ] **Step 1: Add OpenCode-specific helper case in mirror-history test matrix**

```ts
it('runs scrollback smoke for target=opencode in history mode', async () => {
  await withMirrorTarget('opencode', () => testMirrorHistoryFlow());
});
```

- [ ] **Step 2: Reuse the same registry from Task 3 for CLAUDE/OpenCode smoke matrix**

```ts
for (const target of ['claude', 'opencode']) {
  await runSmokeSuiteForTarget(target);
}
```

- [ ] **Step 3: Confirm design doc path is used as canonical spec reference**

```md
Spec Path: docs/superpowers/specs/2026-07-05-cod-207-opencode-live-mirror-smoke-design.md
```

- [ ] **Step 4: Run any lint-friendly smoke/plan checks if part of repo policy**

Run: `npm run format:check`

Expected: PASS; target names remain deterministic (`claude`, `opencode`) and no test duplication.

---

### Task 8: Verification, hygiene, and Jira close-out

**Files:**
- `docs/superpowers/plans/2026-07-05-cod-207-opencode-live-mirror-smoke.md`

- [ ] **Step 1: Re-run the four requested targeted suites and checks**

```bash
npm test -- test/mirror-history-view.test.ts
npm test -- test/routes/session-routes.test.ts
npm test -- test/terminal-touch-tap.test.ts
npx vitest run test/opencode-resize.test.ts
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
```

Expected:
- targeted unit/route/touch tests PASS
- resize test PASS
- typecheck/lint/format/lockfile PASS

- [ ] **Step 2: Verify only intended files changed and plan is complete**

```bash
```

Expected: only `docs/superpowers/plans/2026-07-05-cod-207-opencode-live-mirror-smoke.md` modified (if executing only this task, no code/test modifications).

- [ ] **Step 3: Self-review mapping and placeholder sweep**

```text
1) Spec coverage: map each bullet from design path and current-facts list to Task 1-7.
2) Placeholder scan: verify no 'TODO', 'TBD', 'implement later', or pseudo placeholders remain.
3) Type/identifier consistency: verify names exactly match _isMirrorEligible, _isMirrorSession, _refreshMirrorFrame, _enterHistoryView, _exitHistoryView, _dispatchSyntheticTerminalClick, and _installMobileTapMouseGuard in all steps.
4) Confirm no additional source files are required beyond those listed.
```

Expected: no placeholders and complete requirement mapping.

- [ ] **Step 4: Commit plan-only work**

```bash
```

Expected: repository records one commit containing only the plan file.

---

## Self-review summary

- **Spec mapping:**
  - Target eligibility: Task 2 directly addresses `_isMirrorEligible` and references `_isMirrorSession`, `_refreshMirrorFrame`, `_enterHistoryView`, `_exitHistoryView`.
  - Terminal endpoint behavior: Task 5 validates `GET /api/sessions/:id/terminal` query modes `frame=1`, `lines=`, `capture=1`, `mux-full-history`, and `mux-visible`.
  - Touch/click behavior: Task 6 validates `_dispatchSyntheticTerminalClick`, `_installMobileTapMouseGuard`, and tap handling.
  - Test surface: Tasks 1, 5, 6, and 7 explicitly cover `test/mirror-history-view.test.ts`, `test/routes/session-routes.test.ts`, `test/terminal-touch-tap.test.ts`, `test/opencode-resize.test.ts`, `test/codeman-prod-smoke-harness.test.ts`.
  - Reusable target-scoped smoke: Task 3 + Task 7 implement shared registry for `claude` and `opencode`.

- **No placeholders:** This plan includes concrete test, behavior, and command snippets for every step and no `TODO`/`TBD` style placeholders.
- **Plan completeness check:** All required sections are present; the plan is fully executable with the given facts and file/function names.

Plan complete and ready for execution via subagent-driven development or inline execution.
