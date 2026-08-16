# COD-314 Read My Mind for Codex Design

## Status

Approved direction: provider lanes are strict. Claude sessions use Claude for prediction; Codex sessions use Codex. The
requested Claude CLI design review could not run because the enterprise account had reached its session limit, so the user
authorized Codex to proceed with an internal architecture and security review before this specification was written.

## Problem

Read My Mind is presented as a global opt-in feature, but its implementation deliberately shipped as Claude-only. The
browser refuses to open it for any non-Claude session, the prediction route rejects modes for which Claude hooks are not
available, and the context collector understands only Claude transcript JSONL. The predictor then launches a temporary
`claude -p` process regardless of which session requested the prediction.

This behavior is now unnecessarily restrictive for local Codex sessions. Codeman already resolves the rollout owned by a
specific Codex pane and parses that rollout for the response viewer. A Codex session therefore has enough trustworthy local
context to support Read My Mind, but the feature has not been connected to it.

Simply removing the mode checks would be incorrect. It would still run Claude behind a Codex session, omit the Codex
conversation from the prediction, use a Claude model setting for a different provider, and potentially resolve the wrong
Codex account when a session uses a custom `CODEX_HOME`.

## Goals

- Let the Read My Mind control open and return suggestions for supported local Codex sessions.
- Keep inference in the active session's provider lane: Claude uses `claude -p`; Codex uses `codex exec`.
- Use the correctly owned Codex rollout for recent user prompts, the last assistant response, and recent tool activity.
- Preserve the existing strict suggestion schema, context trust ranking, one-request-per-session guard, and explicit human
  Send/Insert boundary.
- Preserve existing Claude behavior and its `readMyMindModel` setting.
- Fail closed with a clear, path-safe error when the required provider CLI, credentials, or supported execution environment
  is unavailable.
- Reuse one Codex rollout parser rather than allowing Read My Mind and the response viewer to drift.

## Non-goals

- No cross-provider fallback. Codex failure never starts Claude, and Claude failure never starts Codex.
- No user-selectable predictor provider and no new Read My Mind model setting for Codex.
- No Codex prediction for remote SSH or Docker sessions in this change. Their rollout and provider identity live outside the
  local server boundary and need a separate transport design.
- No durable, background capture of Codex prompts into `intents.json`. The active Codex rollout supplies recent prompts on
  demand; user-authored goals and any previously captured case history remain available from the intent profile.
- No Codex proactive prediction, idle prediction, or auto-send path.
- No support for OpenCode, Gemini, Antigravity, Pi, or shell sessions.

## Review findings incorporated

The pre-document review found six constraints that shape the implementation:

1. **Provider choice and model choice are separate.** `readMyMindModel` contains a Claude model and must never be passed to
   `codex exec`. A Codex prediction uses the session's validated launch-time `codexConfig.model` when one exists; otherwise
   it omits `--model` and uses the Codex CLI built-in default. Codeman cannot currently observe a model changed interactively
   with `/model`, so this design does not claim to mirror that runtime change.
2. **Provider identity includes the effective environment.** A Codex pane may have session-scoped `CODEX_HOME` or
   `CODEX_API_KEY` values, while `OPENAI_API_KEY` may come from the Codeman process environment. Rollout discovery and the
   one-shot child must use the same restricted provider identity without exposing it through API state or logs.
3. **A non-interactive Codex agent can still invoke tools and load instructions.** The predictor must run in a fresh private
   temporary directory, explicitly suppress global and project instructions, disable shell, web-search, and subagent tools,
   reject approvals, use a read-only command sandbox, and receive an explicit prediction-only prompt. It must never run in
   the case workspace.
4. **`codex exec` should not create another conversation artifact.** Use `--ephemeral`; consume only the final response file,
   not progress JSONL or terminal rendering.
5. **Rollout ownership is security-sensitive.** Read My Mind must call the existing `findActiveCodexConversation()` resolver
   with the same history-pin, originator, resume-ID, and legacy-cwd precedence as the response viewer. It must not select the
   newest rollout by path or modification time alone.
6. **Parser duplication will drift.** The response viewer's Codex message parsing moves to a shared pure module and retains
   its existing mixed-version deduplication and injected-context filtering. Read My Mind consumes that module's bounded
   signal view.

## Design

### 1. Explicit supported-mode policy

Replace the Read My Mind route's `hooksAvailableForMode()` gate with a feature-specific policy. Claude remains supported as
it is today. Codex is supported only when the session is local: neither `session.remote` nor `session.docker` is present.
Every other mode returns `400 INVALID_INPUT` with copy that names the supported modes without implying that Claude hooks are
the reason.

