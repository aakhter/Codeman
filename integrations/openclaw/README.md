# OpenClaw → Codeman assistant connector

[COD-487](https://aakhter.atlassian.net/browse/COD-487) implements named assistants,
durable requests and an opt-in OpenClaw connector. The tested versions are
OpenClaw **2026.9.8 (fc23bc8)**, Codex **0.160.1**, and Node 22+.
Address Brain with `brain <request>`, `Brain, <request>`, or `/brain <request>`
to bypass OpenClaw's model. Optional model-driven tools are deferred.

## Setup

1. Open **Assistants** in Codeman, create an assistant, and bind an idle local
   Codex session. Binding validates the exact native conversation and canonical
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

- `brain <single-line text>` sends a request; Brain acknowledges briefly and replies when finished.
- `brain status` checks your latest request.
- `brain result` retrieves your latest completed answer.
- `brain cancel` cancels your latest unsent or queued request.

`Brain, ...`, `brain: ...`, and `/brain ...` also work. Status/result/cancel can
still take an explicit connector key for troubleshooting. Latest-request lookup
is limited to the same assistant, Telegram account, private chat and sender.
A known leading `Mem0 Active | ...` runtime banner is omitted from Telegram
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
ingress and sends through `runtime.channel.outbound.loadAdapter('telegram').sendText`.
Unicode-safe chunks stay within 3500 UTF-16 units. Adapter formatting can affect
rendered Markdown. In the Codex harness's `message_tool_only` reply mode, acknowledgements are sent
explicitly through that trusted Telegram adapter too; automatic dispatcher
replies remain suppressed. Delivery-denied, internal, group/thread and unauthorized
turns remain blocked. Prompts/results are not sent through another model.

## Incoming photos and files

Attach a photo or document and put the request in its Telegram caption:
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
it does not stop Codex or undo tool activity. Handle approvals or stop the task
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

## HTTP API

Routes below use `/api/v1` and Codeman's `{success, data}` envelope; responses are
`no-store`. Management uses existing desktop user/admin authentication. A bearer
credential can only read/submit/cancel its own assistant's requests and cannot
access settings, management, terminal input, uploads, SSE or WebSockets.
Disabled/missing/password-reset owners invalidate bearer access.

| Method | Route | Body / behavior |
| --- | --- | --- |
| POST / GET | `/assistants` | Create `{name, slug}` / list visible identities |
| GET / PATCH | `/assistants/:id` | Inspect / `{expectedRevision, name?, enabled?}` |
| POST | `/assistants/:id/binding` | `{sessionId, expectedRevision, expectedGeneration}` |
| DELETE | `/assistants/:id` | `{expectedRevision}`; disabled, no outstanding work |
| POST / GET | `/assistants/:id/tokens` | Issue `{name, scopes}` / metadata only |
| DELETE | `/assistants/:id/tokens/:tokenId` | Revoke |
| POST | `/assistants/:id/handoff` | `{expectedRevision, composerEmpty:true}` |
| POST | `/assistants/:id/take-control` | Pause and release input ownership |
| POST / GET | `/assistants/:id/requests` | Submit `{text, idempotencyKey}` / list |
| GET | `/assistant-requests/:requestId` | Current status and completed `result.text` |
| POST | `/assistant-requests/:requestId/cancel` | Queued cancellation only |
| POST | `/assistant-requests/:requestId/reconcile` | Desktop-only `{acknowledgeSideEffects:true}` |

Single-line text only, maximum 20,000 characters; terminal controls and CLI slash
commands are rejected. Request UUID lookups enforce both ownership and token
assistant scope. Revision/generation checks protect binding changes; duplicate
native-conversation bindings and remote/Docker sessions are rejected. Request
SSE wakeups contain IDs/status/revision only; GET remains authoritative.

## Checks

```sh
npm test -- test/assistant-integration.test.ts test/assistant-requests.test.ts test/openclaw-connector.test.ts
npm --prefix integrations/openclaw test
node scripts/smoke-openclaw-assistant.mjs
# Optional PDF extraction canary (Python reportlab fixture generator required):
node scripts/smoke-openclaw-assistant.mjs --pdf
```

The canary uses isolated instance/data/socket/home, a throwaway real Codex session
and a test Telegram adapter. It does not use a production bot or Brain session.
See [implementation evidence](../../docs/openclaw-integration-evidence.md) and
[release runbook](../../docs/openclaw-release-runbook.md).
