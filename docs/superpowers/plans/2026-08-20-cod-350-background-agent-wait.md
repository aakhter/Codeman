# COD-350 Background-Agent Wait Implementation Plan

> **For Codex:** Execute this plan with `superpowers:subagent-driven-development`, one task at a time. For every task,
> write the named focused tests first, run them to observe the intended failure, implement the smallest production
> change, rerun the focused tests, and commit before moving on. Never run bare `npm test` in a Codeman-managed session.

**Goal:** Keep local Claude sessions with live background agents out of idle/Approvals/automation and show a distinct,
canonical waiting-on-agents state across Codeman.

**Architecture:** `SubagentWatcher` becomes the composite-identity evidence authority. A new
`SessionAgentActivityCoordinator`, owned by `WebServer`, converts watcher/process/pane evidence into a runtime-only
session projection and one autonomous-availability predicate. Raw persisted `Session.status` remains unchanged;
`WebServer.getSessionStateWithRespawn()` adds the effective wire fields. Hook, wait, respawn, and browser consumers use
the coordinator projection rather than independently interpreting raw idle.

**Tech stack:** TypeScript ESM, Node.js process/filesystem APIs, Fastify routes, EventEmitter, browser JavaScript/CSS,
Vitest, existing DOM/browser harnesses.

**Design:** `docs/superpowers/specs/2026-08-20-cod-350-background-agent-wait-design.md`

---

## Task 1: Establish canonical identities and runtime activity contracts

**Files:**

- Create: `src/claude-project-identity.ts`
- Modify: `src/types/session.ts`
- Modify: `src/session.ts`
- Create: `test/claude-project-identity.test.ts`
- Modify: `test/session.test.ts`

**Step 1: Write failing identity and projection tests**

Cover lexical path normalization for redundant separators, `.` segments, and trailing separators while preserving
symlink spelling; Claude project-hash generation; collision-safe opaque serialization of
`(projectHash, claudeSessionId, agentId)`; runtime projection setter/getter behavior; timestamp clearing; and terminal
activity-epoch advancement. Prove derived fields do not appear in `Session.toState()`. Exhaustive projection belongs to
the coordinator in Task 4.

**Step 2: Run the RED tests**

Run:

```bash
npm test -- test/claude-project-identity.test.ts test/session.test.ts
```

Expected: failures because the shared identity helpers, activity types, and Session runtime projection do not exist.

**Step 3: Implement the smallest contracts**

Add `normalizeClaudeProjectPath()`, `claudeProjectHash()`, and an opaque `serializeSubagentKey()`/parser. Add
`SessionActivityStatus`, `AgentObservation`, and `SessionActivityProjection` types. Give `Session` runtime-only getters
and a setter for the projection plus a terminal activity epoch that advances on output, submission, and working
transitions. Keep raw `status`, `isIdle()`, `isBusy()`, `isWorking`, and `toState()` semantics unchanged in this task.

**Step 4: Run GREEN tests and commit**

Run the Task 1 command again, then:

```bash
git add -- src/claude-project-identity.ts src/types/session.ts src/session.ts test/claude-project-identity.test.ts test/session.test.ts
git commit -m "feat(activity): COD-350 add agent activity contracts"
```

## Task 2: Make the watcher composite-keyed and preserve live semantics

**Files:**

- Modify: `src/subagent-watcher.ts`
- Modify: `src/web/routes/system-routes.ts`
- Modify: `test/subagent-watcher.test.ts`
- Modify: `test/routes/system-routes.test.ts`

**Step 1: Write failing watcher and route tests**

Prove two agents with the same bare `agentId` in different project/conversation tuples coexist; same-directory parallel
Claude conversations remain isolated; meta-to-transcript upgrade changes one composite record; bare-ID mutation rejects
ambiguity; and exact identity lookup returns only active/idle agents for that conversation. Add RED cases showing that
startup age filtering is bypassed by targeted reconciliation, live records survive history cleanup/manual clear, and
overflow marks only the affected parent unknown.

Add route tests requiring the clear endpoint to remove completed history only and return a canonical `remaining`
live-agent snapshot carrying `agentKey`.

