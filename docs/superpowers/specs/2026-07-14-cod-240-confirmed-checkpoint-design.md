# COD-240 Confirmed Agent Checkpoint State Machine

## Purpose

Make agent-initiated checkpoints advance only after Codeman has positive evidence that each terminal command was delivered, accepted, and completed. A checkpoint must never submit its continuation while the prior turn is still active, leave continuation text staged without Enter, or report `done` before the new turn starts.

This change covers both checkpoint modes:

- `compact`: `/compact` → continuation
- `clear`: `/clear` → `/init` → continuation

It must preserve Claude behavior while fixing the observed Codex races.

## Current Failure Boundaries

The investigation confirmed three independent faults.

1. `SessionAutoOps` equates `!isWorking()` with readiness. Codex working detection is intentionally quiet-window based, so a false idle can exist while a turn is active.
2. The checkpoint driver treats both “operation never started” and “operation exceeded its maximum runtime” as success. It also ignores `writeCommand()` returning `false`, including the final continuation write.
3. `TmuxManager.sendInput()` sends text and Enter in separate tmux calls but collapses their outcomes into one boolean. A successful text write followed by a failed Enter cannot be recovered without risking duplicated text.

The installed `aicodeman` executable also points to ignored `app/dist`. The observed executable was stale and dereferenced `body.data` when the checkpoint HTTP request returned `null`, even though current TypeScript source uses optional access. Verification must therefore exercise the built CLI artifact, not source helpers alone.

## Chosen Architecture

Keep checkpoint orchestration in `SessionAutoOps`, but replace its implicit idle loop with an explicit, observable state machine. `Session` supplies positive terminal observations, and a checkpoint-specific command-delivery boundary supplies stage-aware acknowledgements.

This is smaller and safer than moving checkpoint ownership into `Session` events or scripting the entire sequence inside tmux. It keeps policy in `SessionAutoOps`, terminal interpretation in `Session`, and transport details in `TmuxManager`.

### State machine

Each request progresses through these externally observable phases:

1. `requested`
2. `waiting-ready`
3. `command-submitted`
4. `operation-started`
5. `operation-complete`
6. `continue-submitted`
7. `done`

It may terminate early as:

- `failed`: delivery, readiness, acceptance, completion, or new-turn confirmation timed out or returned a negative acknowledgement
- `aborted`: the session stopped or checkpoint processing was destroyed

`done` means the continuation was submitted and a new agent turn positively entered working state. It does not merely mean the continuation text reached tmux.

For clear mode, phases 2–5 repeat for `/clear` and `/init` before the continuation phases.

### Terminal observation contract

`SessionAutoOps` receives a checkpoint probe rather than inferring readiness from `!isWorking()`:

```ts
interface CheckpointObservation {
  ready: boolean;
  working: boolean;
  revision: number;
}
```

`Session` derives this observation from the rendered visible pane when a tmux session exists:

- Claude is ready only when a rendered `❯` prompt is present and no working evidence is present.
- Codex is ready only when its rendered `›` input prompt is present and no Codex working frame is present. Claude and Codex are the required modes for this change; existing behavior for other modes is preserved behind the same pluggable probe boundary rather than inventing unverified prompt markers.
- `working` continues to use the existing mode-aware working detection.
- `revision` is a semantic prompt generation, not a raw repaint counter. It advances when the observed state leaves ready and later returns to ready. A continuously ready prompt, status-line repaint, or unrelated frame update does not advance it.

Direct-PTY fallback remains available for Claude. It uses the existing positive prompt/working state recorded by `Session`, not a generic inverse-working check. Codex continues to require tmux.

Before submitting any checkpoint step, the driver waits for `ready: true`. After submission, the operation must leave the baseline prompt—by entering working state or another non-ready rendered state—and later reach a fresh ready observation. Remaining continuously ready until timeout is failure, not a no-op success. Remaining working until timeout is also failure.

The continuation has a stricter confirmation: after successful delivery, the driver must observe `working: true`. A prompt redraw alone cannot complete the checkpoint because the acceptance criterion is that the new turn started.

### Stage-aware command delivery

Add a checkpoint-specific command submission API without changing the broad `sendInput(): Promise<boolean>` contract used elsewhere.

The new result distinguishes transport stages:

```ts
type CommandDeliveryResult =
  | { ok: true }
  | { ok: false; stage: 'text' | 'enter'; error?: string };
```

Delivery behavior is bounded and duplicate-safe:

- If the text stage fails, retry the full text-plus-Enter submission once because no text was acknowledged.
- If text succeeds but Enter fails, retry Enter only once. Never resend the text.
- If either retry fails, return the failed stage and terminate the checkpoint as `failed`.
- Enter-only commands use the same acknowledgement path.
- Test mode remains a no-op success.

