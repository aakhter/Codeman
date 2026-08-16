# Read My Mind

Codeman's per-case memory of what you are trying to accomplish, and the 🧠 button that turns it into a predicted next prompt. Each case has an **intent profile**: freeform `goals` written by you or your agent, plus durable Claude prompts captured while the feature is on. Codex prompts are read only on demand from the strictly owned rollout for prediction and are never persisted. Pressing 🧠 asks a short-lived predictor process for one to three suggestions; you can send, insert, edit, rethink, or dismiss them. Nothing is sent to a session automatically. Design and history: [`readmymind-plan.md`](readmymind-plan.md).

## What it supports

Read My Mind supports **Claude sessions** and **local Codex sessions** only. Provider lanes are strict:

- A Claude session runs one-shot `claude -p` with Claude context and the Claude-only `readMyMindModel` setting.
- A local Codex session runs a separate ephemeral, noninteractive `codex exec` child using that session's provider identity and conversation rollout. It is a short-lived predictor process, not a new interactive Codeman tab or conversation.

There is no cross-provider fallback: a failed Codex prediction never starts Claude, and a failed Claude prediction never starts Codex. Remote-SSH and Docker Codex sessions, plus Shell, OpenCode, Gemini, Antigravity, and Pi, are unsupported. The UI warns before opening Read My Mind for an unsupported session; the global setting being on does not make every mode eligible. Claude's existing scope is unchanged.

## Turning it on

App Settings → Header & Panels → Cross-session features → **Read My Mind** (synced setting `readMyMindEnabled`, default **OFF**). It gates capture and the desktop/phone controls. The API equivalent:

```bash
curl -sk -X PUT https://localhost:3000/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"readMyMindEnabled": true}'
```

Add `-u user:password` if your install has `CODEMAN_PASSWORD` set, and drop `-k`/use `http://` for a plain-HTTP dev server. Turning it OFF stops Claude prompt capture immediately; existing profiles stay until you delete them.

## The 🧠 button

On a supported session, press the brain button in the desktop header or the 🧠 key on the phone/tablet keyboard accessory bar. Codeman combines your goals and recent prompts with the session's last assistant reply, tool activity, workspace signals, away context, sibling sessions, and any pending dialog. The first suggestion opens in an editable field; alternate suggestions are tappable rows.

- **Send** submits it with Enter.
- **Insert** puts it on the CLI composer without Enter so you can edit it first.
- **Rethink** re-runs with the shown suggestions treated as rejected. Its optional steer note is your own highest-authority signal.
- **Dismiss** closes the dialog.

A prediction takes 5–90 seconds and costs real tokens; only one runs per session at a time. A suggestion is always a proposal. Send and Insert require your explicit click, including when an agent called the API.

## Context and capture

Claude retains the original context path: its intent profile, Claude transcript tail, and transcript tool signals. Claude capture reads submitted user turns from the transcript, not keystrokes or terminal output. It skips tool results, local slash-command echoes, wrappers, interrupt markers, entries shorter than three characters, and consecutive duplicates; stored prompts are single-line, capped at 500 characters, with the newest 50 retained. Capture needs Claude hooks to reach the server, so a loopback Docker case needs `CODEMAN_DOCKER_BRIDGE_HOOKS=1` and remote-SSH Claude cases do not capture.

For local Codex, Read My Mind resolves only the active rollout demonstrably owned by the requesting session, then reads recent textual prompts, the last assistant response, and recent tool summaries on demand. It uses neither the newest same-directory rollout nor a foreign pane's rollout; ambiguity, missing identity, and unreadable rollout data fail closed rather than borrowing context. Rollout prompts are prediction inputs only and are **not** written into `intents.json`. Durable Codex prompt capture and proactive prediction remain deferred.

In both lanes, goals and user prompts outrank assistant text, tool logs, and workspace output, which are observations that could contain hostile instructions. The explicit human send/insert boundary is the final safeguard.

## Provider identity, model, and recovery

Codex prediction uses the session's effective Codex identity, so rollout discovery and the child stay in the same account/configuration lane. Private versioned recovery provenance retains only the restorable home and session-key state, never credentials. A restored legacy, unknown, or lost-key Codex session fails Read My Mind closed instead of silently switching accounts. Process-level provider credentials remain server-side and are not exposed through API responses or session state.

`readMyMindModel` is **Claude-only**. Codex uses the validated launch-time session model when one was configured; otherwise its child omits `--model` and uses the Codex CLI built-in default because user configuration is ignored. There is no Codex Read My Mind model setting. A later interactive Codex `/model` change is not currently observable by Codeman and is not mirrored into prediction.

