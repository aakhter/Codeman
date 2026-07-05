# COD-207 — OpenCode first-class Live Mirror support + targeted smoke design

**Date:** 2026-07-05
**Jira:** [COD-207](https://aakhter.atlassian.net/browse/COD-207)
**Status:** Design approved

## Problem

OpenCode sessions are not fully integrated with Live Mirror yet. In practice:

- OpenCode is often missing from Live Mirror eligibility/refresh decision paths.
- Scrolling and click/mouse interaction behavior in OpenCode terminals is inconsistent compared with Codex/Claude/Gemini.
- Browser smoke coverage is incomplete for OpenCode and still runs as broad end-to-end runs instead of targeted checks.

This design makes OpenCode a first-class target for Live Mirror and defines a focused, reproducible OpenCode smoke strategy that validates Codeman-owned behavior without depending on live model answers.

## Clarification

“**liveport**” refers to the existing **Live Mirror** feature where Codeman mirrors the terminal viewport for an active agent mode and keeps one “live frame” while allowing scrollback access. In this model, scrolling up in the terminal should:

- switch from live mode to historical scrollback mode,
- request and show scrollback content from the backend,
- preserve a clear return-to-live path when scrolled back to the bottom.

## Recommended approach

Implement in three coordinated layers:

1. **Extend Live Mirror pathing to treat OpenCode as a first-class terminal target.**
2. **Refactor browser smoke harness structure around reusable target definitions** so OpenCode can be run alone or alongside other targets.
3. **Add OpenCode-specific interaction checks** for Live Mirror refresh, scrollback freeze/fetch, mouse click behavior, and post-create resize semantics.

## Alternatives considered

| Option | Description | Tradeoffs | Why not chosen / when to choose |
|---|---|---|---|
| A | Minimal wiring only | Add `opencode` to currently missing lists/guards and leave terminal interaction code untouched. | Low effort, but leaves root causes unresolved: no deterministic scrollback behavior checks, no click/mouse parity checks, and no safe single-target execution. Only viable as an intermediate step if we first need a “green path” for launch coverage. |
| B | Full terminal subsystem rework | Re-architect live vs frozen frame capture and event transport for all modes. | Very large blast radius across Codex/Claude/Gemini. High regression risk and difficult to verify quickly. Not suitable while we only need OpenCode parity and targeted smoke coverage. |
| C *(recommended)* | Extend existing Live Mirror + focused harness with shared helpers | Localized scope: make OpenCode visible in Live Mirror flows and add shared, target-aware interaction scaffolding. Enables fast iteration and controlled risk. Mode-specific behavior can be added only if evidence shows it is required. | Chosen for this issue; aligns with minimal-risk, incremental parity and explicit acceptance gates. |

## Scope and architecture

### 1) OpenCode as a first-class Live Mirror target

OpenCode should be represented in every “terminal target” path that currently gates behavior by mode, including:

- target/eligibility checks for enabling Live Mirror UI affordances,
- backend live-frame endpoints and refresh code paths,
- modal/help labels and route handling that currently branch on terminal mode.

OpenCode should **not** get bespoke behavior by default.

- The initial implementation should **reuse shared Live Mirror logic**.
- We should introduce mode-specific handling only if investigation confirms it is needed after targeted telemetry/debug verification.

### 2) Live Mirror behavior contract for OpenCode

OpenCode should follow the existing contract used by other agent terminals, with explicit test focus on:

- **Scrollback fetch path**: when the user scrolls up from the bottom, Codeman should request historical frame data and render frozen history.
- **Scrollback freeze behavior**: while scrollback is active, it should not auto-jump to new live output.
- **Return-to-live behavior**: scrolling down to latest content should re-enter live mode and resume normal refresh updates.
- **Live refresh cadence/path**: OpenCode should consume the same periodic or pull-based live updates as other supported modes where applicable.
- **Mouse/touch interaction**: click/mouse event synthesis for terminal cells should be routed through existing shared pathways.
- **Resize after create**: terminal resize should still be validated immediately after session creation (to avoid stale geometry when mirroring first appears).

### 3) Browser smoke design by reusable target definitions

Replace target-specific duplication in browser smoke with a reusable descriptor model that includes:

- **target id** (`claude`, `codex`, `opencode`, `gemini`)
- **mode** and optional **display mode** settings
- **startup expectations** (modal name, session labels, endpoint expectations)
- **action sequence** (create, open tab, switch mode if needed, interaction checks)
- **API expectations** (expected payload/endpoint checks)
- **close modal label**
- **target-specific interaction checks**

This enables:

- **single-target execution** with explicit target filter,
- a shared core loop for common UI setup/teardown,
- easy extension when adding future terminal targets.

Proposed target descriptor fields (conceptual):

```ts
type SmokeTarget = {
  id: 'claude' | 'codex' | 'opencode' | 'gemini';
  label: string;
  mode: 'claude' | 'codex' | 'opencode' | 'gemini' | 'shell';
  startup: {
    createMode: 'shell' | 'agent';
    closeModalLabel: string;
    apiHealthCheck?: string;
  };
  expectations: {
    api: string[];
    uiText?: string[];
    modalText?: string;
  };
  actions: {
    scrollBack: boolean;
    returnToLive: boolean;
    mouseClick: boolean;
    resizeAfterCreate: boolean;
  };
};
```

### 4) Shared helper-first implementation boundary

- Keep shared helpers for:
  - session bootstrap,
  - modal lifecycle,
  - screenshot and assertion support,
  - scroll/refresh instrumentation,
  - terminal event payload inspection.

- Keep OpenCode-specific branching narrow and behind helper hooks only if needed by observed protocol differences.

## Testing design

### Browser smoke refactor

Split browser smoke into a reusable **target registry + execution loop**:

- The registry defines common and target-specific checks.
- `--target <mode>` (e.g., `--target opencode`) or `--targets <comma-separated>` (e.g., `--targets opencode,claude`) limits execution to one or more modes.
- Default remains multi-target behavior for broader manual validation.

OpenCode should gain dedicated smoke coverage that:

- does **not** wait for real model completion,
- does **not** validate model-answer content,
- validates only Codeman-owned behaviors:
  - live frame creation and refresh lifecycle,
  - scrollback fetch + freeze,
  - return-to-live behavior,
  - click/mouse event dispatch,
  - post-create resize.

Suggested assertions for OpenCode smoke:

1. Session starts in expected mode and appears with correct label.
2. Live Mirror UI state transition can be observed after create.
3. A backward scroll request switches from live view to historical/frozen view.
4. New output does not force live repaint while frozen.
5. A forward scroll restores live mirror behavior.
6. A terminal click dispatches the expected mouse protocol payload and updates interaction state.
7. Resize is captured and reflected after creation.

### Unit test alignment

Add/adjust focused unit tests for terminal interaction + API helper logic:

- terminal touch/click dispatch helpers,
- target descriptor filtering/selection,
- OpenCode-specific expectations in shared smoke utility functions.

### Verification notes

- Browser smoke tests are not in CI; therefore execution should be easy and repeatable locally.
- Include explicit examples in the spec/README comments for single-target runs so engineers can validate OpenCode independently.

## Boundaries (to avoid scope creep)

- Do **not** rewrite the terminal subsystem broadly.
- Do **not** modify Claude/Codex/Gemini behavior except through shared target-aware smoke harness and shared utility refactors.
- Do **not** depend on real OpenCode CLI/model responses in smoke assertions.
- Do **not** enable aggressive alt-screen stripping globally unless investigation proves it is required for OpenCode stability.
- Prefer shared helper/util updates over per-target duplicated test code.

## Risks

1. **OpenCode TUI differences** (cursor/line wrapping, alternate screen transitions, mouse mode toggles): may require per-mode mouse/scroll handling.
2. **Alt-screen or erase-sequence semantics** could cause history drift in historical frame rendering.
3. **Capture-refresh mismatch**: backend capture can lag or return partial frames when frontend is in frozen history mode.
4. **Smoke execution overhead**: because browser smoke is manual/external, maintain a deterministic single-target filter for fast debugging.

Mitigations:

- Start with shared-path behavior and gate mode-specific logic behind explicit evidence.
- Add focused assertions for frame boundaries and scroll state transitions.
- Keep one-command target filtering documented and default smoke timeouts short to support fast iteration.

## Verification plan

### Immediate manual verification

- Run target-filtered OpenCode browser smoke first.
- Confirm one-target stability before enabling full runs.
- Verify behavior against live session logs and API traces where available.

### CI-safe automated checks (repo test layer)

- Targeted terminal touch/click unit tests
- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm test -- test/routes/session-routes.test.ts` (if route/session logic is touched in implementation)

## Acceptance criteria (COD-207)

1. OpenCode is treated as a first-class Live Mirror target in frontend/backend eligibility and refresh paths.
2. OpenCode terminal sessions support:
   - scroll-up history fetch,
   - frozen scrollback while browsing history,
   - explicit return-to-live on scroll-down.
3. OpenCode-specific browser smoke validates Codeman-owned behavior and can be executed alone via target filter.
4. OpenCode smoke coverage includes mouse/click event assertions and post-create resize checks.
5. No broad terminal subsystem rewrite is introduced; only necessary shared-path updates and (if validated) narrowly-scoped mode-specific handlers are added.
6. No tests depend on real OpenCode model/assistant outputs.
