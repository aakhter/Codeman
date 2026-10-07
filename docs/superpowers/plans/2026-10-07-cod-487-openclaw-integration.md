# COD-487: OpenClaw integration and named assistants

Issue: https://aakhter.atlassian.net/browse/COD-487

Status: phases 0, 1, and 3 implementation started on 2026-10-07, authorized by the follow-up request. One branch: `feat/COD-487-openclaw-phases-0-1-3`. Phase 3 is tested against the proposed request contract; phase 2 remains a prerequisite for execution. See `docs/openclaw-integration-evidence.md`. Production deployment and live Brain input remain outside this work.

## Outcome

The user can send `/brain <request>` in Telegram and receive the answer from the same Brain conversation they use in Codeman. OpenClaw owns messaging and delivery. Codeman owns assistant identity, execution, and request results. Brain's workspace holds its knowledge, instructions, and tools.

```text
Telegram <-> OpenClaw connector <-> Codeman assistant API <-> Brain's active session
                                            ^                         |
                                      Desktop / Web             Brain workspace
```

An assistant is a stable, owner-scoped identity with an explicit conversation binding. A case remains a workspace configuration, and a session remains a running CLI instance. Several sessions may use a workspace; that alone must never select the assistant's conversation.

OpenClaw keeps its own conversation history. Explicit `/brain` requests bypass OpenClaw's model and forward the user's text; optional model-driven delegation comes later. Replies go only to the initiating chat/thread. Ordinary desktop work is not automatically broadcast to Telegram.

## Evidence and corrections to the initial sketch

Inspected checkout HEAD: `30efd7f4`. Installed OpenClaw CLI: `2026.9.8 (fc23bc8)`; this is not proof of the running gateway's build or plugin compatibility.

Read-only live inspection found `w1-brain`, session `b3893c71-c562-4f8b-b0ee-be36706a2f21`, mode `codex`, local transport, workspace `/mnt/syncthing/brain`. The list response exposed neither a native resume ID nor an explicit resume configuration. This does not prove the native conversation is missing: binding must resolve and validate it independently. This UUID is diagnostic context, not a default to hard-code.

| Existing code | Reuse / limitation |
| --- | --- |
| `src/web/routes/session-routes.ts`: input + wait | Registers the waiter before writing, avoiding the previous-idle race. Delivery acknowledgement is not proof that the CLI accepted or completed a turn. |
| Same file: `last-response` | Prefers Codex rollout data but can fall back to terminal parsing. It is a viewer endpoint, not a request-correlated result API. |
| `src/codex-rollout-reader.ts` | Shared structured parser for response viewer and Read My Mind. Current projection exposes text/timestamps, not native turn identity or completion evidence. Extend through a separate projection without changing viewer behavior. |
| `src/codex-transcript.ts` | Primarily history and identity scanning; reuse identity helpers, not as the sole answer reader. |
| `src/checkpoint-conversation-identity.ts`, `src/native-session-identity.ts` | Reuse exact conversation evidence and effective CODEX_HOME handling. Audit discovery fallbacks before using them for unattended routing. |
| `src/session.ts`: `shouldApplyInput` | Session-local sequence deduplication is not a durable request ledger. |
| `src/web/routes/ws-routes.ts` | Browser terminal input has its own direct write path. An HTTP-only lock will not prevent concurrent input. |
| `src/task-queue.ts` | Existing general task scheduling is not a durable turn/result contract. Share appropriate primitives only after comparison; do not couple assistant requests to Ralph scheduling. |
| `src/web/session-recovery-service.ts`, `src/session-recovery.ts` | Reuse validated recovery paths; do not add a second launcher or weaken exact-resume guards. |
| `src/web/approval-inbox.ts` | In-memory prompts; coverage differs by CLI. Do not promise complete Codex approval forwarding based on this alone. |

**Refined order:** an external adapter is sufficient for an isolated feasibility experiment. A production Telegram bridge needs durable requests and input coordination in Codeman first. Deliver those before connecting the real Brain session.

## First release boundaries

- Local, managed Codex sessions with a proven native conversation and supported structured transcript format.
- One explicitly bound assistant, Brain; generic API names so other assistants can be added later.
- Text requests and final text answers. Queue/status messages and an attention link to Codeman.
- Telegram private chat, existing authorized account policy, explicit `/brain` command.
- No automatic conversation creation or implicit switch on resume failure. Recovery remains an explicit operation initially.
- No voice, attachments, group-topic routing, automatic natural-language delegation, Telegram approval buttons, remote/Docker execution, or other CLI support in this first release. The data model leaves room for them.
- No broad autonomous multi-agent runtime and no OpenClaw code running inside Codeman's process.

## Proposed Codeman model

Names and limits below are design proposals, not existing API promises.

