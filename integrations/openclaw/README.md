# OpenClaw → Codeman assistant connector

[COD-487](https://aakhter.atlassian.net/browse/COD-487) implements named assistants,
durable requests and an opt-in OpenClaw connector. The tested versions are
OpenClaw **2026.9.8 (fc23bc8)**, Codex **0.160.1**, and Node 22+.
Optional model-driven tools are deferred; explicit `/brain` bypasses OpenClaw's model.

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
  "tokenEnv": "CODEMAN_BRAIN_TOKEN"
}
```

Set `CODEMAN_BRAIN_TOKEN` in the gateway service's environment. Use a separate
profile and bot for testing; never start a second poller for the production bot.
Only HTTPS origins or loopback HTTP are accepted. Redirects, credentials, query
strings, subpaths and model-selected destinations are rejected. Recheck the SDK
and native events before upgrading either application.

## Commands

- `/brain <single-line text>` queues a request and acknowledges its connector key.
- `/brain status <connector-key>` fetches current request/delivery state.
- `/brain result <connector-key>` retrieves the matching stored final answer.
- `/brain cancel <connector-key>` cancels unsent local work or queued Codeman work.

Private numeric chats only: account, sender, chat, stable provider message ID and
command authorization must match. Groups, threads, missing IDs and foreign
routing metadata are refused. The connector key identifies the original
account/chat/sender/message and assistant; it is different from Codeman's request
UUID and native conversation ID. Canonical `content` supplies the command text.

`registerCommand` does not supply the stable provider message ID in the tested
SDK, so the plugin uses `inbound_claim`. Its managed service submits/polls outside
ingress and sends through `runtime.channel.outbound.loadAdapter('telegram').sendText`.
Unicode-safe chunks stay within 3500 UTF-16 units. Adapter formatting can affect
rendered Markdown. Prompts/results are not sent through another model.

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
```

The canary uses isolated instance/data/socket/home, a throwaway real Codex session
and a test Telegram adapter. It does not use a production bot or Brain session.
See [implementation evidence](../../docs/openclaw-integration-evidence.md) and
[release runbook](../../docs/openclaw-release-runbook.md).
