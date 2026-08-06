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
