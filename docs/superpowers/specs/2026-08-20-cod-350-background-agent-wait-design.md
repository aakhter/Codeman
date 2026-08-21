# COD-350 Background-Agent Wait Design

## Problem and root cause

Claude can return its main terminal to an idle-looking composer while background agents continue working. Codeman
currently treats the resulting raw `idle` transition, `idle_prompt` hook, and `stop` hook as proof that the session is
available for input. Those signals independently drive the session status, Approvals Inbox, notifications, wait API,
idle/stuck timers, respawn, and other automation. The `SubagentWatcher` knows about the background agents, but its
events currently feed only the agent visualization and are not part of the parent session's activity model.

The result is contradictory state: a pane can visibly say “Waiting for 2 background agents to finish” while Codeman
labels it `IDLE`, creates an answerable “Claude is waiting for your input” approval, and may release the session to
automation. COD-350 makes background-agent work a canonical, server-derived activity state without changing the raw
persisted session-status contract.

## Goals

- Show a distinct **WAITING ON AGENTS** state while an otherwise-idle local Claude session has live background agents.
- Do not place that state in Approvals or notify the user that Claude needs input.
- Keep persisted `status` and raw `stop` wait delivery compatible for existing orchestration and API consumers. A
  suppressed legacy hook SSE event is intentionally replaced by a diagnostic event so an older browser cannot recreate
  the false approval or notification.
- Prevent allocation, idle waits, respawn, stuck detection, and auto-operations from treating the session as available.
- Remain correct across concurrent sessions, restarts, identity changes, watcher resets, stale events, and liveness
  uncertainty.
- Fail open for human-facing prompts but fail safe for autonomous actions when local agent observability is uncertain.

## Non-goals

- This change does not alter Claude's terminal, agent execution, or hook configuration.
- It does not claim host-side agent detection for remote SSH or container sessions whose Claude runtime is not
  observable from the Codeman host. Those sessions retain legacy behavior.
- It does not persist derived agent activity. The server reconstructs it from the live session and agent lifecycle.
- It does not turn background-agent progress into an actionable Approvals item.

## State model

`Session.status` remains the raw `SessionStatus` and remains the value written to persisted state. The wire state gains
an additive, always-emitted `activityStatus` whose domain is `SessionStatus | "waiting_agents" | "checking_agents"`,
plus `activityStatusSince: number | null`. Existing clients may continue using `status`; updated Codeman clients use
the shared effective-activity resolver.

Agent observation is a separate server-side dimension:

- `none`: reconciliation positively found no live background agents.
- `live`: one or more exactly correlated background agents are positively live.
- `unknown`: a local, normally observable session is being reconciled or hit a timeout, read error, or capacity limit.
- `not_observable`: the runtime is outside the supported local observation boundary; legacy behavior applies.

The effective projection is:

1. Permission and elicitation prompts remain actionable and outrank derived activity in the UI.
2. Raw error remains error.
3. Raw busy remains the working presentation even when agents also exist.
4. Raw idle plus `live` becomes `waiting_agents`.
5. Raw idle plus `unknown` becomes `checking_agents`.
6. Every raw `SessionStatus` not overridden above, including stopped and parked, passes through unchanged.

`activityStatusSince` starts when the effective state enters one agent-observation episode. Transitions between
`waiting_agents` and `checking_agents` preserve it; count and progress updates do not reset it. On restart, a positively
live observation reconstructs it as the later of the reliable earliest-live-agent start and the inferred raw-idle
anchor, clamped to the current time. An unknown startup observation has no reliable agent start, so its
`checking_agents` timestamp is the time that reconciliation entered pending state rather than an old raw-idle anchor.
The field is non-null only while `activityStatus` is `waiting_agents` or `checking_agents`; leaving that episode sets it
to null, and existing raw-state timestamps continue to drive working/error/idle/stopped/parked presentation.

The shared presentation order is:

`needs` > `error` > `waiting` (genuine input) > `working` > `waiting_agents` > `checking_agents` > `idle` > `done`.

This feature does not redefine parked-session UX: `activityStatus` passes through `parked`, and the overview resolver
maps it to its existing idle presentation unless a separate parked-state change is approved. The exhaustive projection
table must therefore distinguish wire pass-through from the existing overview label instead of silently inventing a
new parked rank in COD-350.