The browser uses the same policy for its early guard: `openReadMyMind()` accepts `claude` and `codex`, while unsupported modes
show a concise warning. The global `readMyMindEnabled` opt-in continues to control desktop and phone visibility. The setting
does not imply that every session mode is supported.

### 2. Shared Codex rollout reader

Introduce a focused Codex rollout reader outside `session-routes.ts`. It owns pure parsing and bounded file reads; rollout
identity selection remains in `checkpoint-conversation-identity.ts`.

The parser preserves the response viewer's established rules:

- `event_msg/user_message` is the authoritative modern user-turn source.
- Legacy `response_item/message` user rows remain as fallback for old or mixed-version rollouts.
- A multiset removes exactly one legacy duplicate for each matching event-sourced user turn.
- Injected `AGENTS.md`, environment, abort, internal-context, plugin, and option messages are excluded.
- Assistant text comes from `response_item/message` output text blocks.
- Malformed or partially flushed JSONL rows are skipped.

The shared parse result exposes the full user/assistant thread required by the response viewer. A second projection produces
Read My Mind signals: the last assistant text, textual user prompts with timestamps, and up to ten recent tool summaries.
Tool summaries recognize the Codex rollout's function/custom tool-call records and reuse the existing collector's bounded,
allowlisted detail keys (`file_path`, `command`, `pattern`, `path`, `url`, `query`, or `description`). They do not include tool
output or treat it as user intent. Image-only inputs may remain visible in the response viewer but are not added to the
prompt-style history used by Read My Mind.

The response viewer continues to read the complete rollout because it renders expandable history. Read My Mind tail-reads a
bounded region, currently 256 KiB, and drops the first partial line when the read begins mid-file. The active rollout path is
resolved before this read; the collector never scans arbitrary rollout files itself.

### 3. Codex context assembly

For a Claude session, the route keeps the current intent-profile and Claude-transcript path unchanged.

For a Codex session, the route:

1. Derives the provider environment through a new narrow `Session` accessor that returns only the Codex child keys needed by
   server-side provider operations. The values never enter `SessionState`, SSE, response bodies, or logs.
2. Resolves the active rollout with `findActiveCodexConversation()`, using the session's effective `CODEX_HOME`, session ID,
   working directory, configured resume ID, last submit time, and competing Codex submit times.
3. Reads the bounded Read My Mind signal projection from that rollout.
4. Merges the rollout's recent textual user prompts with the case intent profile's existing prompt entries, orders them by
   timestamp, and retains the newest context-budget allowance. Repeated user prompts from different sources or turns remain
   intact; only the shared rollout parser removes a legacy row proven to be the twin of a modern event row.
5. Supplies the Codex last assistant response and tools to the existing pure `buildPredictionContext()` function.

The rollout prompts are prediction inputs, not persisted mutations. This avoids surprising resurrection after the user uses
the existing Forget action and avoids inventing a cursor/tombstone migration in a provider-enable bug fix. Durable Codex
capture remains an explicit later feature.

If no owned rollout exists yet, prediction may still use goals, workspace signals, siblings, and away context; it does not
fall back to another pane's rollout. The absence of a rollout is not itself a server error. If the remaining context cannot
produce at least one valid suggestion, the existing prediction-contract error is returned without a provider fallback.

### 4. Provider-aware predictor dispatch

Keep the exported `readMyMindPredictor` singleton used by route tests, but change its input contract to include an explicit
provider discriminant:

```ts
interface CodexProviderEnvironment {
  CODEX_HOME?: string;
  OPENAI_API_KEY?: string;
  CODEX_API_KEY?: string;
}

type ReadMyMindProvider =
  | { kind: 'claude'; model: string }
  | { kind: 'codex'; model?: string; env: Readonly<CodexProviderEnvironment> };
```

The route constructs this value from the already-authorized session. Request bodies cannot choose the provider, model, or
environment.

The Claude branch remains behaviorally unchanged: it uses the existing validated model, temporary prompt/output files,
detached tmux process, timeout, and cleanup path.

The Codex branch uses `spawn()` with an argument array, never a shell command. Its conceptual invocation is:

```text
codex
  --ask-for-approval never
  exec
  --ephemeral
  --ignore-user-config
  --ignore-rules
  --strict-config
  --disable shell_tool
  --config project_doc_max_bytes=0
  --config agents.enabled=false
  --config tools.web_search=false
  --config shell_environment_policy.inherit=none
  --sandbox read-only
  --skip-git-repo-check
  --color never
  --output-schema <private-schema-file>
  --output-last-message <private-output-file>
  --cd <private-temp-dir>
  [--model <validated-session-model>]
  -
```