**AssistantDefinition:** immutable ID; owner; display name/owner-unique slug; workspace reference; CLI/provider profile references; enabled flag; current session ID; exact native conversation identity including transport and canonical CLI data-home identity; binding generation; supported capabilities. Credentials and raw launch commands stay in their existing canonical configuration.

**AssistantRequest:** server ID; owner and integration principal; assistant ID; client idempotency key and payload hash; immutable binding snapshot/generation; prompt; timestamps; lifecycle state; submission evidence; transcript cursor and native turn ID when available; result reference; reason code. Channel destination is connector-owned and never accepted as authorization from the prompt.

**Storage proposal:** dedicated versioned assistant/request store under `dataPath(...)`, separate from the large session state file. Use serialized atomic snapshots with explicit durable checkpoints before dispatch and before acknowledging acceptance; implement and test flush semantics, permissions, corruption handling, and crash recovery. Keep prompt/results out of general settings, session names, and global search. Initial bounds: 20 queued requests per assistant, 16 KiB UTF-8 prompt, 1 MiB stored final answer, 30-day terminal-result retention. Preserve nonterminal/uncertain records. Retain idempotency tombstones for 90 days and document that retry window; purged results return an explicit expired result instead of rerunning.

## Request lifecycle and guarantees

```text
queued -> dispatching -> running -> completed
   |          |            |  <-> needs_attention
   |          |            +----> interrupted / failed / outcome_unknown
   |          +-----------------> outcome_unknown
   +----------------------------> cancelled / expired
```

1. Authenticate and authorize against the assistant and bound session. Validate capability, binding generation, queue limit, and payload.
2. Persist the request and idempotency record before returning `202`. Same key + same payload returns the same request; same key + different payload returns `409`.
3. Dispatch one request at a time per bound session/conversation, not merely per assistant name. Disallow a second assistant binding to the same live conversation in v1.
4. Under the shared input coordinator, verify CLI readiness, exact conversation, no conflicting automation, and no user-owned composer/input activity. Capture a structured transcript cursor and persist `dispatching` before sending input.
5. Submit through existing Session input machinery. Mark `running` only after the transcript proves the new user turn. Store native turn identity if the installed format supplies it; otherwise require validated cursor/ordered-event evidence and exclusive submission.
6. Complete only when the same turn has supported final/completion evidence. Commentary, an idle timer, a successful PTY write, or the latest nonempty answer alone cannot complete a request. Exclude reasoning/tool output from the returned answer.
7. A restart after a possible write must reconcile exact transcript evidence. If acceptance or completion cannot be proven, set `outcome_unknown` and stop dispatch on that conversation pending review. Never resend automatically just because a HTTP call timed out.

**Guarantee:** durable idempotent request acceptance and conservative handling of ambiguous execution. PTY writes and the local ledger cannot form one atomic transaction, so do not claim unconditional exactly-once execution. A failed or timed-out request may already have produced tool side effects.

Initial request deadline: 30 minutes, configurable. An observation deadline stops waiting and blocks further automatic dispatch until the session is reconciled; it does not interrupt the agent or mean the task failed. Queued cancellation removes only that queued request. Active interruption is an explicit desktop operation in v1.

## Desktop and other input coordination

Both HTTP and WebSocket input paths must consult the same session-level coordinator, including the async mux submission window. Audit direct writers: approvals, cron, Ralph/respawn, checkpoint flows, TUI/local attach, and agent-to-agent input.

- Before dispatch, active desktop input or an unsubmitted composer defers delegation. Idle status alone is insufficient. If composer emptiness cannot be established, require an explicit desktop handoff.
- While a delegated request owns the turn, desktop output remains visible; an opt-in assistant session shows a composer lock with “Brain is answering a Telegram request” and “Take control”. Ordinary sessions retain current behavior.
- Take control releases automation only through a coordinated transition, marks the request interrupted/uncertain, and pauses further queued requests. Do not silently append desktop text to the delegated prompt or discard keystrokes.
- Approval replies may proceed only for the currently matched prompt. No generic input exemption for arbitrary text.
- Conflicting cron/Ralph/respawn/checkpoint activity makes the assistant unavailable for automatic dispatch until resolved.
- Direct tmux input bypasses API locks. Detect unexpected transcript turns or identity changes and stop attribution; document this limitation. Raw local attachment cannot be made mutually exclusive by an HTTP guard.
- Terminal framing preserves prompt content as far as the verified CLI transport permits. The existing single-line-plus-CR path strips embedded newlines: support multiline only after a tested transport strategy exists; otherwise reject it clearly rather than silently altering it. Reject terminal controls and CLI slash commands on the generic ask endpoint in v1.

## Proposed HTTP and event contract

Use the existing `/api/v1` aliasing and ApiResponse envelope. New routes must preserve ownership concealment and existing authorization conventions.

