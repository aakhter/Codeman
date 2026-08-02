# COD-262: Race-free checkpoint fresh-thread handoff

**Issue:** COD-262

**Status:** Proposed design

**Date:** 2026-08-02

## Purpose

Checkpointing can currently race after `/clear`. Codeman considers a terminal-shaped prompt sufficient evidence that the
transition completed, sends `/init`, and then sends the continuation. In the observed incident, Codex had not yet accepted
the transition when the fixed eight-second step timeout expired. It later accepted `/init` in the replacement conversation,
turning an internal checkpoint step into an unintended user-visible task, while the intended continuation was never
delivered.

This design makes fresh-thread checkpoint handoff generation-aware, removes `/init`, adds `/new` as an explicit mode for
both Codex and Claude, and fences automation when a user takes control.

## Goals

- Support three explicit checkpoint modes: `compact`, `clear`, and `new`.
- Treat `/clear` and `/new` as asynchronous conversation transitions rather than terminal keystrokes.
- Identify the managed backend from Codeman's immutable `Session.mode` and use a backend-specific capability adapter.
- Confirm that a fresh conversation generation is active and ready before injecting the continuation.
- Deliver a continuation at most once, or report a terminal failure without a later stray write.
- Make manual user input take ownership immediately and cancel pending automated writes.
- Expose truthful request, running, completed, cancelled, and failed state to callers.
- Add focused regressions and disposable real-CLI smoke coverage for installed Codex and Claude versions.

## Non-goals

- Dynamically infer a backend from arbitrary commands manually launched inside a session shell. Codeman's configured
  `Session.mode` is authoritative; an unrecognized or mismatched backend fails closed.
- Persist raw continuation prompts for replay after a Codeman restart. Restart recovery aborts safely; durable encrypted
  continuation recovery is a separate design.
- Change the semantics of the backend commands themselves.
- Deploy to production as part of this issue. This substrate change lands on `local` as deploy-pending.

## User-visible semantics

| Mode      | Codex     | Claude    | Conversation    | Display         |
| --------- | --------- | --------- | --------------- | --------------- |
| `compact` | supported | supported | same generation | backend-defined |
| `clear`   | supported | supported | new generation  | cleared         |
| `new`     | supported | supported | new generation  | preserved       |

`/new` is therefore the screen-preserving fresh-thread option. `/clear` remains available when clearing the terminal is
desired. Both fresh-thread modes run the same identity and readiness checks. Neither path sends `/init`.

Other session modes may opt in only through a verified adapter. An unsupported mode returns a capability error before any
terminal input is sent.

## Considered approaches

### A. Backend capability adapters plus generation-aware state machine — recommended

Resolve command support from `Session.mode`, capture the current conversation generation, request the transition, observe
the new generation, wait for readiness, and inject through a fenced run. This directly models the asynchronous boundary and
provides a reliable foundation for both `/clear` and `/new`.

### B. Increase the existing timeout

A longer timeout would make the reported incident less frequent but would not prove that the active prompt belongs to the
new conversation. It also leaves `/init` exposed as an unintended task and still permits late writes after failure.

### C. Restart the backend process for every fresh checkpoint

A supervisor restart can create a strong boundary but adds process lifecycle risk, latency, and backend-specific recovery
behavior. It is disproportionate when both supported CLIs already expose fresh-conversation commands and observable
conversation identities.

## Design

### 1. Explicit mode and backend capabilities

Extend `CheckpointMode` to `compact | clear | new`. A checkpoint capability adapter selected from the immutable
`Session.mode` owns:

- the command for each supported mode;
- how to observe the active conversation generation;
- how to decide that the backend is ready for a new prompt;
- any backend-specific acceptance or failure signals.

The adapter lookup is explicit for Codex and Claude. It never guesses from terminal text. Capability validation happens
before mutation so unsupported mode/backend combinations cannot partially execute.

### 2. Conversation generation observation

`CheckpointObservation` gains an optional stable conversation identifier, separate from the existing rendered-prompt
revision. Observation may become asynchronous because authoritative identity can come from rollout or transcript metadata,
not only the terminal buffer.

For Codex, factor the existing active-rollout resolution used by the response-viewer routes into a shared read-only helper.
That resolver already handles ordinary turns and `/new`, `/resume`, and `/fork`; checkpointing consumes the same answer.

For Claude, the adapter reads the active conversation/transcript identity available from the installed CLI's history or
hooks. The implementation must prove this source in an isolated smoke test before enabling the adapter. If identity is
temporarily unavailable, an unchanged prompt is not accepted as proof of a new generation; the run keeps observing until a
bounded deadline and then fails closed.

### 3. State machine

Each invocation creates a unique `runId` and captures a baseline observation before sending any command.

For `compact`:

1. Validate capability and capture the baseline.
2. Send the compact command.
3. Wait for backend-specific acceptance and ready-for-input evidence.
4. Inject the continuation once through the current run fence.

For `clear` and `new`:

1. Validate capability and capture the baseline conversation generation.
2. Send the selected command exactly once.
3. Wait for transition acceptance.
4. Require an active conversation generation different from the baseline.
5. Require the new generation to be ready for user input.
6. Inject the continuation once through the current run fence.

There is no `/init` state. A fixed per-step eight-second timer is replaced with a bounded operation deadline and polling
that tolerates normal delayed transitions. The deadline is configurable for tests, and failures record the last observation
and reason without sending more input.

Identity is the authoritative fresh-thread gate; rendered readiness is the second gate. A prompt-shaped terminal alone is
never enough to satisfy a fresh-thread transition.

### 4. Run fencing and manual takeover

All automated writes carry the active `runId` and pass through one fenced write path. Before every write and after every
await, the operation verifies that its run is still active. Completion, cancellation, timeout, replacement by a newer run,
or server restart invalidates the fence, preventing late callbacks from writing.

User-originated input is distinguished from checkpoint-originated input at the session input boundary. If a user submits
input while a checkpoint handoff is active, Codeman atomically marks that run `cancelled: manual-takeover`, invalidates its
fence, and then accepts the user's input. No continuation from the cancelled run may arrive afterward.

### 5. Status and CLI behavior

The checkpoint request returns `runId` and an accepted state rather than implying completion. Durable in-memory session
state exposes, keyed by `runId`:

- `requested`
- `running`, with the current phase
- `completed`
- `cancelled`, with reason
- `failed`, with reason and the last safe observation

The agent-facing CLI remains request-only by default. This is necessary because a checkpoint requested from inside the
target agent cannot finish until that turn yields; waiting synchronously would deadlock the operation. Its output says
"requested" and includes the run ID.

An optional `--wait` mode polls status only for an external observer. If the target session equals
`CODEMAN_SESSION_ID`, the CLI refuses `--wait` with a clear deadlock explanation. Status polling always follows the returned
run ID so a subsequent checkpoint cannot be mistaken for the requested one.

### 6. Restart and sensitive data handling

A Codeman restart marks any restored in-flight checkpoint as failed/cancelled and performs no terminal write. Raw
continuation text is not persisted solely for checkpoint recovery. Persisted or logged diagnostic state may include a
payload hash and metadata, never the prompt body. This favors a visible safe failure over replaying sensitive or stale input
into an uncertain conversation.

## Failure behavior

- Unsupported backend or mode: reject before sending input.
- Baseline identity unavailable: fail closed before a fresh-thread command unless the adapter can establish an
  authoritative baseline by its deadline.
- Transition accepted but identity unchanged: continue observing until the operation deadline, then fail with no
  continuation.
- New identity observed but not ready: continue observing, then fail with no continuation.
- Manual input: cancel immediately and suppress all later automated writes.
- Server restart: cancel restored in-flight state and do not replay.
- Duplicate or late callback: run-fence check makes it a no-op.

## Verification strategy

Focused automated regressions will cover:

- a fresh-thread transition delayed beyond the old eight-second window;
- `/clear` and `/new` for both configured Codex and Claude modes;
- `/new` preserving display while still changing conversation identity;
- removal of every automatic `/init` write;
- prompt readiness appearing in the old conversation before identity changes;
- wrong-thread and unchanged-identity observations;
- unavailable identity and unsupported backend/mode failures;
- manual takeover before transition, during readiness polling, and immediately before continuation delivery;
- replacement by a newer checkpoint run;
- exactly-once continuation delivery despite repeated observations;
- timeout and late-callback suppression;
- restart cancellation without raw-prompt persistence;
- request-only CLI output, run-ID status polling, and refusal of self-targeted `--wait`.

Disposable isolated smoke tests will exercise the installed Codex and Claude CLIs, proving `/clear`, `/new`, the selected
conversation-identity source, display behavior, and readiness signals. They must never target the current managed session or
production. The final gate also runs the smallest relevant Vitest suites, typecheck, lint, formatting, lockfile validation,
and a production build in accordance with repository policy.

## Rollout and observability

Checkpoint status and failure logs include session ID, configured backend mode, checkpoint mode, run ID, phase, elapsed
time, baseline/current conversation identifiers in safely abbreviated form, and cancellation/failure reason. They exclude
continuation content.

The change lands on Bitbucket `local` after verification and Jira evidence, marked deploy-pending. Production deployment
requires separate authorization.

## Open implementation constraint

Claude `/new` support is part of the approved product behavior, but the exact authoritative conversation-identity source is
an adapter implementation detail that must be validated against the installed Claude CLI. If no stable source can be
proven, Claude fresh-thread checkpointing must remain fail-closed rather than falling back to terminal-shape heuristics.