The assembled context is written to stdin. A dedicated mode-0700 directory contains the JSON schema and final-output file;
files are mode 0600. The directory is outside the case workspace. `--ignore-user-config` prevents configuration-defined MCP
servers, hooks, and extensions from being loaded while Codex authentication still uses `CODEX_HOME`. It does not suppress
`AGENTS.md`; `project_doc_max_bytes=0` explicitly suppresses global and project instruction loading. `--ignore-rules` only
suppresses execution-policy `.rules` files. The remaining overrides disable shell execution, web search, and subagents,
reject approval requests, and prevent the model's subprocess environment policy from inheriting host variables. The
read-only command sandbox is an additional boundary, not a claim that the CLI process itself has no network access.

The final response is validated by the existing Zod parser even though Codex receives an output schema. Defense in depth is
intentional: CLI output constraints do not replace server validation, one-line normalization, length limits, or the 1-3
suggestion cap.

The child has the existing 90-second ceiling and is spawned as its own process group. Timeout terminates that group, escalates
to a hard kill after a short grace period, and removes the private directory. Stdout and stderr are capped at 256 KiB each
while streaming, and the final-output file is monitored with a 64 KiB ceiling; crossing a cap terminates the process and
returns a prediction-contract error. Public errors identify the stage (unavailable CLI, update required,
authentication/configuration failure, timeout, empty output, invalid contract) but include neither prompt contents, provider
environment values, host paths, nor raw CLI diagnostics. Detailed sanitized diagnostics may be logged server-side.

### 5. Configuration behavior

`readMyMindModel` remains a Claude-only setting and retains its current default. Documentation and settings copy must say so.

Codex uses the session's launch-time `session.codexConfig.model` when present and valid under the existing model-name
validation. When absent, the child omits `--model`; because user configuration is ignored, the CLI uses its built-in default.
There is no `readMyMindCodexModel` in this change. A model selected later with `/model` is not exposed in current Codeman
session state and therefore cannot be mirrored reliably; documenting that limitation is preferable to implying runtime
parity that the implementation cannot provide.

The predictor builds a minimal child environment rather than forwarding the server's entire environment. It includes the
augmented executable path, the small set of operating-system values required for the CLI to start, and the effective Codex
provider identity. A narrow Session method returns `CODEX_HOME`, `OPENAI_API_KEY`, and `CODEX_API_KEY` if configured; global
values for those keys remain the fallback. It does not return arbitrary environment overrides. The operating-system values
are enumerated, not inherited wholesale, and `shell_environment_policy.inherit=none` prevents any model-launched subprocess
from inheriting even that launcher environment. Tests prove the method is not serialized by `toState()` or persisted through
the existing safe persistence accessor.

### 6. Codex CLI compatibility

The isolation controls in this design are required, not best-effort. They have been verified against the installed
`codex-cli 0.147.0`, which is the documented tested minimum for this feature. Codeman does not add a global startup gate or
reject older CLIs before Read My Mind is used.

`--strict-config` makes an unrecognized configuration key fail instead of being silently ignored. If `codex exec` rejects a
required option or configuration override, the Codex prediction fails safely with an actionable 502 message that says the
installed Codex CLI must be updated. It must never retry after removing or weakening an isolation control. Unit tests pin
the complete argument vector and map an unsupported-option diagnostic to this safe public error.