Cover every affected route explicitly: exact-conversation `/api/sessions/:id/subagents`; opaque-key metadata,
transcript, and kill routes; unambiguous legacy bare-ID fallback; and ambiguous bare-ID rejection. A same-directory peer
conversation must never appear in or be mutated through another session's route.

**Step 2: Run the RED tests**

```bash
npm test -- test/subagent-watcher.test.ts test/routes/system-routes.test.ts
```

Expected: bare-ID collisions, broad working-directory lookup, and destructive clear behavior fail the new assertions.

**Step 3: Implement composite storage and lifecycle events**

Key `agentInfo`, pending calls, idle timers, file context, and emitted payloads by `agentKey`. Add exact identity lookup,
targeted age-cutoff-free reconciliation, ambiguity-aware legacy lookup, and semantic revision/reset/overflow events.
Separate live semantic records from completed display history; never TTL/LRU-evict positively live records. Change clear
to retain active/idle records and return the live snapshot.

**Step 4: Run GREEN tests and commit**

```bash
npm test -- test/subagent-watcher.test.ts test/routes/system-routes.test.ts
git add -- src/subagent-watcher.ts src/web/routes/system-routes.ts test/subagent-watcher.test.ts test/routes/system-routes.test.ts
git commit -m "refactor(subagents): COD-350 key lifecycle by conversation"
```

## Task 3: Add authoritative process and visible-frame evidence

**Files:**

- Create: `src/subagent-process-inspector.ts`
- Create: `src/claude-background-agent-frame.ts`
- Create: `test/subagent-process-inspector.test.ts`
- Create: `test/claude-background-agent-frame.test.ts`

**Step 0: Capture evidence from the supported installed Claude build**

Before writing parser fixtures, inspect the installed Claude version and capture safely redacted process environment,
arguments, cwd/process tree, sidecar/transcript, and visible-frame shapes from a real local background-agent run. Never
commit prompts, credentials, usernames, or unrelated environment values. Reduce the evidence to the minimum allowlisted
field/role/renderer fixtures needed by the tests. If the supported build exposes no authoritative process-role or
current-frame signature, stop and return to the design gate rather than inventing a synthetic-only signature. Use the
`session-bridge` skill for any disposable Codeman-managed Claude evidence session and clean up only that exact session.

**Step 1: Write failing evidence tests**

For process inspection, cover NUL-delimited environment/argument parsing, verified `--flag value` and `--flag=value`
forms, exact conversation matching, cwd device/inode matching, supported executable/agent-role signature, and parent
process exclusion. Include negative fixtures for substring collisions, the `CODEMAN_MUX` parent, matching-session hook
helpers, and generic inherited Claude children. Unreadable process data must be unknown; a complete scan with no exact
match must be negative; abort must reject late results.

For pane evidence, accept only a source-tagged current visible tmux frame with an anchored bottom-region Claude
background-agent renderer and matching positive count. Reject raw-buffer fallback, scrollback, quoted text, stale
markers, count mismatch, and unrecognized wording.

**Step 2: Run the RED tests**

```bash
npm test -- test/subagent-process-inspector.test.ts test/claude-background-agent-frame.test.ts
```

Expected: failures because existing liveness uses substring matching and has no source-aware frame parser.

**Step 3: Implement the isolated evidence services**

Return `positive | negative | unknown` from the pure process inspector. Define an `ObservableClaudeIdentity` input that
contains the authoritative Session identity, `workingDir`, project hash, and Claude conversation ID; the inspector does
not own or discover that registry. Keep aggregate proof scoped to the exact project and conversation; do not mark every
semantic agent individually alive unless the supported process signature exposes an exact agent ID. Make child-process
and filesystem reads abortable where supported and always ignore late aborted results. Defer watcher/coordinator wiring
to Task 6, after the observable registry exists.

**Step 4: Run GREEN tests and commit**

```bash
npm test -- test/subagent-process-inspector.test.ts test/claude-background-agent-frame.test.ts
git add -- src/subagent-process-inspector.ts src/claude-background-agent-frame.ts test/subagent-process-inspector.test.ts test/claude-background-agent-frame.test.ts
git commit -m "feat(subagents): COD-350 add authoritative wait evidence"
```

## Task 4: Build the activity coordinator and bounded scheduler

**Files:**