`Session` exposes this as the checkpoint driver's command callback. Other input paths continue using the existing boolean API, limiting regression risk.

## Events, Status, and Logging

Reuse the existing additive `session:checkpoint` SSE event rather than introducing a second event name. Each payload includes:

- `sessionId`
- `mode`
- `phase`
- `step` when applicable (`compact`, `clear`, `init`, or `continue`)
- `attempt` for delivery retries
- `reason` and `stage` for failure/abort

`SessionAutoOps` emits every phase transition. `Session` forwards one checkpoint progress event, and the existing listener wiring broadcasts it. Session state retains the most recent checkpoint record—`active`, `phase`, `mode`, optional `step`/`reason`, and `updatedAt`. Terminal phases set `active: false` but remain visible until the next request, so status queries distinguish `done`, `failed`, and `aborted` without appearing stuck.

Logs use the same phase/reason vocabulary. No error path emits `done`.

## CLI Behavior

The CLI continues to report that a checkpoint was *requested* when the API accepts it; it does not claim asynchronous completion. Null, non-JSON, failed, or malformed API responses produce a specific non-zero error rather than falling through to “not enabled” or throwing.

Because `dist` is ignored, the regression test and release verification build the project and execute the built CLI against a controlled local HTTP response. Source-only tests are insufficient for this boundary.

The exact Codex continuation remains literal:

```sh
aicodeman checkpoint --continue '$jira-autoloop'
```

No slash-prefixed Codex command is introduced.

## Error and Cancellation Rules

- Busy, disabled, stopped, and disallowed-mode requests retain their current synchronous refusal reasons.
- A session stop at any asynchronous phase aborts the sequence, clears timers/state, emits `aborted`, and never submits later commands.
- A false-idle observation cannot inject a command because readiness requires a positive prompt observation.
- Failure to deliver or confirm a checkpoint step prevents all later steps and continuation.
- Failure to deliver continuation or confirm a new working turn emits `failed`; it never emits `done`.
- All waits are bounded. Expiry is reported as a named failure reason, never treated as success.

## Test Strategy

### State-machine unit tests

Extend `test/session-checkpoint.test.ts` with RED tests for:

- busy session waits for a positive ready prompt
- false idle without a prompt cannot inject
- delayed readiness eventually submits once
- checkpoint command delivery failure prevents continuation
- operation that never leaves the prompt fails
- operation that starts but never completes fails
- continuation delivery failure prevents `done`
- continuation submitted but no new working transition prevents `done`
- stop/destroy during every wait class aborts without later writes
- compact and clear modes follow their complete ordered phase sequences
- Claude and Codex observation paths preserve their mode-specific prompts

### Faithful transport integration test

Exercise the real command-splitting adapter with a controlled tmux executor:

- text success + Enter success
- text failure + full retry
- text success + Enter failure + Enter-only retry
- repeated Enter failure returns `{ ok: false, stage: 'enter' }`
- command ordering proves text is not duplicated after an Enter-only failure

This test must use the production adapter boundary, not a pure `writeCommand` mock.

### CLI regression

Build the project, run the built checkpoint CLI against controlled null/non-JSON and valid API responses, and assert clean non-zero/zero outcomes without an unhandled rejection.

### Orchestrator verification

Run the smallest relevant Vitest files plus typecheck, lint, formatting, lockfile, and production build checks. Then start an isolated beta instance with a distinct data directory and tmux socket, create a disposable Codex session, and run the exact checkpoint command. Observe the full requested → done sequence and the fresh `$jira-autoloop` turn. Production remains untouched.

## Scope Boundaries

In scope:

- confirmed checkpoint sequencing
- rendered prompt readiness needed by checkpoints
- stage-aware checkpoint command delivery
- checkpoint lifecycle events/status
- defensive built-CLI behavior
- focused documentation and regression coverage

Out of scope:

- changing generic user input semantics
- redesigning all auto-compact, auto-clear, or auto-resume flows
- changing Codex or Claude working detection beyond the positive checkpoint probe
- production deployment
- unrelated terminal or response-viewer behavior

## Acceptance Mapping

- Busy waits and false idle cannot inject: positive `ready` probe before every step.
- Operation not accepted cannot pass: a post-submit transition away from the baseline prompt is mandatory.
- Continue is submitted and starts a turn: delivery acknowledgement plus positive working transition.
- Partial text/Enter failures are detected: structured result with Enter-only retry.
- Failed checkpoint never continues: terminal `failed`/`aborted` states stop the sequence.
- Compact and clear both work: ordered per-step state-machine coverage.
- Claude does not regress: mode-aware prompt observation and targeted tests.
- Status/events/logs distinguish lifecycle: additive checkpoint phases and reasons.
- Mock-only blind spot is closed: production adapter integration plus isolated real-Codex smoke.
