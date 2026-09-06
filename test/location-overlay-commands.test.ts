/**
 * @fileoverview Golden pins for the remote/docker LOCATION OVERLAY commands, now that both
 * are read from `overlays.<location>` on the registry entry rather than from a hardcoded
 * `Record<…CommandMode, string>` in each file.
 *
 * The literals below are transcribed from those two tables as they stood BEFORE the wiring,
 * which is the whole point: the tables were dead-simple duplicates of registry data with
 * nothing keeping the two in step, and the way to delete a duplicate safely is to pin what it
 * produced first. A diff here means an entry's `overlays` (or its first declared binary)
 * changed what a remote or in-container pane actually runs.
 *
 * Note the two arms deliberately NOT read from an entry, each for its own reason: remote
 * `shell` resolves the REMOTE user's login shell (unknowable from here, hence `$SHELL`), and
 * docker `shell` is the entry that declares `docker: { disabled: true }` — a container has no
 * per-user login shell to resolve, so it gets a plain `bash -l`.
 *
 * Port: none (pure, over registry data).
 */

import { it, expect } from 'vitest';
import {
  defaultRemoteCommandForMode,
  remoteLoginShellCommand,
  REMOTE_LOGIN_SHELL_RESOLVE,
} from '../src/remote-hosts.js';
import { defaultDockerCommandForMode } from '../src/docker-hosts.js';
import type { SessionMode } from '../src/types/session.js';

// COD-277 — deliberately NOT upstream's `"${SHELL:-/bin/sh}"`. In a tmux pane `$SHELL` is
// the tmux SERVER's shell (bash here), so a zsh user's ~/.zshrc was never sourced. The shell
// arm resolves the REAL login shell from the passwd entry (getent/dscl) at runtime instead,
// which is why this one golden differs from upstream's.
const REMOTE_LOGIN_SHELL = 'login_shell';

it('pins every remote pane command', () => {
  const expected: Record<string, string> = {
    shell: `${REMOTE_LOGIN_SHELL_RESOLVE}exec "$${REMOTE_LOGIN_SHELL}" -i -l`,
    claude: remoteLoginShellCommand('claude --dangerously-skip-permissions'),
    opencode: remoteLoginShellCommand('opencode'),
    codex: remoteLoginShellCommand('codex'),
    gemini: remoteLoginShellCommand('gemini'),
    antigravity: remoteLoginShellCommand('agy'),
    pi: remoteLoginShellCommand('pi'),
    grok: remoteLoginShellCommand('grok'),
    deepseek: remoteLoginShellCommand('dsh'),
    omp: remoteLoginShellCommand('omp'),
  };
  for (const [mode, want] of Object.entries(expected)) {
    expect(defaultRemoteCommandForMode(mode as SessionMode), mode).toBe(want);
  }
  expect(defaultRemoteCommandForMode('nope' as SessionMode)).toBe(expected.shell);
});

it('pins every in-container pane command', () => {
  const expected: Record<string, string> = {
    shell: 'exec bash -l',
    claude: 'exec claude --dangerously-skip-permissions',
    opencode: 'exec opencode',
    codex: 'exec codex',
    gemini: 'exec gemini',
    antigravity: 'exec agy',
    pi: 'exec pi',
    grok: 'exec grok',
    deepseek: 'exec dsh',
    omp: 'exec omp',
  };
  for (const [mode, want] of Object.entries(expected)) {
    expect(defaultDockerCommandForMode(mode as SessionMode), mode).toBe(want);
  }
  expect(defaultDockerCommandForMode('nope' as SessionMode)).toBe('exec bash -l');
});
