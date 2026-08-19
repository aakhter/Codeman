# COD-334 — Login-Shell Agent CLI Resolution Design

## Summary

Codeman must discover local agent CLIs in the same user environment that launches them. Today, the server rejects a
session before launch when its own `PATH` cannot find the executable, even though the subsequent pane command would run
through the user's interactive login shell and find it. The observed Codex installation is under NVM and is exposed by
`~/.bashrc`, while the Codeman server process has no NVM directory on `PATH`.

This change makes executable discovery consistent for all six local agent modes: Claude, OpenCode, Codex, Gemini,
Antigravity, and Pi.

## Root Cause

Each agent has a separate resolver that checks the server process's `PATH` and a static list of common directories. These
resolvers run in route preflight and again in `TmuxManager.createSession()` before the pane is built. NVM-, asdf-, mise-,
or shell-profile-installed binaries can therefore be rejected before `buildLocalPaneCommand()` runs the user's interactive
login shell.

The resolver failure is cached for the process lifetime, so installing a missing CLI does not repair the status until the
Codeman server restarts. In addition, `buildLocalPaneCommand()` currently applies the login-shell wrapper to OpenCode,
Codex, Gemini, and Antigravity, but omits Claude and Pi.

## Goals

- Discover every local agent CLI through the same interactive login-shell environment used at launch.
- Preserve each CLI's existing public resolver functions and status response fields.
- Preserve Pi's semantic identity check; a generic executable named `pi` must not be accepted.
- Make missing-CLI errors actionable by reporting the server `PATH`, resolved login shell, and checked directories.
- Allow a newly installed CLI to be detected without restarting Codeman.
- Keep remote and Docker launch behavior unchanged; their executable checks happen in their own environments.

## Non-Goals

- Changing remote-host or Docker CLI discovery.
- Installing or upgrading agent CLIs.
- Executing arbitrary shell commands supplied by an API caller.
- Replacing the existing per-agent command builders or configuration logic.

## Design

### Shared executable-discovery core

Add `src/utils/cli-executable-resolver.ts` with a synchronous, injectable core. The resolver accepts a fixed binary name,
the agent's existing common search directories, and an optional candidate validator. It checks candidates in this order:

1. The server process's `PATH`.
2. The agent's existing common install directories.
3. The user's resolved local shell, invoked with the same allowlisted interactive-login flags used by local panes, running
   `command -v <binary>`.

Only internally declared binary names are accepted, constrained to a conservative executable-name pattern before they are
placed in the shell probe. Returned paths must be absolute and must still exist. The core returns a structured result with
the accepted binary path, directory, source (`process-path`, `common-directory`, or `login-shell`), and diagnostics.

The injectable core takes lookup and validation functions so unit tests do not depend on the developer machine. The
production adapter scans the captured server `PATH` directly instead of invoking `which`, and accepts only executable
regular files. Its login-shell probe uses `execFileSync`, not an interpolated outer shell, bounds execution with
`EXEC_TIMEOUT_MS`, and parses only an absolute, basename-matching path enclosed by fixed begin/end tags so profile noise
cannot masquerade as a result.

### Resolver compatibility wrappers

Keep the current exports (`findClaudeDir`, `resolveOpenCodeDir`, `resolveCodexDir`, `resolveGeminiDir`,
`resolveAntigravityDir`, and `resolvePiDir`) as thin wrappers over the shared core. Existing imports therefore do not need
to change.

Each wrapper retains its current common-directory list. Pi supplies its existing `--version` validator for every candidate
and keeps exposing the validated version through `getPiCliVersion()`. Production validation is strict even under Vitest;
hermetic tests inject their own host and version probe rather than using an environment-based identity bypass.

Successful resolutions remain cached. Failures are not cached, allowing status checks and later session starts to discover
a CLI installed after the server started.

### Launch consistency

