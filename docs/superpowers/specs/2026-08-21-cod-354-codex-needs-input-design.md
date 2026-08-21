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

Add a bounded Codex turn-end fallback at the activity-decision boundary. A confirmed Codex `working -> idle` event may
recover normal idle delivery when all of the following are true:

1. the event is `raw_idle` with reason `turn-end`;
2. the session mode is `codex`;
3. authoritative watcher/team evidence contains zero effective agents;
4. there is no affirmative process or visible-frame evidence of a live agent; and
5. the bounded zero-agent confirmation belongs to the current session identity, terminal epoch, and event sequence.

Repeated terminal frames may restart inspection, but they cannot postpone a current, authoritative zero-agent result
forever. Once the bounded confirmation succeeds, the existing `commitRawIdle()` path runs unchanged. That path creates
the idle approval, broadcasts `session:idle`, and lets the existing browser state machine render and persist the
yellow needs-input alert.

## Rejected Approaches

- Bypass activity coordination for every Codex idle event. This is small but reintroduces false alerts while Codex
  subagents are genuinely active.
- Create the alert in browser code from `status=idle`. This duplicates server truth, does not survive reload reliably,
  and leaves `/api/approvals` and other devices inconsistent.
- Disable subagent tracking for Codex. This loses useful `waiting_agents` presentation and weakens automation safety.

## Data Flow and Boundaries

`Session` continues emitting a reasoned raw idle event. `SessionAgentActivityCoordinator` continues owning agent
evidence, identity fencing, and bounded settlement. `session-listener-wiring` remains the only component that commits a
Codex inferred idle approval. The correction exposes enough decision information to distinguish bounded authoritative
zero from genuinely live or unresolved evidence; it does not inspect watcher internals in the UI or listener layer.

Explicit permission and elicitation events remain immediate and continue to outrank derived activity. A live agent
keeps `waiting_agents`; genuinely uncertain evidence may remain `checking_agents` during the bounded check. Only the
current zero-agent Codex turn-end receives the fallback.

## Failure and Race Handling

- Stale zero-agent results from an earlier identity, terminal epoch, semantic revision, or event sequence are ignored.
- New affirmative agent evidence cancels or invalidates the fallback.
- A later terminal frame cannot resurrect a retired raw-idle event.
- Inspection errors do not fabricate zero-agent evidence.
- Restored sessions receive the same bounded behavior without treating startup quiet as a completed turn.

## Verification

Test-driven coverage will prove:

- repeated Codex idle TUI frames with authoritative zero agents eventually commit one turn-end idle approval;
- restored and remote Codex sessions recover the alert after a real turn, but not on startup;
- live Codex subagents still suppress false idle approvals and project `waiting_agents`;
- Claude behavior is byte-for-behavior unchanged across idle, permission, elicitation, and agent-wait cases;
- stale identity/epoch/revision evidence cannot release a newer event;
- `/api/approvals` seeds the same alert in a second browser context; and
- the deployed vertical rail receives `tab-alert-idle` without changing its CSS.

## Delivery

Implementation will use an isolated COD-354 branch, focused RED-to-GREEN tests, independent review, static/build gates,
an isolated realistic smoke, and live LAN acceptance before merge/deploy authorization is considered complete.