## Codex isolation and failure behavior

The local Codex child uses an ephemeral private working directory, not the case workspace. It ignores user configuration, rules, and global/project instructions; disables shell, web-search, and subagents; rejects approvals; uses a read-only command sandbox; and validates a schema-constrained final response again on the server. Its environment, output, and timeout are bounded, and private files are removed after success, error, or timeout. This does **not** claim that the CLI process itself is network-disabled.

These required controls were tested with `codex-cli 0.147.0`. An older or incompatible CLI that rejects a required isolation option returns an update-required `502`; Codeman never retries with weaker controls. Other unavailable-CLI, authentication/configuration, timeout, empty-output, and invalid-contract failures return a safe `502` without prompt contents, provider values, host paths, or raw CLI diagnostics.

## Where profiles live and how to wipe them

Profiles live in `~/.codeman/intents.json`, atomically written at mode 0600 because captured prompts can contain secrets. The file is per Codeman instance. Keys derive from owner plus the case's resolved working directory, so profiles survive `/clear`, respawn cycles, and session churn; different owners have separate profiles.

Forget one case with `DELETE /api/sessions/:id/intent`. To forget everything, stop the server and delete `~/.codeman/intents.json`.

## The API

The four endpoints are session-scoped so ownership is enforced by the session (`/api/v1/` aliases work too; full contract in [`api-reference.md`](api-reference.md)):

```bash
# Read the profile for a session's case
curl -sk https://localhost:3000/api/sessions/$SID/intent | jq '.data.intent'

# Record goals (REPLACES the text: read + merge to append)
curl -sk -X PUT https://localhost:3000/api/sessions/$SID/intent \
  -H 'Content-Type: application/json' \
  -d '{"goals":"ship 1.17; then mobile polish"}'

# Forget the case
curl -sk -X DELETE https://localhost:3000/api/sessions/$SID/intent

# Predict for a Claude or local Codex session (5–90 s)
curl -sk -X POST https://localhost:3000/api/sessions/$SID/readmymind \
  -H 'Content-Type: application/json' -d '{}' | jq '.data.suggestions'
```

The prediction body can carry only rethink state: `{"steer":"…","rejected":["…"]}`. It cannot choose a provider, model, environment, or rollout. The response remains `{ suggestions: [{ prompt, why, kind }], durationMs }`, where `kind` is `continue`, `verify`, or `redirect`. Unsupported modes return `400 INVALID_INPUT`, a concurrent request returns `409 CONFLICT`, and provider or output failures return `502 OPERATION_FAILED`.

## For agents

The `codeman` agent skill documents the same verbs. Agents should read the profile to understand user intent, record only goals the user actually stated, merge before PUT because it replaces, never delete a profile unprompted, and never send a suggestion unless the user explicitly asks. It is the user's memory, not the agent's.

## Troubleshooting

| Symptom                                          | Cause / fix                                                                                                                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No 🧠 control, or an unsupported-session warning | Enable `readMyMindEnabled`; only Claude and local Codex are supported. Remote/Docker Codex and the other modes cannot predict.                                                                           |
| Prediction feels generic                         | Record goals and let Claude capture build history; a new Codex session may not yet have an owned rollout. Read My Mind will not borrow a similar-looking rollout.                                        |
| `409 CONFLICT`                                   | One prediction per session is running; wait up to 90 seconds.                                                                                                                                            |
| Codex asks to update                             | Its CLI rejected a required isolation control. Update Codex; Codeman will not weaken the invocation.                                                                                                     |
| Codex `502`                                      | Codex may be unavailable, unauthenticated, misconfigured, timed out, or have returned an invalid response. Restart or recreate restored legacy/lost-key sessions rather than expecting account fallback. |
| Claude profile stays empty                       | Capture was off, the session is not Claude, or Claude hooks cannot reach the server. Capture is not retroactive.                                                                                         |
| Goals disappeared after an agent write           | PUT replaces the whole text. Re-state them and ask the agent to read and merge first.                                                                                                                    |

## Where the code lives

`src/intent-store.ts` stores profiles; `src/transcript-watcher.ts` captures Claude prompts; `src/readmymind-context.ts` assembles context; `src/readmymind-collectors.ts` reads Claude signals; `src/codex-rollout-reader.ts` reads owned Codex rollout signals; `src/checkpoint-conversation-identity.ts` resolves rollout ownership; `src/readmymind-predictor.ts` dispatches the provider child; `src/web/routes/readmymind-routes.ts` owns the API policy; and `src/web/public/readmymind-ui.js` owns the UI.