## Identity and lifecycle authority

Semantic correlation uses the exact canonical tuple `(projectHash, claudeSessionId, agentId)`. One shared
Claude-compatible lexical path normalizer and project-hash function is used by launch, watcher, reconciliation, and
tests; redundant separators, `.` segments, and trailing separators cannot produce competing identities. The project
hash preserves the launch path's symlink spelling because that is the spelling Claude uses for its project directory;
it is not silently replaced with an independently guessed `realpath`.

The server exposes an opaque, collision-safe serialization of the tuple as stable `agentKey` for browser maps and
mutation actions; consumers never construct it by concatenating slash-delimited strings. `agentId` remains display and
backward-compatibility data. A mutation request using a bare duplicate `agentId` fails with an ambiguity error rather
than acting on the wrong agent.

The semantic live index is separate from completed/display history. It contains only agents correlated to currently
live local Codeman sessions. History TTL/LRU cleanup and the manual clear endpoint cannot evict active or idle live
records. Manual clear removes completed history and returns the canonical remaining-live snapshot, which the browser
applies atomically.

Every semantic discovery, completion, removal, quarantine, identity change, and reset increments a per-session
revision and recomputes the parent from the exact current set; counters are never incremented or decremented blindly.
Active semantic records leave through verified completion/liveness or an explicit tracking reset, not ordinary display
history cleanup. Storage has named per-session and overall bounds. Overflow marks only the affected live session
`unknown`, blocks its automation, and emits a bounded diagnostic; it never evicts another parent's live evidence.

## Reconciliation and liveness

Startup and tracking re-enable run a targeted, age-cutoff-free reconciliation for every live observable local Claude
identity. A newly created or re-identified session enters `unknown` synchronously and is not externally allocatable
until reconciliation for that exact object and identity generation finishes. Identities appearing during an enable
pass receive the same per-session gate; one failed session does not block unrelated sessions.

Raw Claude idle, `idle_prompt`, and `stop` effects request targeted reconciliation before committing user-facing or
automation consequences. Raw `stop` wait delivery remains immediate and occurs before that asynchronous decision. A
suppressible `idle_prompt` requires an exact live agent plus one of:

- exact positive aggregate process identity for the same canonical project and Claude conversation; or
- a source-tagged current visible tmux frame whose bottom status region exactly matches Claude's background-agent
  renderer and whose positive count equals the exact live composite-agent count.

Aggregate process proof requires all of the following: `/proc/<pid>/cwd` and the session working directory resolve to
the same filesystem object (device/inode), while the watcher record independently carries the exact Claude project
hash; an allowlisted Claude environment field or CLI flag parses to the exact `claudeSessionId`; and the process is not
the Codeman-managed parent (`CODEMAN_MUX=1`). It must also match an allowlisted Claude background-agent process
signature for a supported version: a verified agent-role environment/argument marker, or a verified executable plus
subagent launch signature and process-tree relationship. Sharing only cwd and conversation identity is insufficient;
generic hook helpers and inherited auxiliary children are negative fixtures.

Environment entries and arguments are parsed as NUL-delimited structured tokens, including verified `--flag value` and
`--flag=value` forms, never substring-searched. Supported fields, flags, executables, and role signatures must be
established by fixtures from the Claude versions Codeman supports. An unreadable process table or an unrecognized
identity format is `unknown`, not a guessed match; a successful complete inspection with no exact match is a negative
result. Process capability is explicit: Claude Code 2.1.237 exposes no verified background-agent process-role
signature, so its complete readable scan returns `negative/no_registered_role_signature`. That reason means only that
exact process proof is unavailable; it is not semantic proof that no background agent exists and cannot erase stronger
exact watcher or current-frame evidence. Only `negative/no_matching_process` from a supported version with a registered
positive-capable matcher is authoritative process absence. When a supported Claude version exposes an exact agent ID,
it may additionally bind the process to an
`agentKey`; otherwise aggregate proof means only “at least one background agent for this project/conversation is live”
and must not mark every semantic agent record individually alive.

Scrollback, raw-buffer fallbacks, quoted text, stale markers, mismatched counts, and unrecognized variants are not
semantic evidence. Exact watcher live evidence plus an exact matching current-frame count remains sufficient to
suppress `idle_prompt` and raw-idle presentation when process proof capability is unavailable. A `stop` is stricter:
only exact positive live-process evidence may suppress its completion presentation. Recent transcript modification or
a pane marker alone is insufficient because both can outlive the final agent process.

