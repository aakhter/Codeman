# COD-354 Codex Needs-Input Alert Recovery Design

## Problem

COD-350 correctly prevents a quiet parent session from being classified as idle while background agents are still
working. Its activity coordinator also treats uncertain agent evidence as `checking_agents` and suppresses inferred
idle approvals. In production, an idle Codex TUI can keep repainting while no agents exist. Those frames repeatedly
invalidate the zero-agent settle window, leaving restored and remote Codex sessions in `checking_agents` indefinitely.
The confirmed Codex turn-end is then dropped before `commitRawIdle()`, so `/api/approvals`, browser pending hooks, and
the yellow needs-input tab alert all remain empty.

## Scope

This is a Codex-only correction. It must not weaken COD-350 for Claude sessions or for any session with affirmative
live-agent evidence. It does not redesign tab colors, approval storage, the Approvals drawer, or the browser alert
state machine.

## Chosen Approach

Restore the existing non-observable Codex turn-end path at the activity-coordination boundary. Codex sessions are not
routed through the Claude conversation watcher or Claude process inspection: local, remote, and Docker Codex adapters
therefore start as `not_observable`. A confirmed Codex `working -> idle` event may recover normal idle delivery when all
of the following are true:

1. the event is `raw_idle` with reason `turn-end`;
2. the session mode is `codex`;
3. the adapter is not eligible for Claude watcher/process evidence and remains `not_observable`;
4. no watcher/process result has classified the session as live; and
5. normal identity, terminal epoch, and event ordering fences are preserved.

Repeated terminal frames still invalidate timers and event-bound evidence, but they must not promote a non-observable
Codex adapter to `unknown`, because no Codex inspection can ever resolve that state. The adapter returns to
`not_observable`, and the existing synchronous `commitRawIdle()` path runs unchanged. That path creates the idle
approval, broadcasts `session:idle`, and lets the existing browser state machine render and persist the yellow
needs-input alert.

## Rejected Approaches

- Route Codex through Claude's conversation watcher. Codex has no Claude conversation identity, so this would create
  synthetic evidence and couple unrelated runtime protocols.
- Create the alert in browser code from `status=idle`. This duplicates server truth, does not survive reload reliably,
  and leaves `/api/approvals` and other devices inconsistent.
- Mark every unknown session non-observable. This would weaken real Claude watcher/process uncertainty and reintroduce
  false alerts while observable Claude background agents are active.

## Data Flow and Boundaries

`Session` continues emitting a reasoned raw idle event. `SessionAgentActivityCoordinator` continues owning agent
evidence, identity fencing, and bounded settlement. `session-listener-wiring` remains the only component that commits a
Codex inferred idle approval. The correction keeps non-observable Codex state out of the Claude-only unresolved
inspection state; it does not inspect watcher internals in the UI or listener layer.

Explicit permission and elicitation events remain immediate and continue to outrank derived activity. Observable
Claude sessions with live agents keep `waiting_agents`; genuinely uncertain Claude evidence may remain
`checking_agents` during the bounded check. Only a current Codex turn-end uses the non-observable direct path.

## Failure and Race Handling

- Stale results from an earlier identity, terminal epoch, semantic revision, or event sequence are ignored.
- New terminal activity still cancels timers, invalidates receipts, and aborts inspection before Codex returns to
  `not_observable`.
- A later terminal frame cannot resurrect a retired raw-idle event.
- Inspection errors do not fabricate zero-agent evidence.
- Restored sessions receive the same bounded behavior without treating startup quiet as a completed turn.

## Verification

Test-driven coverage will prove:

- repeated Codex idle TUI frames cannot strand a non-observable adapter in `checking_agents` and one turn-end commits
  one idle approval;
- restored and remote Codex sessions recover the alert after a real turn, but not on startup;
- observable Claude live-agent evidence still suppresses false idle approvals and projects `waiting_agents`;
- Claude behavior is byte-for-behavior unchanged across idle, permission, elicitation, and agent-wait cases;
- stale identity/epoch/revision evidence cannot release a newer event;
- `/api/approvals` seeds the same alert in a second browser context; and
- the deployed vertical rail receives `tab-alert-idle` without changing its CSS.

## Delivery

Implementation will use an isolated COD-354 branch, focused RED-to-GREEN tests, independent review, static/build gates,
an isolated realistic smoke, and live LAN acceptance before merge/deploy authorization is considered complete.