- Create: `src/session-agent-activity-coordinator.ts`
- Create: `test/session-agent-activity-coordinator.test.ts`

**Step 1: Add RED state-machine tests in small groups**

Test and implement in order. For each numbered group, add only that group's RED assertions, run the file and observe the
specific failure, implement the minimum GREEN slice, rerun, and only then add the next group:

1. `none`, `live`, `unknown`, and `not_observable` projection; exhaustive pass-through for every `SessionStatus`; raw
   busy/error/stopped/parked precedence; symmetric `waiting_agents`/`checking_agents` episode timestamps.
2. Exact project/conversation isolation and ambiguous identity behavior.
3. Synchronous pending state on startup/re-enable/new identity.
4. Invalidation by Session object, Claude identity, tracking generation, terminal activity epoch, semantic revision, and
   expired decision token.
5. One coordinator event sequence for raw idle, stop, idle prompt, permission, and elicitation; completion watermark and
   quarantine behavior.
6. Deadline/abort/late-result rejection and per-session single-flight.
7. Retry at 250 ms, 1 s, 5 s, then capped 30 s; one immediate retry per meaningful semantic revision.
8. Scheduler concurrency four, at most three background jobs, reserved foreground capacity, bounded three-job priority
   burst, FIFO order, and no starvation.
9. Final-agent settle using `IDLE_SILENCE_MS`, output cancellation, new-agent supersession, exact-zero early end, and
   stale timer rejection.
10. Cleanup of queue consumers, retries, quarantines, watermarks, and settle timers.

**Step 2: Run the RED test file**

```bash
npm test -- test/session-agent-activity-coordinator.test.ts
```

Expected: the coordinator module is absent.

**Step 3: Complete each tested slice**

Keep evidence collection injected. Jobs return evidence only; they never mutate sessions directly. Only a still-live
decision token may commit after every generation/revision/epoch check. Separate human-presentation decisions from the
autonomous availability dimension so unknown shows genuine prompts but blocks autonomous actions. Maintain the exact
observable-session registry here so inspection receives the Session object, working directory, project hash, and
Claude identity from one authoritative mapping.

**Step 4: Run GREEN tests and commit**

```bash
npm test -- test/session-agent-activity-coordinator.test.ts
git add -- src/session-agent-activity-coordinator.ts test/session-agent-activity-coordinator.test.ts
git commit -m "feat(activity): COD-350 coordinate background-agent waits"
```

## Task 5: Gate all server-side idle automation with one predicate

**Files:**

- Modify: `src/session.ts`
- Modify: `src/session-manager.ts`
- Modify: `src/session-auto-ops.ts`
- Modify: `src/respawn-controller.ts`
- Modify: `test/session.test.ts`
- Modify: `test/session-manager.test.ts`
- Modify: `test/session-auto-resume.test.ts`
- Create: `test/session-auto-ops-availability.test.ts`
- Modify: `test/respawn-controller.test.ts`

**Step 1: Write RED availability tests**

Add `Session.isAutonomouslyIdle()`/`blocksIdleAutomation` expectations while preserving raw status helpers. Prove live
and unknown sessions are excluded from `SessionManager.getIdleSessions()`, while `not_observable` delegates to legacy
raw idle. Cover auto-resume plus auto-compact, auto-clear, checkpoint readiness, and their delayed retry writes for both
`live` and `unknown` in the dedicated availability file. Prove respawn rejects both hook and heuristic confirmations
while blocked and cancels an already-armed confirmation when agent activity begins.

**Step 2: Run RED tests**

```bash
npm test -- test/session.test.ts test/session-manager.test.ts test/session-auto-resume.test.ts test/session-auto-ops-availability.test.ts test/respawn-controller.test.ts
```

Expected: raw `isWorking`/`isIdle` checks still permit allocation or automation.

**Step 3: Implement the shared predicate**

Use the Session runtime projection from Task 1. Do not overload raw `isWorking`, because manual input and terminal truth
still depend on it. Gate allocation, auto-ops, and both early and final respawn confirmation paths. Add an explicit
respawn cancellation method called when the projection becomes waiting/checking.

**Step 4: Run GREEN tests and commit**