Reconciliation uses a bounded shared scheduler with per-session single-flight/coalescing and a default concurrency of
four. Background startup/retry work may occupy at most three slots, reserving one for foreground raw-idle/hook
decisions. In work shared by the remaining slots, no more than three foreground jobs may start consecutively while
background work is queued; the oldest background job then starts next. FIFO order applies within each class. This
bounded-burst rule prevents an endless foreground stream from starving startup/retry work and gives fairness tests a
measurable contract. Queue wait counts against the foreground decision deadline. Every request owns an abortable
decision token; expiry removes queued work or detaches the consumer, aborts process inspection when no consumers remain,
and permanently rejects late results.

Async commits validate the same Session object, Claude identity generation, tracking generation, terminal activity
epoch, semantic-index revision, and live decision token. Agent discovery/completion, terminal output, submission, or a
working transition while a check is pending therefore forces discard or recomputation instead of committing stale
idle state.

Transient `unknown` state schedules one coalesced generation-keyed retry at 250 ms, 1 s, 5 s, and then at a capped
30-second interval. A new meaningful semantic revision may request one immediate retry; repeated progress/filesystem
noise at the same revision cannot bypass backoff. Identity replacement, tracking disable, session deletion/exit, and
server shutdown cancel retry and settle timers.

## Hook, approval, and wait behavior

Permission and elicitation hooks remain immediate and actionable; they never wait for agent reconciliation.

When an `idle_prompt` or `stop` is suppressed as background-agent presentation:

- no idle approval, waiting-for-input notification, response-complete notification, push, pending hook, stuck timer,
  or respawn confirmation is created;
- the raw hook is still recorded in the run summary;
- raw `stop` still resolves existing `until=stop` waiters immediately;
- a new `hook:suppressed` diagnostic SSE event carries the Codeman `sessionId`, original event, timestamp, effective
  activity, reason, and confidence; and
- the legacy `hook:idle_prompt`/`hook:stop` SSE event is not emitted, so older browsers do not recreate the bug by
  ignoring a new suppression flag.

An unsuppressed stop remains authoritative for human-facing completion presentation. When exact reconciliation returns
capability-complete `negative/no_matching_process` for a supported version with a registered positive matcher, the stop
also clears the derived waiting claim for that identity generation and quarantines weaker sidecar/file evidence
observed at or before the stop. `negative/no_registered_role_signature` leaves stronger watcher/frame-derived live
state intact and cannot by itself establish semantic `none`; without stronger evidence the observation remains live or
unknown. An independent exact watcher reconciliation that establishes zero live records, including verified completion
and the final-agent settle, still converges to `none` and delivers the derived idle edge exactly once. A quarantined
agent cannot resurrect waiting through a delayed final transcript write; it needs renewed positive process evidence,
while a genuinely new composite agent may establish a new wait immediately.

If the stop is unsuppressed because reconciliation is unreadable, times out, or has no registered positive-proof
capability, completion presentation still fails open but autonomous availability remains fail-safe. The observation
stays `unknown`, or retains a stronger existing `live` projection, until retry; it is not falsely converted to `none`.
This can intentionally show a completion notice while still labeling the session **CHECKING AGENTS** or **WAITING ON
AGENTS**: the former is a human notification, while the latter is the conservative automation/activity state.

Stop, `idle_prompt`, raw-idle, permission, and elicitation events all receive a value from one monotonic coordinator
event sequence scoped to the Codeman session and Claude identity generation. Approval items store their source sequence.
Stop resolves only approvals whose source sequence is at or before its own. A committed completion watermark prevents
an older delayed `idle_prompt` or raw-idle decision from creating an approval after a newer stop. Permission and
elicitation prompts remain independent of that watermark and never wait for reconciliation.

Raw `session:idle` does not broadcast legacy idle or call `sessionWaits.notifySignal("idle")` while observation is
`live` or `unknown`. When the final derived transition genuinely reaches idle, Codeman broadcasts one derived idle
edge and resolves existing fresh idle waiters exactly once. New immediate callers and already-parked callers therefore
observe the same availability state. Tracking disable is an explicit user-selected reset to legacy behavior and emits
the corresponding derived idle edge when the raw session is idle.