The invocation and isolation assumptions were checked against OpenAI's official
[developer command](https://learn.chatgpt.com/docs/developer-commands?surface=cli),
[non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), and
[`AGENTS.md` loading](https://learn.chatgpt.com/docs/agent-configuration/agents-md) documentation, plus the installed CLI's
`codex --help`, `codex exec --help`, and feature list.

### 7. Error and concurrency behavior

The existing `predictionsInFlight` set remains keyed by Codeman session ID, so a second request for the same pane receives
409 while either provider is running. Different sessions may predict concurrently.

The existing Claude error path remains unchanged. New Codex failure mapping retains the API envelope and 502 status used by
the current predictor. Provider-specific copy is actionable but safe:

| Condition                                    | Public behavior                    |
| -------------------------------------------- | ---------------------------------- |
| Unsupported mode or non-local Codex session  | 400 `INVALID_INPUT`                |
| Prediction already running for this session  | 409 `CONFLICT`                     |
| Codex binary cannot start                    | 502 provider-unavailable message   |
| Codex rejects a required isolation control   | 502 update-required message        |
| Codex authentication/configuration failure   | 502 provider-configuration message |
| Provider exceeds 90 seconds                  | 502 timeout message                |
| Final output is empty or violates the schema | 502 prediction-contract message    |

The UI continues to render prediction text only through `value`/`textContent`. Send and Insert remain the only routes from a
suggestion to the active terminal, and both require an explicit human click.

## Security invariants

- The requesting session determines the provider; client input cannot select or override it.
- Codex prediction never runs in or adds a writable directory from the user workspace.
- The Codex subprocess is ephemeral; its command sandbox is read-only, approvals are rejected, global/project instructions
  are suppressed, and shell, web-search, and subagent tools are disabled.
- The Codex subprocess receives a minimal environment, not the full Codeman server environment.
- The Codex model's subprocess environment policy inherits no launcher variables.
- Provider secrets remain server-side environment values and are absent from logs, API state, persisted state, command-line
  arguments, and temporary files.
- Rollout selection fails closed on ambiguity and never uses a newest-file shortcut.
- Observed assistant, tool, workspace, and rollout content retains the existing lower trust tier in the prediction prompt.
- Suggestions remain untrusted text until the user explicitly sends or inserts one.
- Temporary output is bounded, private, and removed on success, error, and timeout.

## Test plan

### Shared rollout reader

- Preserve all existing Codex response-viewer fixtures after extraction.
- Parse modern event-sourced user turns and legacy-only turns.
- Deduplicate mixed-version event/legacy twins one-for-one.
- Exclude every known injected-context prefix.
- Extract the last assistant response and bounded recent tool summaries.
- Ignore image-only user inputs for Read My Mind prompt history.
- Skip malformed and partial tail rows.

### Predictor

- Dispatch Claude and Codex from the explicit provider discriminant.
- Prove a Codex request never invokes the Claude runner and vice versa.
- Pin the complete Codex argument vector: ephemeral, isolated temp cwd, read-only command sandbox, ignored config/rules,
  suppressed instructions, disabled shell/web/subagents, rejected approvals, schema file, output file, stdin prompt, and
  optional validated launch-time model.
- Prove the prompt and provider secrets do not appear in command arguments.
- Propagate only the enumerated operating-system values and three allowed Codex identity keys; prove no arbitrary server or
  session environment variable is forwarded.
- Prove session-scoped `CODEX_HOME`/`CODEX_API_KEY` precedence and process-level identity fallback without exposing arbitrary
  `CODEX_*` overrides.
- Map rejection of any required isolation option to the safe update-required failure without a weaker retry.
- Accept valid schema-constrained output and apply the shared Zod normalization.
- Reject malformed, empty, oversized, and wrong-contract output.
- Terminate safely when stdout, stderr, or the final-output file crosses its byte cap.
- Terminate and clean up on timeout and spawn failure.

### Routes and context

- Claude route behavior and model lookup remain unchanged.
- Local Codex mode is accepted and calls the predictor with `kind: 'codex'`.
- Codex uses its launch-time session model or omits the model; it never calls `getReadMyMindModel()`.
- The owned-rollout resolver receives the effective session `CODEX_HOME` and identity inputs.
- Codex rollout prompts, assistant text, and tools appear in the assembled context.
- Intent-profile prompts and rollout prompts merge in timestamp order while preserving intentional repeated prompts across
  different sources or turns.
- A missing owned rollout does not select a sibling rollout.
- Remote/Docker Codex and all unsupported modes receive 400.
- Same-session concurrent requests retain the 409 guard.
- Predictor failures release the in-flight guard for retry.
- Multi-user ownership remains enforced before rollout or provider environment access.

### Browser and documentation

- `openReadMyMind()` accepts Claude and Codex and still rejects unsupported modes.
- Desktop and phone controls remain gated by `readMyMindEnabled`.
- Suggestion rendering retains the no-`innerHTML` guard and explicit-click send boundary.
- User and API docs describe provider lanes, local-Codex scope, Claude-only `readMyMindModel`, and provider-specific failure
  troubleshooting.

## Documentation changes

- Update `docs/readmymind.md` to describe Claude and local Codex operation and the provider-specific one-shot calls.
- Update `docs/readmymind-plan.md` by marking local Codex prediction as shipped separately from durable Codex capture.
- Update `docs/api-reference.md` so the prediction endpoint no longer says Claude-only.
- Update architecture invariants with the provider-lane, rollout-ownership, and isolated `codex exec` rules.

## Delivery boundaries

The implementation should land as focused commits under COD-314:

1. Extract and regression-test the shared Codex rollout reader.
2. Add the isolated Codex predictor runner and provider dispatch.
3. Wire route context, restricted provider environment, and UI mode support.
4. Update user/API/architecture documentation.

No unrelated external-CLI generalization or Read My Mind redesign belongs in these commits.
