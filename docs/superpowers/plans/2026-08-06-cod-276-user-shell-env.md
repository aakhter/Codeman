# COD-276 — Agent CLIs inherit the logged-in user's shell env — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent CLI sessions (`opencode`, `claude`, `codex`, `gemini`, `agy`) inherit the logged-in user's PATH and env vars on both local and remote hosts by sourcing the user's shell profile before the agent starts.

**Architecture:** Add a pure, unit-testable command-string builder `buildUserShellEnvCommand` in a new `src/utils/user-shell-env.ts` that detects the user's login shell at runtime and re-`exec`s the agent through that login shell with rc files sourced (bash → `bash -lc`; zsh → `zsh -lc` + explicit `source ~/.zshrc`). Wire it into the local launch path (`createSession`/`respawnPane`) and the remote launch path (`buildRemoteLaunchCommand`). `shell` mode and Docker launches are untouched.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest, tmux. `docker-hosts`/`remote-hosts` not modified except where noted.

**Spec:** `docs/superpowers/specs/2026-08-06-cod-276-user-shell-env-design.md`

---

### Task 1: Create `src/utils/user-shell-env.ts` with the pure builder + tests

**Files:**
- Create: `src/utils/user-shell-env.ts`
- Test: `test/user-shell-env.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/user-shell-env.test.ts
import { describe, it, expect } from 'vitest';
import { buildUserShellEnvCommand } from '../src/utils/user-shell-env.js';

describe('buildUserShellEnvCommand', () => {
  it('re-execs the agent through `bash -lc` (login shell) for bash/unknown shells', () => {
    const out = buildUserShellEnvCommand({
      pathExport: 'export PATH="/home/u/.opencode/bin:$PATH"',
      envExports: ['export CODEMAN_MUX=1'],
      cmd: 'opencode --model sonnet',
    });
    expect(out).toContain('exec bash -lc');
    expect(out).toContain(
      'export PATH="/home/u/.opencode/bin:$PATH" && export CODEMAN_MUX=1 && exec opencode --model sonnet'
    );
  });

  it('sources ~/.zshrc explicitly for zsh login shells (non-interactive zsh does NOT auto-source it)', () => {
    const out = buildUserShellEnvCommand({ cmd: 'opencode' });
    expect(out).toContain('exec zsh -lc');
    expect(out).toContain('source ~/.zshrc 2>/dev/null;');
  });

  it('keeps the final pane PID as the agent via a trailing exec', () => {
    const out = buildUserShellEnvCommand({ pathExport: 'export PATH="/x:$PATH"', cmd: 'opencode' });
    expect(out).toContain('export PATH="/x:$PATH" && exec opencode');
  });

  it('detects the login shell at runtime from $SHELL then getent', () => {
    const out = buildUserShellEnvCommand({ cmd: 'claude' });
    expect(out).toContain('login_shell=${SHELL:-$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)}');
  });

  it('omits pathExport/envExports when not provided', () => {
    const out = buildUserShellEnvCommand({ cmd: 'codex' });
    expect(out).toContain('exec codex');
    expect(out).not.toContain('&& export');
  });

  it('does NOT emit a host login-shell wrapper when there is nothing to source (empty inputs still keep exec)', () => {
    const out = buildUserShellEnvCommand({ cmd: 'gemini' });
    expect(out).not.toContain('exec gemini &&');
    expect(out).toContain('exec gemini');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/user-shell-env.test.ts`
Expected: FAIL — module `../src/utils/user-shell-env.js` cannot be resolved.

- [ ] **Step 3: Create the implementation**