## Automation safety and final-agent settling

One server predicate defines autonomous availability. For a supported local session, only `none` plus completed
readiness may delegate to the appropriate raw session state; `live` and `unknown` always block. `not_observable`
explicitly delegates to legacy raw-state availability, which is how unsupported remote/container sessions and an
intentional tracking-disable retain existing behavior. Session allocation, `SessionManager` idle selection,
immediate/fresh idle waits, respawn confirmation, and auto-operations all use that predicate. Entering
`waiting_agents` or `checking_agents` cancels pending respawn confirmation and client idle/stuck timers.

After the final agent completes, Codeman retains the observation episode for the existing `IDLE_SILENCE_MS` interval
to avoid a visible idle flash before Claude synthesizes the results. Parent output clears the settle state to working;
a newly discovered agent supersedes it; and a fresh stop/idle prompt whose exact reconciliation finds no agents ends
the grace and is honored immediately. Generation tokens prevent an old timer from clearing a newer wait. Suppressed
old hooks are never replayed; the eventual derived idle transition is a new availability event, not a hook replay.

Human-facing uncertainty and autonomous uncertainty deliberately differ. A genuine prompt or stop is shown when
local reconciliation times out or fails, because hiding user input is worse. The same `unknown` result remains
non-allocatable and cannot trigger respawn or auto-operations until a later retry reaches a known state.

## Client presentation

All updated client surfaces consume the shared effective resolver rather than raw `status`: mobile overview, desktop
home, rich sidebar, full and incremental tab renderers, status dots and ARIA labels, monitor badges, away digest,
command palette/search terms, and user-facing status counts. Reconnect and session-working handlers explicitly replace
or clear stale derived fields.

Expanded labels are **WAITING ON AGENTS** and **CHECKING AGENTS**. Compact labels are **AGENTS** and **CHECKING**.
Styling reuses the existing agent-accent palette and provides distinct accessible text; animation obeys reduced-motion
preferences. Action prompts continue to outrank these labels.

## Failure and cleanup rules

- Local timeout, read failure, or overflow: show genuine prompt/completion effects, project `checking_agents` when no
  stronger live evidence exists, block automation, and retry with bounded backoff.
- Unsupported remote/container observation, or intentional tracking disable: set `not_observable`, do not claim agent
  awareness, and delegate presentation and automation availability to the legacy raw-state rules.
- Ambiguous session identity or composite lookup: do not suppress a prompt or mutate an agent; surface a diagnostic.
- Session deletion, PTY exit, Claude identity replacement, tracking reset, and watcher/server shutdown clear derived
  state, watermarks, quarantines, queued work, retries, settle timers, and cache entries for that generation.
- Discovery of positively live agents resolves only stale idle-kind Approval items. Permission/question items remain.

## Verification

Focused unit, route, and browser tests will cover:

- exact project/session isolation, same-directory parallel sessions, duplicate bare agent IDs, and canonical paths;
- process-backed, sidecar-only/in-process, internal, nested, unsupported, ambiguous, and overflow cases;
- Claude Code 2.1.237 no-signature negative without false semantic clearing, frame-backed idle-prompt/raw-idle
  suppression, and unsuppressed stop with retained autonomous blocking;
- idle_prompt and stop suppression, raw stop delivery, new diagnostic SSE routing, stale approval cleanup, and old-client
  compatibility;
- discovery/final-completion races, delayed hooks, final transcript flushes, terminal output during refresh, session
  deletion/identity changes, timeout cancellation, and generation/revision invalidation;
- startup/re-enable readiness, concurrent session creation/adoption, tracking disable, manual clear, retry/backoff,
  bounded concurrency, priority/fairness, and timer cleanup;
- idle waiter suppression and derived delivery, allocation, respawn, auto-ops, final-agent settle/cancel behavior, and
  unknown-state safety; and
- exhaustive state resolution, ordering, timestamps, reconnect clearing, every user-facing status surface, ARIA/CSS,
  reduced-motion behavior, and pass-through coverage for every `SessionStatus` member.

Verification will use only focused test files, followed by typecheck, lint, formatting, lockfile validation, production
build, and a realistic staging smoke. Production remains untouched without explicit deploy authorization.