| Operation | Proposed route |
| --- | --- |
| List/create assistants | `GET/POST /api/v1/assistants` |
| Inspect/update assistant | `GET/PATCH /api/v1/assistants/:id` |
| Explicitly bind an existing session | `POST /api/v1/assistants/:id/binding` with session ID and expected generation |
| Submit/list requests | `POST/GET /api/v1/assistants/:id/requests` |
| Get status and final result | `GET /api/v1/assistant-requests/:id` |
| Cancel a queued request | `POST /api/v1/assistant-requests/:id/cancel` |

SSE `assistant:updated` and `assistant-request:updated` are owner-filtered wakeups with IDs/status/revision only. GET is authoritative after reconnect; do not depend on SSE replay or include entire prompts/results in broadcasts. Use expected revisions for binding updates. Binding changes with active work return conflict and require reconciliation; queued requests cannot silently move to another conversation.

Additive integration authorization: opaque revocable tokens scoped to owner, assistant ID(s), and submit/read/queued-cancel capabilities. Hash tokens at rest, reveal only at creation, and reject them on unrelated routes. Do not reuse the hook secret or grant the plugin an unrestricted admin password for the production rollout. Test the new principal through the common authentication layer and the assistant routes.

## OpenClaw connector

Recommended form: a separately packaged OpenClaw plugin with a deterministic command and optional agent tools, calling Codeman over its authenticated API. An MCP wrapper is a later compatibility option, not required for the initial Telegram command.

Proposed source location: `integrations/openclaw/`, isolated package and build/test configuration. Do not repurpose `plugins/codeman/`, which is the existing Claude plugin mirror. Installation must be explicit; root postinstall must not load it into the production gateway.

- Register `/brain <text>`, `/brain status`, `/brain result <request-id>`, and queued cancellation. Command parsing must distinguish subcommands from ordinary prompt text.
- Generic optional tool names: `codeman_assistant_ask`, `codeman_assistant_status`, `codeman_assistant_result`. Brain is an assistant binding, not a hard-coded tool implementation.
- Map trusted Telegram account/chat/message metadata to a durable idempotency key and permitted assistant. The model cannot supply another user's principal or a reply destination. Restrict request retrieval to the originating authorized conversation as well as the Codeman token scope.
- Acknowledge with a request ID promptly. Use a managed plugin service/outbox for eventual delivery; long-running Brain work must not depend on a single command handler remaining alive.
- Persist request-to-destination mappings and delivery state across plugin/gateway restarts. Use channel SDK delivery, formatting, and chunk limits. Completed execution and successful Telegram delivery are separate states.
- Prefer editing a known acknowledgement message for final output where supported. An uncertain Telegram send may duplicate a notification; it must never rerun the Brain request. Make request IDs visible for reconciliation.
- Default to verbatim final text with transport-safe formatting. No extra OpenClaw model invocation is required for `/brain`.
- Report “needs attention” with a Codeman link only when supported evidence exists. Generic stalled turns remain explicitly unknown; no guessed auto-approval.

