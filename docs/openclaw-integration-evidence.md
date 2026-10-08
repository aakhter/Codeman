# COD-487 full first-release implementation evidence

Date: 2026-10-07. Branch: `feat/COD-487-openclaw-phases-0-1-3`.
Worktree: `/opt/projects/Codeman-COD-487`. The initial branch name is retained.
Production Brain, its native conversation, and its Telegram gateway were not changed.

## Delivered behavior

Named local Codex assistants have exact native bindings, ownership, revision/
generation checks and one-time scoped credentials hashed at rest. The durable
request ledger retains idempotency keys, dispatch intent, native turn identity,
final answers and reconciliation state. Normal HTTP, terminal WebSocket and
Session writers share input guards; handoff requires explicit composer/task
attestation and rejects pending input or conflicting automation.

Dispatch uses the existing mux path once. Restart reconciles transcript evidence
without replay. Exact user/turn/final/completion events provide attribution;
ambiguous writes, deadlines, competing turns and rotated/truncated files block
further dispatch. Take control waits for pending submission, pauses the assistant,
cancels queued work and marks active work uncertain. It does not stop the CLI.
Recovery cannot inherit a handoff across a changed session object or process ID.
Explicit reconciliation/rebind/handoff is required.

Desktop/mobile Assistants controls cover create, rename, enable/pause, delete,
bind/rebind, token creation/revocation, request history/results, queued cancellation,
handoff, takeover and uncertain-outcome review. The connector supports private
`/brain`, status/result and queued cancellation, with trusted routing, stable
provider-message keys, a persisted outbox, managed lifecycle and conservative
unknown-delivery handling. It is separately installed and opt-in.

## Observed contracts