```bash
npm test -- test/session.test.ts test/session-manager.test.ts test/session-auto-resume.test.ts test/session-auto-ops-availability.test.ts test/respawn-controller.test.ts
git add -- src/session.ts src/session-manager.ts src/session-auto-ops.ts src/respawn-controller.ts test/session.test.ts test/session-manager.test.ts test/session-auto-resume.test.ts test/session-auto-ops-availability.test.ts test/respawn-controller.test.ts
git commit -m "fix(automation): COD-350 block idle actions during agent work"
```

## Task 6: Integrate coordinator ownership, lifecycle, readiness, and wire state

**Files:**

- Modify: `src/web/server.ts`
- Modify: `src/subagent-watcher.ts`
- Modify: `src/web/session-listener-wiring.ts`
- Modify: `src/services/unified-session-service.ts`
- Modify: `src/web/routes/session-routes.ts`
- Create: `src/web/ports/agent-activity-port.ts`
- Modify: `src/web/ports/index.ts`
- Modify: `src/web/ports/session-port.ts`
- Modify: `src/web/routes/system-routes.ts`
- Modify: `test/mocks/mock-route-context.ts`
- Create: `test/session-agent-activity-server.test.ts`
- Modify: `test/subagent-watcher.test.ts`
- Modify: `test/session-listener-wiring.test.ts`
- Modify: `test/session-cleanup.test.ts`
- Modify: `test/routes/system-routes-settings-partial-put.test.ts`
- Modify: `test/services/unified-session-service.test.ts`
- Modify: `test/routes/unified-sessions-routes.test.ts`

**Step 1: Write RED server integration tests**

Prove `WebServer` attaches a local Claude session as unknown before external availability, reconciles restored/new/
re-identified sessions without the history age cutoff, and handles sessions created during enable. Verify remote or
unobservable container sessions are `not_observable`. Require watcher events to update the coordinator before agent SSE,
invalidate the light-session cache, append always-emitted `activityStatus`/`activityStatusSince` in
`getSessionStateWithRespawn()`, and resolve only stale idle approvals on discovery.

For multi-user mode, coordinator-mapped `subagent:*` broadcasts carry a trusted Codeman session/owner routing hint
separately from the Claude conversation ID used by agent visualization. Prove the owning non-admin receives only their
event and a peer owner's event is filtered.

Wire the Task 3 inspector here using the coordinator's `ObservableClaudeIdentity` registry; neither watcher nor inspector
may guess `workingDir`. Replace the watcher's substring liveness path and test positive/negative/unknown propagation from
the injected identity provider.

Add explicit integration cases for terminal output, input submission, and working transitions. Each must advance the
Session activity epoch, notify the coordinator, cancel final-agent settle when required, recompute projection, and
broadcast the resulting state rather than waiting for a later watcher poll. Extend the existing session-listener wiring;
do not add parallel duplicate Session listeners in `WebServer`.

Cover tracking disable/re-enable, one derived idle edge on disable when raw idle, identity replacement, PTY exit,
session deletion, watcher reset, and server shutdown. Add the existing cleanup regression: kill subagents with
`session.claudeSessionId`, never the Codeman session ID.

Add RED coverage for `/api/sessions/unified`, which currently bypasses `getSessionStateWithRespawn()` and builds its live
input from `Session.toState()`. Require optional activity fields on `LiveSessionInput`/`UnifiedSessionItem`, live-source
precedence during merge, and the same derived values on unified reload/search results without persisting them.

**Step 2: Run RED tests**

```bash
npm test -- test/session-agent-activity-server.test.ts test/subagent-watcher.test.ts test/session-listener-wiring.test.ts test/session-cleanup.test.ts test/routes/system-routes-settings-partial-put.test.ts test/services/unified-session-service.test.ts test/routes/unified-sessions-routes.test.ts
```

Expected: no coordinator owner/port exists, wire state lacks derived fields, and lifecycle cleanup is incomplete.

**Step 3: Wire the server and settings lifecycle**

Own one coordinator in `WebServer`; expose the minimal activity port to routes/listeners. Replace bare generic watcher
toggle handling with coordinator-aware enable/disable. Attach/detach synchronously around session visibility and cleanup.
Keep derived state out of persistence. Broadcast a full session update on projection change and invalidate both cached
light state and any per-session debounced snapshot. Feed the runtime projection explicitly into unified-session live
inputs and let the existing live-source overwrite rules carry it into merged items.