Official references, checked 2026-10-07: [tools and commands](https://docs.openclaw.ai/plugins/sdk-overview/tools-and-commands), [tool plugins](https://docs.openclaw.ai/plugins/tool-plugins), [plugin lifecycle](https://docs.openclaw.ai/tools/plugin). Installed SDK documentation confirms registerCommand bypasses the LLM and registerTool exposes agent tools. Source is the authority for the pinned installed version; verify actual command context, ingress IDs, and background delivery before choosing precise SDK calls.

## Work packages and dependencies

COD-487 remains the parent feature. All six work packages have Jira subtasks, created on 2026-10-07. Use the matching issue key for each implementation PR.

| Phase | Child issue | Blocked by |
| --- | --- | --- |
| 0 | [COD-488: integration contract spike](https://aakhter.atlassian.net/browse/COD-488) | None |
| 1 | [COD-489: named assistants and scoped access](https://aakhter.atlassian.net/browse/COD-489) | COD-488 |
| 2 | [COD-490: requests and input coordination](https://aakhter.atlassian.net/browse/COD-490) | COD-489 |
| 3 | [COD-491: OpenClaw plugin and Telegram delivery](https://aakhter.atlassian.net/browse/COD-491) | COD-490 |
| 4 | [COD-492: assistant UI and recovery binding](https://aakhter.atlassian.net/browse/COD-492) | COD-490 |
| 5 | [COD-493: release and Brain canary](https://aakhter.atlassian.net/browse/COD-493) | COD-491, COD-492 |

Phases 3 and 4 may proceed independently after phase 2. The minimum desktop lock/take-control UI belongs to phase 2; phase 4 completes the management UI.

| Order | Work package | Likely files / responsibility | Exit criterion |
| --- | --- | --- | --- |
| 0 | Feasibility and contract spike | Isolated fixtures/harness; OpenClaw SDK inspection; existing input/wait/rollout readers | Prove exact session attribution, prompt acceptance, final-turn signal, command sender/message IDs, async delivery, and safe composer handoff. Record unsupported formats explicitly. |
| 1 | Assistant identity, store, and scoped API access | New `src/types/assistant.ts`, `src/assistant-store.ts`, `src/assistant-registry.ts`; route helpers/auth integration; `src/web/routes/assistant-routes.ts`, server registration and schemas | Owner-scoped CRUD/binding, versioned persistence, least-privilege connector credentials, exact local Codex capability check. |
| 2 | Durable request engine and turn/input coordination | New `src/assistant-request-manager.ts`, `src/session-input-coordinator.ts`, `src/assistant-turn-observer.ts`; parser projection; Session, HTTP/WS input, event wiring and API errors | Restart/retry/concurrent-input tests prove correct attribution and conservative ambiguous outcomes. |
| 3 | OpenClaw plugin and Telegram delivery | `integrations/openclaw/` and connector documentation | Private-chat `/brain` submits once, reports progress, and delivers the matching result through gateway restart using a test assistant. |
| 4 | Desktop assistant controls and recovery binding | New `src/web/public/assistants-ui.js`; session/settings integration, markup/styles, recovery service hooks | Configure/bind/pause assistant, inspect request queue, take control, and explicitly rebind after validated recovery; desktop/mobile browser checks pass. |
| 5 | Opt-in Brain canary and release | Runbook, deployment evidence, Jira verification | One authorized real Brain request returns the matching answer, with session/conversation identity preserved and rollback demonstrated. |

Packages 1 and 2 precede production connector use. Package 4's minimum lock/take-control UI must ship with package 2 before any live shared-session canary; the rest of the settings UI may follow. Package 0 is a disposable isolated experiment, not a production bridge with partial guarantees.

## Validation and release gates

- Unit fixtures: duplicate textual prompts, partial JSONL records, multi-message turns, commentary vs final, compaction, aborts, unknown formats, rotated/truncated files, custom CODEX_HOME, ambiguous identity, and exclusion of other conversations/subagents.
- Request engine: same/different-payload retries, concurrent acceptance, crash before/after dispatch write, restart after CLI acceptance, result before ledger persistence, corrupt store, queue capacity, expiry, and retention/tombstones.
- Integration: HTTP and WS races, nonempty composer, desktop takeover, independent terminal input, stale approvals, automation collision, binding generation changes, unavailable transcript, owner/token revocation, cross-owner GET/SSE, and secret-free diagnostics.
- Connector: duplicate Telegram updates, wrong sender/chat, gateway restart, delayed results, delivery timeout, chunked long replies, unsupported multiline/control input, and no request resubmission on reply failure.
- Run existing related suites: `test/codex-rollout-reader.test.ts`, `test/native-session-identity.test.ts`, `test/routes/session-wait-routes.test.ts`, `test/session-wait-registry.test.ts`, recovery and HTTP/WS input tests selected after edits.
- Before review: typecheck, lint, format check, lockfile check, targeted tests, frontend syntax/assets checks where applicable. Verify API responses with curl and UI with Playwright using domcontentloaded and async population waits.
- All development instances use unique CODEMAN_INSTANCE/data directory/tmux socket and test workspace. Never submit experimental input to w1-brain or other user sessions. Use a separate OpenClaw test profile/channel setup; do not start a second poller on the production bot token.
- Production deployment and real Telegram/Brain test are a later explicitly authorized step. Source merge, build/deploy, Bitbucket CI, and observed end-to-end delivery are distinct evidence. Release only to this checkout's Bitbucket repository.
- Rollback: disable connector and assistant dispatch; preserve durable requests/results; reconcile uncertain in-flight work. Do not kill/recreate Brain to undo the integration, and do not replay pending prompts during rollback.

## Decisions to settle in the spike

1. Which installed Codex event shapes provide dependable turn completion? The current parser discards the required distinctions. If none can be proven for the live format, stop the production path and revise the execution mechanism.
2. Can the installed OpenClaw command context provide stable update/message IDs and trusted reply routing, and which managed service/delivery APIs survive reload? If IDs are absent, use a supported ingress hook; never invent prompt-text-based deduplication.
3. Can a composer be proven empty before mux input? Choose a tested check or explicit handoff; an arbitrary idle delay is inadequate.
4. What exact identity proof binds the existing Brain session, including any custom provider data home? Do this read-only before enabling it.

Default product choices for planning: explicit /brain command, private chat, text-only local Codex, queued requests, final-answer delivery, desktop approval handling, manual recovery. These keep the first release narrow while retaining the named-assistant end goal.
