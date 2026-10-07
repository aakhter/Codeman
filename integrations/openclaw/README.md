# OpenClaw → Codeman assistant connector

Part of [COD-487](https://aakhter.atlassian.net/browse/COD-487), phases 0/1/3 on one branch.
This package is opt-in and does not install itself into a gateway. The tested host is
OpenClaw **2026.9.8 (fc23bc8)** with Node 22+. Recheck the SDK before upgrading.

The current Codeman assistant API stores identities, exact local Codex bindings,
and scoped credentials. **Execution remains unavailable until COD-490 adds the
durable request engine and desktop handoff.** The connector reports this explicitly.
Phase 3 is implemented and tested against a contract fixture; this is not a live
Telegram/Brain acceptance test. Optional model-driven tools are deferred.

## Assistant management

Use the existing desktop administrator authentication for these `/api/v1` routes.
Responses use Codeman's `{success, data}` envelope. All assistant responses are `no-store`.

| Method | Route | Body / behavior |
| --- | --- | --- |
| POST | `/assistants` | `{name, slug}`; creates a disabled local Codex identity |
| GET | `/assistants` or `/assistants/:id` | Owner-visible metadata and capabilities |
| PATCH | `/assistants/:id` | `{expectedRevision, name?, enabled?}` |
| POST | `/assistants/:id/binding` | `{sessionId, expectedRevision, expectedGeneration}`; starts generation at 0 |
| DELETE | `/assistants/:id` | `{expectedRevision}`; requires disabled and reconciled requests; revokes tokens |
| POST | `/assistants/:id/tokens` | `{name, scopes:["read","submit","cancel"]}`; reveals token once |
| GET | `/assistants/:id/tokens` | Metadata only |
| DELETE | `/assistants/:id/tokens/:tokenId` | Revocation |

Bind only an idle, running, local Codex session with available credentials. The
native rollout must have matching metadata ID and workspace, plus a unique
Codeman originator or an explicit matching native resume ID. Conflicting resume
IDs, multiple owned rollouts, remote/docker sessions, and cross-owner bindings
are rejected. A shared workspace or the newest transcript is insufficient.
Rebinding requires current revision and generation. The phase 2 implementation
must inject its outstanding-request guard before enabling dispatch.

Tokens are 256-bit random credentials, stored only as SHA-256 hashes in the
instance-specific private `assistants.json`. A bearer token is limited to one
assistant and its granted scopes; it cannot manage assistants/tokens or use
session input, settings, SSE, uploads, or the terminal WebSocket. Disabled,
missing, or password-reset owners invalidate bearer access in multi-user mode.
Switching to single-user mode does not promote an owned token to administrator.

## Installation after the execution engine ships

Install/link this directory through OpenClaw's normal plugin workflow. Configure
`plugins.entries.codeman-assistant` with `enabled: true` and this `config`:

```json
{
  "baseUrl": "http://127.0.0.1:3002",
  "assistantId": "<assistant UUID from Codeman>",
  "accountId": "<configured Telegram account ID>",
  "allowFrom": ["<numeric Telegram sender ID>"],
  "tokenEnv": "CODEMAN_BRAIN_TOKEN"
}
```

Set that environment variable in the gateway's credential environment, using a
scoped Codeman token. Never put the token in this config, logs, or source control.
The base URL must be an HTTPS origin or loopback HTTP; credentials, redirects,
query strings, subpaths, and arbitrary model-supplied destinations are rejected.
Subpath hosting is not supported by this initial connector.

Use a separate test profile and bot for gateway testing. Do not create another
poller for the production bot. Root npm installation does not load this plugin.

## Commands and delivery

- `/brain <single-line text>` accepts a request into the connector outbox.
- `/brain status <connector-key>` reports locally observed request/delivery state.
- `/brain result <connector-key>` retrieves its stored completed result.
- `/brain cancel <connector-key>` requests queued cancellation from Codeman.

The key in the acknowledgement identifies the original account/chat/sender/message
and assistant. It is not a native Codex thread ID. The connector stores Codeman's
request UUID after durable API acceptance. Private-chat sender IDs are explicitly
allowlisted and must match the chat; groups, threads, missing IDs, unauthorized
commands, and mismatched routing metadata are refused. OpenClaw's model is not
called for these requests. Command text comes from the canonical `content` field,
not the decorated body. `telegram:<chat-id>` and numeric canonical chat forms
are supported.

The installed `registerCommand` handler lacks the provider message ID, so this
plugin uses the supported `inbound_claim` hook. Its managed service submits and
polls outside the ingress handler and sends completed results through
`runtime.channel.outbound.loadAdapter('telegram').sendText`. Unicode-safe chunks
stay within 3500 UTF-16 units; text is passed to the Telegram adapter without an
extra model invocation. Adapter formatting can affect rendered Markdown.

The private outbox under the service's `stateDir` survives gateway restart. A
lost API acceptance response retries the **same** idempotency key and payload.
That is safe only with phase 2's durable idempotency contract. Delivery failures
never submit a completed request again. A crash/timeout during a Telegram send
becomes `delivery_unknown` and automatic delivery stops. Retrieve the stored
result with `/brain result` and review the uncertain notification before any
manual delivery retry. Delivery is conservative, not an exactly-once guarantee.
No raw prompt/token/error is logged. Corrupt state is preserved; capacity is 1000
records and requires operator archival of reconciled records. Approvals,
interruptions, and unknown execution outcomes require desktop attention.

## Phase 2 HTTP contract required by the connector

These routes currently return 503 and `capabilities.requestExecution` is false.
Phase 2 must implement them before changing that capability:

```text
POST /api/v1/assistants/:id/requests
  { text, idempotencyKey }
GET /api/v1/assistant-requests/:requestId
POST /api/v1/assistant-requests/:requestId/cancel
```

Request responses must include `{id, assistantId, idempotencyKey, status}`;
completed requests additionally include `result: {text}`. Supported statuses are
`queued`, `dispatching`, `running`, `awaiting_approval`, `completed`, `failed`,
`cancelled`, `interrupted`, and `outcome_unknown`. The same key with the same
payload must return the same durable request UUID; a different payload must
conflict. Request routes must verify request ownership and assistant scope at
lookup, including GET/cancel by request UUID. The bearer middleware's path/scope
check alone cannot provide request-level ownership. Cancellation is queued-only.

## Checks

```sh
npm test -- test/assistant-integration.test.ts test/openclaw-connector.test.ts
npm --prefix integrations/openclaw test
```

The root CI test invokes the package's regression suites. The native contract
probe is deliberately read-only and is not a production turn observer:

```sh
node integrations/openclaw/codex-contract-spike.mjs \
  <rollout-path> <native-conversation-id> <originator> '<known-test-prompt>'
```

See [phase evidence](../../docs/openclaw-integration-evidence.md) for the exact
verified versions, supported signals, and remaining release gates.