**Step 4: Run GREEN tests and commit**

```bash
npm test -- test/session-agent-activity-server.test.ts test/subagent-watcher.test.ts test/session-listener-wiring.test.ts test/session-cleanup.test.ts test/routes/system-routes-settings-partial-put.test.ts test/services/unified-session-service.test.ts test/routes/unified-sessions-routes.test.ts
git add -- src/web/server.ts src/subagent-watcher.ts src/web/session-listener-wiring.ts src/services/unified-session-service.ts src/web/routes/session-routes.ts src/web/ports/agent-activity-port.ts src/web/ports/index.ts src/web/ports/session-port.ts src/web/routes/system-routes.ts test/mocks/mock-route-context.ts test/session-agent-activity-server.test.ts test/subagent-watcher.test.ts test/session-listener-wiring.test.ts test/session-cleanup.test.ts test/routes/system-routes-settings-partial-put.test.ts test/services/unified-session-service.test.ts test/routes/unified-sessions-routes.test.ts
git commit -m "feat(server): COD-350 publish coordinated agent activity"
```

## Task 7: Make hooks, Approvals, idle events, and wait routes coherent

**Files:**

- Modify: `src/web/routes/hook-event-routes.ts`
- Modify: `src/web/session-listener-wiring.ts`
- Modify: `src/web/approval-inbox.ts`
- Modify: `src/web/sse-events.ts`
- Modify: `src/web/routes/session-routes.ts`
- Modify: `src/web/ports/agent-activity-port.ts`
- Modify: `test/routes/hook-event-routes.test.ts`
- Modify: `test/session-listener-wiring.test.ts`
- Modify: `test/approval-inbox.test.ts`
- Modify: `test/sse-events.test.ts`
- Modify: `test/routes/session-wait-routes.test.ts`
- Modify: `test/routes/session-input-wait.test.ts`

**Step 1: Write RED hook and ordering tests**

Cover process-backed stop suppression; process-backed or exact visible-frame idle-prompt suppression; sidecar-only stop
fall-through; timeout/read-error human fail-open plus autonomy fail-safe; immediate raw stop waiter delivery; and the
complete `hook:suppressed` payload/routing. Assert suppression emits no legacy hook event, push, approval, pending-hook
effect, response-complete effect, or respawn signal, while the run summary still records the raw hook.

Add source sequence to Approval items. Prove stop resolves only older/equal items; delayed idle prompt/raw idle cannot
commit after a newer completion watermark; permission and elicitation remain immediate; discovery clears only idle-kind
items; and a delayed final file write cannot escape stop quarantine.

**Step 2: Write RED idle/wait tests**

Prove live/unknown raw idle neither broadcasts legacy `session:idle` nor resolves idle waiters. A final derived-none edge
must resolve a fresh waiter exactly once after settle. `currentSignalFor()` and duplicate/immediate input paths must not
return raw idle while autonomy is blocked. Suppressed stop must still resolve `until=stop`; dead-worker exit still wins;
`not_observable` preserves legacy behavior.

**Step 3: Run the RED files**

```bash
npm test -- test/routes/hook-event-routes.test.ts test/session-listener-wiring.test.ts test/approval-inbox.test.ts test/sse-events.test.ts test/routes/session-wait-routes.test.ts test/routes/session-input-wait.test.ts
```

Expected: current routes apply hook effects before agent evidence and immediate waits trust raw idle.

**Step 4: Implement ordered effects**

Allocate the shared coordinator sequence at receipt. For stop, notify raw stop waiters and record the summary before any
await. Apply normal or suppressed presentation only through a current decision token. Add `sourceSequence` and bounded
resolution to Approvals. Delegate raw-idle effects to the coordinator without making the EventEmitter listener itself
an unguarded async handler. Consult `isAutonomouslyIdle()` for immediate wait projection.

**Step 5: Run GREEN tests and commit**