```ts
// src/utils/user-shell-env.ts
/**
 * @fileoverview COD-276 — route agent CLI launches through the logged-in user's
 * login shell so the agent inherits the user's shell env (PATH, API keys, etc.)
 * on both local and remote hosts. Pure, unit-testable command-string builders.
 *
 * @module utils/user-shell-env
 */

import { shellescape } from '../remote-hosts.js';

export interface UserShellEnvLaunchOptions {
  /**
   * `export PATH="<cli-dir>:$PATH"` with NO trailing `&&`, or '' when no CLI-dir
   * prefix applies (e.g. remote, where the PATH bootstrap already covers it).
   */
  pathExport?: string;
  /** Array of `export KEY=value` lines pushed by Codeman (locale, mux markers, ...). */
  envExports?: string[];
  /** The final agent command, e.g. `nice -n 10 opencode --model x`. */
  cmd: string;
}

/**
 * Build a pane-level fragment that detects the user's login shell at runtime and
 * re-`exec`s the agent through that shell with the user's rc files sourced.
 *
 * Ordering guarantee: Codeman's `pathExport` + `envExports` run AFTER the profile
 * (bash auto-sources via `-l`; zsh sources `~/.zshrc` explicitly first), so
 * Codeman-controlled values still win. Secret API keys ride tmux `setenv` and are
 * inherited by the pane, so profiles cannot clobber them.
 */
export function buildUserShellEnvCommand(opts: UserShellEnvLaunchOptions): string {
  const body = [opts.pathExport, ...(opts.envExports ?? []), `exec ${opts.cmd}`]
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .join(' && ');

  // bash: `bash -lc` is a login shell — it auto-sources ~/.bash_profile / ~/.profile
  // before running `body` (the same behavior `shell` mode gets via `exec bash -l`).
  // .bashrc is intentionally NOT force-loaded: it is interactive-guarded and
  // .bash_profile normally sources it.
  const bashBody = body;

  // zsh: `zsh -lc` auto-sources ~/.zprofile but NOT ~/.zshrc when non-interactive,
  // so source ~/.zshrc explicitly first (COD-276 zsh/zshrc requirement).
  const zshBody = `source ~/.zshrc 2>/dev/null; ${body}`;

  return [
    'login_shell=${SHELL:-$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)}',
    'case "${login_shell##*/}" in',
    `  zsh) exec zsh -lc ${shellescape(zshBody)} ;;`,
    `  *)   exec bash -lc ${shellescape(bashBody)} ;;`,
    'esac',
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/user-shell-env.test.ts`
Expected: PASS (all 6 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/utils/user-shell-env.ts test/user-shell-env.test.ts
git commit -m "feat(core): COD-276 add user-shell-env launch builder"
```

---

### Task 2: Wire the user-shell-env wrapper into the local launch path

**Files:**
- Modify: `src/tmux-manager.ts` (imports; add `isAgentCliMode` + pure `buildLocalPaneCommand`; use them in `createSession` and `respawnPane`)
- Test: `test/user-shell-env.test.ts` (already covers the builder) + add `test/tmux-manager.test.ts` cases via the new pure `buildLocalPaneCommand`

- [ ] **Step 1: Write failing tests for `buildLocalPaneCommand`**

Add to `test/user-shell-env.test.ts` (or a small new `buildLocalPaneCommand` describe in `test/tmux-manager.test.ts` — prefer the latter):

```ts
// test/tmux-manager.test.ts (append a new describe block)
import { buildLocalPaneCommand, buildNofileLimitCommand } from '../src/tmux-manager.js';

describe('COD-276 buildLocalPaneCommand', () => {
  it('wraps agent modes with the user-shell-env builder (zsh/zshrc handled upstream)', () => {
    const out = buildLocalPaneCommand({
      mode: 'opencode',
      pathExport: 'export PATH="/u/.opencode/bin:$PATH" && ',
      envExports: ['export CODEMAN_MUX=1'],
      cmd: 'opencode --model sonnet',
    });
    expect(out).toContain(buildNofileLimitCommand());
    expect(out).toContain('exec bash -lc');
    expect(out).toContain('exec opencode --model sonnet');
    // pathExport trailing ' && ' is normalized for the inner builder
    expect(out).not.toContain('" &&   &&');
  });

  it('leaves shell mode unchanged', () => {
    const out = buildLocalPaneCommand({
      mode: 'shell',
      pathExport: '',
      envExports: ['export CODEMAN_MUX=1'],
      cmd: '$SHELL',
    });
    expect(out).toBe(`${buildNofileLimitCommand()} && export CODEMAN_MUX=1 && $SHELL`);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/tmux-manager.test.ts`
Expected: FAIL — `buildLocalPaneCommand` is not exported from `src/tmux-manager.js`.

- [ ] **Step 3: Add import, helpers, and pure `buildLocalPaneCommand`**

Add import near the other utils import (top of file):

```ts
import { buildUserShellEnvCommand } from './utils/user-shell-env.js';
```

Add a module-level helper + pure builder (place near `buildSpawnCommand`, ~line 895):

```ts
/** Whether a mode launches an external agent CLI whose env must be inherited. */
function isAgentCliMode(mode: SessionMode): boolean {
  return mode === 'opencode' || mode === 'codex' || mode === 'gemini' || mode === 'agy';
}

/**
 * COD-276 — assemble the local pane launch command. Agent modes re-`exec` through
 * the user's login shell so the CLI inherits the user's shell env; `shell` mode is
 * unchanged. `pathExport` is the `export PATH="…" && ` string from buildPathExport.
 */
export function buildLocalPaneCommand(opts: {
  mode: SessionMode;
  pathExport: string;
  envExports: string[];
  cmd: string;
}): string {
  const nofile = buildNofileLimitCommand();
  if (isAgentCliMode(opts.mode)) {
    return `${nofile} && ${buildUserShellEnvCommand({
      pathExport: opts.pathExport.replace(/ && $/, ''),
      envExports: opts.envExports,
      cmd: opts.cmd,
    })}`;
  }
  return `${nofile} && ${opts.pathExport}${opts.envExports.join(' && ')} && ${opts.cmd}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/tmux-manager.test.ts`
Expected: PASS (new describe passes; existing tests unaffected).

- [ ] **Step 5: Use `buildLocalPaneCommand` in `createSession`**

In `createSession`, replace the env-exports/localfullcmd construction. Change:

```ts
const envExportsStr = this.buildEnvExports(sessionId, muxName, mode, truecolorEnabled, headroomClaudeUrl).join(
  ' && '
);
```

to:

```ts
const envExports = this.buildEnvExports(sessionId, muxName, mode, truecolorEnabled, headroomClaudeUrl);
const envExportsStr = envExports.join(' && ');
```

Then change:

```ts
const localFullCmd = `${buildNofileLimitCommand()} && ${pathExport}${envExportsStr} && ${cmd}`;
```

to:

```ts
const localFullCmd = buildLocalPaneCommand({ mode, pathExport, envExports, cmd });
```

- [ ] **Step 6: Use `buildLocalPaneCommand` in `respawnPane`**

In `respawnPane`, change:

```ts
const envExportsStr = this.buildEnvExports(sessionId, muxName, mode, truecolorEnabled, headroomClaudeUrl).join(
  ' && '
);
```

to:

```ts
const envExports = this.buildEnvExports(sessionId, muxName, mode, truecolorEnabled, headroomClaudeUrl);
const envExportsStr = envExports.join(' && ');
```

Then change:

```ts
const localFullCmd = `${buildNofileLimitCommand()} && ${pathExport}${envExportsStr} && ${cmd}`;
```

to:

```ts
const localFullCmd = buildLocalPaneCommand({ mode, pathExport, envExports, cmd });
```

- [ ] **Step 7: Commit**

```bash
git add src/tmux-manager.ts test/tmux-manager.test.ts
git commit -m "feat(core): COD-276 source user shell env for local agent launches"
```

---

### Task 3: Wire the user-shell-env wrapper into the remote launch path

**Files:**
- Modify: `src/tmux-manager.ts` (`buildRemoteLaunchCommand` pane-command construction)
- Test: `test/remote-tmux-launch.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `test/remote-tmux-launch.test.ts`:

```ts
describe('COD-276 remote agent launches source user shell env', () => {
  it('wraps agent modes so the remote CLI inherits the user shell env', () => {
    const command = buildRemoteLaunchCommand({
      mode: 'opencode',
      sessionId: 'abcd1234-5678-90ab-cdef-1234567890ab',
      remote: baseRemote,
    });
    // agent runs through a login shell with rc sourcing; shell is still the agent
    expect(command).toContain('exec bash -lc');
    expect(command).toContain('exec opencode');
    expect(command).toContain('login_shell=${SHELL:-');
  });

  it('still honors per-mode command overrides for agent modes', () => {
    const command = buildRemoteLaunchCommand({
      mode: 'codex',
      sessionId: 'abcd1234-5678-90ab-cdef-1234567890ab',
      remote: { ...baseRemote, commands: { codex: 'exec codx personal' } },
    });
    expect(command).toContain('exec bash -lc');
    expect(command).toContain('exec codx personal');
  });

  it('keeps shell mode launch unchanged (no user-shell wrapper)', () => {
    const command = buildRemoteLaunchCommand({
      mode: 'shell',
      sessionId: 'abcd1234-5678-90ab-cdef-1234567890ab',
      remote: baseRemote,
    });
    expect(command).toContain('exec bash -l');
    expect(command).not.toContain('exec bash -lc');
    expect(command).not.toContain('login_shell=');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/remote-tmux-launch.test.ts`
Expected: FAIL — the `opencode` command does not yet contain `exec bash -lc`.

- [ ] **Step 3: Update `buildRemoteLaunchCommand`**

In `buildRemoteLaunchCommand`, change the pane-command construction. Before:

```ts
  const paneCommand = `cd ${shellescape(remote.remotePath)} && ${withRemotePathBootstrap(modeCommand)}`;
```

After:

```ts
  // COD-276: agent modes re-exec through the user's login shell so the remote CLI
  // inherits the user's shell env (bash -lc, or zsh -lc + explicit ~/.zshrc). The
  // per-host `commands.<mode>` override remains authoritative for WHICH command runs.
  const effectiveMode = isAgentCliMode(mode)
    ? buildUserShellEnvCommand({ cmd: modeCommand.replace(/^exec\s+/, '') })
    : modeCommand;
  const paneCommand = `cd ${shellescape(remote.remotePath)} && ${withRemotePathBootstrap(effectiveMode)}`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/remote-tmux-launch.test.ts`
Expected: PASS (all new + existing COD-104 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/tmux-manager.ts test/remote-tmux-launch.test.ts
git commit -m "feat(core): COD-276 source user shell env for remote agent launches"
```

---

### Task 4: Full verification

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no type errors.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors/warnings introduced.

- [ ] **Step 3: Format check**

Run: `npm run format:check`
Expected: clean (or run `npm run format` on touched files if Prettier disagrees).

- [ ] **Step 4: Lockfile check**

Run: `npm run check:lockfile`
Expected: clean.

- [ ] **Step 5: Run the focused test files (never the full suite — we are in a managed tmux session)**

Run:
```bash
npm test -- test/user-shell-env.test.ts test/tmux-manager.test.ts test/remote-tmux-launch.test.ts
```
Expected: all PASS.

- [ ] **Step 6: Update Jira (COD-276) with branch, approach, and verification** (after PR). Final commit:

```bash
git commit -am "chore: COD-276 verification"
```
```
