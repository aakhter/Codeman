# OpenClaw → Codeman assistant connector

[COD-487](https://aakhter.atlassian.net/browse/COD-487) implements named assistants,
durable requests and an opt-in OpenClaw connector. The tested versions are
OpenClaw **2026.9.8 (fc23bc8)** and Node 22+. Named assistants support local
Codex, Claude Code and OpenCode sessions (COD-499).
Address Brain with `brain <request>`, `Brain, <request>`, or `/brain <request>`
to bypass OpenClaw's model. You can also reply directly to a connector-delivered
Brain answer or acknowledgement without repeating `brain`. Replies follow the
recorded provider message ID for the same authorized channel/account/chat/sender; quoted
text, unrelated bot messages and ordinary unaddressed messages do not select
Brain. Optional model-driven tools are deferred.

## Setup

1. Open **Assistants** in Codeman, create an assistant, and bind an idle local
   Codex, Claude Code or OpenCode session. Binding validates the exact native conversation and canonical
   workspace/data-home; it never selects the newest conversation in a workspace.
2. Disable conflicting session automation, clear any unsubmitted composer text,
   stop direct tmux input, enable the assistant, and explicitly hand control over.
   Normal HTTP/WebSocket/session input is then locked. Output remains visible.
3. Issue an assistant token with `read`, `submit`, and `cancel` scopes. Copy the
   one-time value into the gateway's credential environment. Tokens are hashed
   at rest and can be revoked in Codeman. Never put them in configuration or logs.
4. Install/link this directory through OpenClaw's normal plugin workflow. Root
   npm installation does not install it into a gateway. Configure
   `plugins.entries.codeman-assistant` with `enabled: true` and this `config`:

```json
{
  "baseUrl": "http://127.0.0.1:3002",
  "assistantId": "<assistant UUID>",
  "accountId": "<configured Telegram account ID>",
  "allowFrom": ["<numeric Telegram sender ID>"],
  "tokenEnv": "CODEMAN_BRAIN_TOKEN",
  "mediaRoot": "/home/ubuntu/.openclaw/media/inbound"
}
```

### WhatsApp (COD-505)

Install/link OpenClaw's WhatsApp channel and pair its account as usual. Add an
optional `whatsapp` block to the connector configuration above:

```json
{
  "whatsapp": {
    "accountId": "default",
    "allowFrom": ["+15551234567"],
    "mediaRoot": "/home/ubuntu/.openclaw/media/inbound"
  }
}
```

Use the actual WhatsApp account ID and exact authorized E.164 phone numbers.
OpenClaw's own WhatsApp access policy still applies; the connector applies its
own allowlist too. Groups, threads, foreign accounts and missing/invalid provider
message IDs are rejected. Normal WhatsApp messages carry `CommandAuthorized=false`
when OpenClaw did not check command access; private phone/account allowlisting
authorizes `brain ...` requests. Slash commands also require command authorization.
Existing Telegram configuration and saved outbox records remain compatible.

Both channels route to the configured assistant. Replies to a recorded Brain
answer/acknowledgement select the same assistant without a prefix. Reply ownership,
latest-request controls and deduplication include the originating channel; results
always use that channel's outbound adapter. A network failure retries the saved
answer with bounded backoff and never reruns the accepted task. Crash-time uncertain
sends still require reconciliation; a provider may accept a message before its
receipt is lost, so retries can produce duplicate replies.

Attachments use each channel's own `mediaRoot` and the same bounded, private,
local staging checks. The existing `.codeman-telegram` workspace folder name is
retained for compatibility for both channels. No historical message is replayed
when WhatsApp support is enabled. Reload the gateway once configuration is saved.

The manifest declares `activation.onStartup: true` so the gateway imports the
connector and starts its managed outbox service. Runtime inspection alone does
not prove startup activation. Verify the gateway log contains
`Codeman assistant connector service started`.

Set `CODEMAN_BRAIN_TOKEN` in the gateway service's environment. Use a separate
profile and bot for testing; never start a second poller for the production bot.
Only HTTPS origins or loopback HTTP are accepted. Redirects, credentials, query
strings, subpaths and model-selected destinations are rejected. Recheck the SDK
and native events before upgrading either application.

## Commands

- `brain <text>` sends a request; Brain acknowledges briefly and replies when finished.
- `brain status` checks your latest request.
- `brain result` retrieves your latest completed answer.
- `brain cancel` cancels your latest unsent or queued request.

`Brain, ...`, `brain: ...`, and `/brain ...` also work. Status/result/cancel can
still take an explicit connector key for troubleshooting. Latest-request lookup
is limited to the same assistant, channel, account, private chat and sender.
A known leading `Mem0 Active | ...` runtime banner is omitted from message
presentation; the native answer stored in Codeman is preserved.

Private numeric chats only: account, sender, chat, stable provider message ID and
command authorization must match. Groups, threads, missing IDs and foreign
routing metadata are refused. The connector key identifies the original
account/chat/sender/message and assistant; it is different from Codeman's request
UUID and native conversation ID. Canonical `content` supplies the command text.

`registerCommand` does not supply the stable provider message ID in the tested
SDK. Ordinary bot chats use `reply_dispatch`, which preserves trusted
`CommandAuthorized`, sender/account/chat, stable provider message ID and thread
metadata before model dispatch. `inbound_claim` remains available for explicitly
plugin-owned conversation bindings; it is not a global ingress hook. Its managed service submits/polls outside
ingress and sends through `runtime.channel.outbound.loadAdapter(channel).sendText`.
Unicode-safe chunks stay within 3500 UTF-16 units. Adapter formatting can affect
rendered Markdown. In the Codex harness's `message_tool_only` reply mode, acknowledgements are sent
explicitly through that trusted originating-channel adapter too; automatic dispatcher
replies remain suppressed. Delivery-denied, internal, group/thread and unauthorized
turns remain blocked. Prompts/results are not sent through another model.

## Questions during a Codex task (COD-507)

When the linked local Codex task asks a question, Brain sends it to the same
WhatsApp or Telegram chat. Reply directly to that question message, without a
Brain prefix. You can also send `brain answer <your answer>` when exactly one
question is pending in that chat. Use an option number or label for choices;
for several questions, put one answer on each line.

Answers resume the original request and native turn. They do not create another
queued task. Native async questions use `turn/steer` with the exact active turn
precondition and a recorded user-message ID. Blocking questions use the native
server request/response protocol. Codeman only subscribes to an already-loaded
local daemon thread at the bound `CODEX_HOME`; it never starts a replacement CLI
or daemon. This question relay requires a Codex version with that daemon API.
Claude/OpenCode task execution remains supported, but their interactive question
relay is not implemented here.

Question receipts are saved separately from final results, with the same
channel/account/private-chat/sender checks and delivery retry policy. Gateway
restarts preserve reply ownership. Provider-confirmed failures before dispatch
(including an unavailable WhatsApp listener during startup) use bounded retries;
unknown sends still require review. Duplicate confirmed answers are acknowledged
without another native write; stale questions and uncertain answer writes ask
for review in Codeman. Secret-marked native questions and permission approvals
stay in Codeman. Pending questions pause the normal observation deadline;
answering grants another 30 minutes for completion. Async question messages are
excluded from final-answer detection.

## Incoming photos and files

Attach a photo or document and put the request in its Telegram or WhatsApp caption:
`Brain, explain this photo` or `Brain, summarize this PDF`. A caption of just
`brain` asks it to review the attached files. Albums preserve attachment order
when OpenClaw exposes the album as one inbound message. Sending an unaddressed
attachment alone continues through OpenClaw's ordinary handling.

Set optional `mediaRoot` to the gateway's actual inbound download directory.
Media forwarding requires OpenClaw and Codeman on the same host with a loopback
Codeman origin and a local bound workspace. Existing remote text-only setups
remain supported; remote file transfer is deferred. Current SDK `media` facts
and legacy `MediaPaths`/`MediaPath` aliases are supported. Supplemental quoted
attachments and arbitrary URLs are never fetched.

After identity checks and binding readiness, the connector copies downloaded
files into the bound workspace's private `.codeman-telegram/<request-key>/`
folder (directories 0700, files 0600). Saved filenames use content hashes and
safe extensions. Brain receives the caption plus instructions to inspect the
local files with its file/image tools, through the same durable single-line
request API and exact native conversation. No upload or terminal-input token
scope is added. Original downloads can then expire without breaking accepted
work. Missing, unsafe, oversized, or unsaved attachments reject the entire
request; the caption is never silently submitted alone.

Limits: 10 files, 20 MiB per file, 40 MiB per request, 256 MiB retained per
workspace. OpenClaw/Telegram download limits may be lower. Files remain for
conversation references and review; no automatic deletion occurs. Archive only
completed/reconciled request directories when capacity is reached, preserving
outbox/ledger identity records and files needed by active requests. Photo,
text-file, and PDF analysis depends on the bound agent's file/image tools;
this does not add audio/video transcription or outbound file delivery.

## Guarantees and attention states

Codeman persists acceptance and the payload hash before returning a request.
The same key/payload returns the same UUID, including after restart; changed
payload returns 409. One turn runs per bound assistant/conversation. Dispatch
intent is persisted before the mux write. Native user acceptance, exact turn ID,
final-answer phase and matching task completion provide result attribution;
terminal output, commentary and idle timers cannot complete a request.

The ledger and PTY write cannot be atomic. An uncertain write, foreign turn,
identity change, transcript rotation/truncation or observation timeout pauses
execution as `outcome_unknown`. Possible tool side effects must be reviewed.
Restart reconciles possible writes without resubmitting them; queued work needs
a new explicit desktop handoff. Recovery requires taking control, reconciliation
and explicit rebind to a proven native conversation.

**Take control** disables the assistant, cancels queued work, waits for pending
submission, and marks active work interrupted. It releases Codeman's input lock;
it does not stop the agent or undo tool activity. Handle approvals or stop the task
in the desktop terminal, then acknowledge reconciliation before enabling again.
Direct tmux writes bypass the lock and must stop during handoff. Unexpected
native turns are detected conservatively.

The private outbox survives gateway restart. Lost acceptance responses retry the
same key/payload. Delivery failures never rerun completed work. A crash/timeout
while sending becomes `delivery_unknown`; automatic delivery stops. Retrieve
`/brain result` and review before manually sending a notification again.
Delivery is conservative, without an exactly-once notification guarantee.

Requests expire before dispatch after 30 minutes. An active observation deadline
blocks dispatch but does not interrupt the agent. Each assistant has 20 queued/
active slots; both durable ledgers retain at most 1000 records. Preserve backups
and idempotency tombstones when archiving; do not delete keys and replay old input.
No raw prompt, token or error is logged by the connector. Corrupt state is
preserved and execution fails closed.

## Automatic session recovery (COD-498)

An explicit desktop handoff arms bounded recovery for that assistant. If its
idle local supported session disappears or its agent exits, Codeman creates a
replacement with the saved session name/configuration and resumes the **exact**
native conversation, workspace and provider data/config home. It verifies native readiness,
current owner permissions and an empty composer before updating the binding and
restoring messaging ownership. Tokens and assistant identity are unchanged.
Only unsent queued requests migrate to the verified replacement binding;
submitted/uncertain work is never replayed.

Recovery waits 60 seconds after server startup for ordinary session restoration.
Each startup attempt has a 60-second readiness window; failed launches wait
30 seconds between retries, with at most three attempts persisted across restarts.
A live candidate with uncertain readiness stops for desktop review rather than
spawning another process. A missing/unfinished conversation, changed identity,
revoked owner or un-restorable session-only provider credentials also stops for
review. There is no fresh-conversation fallback. Active or uncertain requests
must be reviewed before recovery can proceed. **Take control** disarms recovery;
a new explicit handoff re-arms it and resets the attempt budget.

Private recovery profiles and attempt/launch intent are stored in instance-scoped
`assistant-recovery.json` (0600). Profiles can include private owner-authored
launch commands; never expose or commit this file. The API exposes only recovery
state, a safe reason and attempt count. The UI shows **Recovering** or **Recovery
needed**, and Telegram reports reconnecting/review instead of claiming readiness.
A normal Codeman restart that retains the same live session still needs an
explicit handoff; recovery does not take control of a healthy desktop session.

Run the isolated native recovery canary with:

```sh
node scripts/smoke-openclaw-assistant.mjs --pdf
node scripts/smoke-openclaw-assistant.mjs --mode=claude --recovery
node scripts/smoke-openclaw-assistant.mjs --mode=opencode --recovery --recovery
```

## HTTP API

Routes below use `/api/v1` and Codeman's `{success, data}` envelope; responses are
`no-store`. Management uses existing desktop user/admin authentication. A bearer
credential can only read/submit/cancel its own assistant's requests and cannot
access settings, management, terminal input, uploads, SSE or WebSockets.
Disabled/missing/password-reset owners invalidate bearer access.

| Method      | Route                                      | Body / behavior                                     |
| ----------- | ------------------------------------------ | --------------------------------------------------- |
| POST / GET  | `/assistants`                              | Create `{name, slug}` / list visible identities     |
| GET / PATCH | `/assistants/:id`                          | Inspect / `{expectedRevision, name?, enabled?}`     |
| POST        | `/assistants/:id/binding`                  | `{sessionId, expectedRevision, expectedGeneration}` |
| DELETE      | `/assistants/:id`                          | `{expectedRevision}`; disabled, no outstanding work |
| POST / GET  | `/assistants/:id/tokens`                   | Issue `{name, scopes}` / metadata only              |
| DELETE      | `/assistants/:id/tokens/:tokenId`          | Revoke                                              |
| POST        | `/assistants/:id/handoff`                  | `{expectedRevision, composerEmpty:true}`            |
| POST        | `/assistants/:id/take-control`             | Pause and release input ownership                   |
| POST / GET  | `/assistants/:id/requests`                 | Submit `{text, idempotencyKey}` / list              |
| GET         | `/assistant-requests/:requestId`           | Current status and completed `result.text`          |
| POST        | `/assistant-requests/:requestId/cancel`    | Queued cancellation only                            |
| POST        | `/assistant-requests/:requestId/reconcile` | Desktop-only `{acknowledgeSideEffects:true}`        |

Single-line text only, maximum 20,000 characters; terminal controls and CLI slash
commands are rejected. Request UUID lookups enforce both ownership and token
assistant scope. Revision/generation checks protect binding changes; duplicate
native-conversation bindings and remote/Docker sessions are rejected. Request
SSE wakeups contain IDs/status/revision only; GET remains authoritative.

## Provider identities and recovery (COD-499)

The linked session chooses the assistant's CLI. Complete one initial request in
that terminal before binding, then hand control over in **Assistants**. Messaging,
attachments, scoped tokens and bounded recovery use the same connector for all
three CLIs. Remote and Docker sessions remain unsupported.

- **Codex:** exact rollout UUID, configured Codex home and native turn completion.
- **Claude Code:** exact session UUID and config directory, parent-linked JSONL
  messages and native turn-duration completion. Recovery passes `--resume` with
  that UUID and preserves model, effort, tools and permission mode.
- **OpenCode:** exact `ses_…` identity and native SQLite messages/parts. Completion
  requires a finished assistant response linked to the submitted user message.
  Recovery resumes that ID without forking, preserving model/tool settings and
  checking both data and configuration roots. If workspace discovery finds
  multiple candidates, explicitly choose a native continuation before binding.

Existing Codex bindings and tokens remain compatible. The persisted/API binding
field `codexHome` retains its legacy name; for Claude it holds the config root,
for OpenCode the XDG data root. `binding.mode` distinguishes new provider bindings;
an omitted mode means Codex. Private recovery profiles never appear in the API.

Automatic recovery refuses custom endpoint profiles, session-only credentials,
Claude credential/endpoint overrides and custom OpenCode environment/inline configuration that
cannot safely be restored. Normal messaging can still be handed over, but those
sessions need manual recovery. Approval prompts still use the terminal and the
selected CLI's permission policy.

## Checks

```sh
npm test -- test/assistant-integration.test.ts test/assistant-requests.test.ts test/openclaw-connector.test.ts
npm --prefix integrations/openclaw test
node scripts/smoke-openclaw-assistant.mjs
# Optional PDF extraction canary (Python reportlab fixture generator required):
node scripts/smoke-openclaw-assistant.mjs --pdf
node scripts/smoke-openclaw-assistant.mjs --mode=claude --recovery
node scripts/smoke-openclaw-assistant.mjs --mode=opencode --recovery
```

The canary uses isolated instance/data/socket/home, a throwaway real session of the selected CLI
and a test Telegram adapter. It does not use a production bot or Brain session.
See [implementation evidence](../../docs/openclaw-integration-evidence.md) and
[release runbook](../../docs/openclaw-release-runbook.md).

## Reply conversation routing (COD-500)

The `reply_dispatch` adapter reads the SDK's `ReplyToIdFull`/`ReplyToId`, not the
quoted body. Ownership comes from durable delivery receipts or the bounded
`replyTargets` ledger (latest 2000 immediate connector replies) in the private
outbox. Existing result receipts remain usable after upgrade and restart. Every
result chunk can be replied to. Acknowledgements and status/result replies use
the same trusted receipt-bearing adapter in normal and `message_tool_only`
delivery modes. An acknowledgement failure still claims accepted work and
cannot fall through to OpenClaw's model or replay it.

Follow-ups retain their own incoming message ID/idempotency key and use the same
assistant/native conversation. They do not prepend quoted text, change global
routing, or replay the request being replied to. Chat authorization, groups,
threads, send policy and tail/internal dispatch restrictions remain enforced.
Test with `node scripts/smoke-openclaw-assistant.mjs --reply`.

### Recovery placement and custom Codex launchers (COD-502)

Recovered assistants retain their owner-scoped tab group. Moving an assistant
updates its recovery placement; deletion captures the current placement before
removing the old tab. If that group has since been removed, the replacement
appears in Ungrouped. This applies to Codex, Claude and OpenCode.

A custom Codex command must have an explicit resume template in the owner's
saved command profile, for example `exec codx cisco resume {{resumeId}}`.
Automatic recovery never guesses arguments for an opaque launcher or starts a
fresh conversation. Missing, changed or ambiguous templates require review.

A failed replacement launch may retry only when every native pane in that
replacement is confirmed exited. Unknown or live candidates remain blocked.
Retries remain bounded to three attempts, with no replay of accepted requests.

Run the isolated native regression canary with:

```sh
node scripts/smoke-openclaw-assistant.mjs --recovery --recovery-failure
```

It deliberately exits the first custom-launcher resume attempt, then verifies
that the next attempt resumes the same conversation in the original group.

### Telegram reply delivery retries (COD-503)

Recognized Telegram network failures, HTTP 429 and server errors retry the saved
reply with delays of 5, 15, 30, 60 and 120 seconds. A Telegram `retry_after`
response may lengthen that delay. The per-chunk failure count and next retry time
are persisted, so a gateway restart continues the schedule. Receipt-bearing
chunks are skipped; Codeman requests are never resubmitted by a delivery retry.

Permanent errors, missing receipts, a crash during a send, or exhausted retries
retain an uncertain delivery state. `brain result` can retrieve the saved answer.
Telegram sends have no idempotency key, so a network failure after Telegram
accepted a reply can produce a duplicate reply on retry; it never repeats the
task's actions.

The native canary supports `--delivery-retry` to inject one failed result send
and verify automatic recovery through the plugin service.

### WhatsApp validation

`node --test integrations/openclaw/connector.test.mjs` covers private phone/account
validation, unauthorized ingress, channel-scoped reply ownership, legacy outbox
loading, deduplication, adapter selection and retry/restart behavior.

`node scripts/smoke-openclaw-assistant.mjs --whatsapp --delivery-retry --reply`
uses an isolated Codeman instance, a real native CLI and a test WhatsApp adapter;
it reads image/text attachments, injects one result-send failure, verifies one
accepted task and reply routing after restart, and checks desktop/mobile UI.
It does not send WhatsApp messages or use production Brain.

COD-505 evidence (2026-10-10): 36 connector regression tests and the root test
wrapper passed. Typecheck, lint (one pre-existing warning), format and lockfile
checks passed. The WhatsApp/native Codex canary passed with text/image reading,
result delivery retry, receipt-backed replies after service restart, and desktop
and mobile checks. Artifacts: `/tmp/cod487-assistant-canary-d4J86l/summary.json`.
This proves the connector against an isolated native session and a test adapter;
production WhatsApp receipt acceptance requires a new user message.

### WhatsApp table presentation (COD-506)

New WhatsApp results render ordinary Markdown tables and self-contained tables
inside plain/text/Markdown code fences as labelled row blocks. Strict bordered
ASCII tables inside those fences are supported too. Ordinary code and ambiguous
or malformed tables remain unchanged. All columns are labelled and retained;
blank cells appear as an em dash. The native answer in Codeman is never rewritten.

Tables exceeding eight rows or 3500 rendered characters use a two-row preview
and a CSV document with all columns and rows. Spreadsheet formula-like cells are
prefixed with an apostrophe; CSV quotes and embedded quotes are escaped. Normal
text is chunked at 3500 UTF-16 units; table rows stay together. Oversized rows go
to CSV rather than being truncated.

Export data is persisted in the private outbox, so a retry or gateway restart
uses the exact saved parts and receipts, without rerunning Brain or resending
acknowledged parts. Existing deliveries keep their saved presentation, including
partially delivered answers from earlier releases. Export files use private
per-send directories and are deleted after the awaited adapter send, including
failed sends. `brain result` can retrieve an answer and its CSV; replies to CSV
receipts are owned by Brain in the same private chat. No production answer is
automatically resent when this formatting change is enabled.

Run the native end-to-end canary with
`node scripts/smoke-openclaw-assistant.mjs --whatsapp --delivery-retry --reply --tables`.
It verifies the unchanged native table, formatted preview and full CSV using a
test document adapter without sending a real WhatsApp message.

COD-506 evidence (2026-10-11): 44 formatter/connector regressions and the root
wrapper passed, along with typecheck, lint (existing warning), format and lockfile
checks. Native Codex + browser canary passed table/CSV delivery, input attachments,
retry without replay, prefix-free replies and desktop/mobile controls. Artifacts:
`/tmp/cod487-assistant-canary-c4Jdpc/summary.json`. The channel adapter was a test
adapter; real recipient rendering still requires a new user WhatsApp request.


## Multiline messages (COD-508)

Telegram and WhatsApp requests can contain multiple lines, blank lines, tabs, and
pasted commands. The connector removes only the Brain addressing prefix. It saves
the remaining message as a private UTF-8 file in the bound local workspace,
without trimming, wrapping, appending a newline, or changing LF/CRLF line breaks.
The native assistant reads that file as the user's original message. This also
works with attachments and all supported local assistant CLIs; the underlying
HTTP request and terminal submission remain single-line. No media download folder
is required for text-only messages. Terminal escape/control characters remain
rejected, and the original 20,000-character input limit still applies.

The message file uses the existing bounded private attachment storage and survives
connector restarts and duplicate delivery. Original-message hashes still detect
edited duplicate messages. Files may contain sensitive pasted text: archive them
with the workspace's other retained assistant attachments. Messages rejected
before this fix are not automatically replayed; send a new message after updating.

Run `node scripts/smoke-openclaw-assistant.mjs --whatsapp --multiline` for an
isolated native readback with exact saved-byte assertions and temporary attachments.


## Short Codex reply submission recovery (COD-513)

All automated Codex prompts use explicit paste boundaries, including short replies.
For a newly dispatched assistant request, Codeman checks the full composer on a
bounded schedule for up to 60 seconds. It presses only Enter while the exact
request remains unsubmitted, its native transcript has not changed, and the same
live binding, input permit and credential remain valid. Changed text, a dialog,
native activity, automation, shutdown or revoked ownership stops recovery. It
never retypes the message and does not rearm old delivery intents after restart.

Run `node scripts/smoke-openclaw-assistant.mjs --whatsapp --submit-retry` to
withhold the first Enter in an isolated native session and verify one completed
request and one returned result through the channel adapter.
