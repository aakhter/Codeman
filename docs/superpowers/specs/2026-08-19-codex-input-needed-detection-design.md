# COD-337: Codex Input-Needed Detection

## Problem

Codeman currently treats the expiry of Codex's external-CLI quiet timer as proof that a turn ended. The timer can expire while Codex still renders a `Working` status, which emits an `idle` event and creates a false yellow input-needed alert.

Silence in the PTY stream is not sufficient evidence that Codex is waiting for input. Codex can remain silent during tool calls while its rendered terminal frame continues to show progress.

## Decision

Before the Codex quiet timer emits `idle`, it must inspect the current rendered pane and classify it using Codex-specific evidence:

- **Working:** a recognized Codex working or progress marker is visible. Preserve the working state and re-arm the quiet timer.
- **Input ready:** the Codex composer or a recognized approval/choice dialog is visible and no working marker is visible. Emit the existing `turn-end` idle event, which may create the yellow alert.
- **Unknown:** neither state is proven, or the pane cannot be captured. Preserve the working state and recheck later.

The classifier must give working evidence precedence because Codex can retain a composer-shaped row while a turn is still active.

## Implementation Shape

Add a small pure Codex frame classifier alongside the existing working-frame helpers in `src/session.ts`. Reuse the broader working detector already used by checkpoint sequencing. Reuse existing Codex prompt normalization and dialog-option parsing where practical rather than adding generic text heuristics.

Apply the classifier only in the Codex branch of `_armExternalCliIdleTimer()`. Other external CLIs retain their current quiet-timer behavior.

No UI changes are required: preventing the incorrect `idle` event prevents the approval inbox from producing the false yellow highlight at its source.

## Failure Handling

Pane capture failure and unrecognized frames are inconclusive, not idle. The timer rechecks on the existing bounded cadence. A later recognized prompt completes the transition; a later working frame continues to hold the working state.

## Tests

Focused regression coverage will verify:

1. A rendered Codex `Working` frame survives quiet-timer expiry without emitting idle.
2. A genuine Codex composer emits one `turn-end` idle event.
3. A recognized approval/choice dialog emits a `turn-end` idle event.
4. An unknown or unavailable frame does not emit idle.
5. Working evidence overrides a retained composer row.
6. Non-Codex external CLI behavior is unchanged.

## Scope

This change corrects Codex state inference and the resulting input-needed highlight. It does not redesign the approvals inbox, alter alert styling, or introduce transcript-semantic classification of natural-language responses.
