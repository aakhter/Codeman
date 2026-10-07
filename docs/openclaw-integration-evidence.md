# COD-487 phases 0, 1, 3: implementation evidence

Date: 2026-10-07. Branch: `feat/COD-487-openclaw-phases-0-1-3`.
Worktree: `/opt/projects/Codeman-COD-487`. Production Brain and its Telegram
configuration have not been changed. This work does not implement phase 2.

## Phase 0: observed integration contracts

Installed OpenClaw `2026.9.8 (fc23bc8)` accepts this package through its real
runtime loader. An isolated profile's `plugins info codeman-assistant --runtime
--json` reports `status: loaded`, typed hook `inbound_claim`, service
`codeman-assistant-outbox`, and no diagnostics. No gateway or Telegram poller was
started. `plugins validate` requires tool/feature authoring metadata and rejects
this command/service plugin; it is not the loader compatibility check for this
entry shape. Runtime registration and package tests are the relevant checks.

Inspected installed SDK command execution and inbound hook mapping: command
handlers omit message IDs, whereas `inbound_claim` receives canonical content,
channel/account/chat/sender/message ID and `commandAuthorized`. Telegram origin
targets can carry the `telegram:` prefix; the connector normalizes this only for
private numeric chats. Delivery uses the supported outbound adapter and a managed
service lifecycle. SDK delivery is exercised through a test adapter; real bot
send/receive and gateway restart remain phase 5 canary gates.

A separate, read-only Codex `exec` invocation with CLI **0.160.1** and originator
`codeman_cod487-spike` produced conversation
`01a116ff-5757-7623-82d9-49b6eb735d99` and turn
`01a116ff-57cf-7bf2-beb9-fa00e35dfd37`. The fixed, tool-free prompt requested
`COD487_SPIKE_OK`; the response matched. Its persisted rollout supplies:

1. `session_meta` with exact ID, cwd, originator and CLI version.
2. `event_msg/task_started` with a native `turn_id`.
3. `event_msg/item_completed`, `UserMessage`, matching `thread_id` and `turn_id`.
4. `AgentMessage` with `phase: final_answer`, same thread/turn and final text.
5. `task_complete` with matching turn and `last_agent_message` equal to final text.

The read-only probe returns supported/accepted/completed true. A reduced fixture
contains only this throwaway task's metadata and events. Tests reject commentary,
foreign completion, missing acceptance, another conversation, and partially
written completion. This validates the observed format, not all Codex versions
or the PTY submission path. Missing/changed fields must remain unsupported until
phase 2 validates them; aborts, compaction, rotation, truncation, restart cursors,
and unexpected desktop turns still belong to phase 2's observer tests.

Idle status does not prove an empty composer. The phase 2 contract therefore
requires explicit desktop handoff and coordination of both HTTP and WebSocket
input. This branch does not infer composer emptiness or claim exclusive terminal
control. It cannot bind/activate the real Brain automatically.

## Phase 1: implemented foundation

Versioned private assistant metadata, revision/generation checks, explicit local
Codex identity binding, owner-scoped management routes, opaque hashed tokens,
revocation, and additive bearer authentication through the shared middleware.
Management remains available through normal administrator/user authentication.
Assistant request endpoints return 503 and advertise execution unavailable.
Metadata enablement does not enable CLI execution. Phase 2 must supply its durable
outstanding-request guard before request dispatch can become available.

## Phase 3: transport against the proposed phase 2 contract

Separate opt-in package; deterministic private `/brain` ingress; stable provider
message keys; durable request-to-destination mapping; asynchronous submit/poll;
identity-checked final results; Unicode chunking; persisted chunk receipts;
conservative unknown-delivery handling; local status/result and queued-cancel
commands. Generic model tools are optional and deferred. Details and required
request response fields are in `integrations/openclaw/README.md`.

Regression fixtures exercise duplicate/concurrent updates, acceptance-response
loss with the same key after restart, delayed completion, completed execution
without successful notification, gateway-state restart, unknown send outcomes,
wrong chat/sender/account, malformed input, unsupported capabilities, and Unicode.
These are local protocol tests, not evidence of live Telegram delivery.

## Verification

- Targeted registry/route/auth/identity/rollout/wait suites and connector suites.
- Typecheck, lint, format check, and lockfile synchronization.
- Isolated Codeman HTTP server on port 34870 with unique instance/data/socket;
  curl verifies `/api/v1` assistant creation/list, scoped read, terminal/settings
  rejection (403), unbound enable conflict (409), engine gate (503), token
  revocation (401). No session was created or given input.
- Real OpenClaw loader registration in a separate `/tmp` profile, without starting
  its gateway or using bot credentials.

Release remains gated on COD-490 durable execution, desktop handoff, request
ownership checks and native-turn reconciliation; then COD-492 controls and
COD-493 authorized live Brain/Telegram canary. Jira work remains In Progress
until the relevant acceptance gates are satisfied.