```bash
npm test -- test/routes/hook-event-routes.test.ts test/session-listener-wiring.test.ts test/approval-inbox.test.ts test/sse-events.test.ts test/routes/session-wait-routes.test.ts test/routes/session-input-wait.test.ts
git add -- src/web/routes/hook-event-routes.ts src/web/session-listener-wiring.ts src/web/approval-inbox.ts src/web/sse-events.ts src/web/routes/session-routes.ts src/web/ports/agent-activity-port.ts test/routes/hook-event-routes.test.ts test/session-listener-wiring.test.ts test/approval-inbox.test.ts test/sse-events.test.ts test/routes/session-wait-routes.test.ts test/routes/session-input-wait.test.ts
git commit -m "fix(hooks): COD-350 suppress false agent-wait approvals"
```

## Task 8: Add one browser activity resolver and update every status surface

**Files:**

- Modify: `src/web/public/constants.js`
- Modify: `src/web/public/mobile-overview.js`
- Modify: `src/web/public/home-sessions.js`
- Modify: `src/web/public/app.js`
- Modify: `src/web/public/panels-ui.js`
- Modify: `src/web/public/session-lineage.js`
- Modify: `src/web/away-digest.ts`
- Modify: `src/web/public/styles.css`
- Modify: `src/web/public/mobile.css`
- Modify: `src/cli.ts`
- Modify: `test/session-overview-order.test.ts`
- Modify: `test/mobile-overview.test.ts`
- Modify: `test/home-sessions.test.ts`
- Modify: `test/session-list-layout.test.ts`
- Modify: `test/tab-layout-app.test.ts`
- Modify: `test/command-palette-ui.test.ts`
- Modify: `test/monitor-tab-sync.test.ts`
- Modify: `test/away-digest.test.ts`
- Modify: `test/away-digest-ui.test.ts`
- Modify: `test/cli-commands.test.ts`
- Modify: `test/cli-mux-table.test.ts`

**Step 1: Write RED pure resolver/order tests**

Add a shared `CodemanSessionActivity` API for effective wire state, overview state, compact/expanded labels, ARIA, and
sort anchor. Assert exact priority, old payload fallback, parked's unchanged overview behavior, agent-episode timestamp,
and oldest-first ordering for waiting/checking.

Run and green this pure resolver slice before adding any surface tests.

**Step 2: Write RED surface tests**

Require full and incremental tab paths, mobile/home/rich sidebar, monitor, lineage, command-palette subtitle/search,
away digest, CLI list/status output, and user-facing counts to consume effective activity with raw-status fallback.
Expanded labels are `WAITING ON AGENTS`/`CHECKING AGENTS`; compact labels are `AGENTS`/`CHECKING`. Agent states must
have distinct classes, `data-activity-status`, accessible names, and themed status badges. Away digest classifies them as
still running.

Add and green one surface family at a time: mobile/home/rich sidebar; full/incremental tabs and ARIA; monitor/lineage;
palette/search/CLI; away digest; then CSS/reduced motion. Keep the task-level commit boundary, but do not batch all RED
assertions before the first implementation change.

**Step 3: Run RED frontend tests**

```bash
npm test -- test/session-overview-order.test.ts test/mobile-overview.test.ts test/home-sessions.test.ts test/session-list-layout.test.ts test/tab-layout-app.test.ts test/command-palette-ui.test.ts test/monitor-tab-sync.test.ts test/away-digest.test.ts test/away-digest-ui.test.ts test/cli-commands.test.ts test/cli-mux-table.test.ts
```

Expected: raw `session.status` paths render idle and no agent-state styles exist.

**Step 4: Implement resolver, surfaces, and accessible styling**

Use the existing themed `--session-purple` token. Waiting may use a calm slow pulse; checking stays visually quieter.
Under `prefers-reduced-motion: reduce`, remove animation while retaining text/color/border distinctions. Keep the status
dot decorative and include the effective state in the tab's accessible name.

**Step 5: Run GREEN tests and commit**