Extend `isAgentCliMode()` in `src/tmux-manager.ts` to include Claude and Pi. All six local agent modes then launch through
the same interactive login-shell wrapper. The resolved CLI directory is shell-escaped and prepended after the profile
loads, while the inherited `"$PATH"` remains literal through the final shell-escaped outer `bash -c` command. This ensures
that the exact preflight-validated executable wins even when the path contains shell-significant characters or the profile
reorders `PATH`. Claude's resume/new-session fallback remains a compound shell command: nice priority applies to both legs
and only the successful final leg is `exec`'d.

Shell mode remains unchanged. Remote and Docker command selection is lazy, so their builders resolve in their own
environment without evaluating the local builder or invoking any local CLI probe.

### Diagnostic failures

The shared resolver exposes a formatter for missing executable diagnostics. Route preflight and `TmuxManager` errors retain
the existing install hint and append:

- the effective server `PATH`;
- the resolved local shell and login flags; and
- the explicit common directories checked.

Each rendered diagnostic field is flattened and length-bounded. Diagnostics contain environment paths but no
environment-variable values other than `PATH`; they do not include API keys, complete environment dumps, shell-profile
contents, or command output unrelated to the executable path.

### Status endpoints and browser errors

Existing `/api/<agent>/status` fields remain unchanged. When an agent is unavailable, the response additionally carries an
optional `error` string produced by the shared diagnostic formatter. Because the resolver wrappers use the shared core,
status reports the same availability and path that session preflight uses.

The five browser launch functions that perform local status preflight use `status.error` when present and retain their current
install message as a compatibility fallback. Claude launches already surface the session-create response error directly.
This is required for the reported failure: the screenshot is generated by the browser's status preflight, before the
quick-start route can return its own detailed error.

## Error Handling

- A timed-out or failing server-PATH lookup proceeds to common-directory and login-shell checks.
- A failing login-shell probe produces an unavailable result with diagnostic metadata; it does not block the server.
- Login-shell output is accepted only when it contains a valid absolute executable path that exists.
- A candidate rejected by Pi validation does not stop later candidates from being checked.
- Failed discoveries are retried on the next call rather than poisoning a process-lifetime cache.

## Testing

Focused Vitest coverage proves:

- a CLI available only through a synthetic interactive login shell is resolved;
- server `PATH` and common-directory candidates keep their precedence;
- malformed, relative, nonexistent, and timed-out shell results are rejected;
- failures are not cached while successes are;
- Pi still rejects a non-agent `pi` candidate and accepts a semver-reporting candidate;
- every local agent mode uses the login-shell pane wrapper;
- missing-CLI errors include the server `PATH`, login shell, checked directories, and the existing install hint;
- unavailable status responses expose that bounded error and each browser launcher displays it; and
- existing route/status and tmux-manager behavior remains green.

Functional verification ran a child Node/tsx process with a deliberately minimal server `PATH` that omitted the user's real
NVM bin while retaining the real `HOME` and `SHELL`. It imported the worktree Codex resolver, confirmed the real Codex
directory was recovered through the login shell, and inspected the controlled local-pane/final-shell layering to confirm
the resolved path survived unchanged. No isolated Codeman instance was needed, and no production tmux, socket, data, port,
or deployment was touched.

## Files Changed

- Added `src/utils/cli-executable-resolver.ts` for shared resolution and diagnostics.
- Added `test/cli-executable-resolver.test.ts` for resolver behavior.
- Modified the six files under `src/utils/*-cli-resolver.ts` to delegate to the shared core.
- Modified `src/tmux-manager.ts` for all-mode login-shell launch and shared diagnostic errors.
- Modified `src/web/routes/session-routes.ts` to use shared diagnostic errors.
- Modified `src/web/routes/system-routes.ts` and `src/web/public/session-ui.js` to carry those errors through status preflight.
- Extended focused resolver, route, browser-launcher, and tmux-manager tests.
- Updated `docs/architecture-invariants.md` with the discovery/launch invariant.

## Rollout and Compatibility

No persisted data, configuration, or migration changes are required. The status API change is backward-compatible and
additive: an optional `error` appears only for unavailable CLIs. Existing PATH and common-directory matches keep precedence.
The intentional behavior changes are that profile-managed executables are recognized, negative results recover without
restart, and missing-CLI errors carry bounded diagnostics from the server through the browser.
