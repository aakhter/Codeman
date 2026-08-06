# Design — COD-276: Agent CLIs inherit the logged-in user's shell env

**Status:** Approved
**Date:** 2026-08-06
**Jira:** [COD-276](https://aakhter.atlassian.net/browse/COD-276)

## Problem

When Codeman launches an agent CLI (`opencode`, `claude`, `codex`, `gemini`, `agy`) on
either a **local** host or a **remote** (SSH) host, the agent does **not** see the logged-in
user's shell PATH additions or environment variables (API keys, `EDITOR`, tool paths, etc.).
Only the `shell` mode currently carries the user's environment.

### Root cause

- **Local:** Codeman creates a tmux server whose environment is inherited from the Codeman
  process (`env: cleanEnv = { ...process.env }` in `createSession`). When Codeman runs as a
  service (systemd, see `scripts/codeman-web.service`), that environment is minimal — the
  server never sources `~/.bash_profile` / `~/.profile` / `~/.bashrc` / `~/.zshrc`. The agent
  pane command only prepends the CLI binary dir to PATH (`buildPathExport`); the user's real
  PATH and profile env vars never reach the agent.
- **Remote:** the agent runs as `exec opencode` (etc.) inside a remote tmux launched via
  `ssh host 'tmux -L codeman new-session …'`. ssh executes the remote command through the
  user's shell as a **non-login, non-interactive** shell, so the user's profile files are not
  sourced. `withRemotePathBootstrap` only injects a hardcoded PATH; user env vars are lost.
- **Asymmetry confirming the bug:** `defaultRemoteCommandForMode('shell')` is `exec bash -l`
  (a login shell that DOES read the user's profile), while the four agent modes are bare
  `exec opencode|claude|codex|gemini`. This is why shell sessions see user env and agents don't.

### Scope

- **In scope:** local and remote launches of the agent CLIs `opencode`, `claude`, `codex`,
  `gemini`, `agy`.
- **Out of scope (unchanged behavior):** `shell` mode (already correct), the Docker case
  launch path (`buildDockerLaunchCommand`), and the existing `tmux setenv` secret-injection
  path.

## Approach

Source the logged-in user's shell profile before the agent starts, on both local and remote
hosts, detecting the user's login shell rather than hardcoding bash.

### 1. Detect the login shell at runtime

Detection runs *inside the pane command* (not at build time), so it works for remote hosts
where the Codeman server cannot know the remote user's shell:

- Prefer `$SHELL` when it is a real path for a known shell.
- Fall back to `getent passwd "$(id -un)" | cut -d: -f7`.
- Default to bash when neither is usable.

This yields a login-shell path such as `/bin/bash` or `/bin/zsh`.

### 2. Source the right rc files for the detected shell, then `exec` the agent

Build a tiny, self-contained fragment that runs inside the pane shell (after `cd <workingDir>`),
detects the shell, sources the appropriate profile files, and `exec`s the agent so the final
pane PID remains the agent itself (preserving PID/scrollback/resume semantics):

- **bash** (or unknown): `source ~/.bash_profile`, `~/.profile`, `~/.bashrc` via a login-style
  launch — the same files `exec bash -l` already sources for shell mode.
- **zsh**: `source ~/.zprofile`, then **`~/.zshrc`**. `zsh -c` does **not** auto-source
  `~/.zshrc` (non-interactive), so `.zshrc` is sourced explicitly — this is the specific
  zsh/zshrc case the requirements call out.

The final fragment shape (for an agent target command `T`):

```
<detect shell> && exec <loginShell> -c '<profileSourcing>; export PATH="<CLI_DIR>:$PATH"; <codeman exports>; exec <T>'
```

### 3. Ordering guarantee (Codeman wins)

- Profile source runs **first**, so the user's env is established.
- Codeman's `pathExport` (CLI dir prepended to `$PATH`) runs **after** the profile, so the CLI
  binary is still resolved even if the profile sets `PATH`.
- Codeman's secret keys are injected at the tmux **session** level via `setenv` and inherited by
  the pane — profiles cannot clobber them.
- Codeman's inline exports (`CODEMAN_MUX`, `CODEMAN_SESSION_ID`, locale, `COLORTERM`, …) run
  after the profile within the same `exec`'d shell, so Codeman-controlled values still win over
  profile-set values.

### 4. New pure helper module

Create `src/utils/user-shell-env.ts` with unit-testable, pure builders:

- `buildUserShellEnvLaunch(options)` — returns the full fragment described above.
- Internal helpers for shell detection and per-shell rc sourcing (zsh vs bash).

## Integration points

All in `src/tmux-manager.ts` plus one shared helper in `src/remote-hosts.ts`:

- `createSession()` — local `localFullCmd` assembly.
- `respawnPane()` — local `localFullCmd` assembly.
- `buildRemoteLaunchCommand()` / `withRemotePathBootstrap()` — remote pane command.
- `buildPathExport()` — unchanged; consumed by the wrapper.
- `shell` mode and Docker launch paths are **not** touched.

## Testing

Focused, tmux-safe, pure command-string builder tests (no real tmux, no server):

- `test/user-shell-env.test.ts`:
  - zsh detection → sources `~/.zprofile` and `~/.zshrc`.
  - bash (or unknown) → sources `~/.bash_profile`, `~/.profile`, `~/.bashrc`.
  - `exec` preserves the agent (final pane PID = agent).
  - Codeman exports/prepended CLI PATH run after the profile.
- `test/remote-tmux-launch.test.ts`:
  - `opencode` (and other agent modes) remote command now includes profile sourcing.
  - `shell` mode unchanged (`exec bash -l`).
  - No `bash -lc` regression for non-agent paths.
- `test/tmux-manager.test.ts`:
  - Local `createSession` / `respawnPane` include the sourcing fragment for agent modes.
  - `shell` mode untouched.

## Out of scope / follow-ups

- Docker case launches (`buildDockerLaunchCommand`) — separate concern, possible follow-up.
- Fish/other exotic shells — fall back to the bash fragment; not a blocker.