```bash
npm test -- test/session-overview-order.test.ts test/mobile-overview.test.ts test/home-sessions.test.ts test/session-list-layout.test.ts test/tab-layout-app.test.ts test/command-palette-ui.test.ts test/monitor-tab-sync.test.ts test/away-digest.test.ts test/away-digest-ui.test.ts test/cli-commands.test.ts test/cli-mux-table.test.ts
git add -- src/web/public/constants.js src/web/public/mobile-overview.js src/web/public/home-sessions.js src/web/public/app.js src/web/public/panels-ui.js src/web/public/session-lineage.js src/web/away-digest.ts src/web/public/styles.css src/web/public/mobile.css src/cli.ts test/session-overview-order.test.ts test/mobile-overview.test.ts test/home-sessions.test.ts test/session-list-layout.test.ts test/tab-layout-app.test.ts test/command-palette-ui.test.ts test/monitor-tab-sync.test.ts test/away-digest.test.ts test/away-digest-ui.test.ts test/cli-commands.test.ts test/cli-mux-table.test.ts
git commit -m "feat(ui): COD-350 show waiting-on-agents activity"
```

## Task 9: Make browser event transitions and Approvals sequence-safe

**Files:**

- Modify: `src/web/public/app.js`
- Modify: `src/web/public/settings-ui.js`
- Modify: `src/web/public/approvals-ui.js`
- Modify: `test/tab-layout-app.test.ts`
- Modify: `test/approvals-ui-hook-propagation.test.ts`

**Step 1: Write RED event-transition tests**

Cover init/reconnect hydration, activity-only updates, waiting/checking idle events cancelling rather than arming stuck
timers, genuine derived idle arming exactly once, and working/output/restart/exit clearing stale derived fields. Assert
that `_onHookStop()` no longer blanket-clears a newer permission/question; server `approval:resolved` is authoritative.
Resolving a stale idle approval clears only `idle_prompt`. A suppressed hook has no legacy handler effect.

**Step 2: Run RED tests**

```bash
npm test -- test/tab-layout-app.test.ts test/approvals-ui-hook-propagation.test.ts
```

Expected: current handlers overwrite raw status locally, arm idle timers, and clear all pending hooks.

**Step 3: Implement one activity-event merge helper**

Use a shared `_applySessionActivityEvent()` path from init, created, updated, idle, working, and exit handlers. Refresh
all open status surfaces on activity-only changes. Let Approval SSE resolution, not an unsequenced local stop handler,
clear permission/question state.

**Step 4: Run GREEN tests and commit**

```bash
npm test -- test/tab-layout-app.test.ts test/approvals-ui-hook-propagation.test.ts
git add -- src/web/public/app.js src/web/public/settings-ui.js src/web/public/approvals-ui.js test/tab-layout-app.test.ts test/approvals-ui-hook-propagation.test.ts
git commit -m "fix(ui): COD-350 reconcile agent activity events"
```

## Task 10: Migrate browser agent state and actions to `agentKey`

**Files:**

- Modify: `src/web/public/app.js`
- Modify: `src/web/public/panels-ui.js`
- Modify: `src/web/public/settings-ui.js`
- Modify: `src/web/public/subagent-windows.js`
- Create: `test/subagent-ui-identity.test.ts`
- Modify: `test/mobile/subagent-windows.test.ts`

**Step 1: Write RED collision and clear tests**

Prove two agents sharing a bare `agentId` coexist in every browser map and DOM/window identity. Completion, kill,
transcript, close, reparent, minimized state, timers, and connection lines must affect only the selected `agentKey`.
Missing keys are ignored with a bounded diagnostic. Legacy persisted bare-ID parent/window state migrates only when one
current agent matches; ambiguous state is dropped.

Require manual clear to atomically replace browser state from the server's `remaining` snapshot, preserve live windows/
associations/activity, and remove only absent completed history. Update confirmation/count copy accordingly.

Work in RED→GREEN slices: first core maps/event identity, then action URLs and completion timers, then persisted window/
parent migration, and finally manual-clear snapshot reconciliation. Run the focused files after each slice rather than
writing the entire collision matrix before implementation.

**Step 2: Run RED tests**

```bash
npm test -- test/subagent-ui-identity.test.ts test/mobile/subagent-windows.test.ts
```

Expected: maps and actions collide on `agentId`, and clear erases live client state.

**Step 3: Convert all keys and endpoints**

Use opaque `agentKey` for all maps, sets, timers, persisted window/parent associations, DOM data attributes, and encoded
mutation/transcript URLs. Keep `agentId` only as visible copy. Apply the canonical live snapshot in one client update.

**Step 4: Run GREEN tests and commit**