Installed OpenClaw **2026.9.8 (fc23bc8)** loads this package through its real
runtime loader. An isolated profile's `plugins info codeman-assistant --runtime
--json` reports loaded, typed hook `inbound_claim`, service
`codeman-assistant-outbox`, and no diagnostics. No real gateway/poller was started.
`plugins validate` expects tool/feature authoring metadata and rejects this
command/service entry; runtime loader registration is the compatibility evidence.
Command handlers omit stable message IDs, so canonical inbound claim metadata
provides account/chat/sender/message and command authorization. Delivery uses the
SDK outbound Telegram adapter. Optional model tools are deferred.

Codex **0.160.1** supplies exact session metadata and native `task_started`,
`item_completed` user/final-answer events and `task_complete` with matching turn
and last final text. The reduced fixture comes from a tool-free throwaway task;
reasoning, tool output and user credentials are excluded. Unsupported formats
cannot produce a completed result. Native fixture tests alone are separate from
the real PTY canary below.

## Verification

- Build, typecheck, lint (zero errors; one existing server `any` warning), format,
  lockfile, frontend syntax and public asset checks pass.
- Focused assistant/store/auth/identity/native projection/connector/wait/submit
  verification passes (102 tests), alongside native identity/rollout regressions
  (15 tests), session routes/input-lock regressions (220 tests), CLI format guard
  (11 tests) and mobile header policy (5 tests): **353 focused tests pass**. Tests cover duplicate/concurrent requests, changed
  payloads, durable intent before write, lost write/restart without resend,
  late completion, deadline, inode replacement, incomplete native task despite
  idle status, desktop interference, queued expiry/cancel, grant revocation,
  takeover during mux submission, corruption and foreign request UUIDs.
- Existing real terminal smoke passes **107 checks**: shell streaming, real Codex
  follow-up/history, tab switching, replay and browser console checks.
  Artifact: `/tmp/codeman-dev-smoke-artifacts-2026-10-07T16-06-14-170Z-p205202-rf8d34c7c97104b228fd41caed13154b8/summary.json`.
- `scripts/smoke-openclaw-assistant.mjs` launches an isolated instance/data/socket/
  home and a throwaway real Codex session. It exercises browser management,
  exact binding, explicit handoff, blocked desktop input, duplicate Telegram
  ingress, managed connector restart, native completion, matching final delivery,
  desktop takeover and mobile controls. Curl and the real terminal WebSocket
  verify blocked input. Passing artifact:
  `/tmp/cod487-assistant-canary-ZmYLop/summary.json`. The Telegram adapter is a test adapter,
  without real bot credentials or a production poller. Summaries/screenshots are
  retained under its printed `/tmp/cod487-assistant-canary-*` artifact directory.
- The broad npm suite is not clean on the starting commit. Failure comparison
  uses detached baseline `9611469d`: existing activity/layout/resize/settings
  assertions reproduce unchanged; the remote-file route's representative failure
  also reproduces. Its mocks target the former remote file seam. These are
  recorded separately from passing feature tests. The broad run also exposed
  missing Session mock support for the new auxiliary-input guard and an omitted
  CLI static-guard explanation for the deliberately Codex-specific native format;
  those integrations and the mobile header policy were corrected and rerun.
  The full sweep completed: 629 files, 11,767 passing tests, 108 failing tests.
  Nine feature-related failures across three files were fixed; the other failures
  are in 28 baseline suites (the remote-file baseline used a representative test).
  Comparison artifact: `/tmp/cod487-baseline-comparison.json`; full output:
  `/tmp/cod487-full-suite.log`. No unrelated source is changed.

## First-release limits and remaining release gates

Local managed Codex, single-line text, private Telegram chat, explicit commands,
desktop approvals, manual recovery, fixed 30-minute deadline and retained ledgers
capped at 1000 entries. Direct tmux input cannot be fenced by HTTP/Session guards;
users must stop it during handoff, and unexpected native turns fail attribution.
Generic approval waits remain running until native evidence or desktop takeover;
there are no Telegram approval buttons or guessed automatic approval.

The source feature and isolated canary are implemented. Deployment/version bump,
Bitbucket CI and one explicitly authorized real Brain/Telegram canary remain
separate gates under COD-493. Source does not prove production acceptance.
See [connector setup](../integrations/openclaw/README.md) and
[release/rollback runbook](openclaw-release-runbook.md).

## 2026-10-08 production ingress correction

The first real private-chat acceptance exposed a gap in the original canary:
`inbound_claim` is targeted only at a plugin-owned OpenClaw conversation binding.
A registered hook and loaded plugin did not establish ordinary bot-chat routing.
The gateway received `/brain`, but Codeman's Brain request ledger remained empty.

The connector now also claims ordinary messages through `reply_dispatch`, before
model execution, using the finalized trusted channel context. This retains
`CommandAuthorized`, exact Telegram account/sender/private chat, stable provider
message ID and thread rejection; `before_dispatch` omits authorization and thread
facts and was rejected as the correction surface. Plugin-owned bindings retain
`inbound_claim`. Ordinary messages and unrelated channels fall through normally.

All 13 connector/native tests pass, including the ordinary-chat hook and denied
account/sender/group/thread/missing identity/internal-turn/delivery-policy cases.
The installed OpenClaw hook runner invokes the new hook and returns handled.
The updated real Codex/browser canary passes ordinary-chat takeover, duplicate
message identity, one execution and matching final delivery through a test SDK
adapter: `/tmp/cod487-assistant-canary-kFcPk5/summary.json`. The root connector
wrapper test and formatting/syntax checks pass. Production gateway was restarted
with the linked connector; runtime loader reports two hooks and no diagnostics.
The existing Brain session/conversation and explicit handoff were preserved.
A new real Telegram message is required to establish production delivery; previous
messages are not automatically replayed.

## 2026-10-08 gateway startup correction

The next real Telegram attempt still reached the ordinary OpenClaw model. The
manifest lacked `activation.onStartup: true`; the installed SDK startup planner
explicitly excludes hook/service-only plugins without a startup trigger. CLI
runtime inspection imported the plugin independently and was insufficient proof.

Added explicit startup activation and a credential-free managed-service startup
log. The installed SDK's real `loadGatewayStartupPluginPlan` now includes
`codeman-assistant`. All 14 connector/native tests and the root wrapper pass;
formatting checks pass. Production `openclaw-gateway` was restarted and its user
journal records `Codeman assistant connector service started` at
2026-10-08T08:54:48.099Z. This establishes live service activation, separately from
CLI inspection and the earlier isolated real Codex canary. Existing Brain binding
and handoff are preserved. A fresh Telegram test is requested; failed earlier
messages are not replayed.

## 2026-10-08 explicit-delivery correction

User message 916 reached Telegram ingress at 08:59:05Z and completed without
queued replies at 08:59:06Z; neither connector outbox nor Brain requests existed.
The persisted Telegram session uses the Codex harness. Its installed
`deliveryDefaults.visibleReplies` is `message_tool`; the installed SDK's real
source-reply visibility policy reproduces `message_tool_only` and
`suppressHookUserDelivery=true` for this explicit `/brain` text. The connector
mistakenly treated automatic-reply suppression as an ingress denial.

For an authorized private `/brain` command in message-tool-only mode, the
connector now sends its acknowledgement explicitly using the same trusted
Telegram adapter as final-result delivery. It preserves the gateway's global
reply policy and still rejects send-policy denial, internal/tail turns, foreign
accounts/senders/chats, missing identity, groups and threads. Other suppression
modes are still denied. Routing diagnostics logged only boolean checks and were
removed after reproducing the source-policy condition.

All 14 connector/native tests and the root wrapper pass. The updated isolated
real Codex/browser canary verifies message-tool-only takeover, explicit matching
acknowledgements, duplicate identity, one native completion and final delivery:
`/tmp/cod487-assistant-canary-AmTwl6/summary.json`. Formatting/diff checks pass.
Production hot replacement is recorded at 2026-10-08T09:10:57Z, preceded by the
connector service-start log. Brain remains ready on the same native binding.
A new real Telegram receipt remains separate from the test-adapter canary.

## COD-495 conversational Telegram presentation

Real production acceptance is now proven for the existing Brain conversation:
request `feab4ac6-2955-4d9a-8cd3-b8a81ad4e825` completed with the expected marker,
the connector outbox records `delivered` with one Telegram receipt, and the user
confirmed the acknowledgement and answer in their private chat. The leading
Mem0 banner was part of the stored native final answer.

COD-495 adds case-insensitive `brain ...`, `Brain, ...`, and `brain: ...` routing
alongside `/brain`, a short acknowledgement without exposing request keys, and
status/result/cancel for the latest request scoped to the same assistant,
account, sender and private chat. Explicit keys remain available. Telegram
presentation removes only the known leading Mem0 status banner when followed by
an answer; Codeman's stored native answer remains untouched. The same routing,
authorization, idempotency and queued-only cancellation constraints apply.

All 17 connector/native tests and the root wrapper pass. The isolated real
Codex/browser canary now submits `Brain, Reply ...` and verifies explicit simple
acknowledgements, duplicate identity, one completion and matching final delivery:
`/tmp/cod487-assistant-canary-3T8RNy/summary.json`. Formatting/diff checks pass.


## COD-496 incoming Telegram media

Implemented private, bounded copying of current SDK media facts and legacy
aliases into the exact bound local workspace. Captions continue through the
existing assistant request API and native turn observer; no bearer scopes,
conversation selection, platform destinations or CLI launch paths changed.
Files are retained after OpenClaw's transient downloads expire. Failed media
staging never submits a caption alone. Telegram replies remain text.

The first real canary exposed long literal input remaining in Codex's composer
with the prior 50 ms text/Enter separation. Increasing the delay alone did not
resolve Codex’s heuristic paste buffering above 1 KiB. Long Codex prompts now
use explicit bracketed-paste boundaries and one separate Enter; uncertain
delivery still has no automatic retry. Other CLI transport remains unchanged. A later isolated canary reached the image tool but its default sandbox
could not initialize (`bwrap` loopback permission failure). Only the throwaway
canary now explicitly uses its existing bypass-approvals session option; the
production Brain permission configuration is preserved.

Successful real Codex/browser evidence:
`/tmp/cod487-assistant-canary-vyj2qV/summary.json` (text and image) and
`/tmp/cod487-assistant-canary-33E07K/summary.json` (text, image and PDF, with the
final paste protocol). The agent read a random hidden
code from the staged text file and used its image tool to identify a blue
triangle. The prompt did not reveal either answer. Temporary source files were
deleted after acceptance; duplicate ingress and managed plugin service restart
still produced one completed request and one matching test Telegram receipt.
Desktop/mobile and input ownership checks passed. This is an isolated SDK
adapter test, not proof of a new real Telegram photo/PDF delivery. The PDF
canary additionally extracted a second hidden code from an attached PDF; it
ran against Codex 0.161.0 using the same native request observer.

Validation: 23 connector/native tests; root connector wrapper; 217 targeted
assistant/integration/tmux tests; typecheck, lint (one existing server warning),
format and lockfile checks. Final transport regressions plus the connector
wrapper passed 218 tests. Source is tracked under COD-496; deployment and
actual Telegram acceptance are recorded separately.

## COD-499: Claude Code and OpenCode assistant support

Named assistants now bind local Codex, Claude Code and OpenCode sessions. Native
adapters validate identity and prompt acceptance, observe completed responses,
and resume the same conversation after idle-session loss. Existing Codex bindings
and tokens retain their original representation. Claude observation follows
attachment/hook parent links and matches complete paired native paste envelopes.
OpenCode reads readonly SQLite snapshots of linked messages and parts. Unknown
attribution stops dispatch without replay.

Final isolated real-CLI canaries passed text/image tool use, input ownership,
connector duplicate/restart delivery, desktop/mobile UI and deletion recovery:

- Claude Code: `/tmp/cod487-assistant-canary-1qPoWQ/summary.json`.
- OpenCode: `/tmp/cod487-assistant-canary-nxbKGa/summary.json`.
- Codex regression: `/tmp/cod487-assistant-canary-sKpMvU/summary.json`.

Each recovery retained the native conversation, root and workspace, incremented
the binding generation and completed a follow-up. These use a test Telegram SDK
adapter, not the production bot. Brain was not prompted or deleted.

The realistic browser smoke passed all applicable Claude, Codex and shell checks
for history, replay and tab switching, with no page or serious console errors:
`/tmp/codeman-dev-smoke-artifacts-2026-10-08T17-54-19-059Z-p1542321-r0870a7f0237b4a7e9c88bcb2fe97edd6/summary.json`.
Remote coverage was skipped because no target was configured.

Validation: 49 assistant/native/recovery/connector wrapper tests and 23 plugin
tests; typecheck, lint (one existing warning), format, lockfile, frontend syntax
and public asset checks. Native schemas were checked against installed CLIs,
the [Claude hook contract](https://code.claude.com/docs/en/hooks) and the
[OpenCode message implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/message-v2.ts).

The first Claude fixture copied a refreshable OAuth credential, leaving the
original token stale after refresh. The refreshed credential was restored after
matching account identity. Subsequent canaries share the credential file while
isolating native conversations, data and tmux sockets.