```bash
npm test -- test/subagent-ui-identity.test.ts test/mobile/subagent-windows.test.ts
git add -- src/web/public/app.js src/web/public/panels-ui.js src/web/public/settings-ui.js src/web/public/subagent-windows.js test/subagent-ui-identity.test.ts test/mobile/subagent-windows.test.ts
git commit -m "refactor(ui): COD-350 key agents by composite identity"
```

## Task 11: Prove the reported behavior end to end

**Files:**

- Create: `test/background-agent-wait.integration.test.ts`
- Modify: `test/integration-flows.test.ts` only if its shared harness needs a reusable setup helper
- Modify: `test/session-cleanup.test.ts` only for uncovered lifecycle cleanup

**Step 1: Write the final RED scenario**

Model the screenshot: raw idle plus two exact live agents must produce `activityStatus: waiting_agents`, no idle Approval,
no waiting-for-input/response-complete push, no idle waiter completion, and no respawn/auto-op eligibility. A second
same-directory conversation must remain unaffected.

Add final completion settle followed by parent output, exact-zero stop during settle, reconnect/startup unknown-to-live,
and deletion/identity/tracking/server-shutdown races while reconciliation is queued.

**Step 2: Run RED, implement only missing integration seams, and rerun GREEN**

```bash
npm test -- test/background-agent-wait.integration.test.ts test/integration-flows.test.ts test/session-cleanup.test.ts
```

**Step 3: Run the focused combined regression set**

```bash
npm test -- test/session-agent-activity-coordinator.test.ts test/subagent-watcher.test.ts test/subagent-process-inspector.test.ts test/claude-background-agent-frame.test.ts test/session-agent-activity-server.test.ts test/session-cleanup.test.ts test/routes/system-routes.test.ts test/routes/hook-event-routes.test.ts test/session-listener-wiring.test.ts test/approval-inbox.test.ts test/session-manager.test.ts test/session-auto-resume.test.ts test/session-auto-ops-availability.test.ts test/respawn-controller.test.ts test/routes/session-wait-routes.test.ts test/routes/session-input-wait.test.ts test/services/unified-session-service.test.ts test/routes/unified-sessions-routes.test.ts test/session-overview-order.test.ts test/mobile-overview.test.ts test/home-sessions.test.ts test/tab-layout-app.test.ts test/approvals-ui-hook-propagation.test.ts test/command-palette-ui.test.ts test/monitor-tab-sync.test.ts test/away-digest.test.ts test/cli-commands.test.ts test/cli-mux-table.test.ts test/subagent-ui-identity.test.ts test/mobile/subagent-windows.test.ts test/background-agent-wait.integration.test.ts
```

**Step 4: Run static/build gates**

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
git diff --check
npm run build
```

Expected: all focused tests and gates pass. Do not run bare `npm test`.

**Step 5: Commit integration proof**

```bash
git add -- test/background-agent-wait.integration.test.ts test/integration-flows.test.ts test/session-cleanup.test.ts
git commit -m "test(activity): COD-350 cover background-agent wait flow"
```

If the final integration RED exposes a missing production seam, add the exact affected production path(s) to this
commit instead of staging tests only. Inspect `git diff --name-only` before committing and prove no intended production
fix remains unstaged.

## Task 12: Independent review, staging, and auto-land

1. Run `superpowers:requesting-code-review` with an independent reviewer against the full COD-350 branch diff and Jira
   acceptance criteria. Fix Critical/Important findings with new RED tests and repeat until approved.
2. Re-run the affected focused files after every review fix, then repeat the Task 11 combined/static/build gates from a
   clean worktree.
3. Start the isolated staging instance configured in `.jira-autoloop/config.md` on port 5350 with instance/socket/data
   namespace `cod350-verify`. Verify authenticated session state, Approvals absence, visible labels, hook suppression,
   final-agent transition, reconnect, and exact cleanup. Capture a screenshot because this is a visible UI change.
4. Stop only the exact staging PID and prove port 5350 is released. Do not touch production.
5. Post Jira evidence, link the reviewed commit, fast-forward the local landing branch, push only to Bitbucket `origin`,
   and mark COD-350 Done/deploy-pending if every gate passes. Production deployment still requires the literal user
   command `deploy`.
