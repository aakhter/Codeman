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
import { renderRemoteCliCommand } from '../src/tmux-manager.js';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';
import { CHECKPOINT_FRAME_PROFILES, isKnownCheckpointFrameProfile } from '../src/config/cli-registry/profiles.js';
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
    copilot: remoteLoginShellCommand('copilot'),
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
    copilot: 'exec copilot',
  };
  for (const [mode, want] of Object.entries(expected)) {
    expect(defaultDockerCommandForMode(mode as SessionMode), mode).toBe(want);
  }
  expect(defaultDockerCommandForMode('nope' as SessionMode)).toBe('exec bash -l');
});

// ---------------------------------------------------------------------------
// COD-416 wave 3e — the per-session half of the same two overlays
// ---------------------------------------------------------------------------
//
// The goldens above pin the STATIC default each location falls back to. These pin the part
// that varies with the session: which CLIs carry their own config to a remote host, and how a
// resume id reaches an in-container pane. Both were id-branches in tmux-manager.ts and are now
// `overlays.remote.fromLaunchSpec` / `overlays.docker.resume`.

it('renders a remote command from the launch spec for exactly the CLIs that declare it', () => {
  // Descriptive, not aspirational: these four are the four that had a hand-written per-session
  // builder before the conversion. Widening this set is a behaviour change on a path no test
  // and no beta instance can exercise — see the note on `overlays.remote.fromLaunchSpec`.
  const carriesSessionConfig = STOCK_CLIS.filter((entry) => {
    const overlay = entry.overlays.remote;
    return !!overlay && !('disabled' in overlay) && overlay.fromLaunchSpec === true;
  }).map((entry) => entry.id);
  expect([...carriesSessionConfig].sort()).toEqual(['antigravity', 'codex', 'gemini', 'opencode']);

  // And the flag is what actually selects the per-session render.
  expect(renderRemoteCliCommand('gemini' as SessionMode, { mode: 'gemini', sessionId: 'abc123' })).toBe(
    'gemini --skip-trust --approval-mode yolo'
  );
  expect(
    renderRemoteCliCommand('gemini' as SessionMode, {
      mode: 'gemini',
      sessionId: 'abc123',
      geminiConfig: { model: 'gemini-2.5-pro', resumeSession: 'sess-1' },
    })
  ).toBe('gemini --skip-trust --approval-mode yolo --model gemini-2.5-pro --resume sess-1');
  // pi declares no remote overlay, so it keeps the static default — its config is dropped.
  expect(
    renderRemoteCliCommand('pi' as SessionMode, {
      mode: 'pi',
      sessionId: 'abc123',
      piConfig: { model: 'pi-1' },
    })
  ).toBeUndefined();
});

it("carries opencode's config blob to a remote pane as its declared env var", () => {
  // `env.configContentVar` names the var; the JSON is built by the same resolver the local
  // `tmux setenv` path uses, so remote and local cannot disagree about auto-allow.
  const command = renderRemoteCliCommand('opencode' as SessionMode, {
    mode: 'opencode',
    sessionId: 'abc123',
    openCodeConfig: { autoAllowTools: true },
  });
  expect(command).toBe(`OPENCODE_CONFIG_CONTENT='{"permission":{"*":"allow"}}' opencode`);
  // A CLI declaring no configContentVar gets no prefix.
  expect(renderRemoteCliCommand('codex' as SessionMode, { mode: 'codex', sessionId: 'abc123' })).toBe('codex');
});

it('runs a resolved raw command line verbatim on a remote host too', () => {
  // `launch.rawCommandField` (codex's COD-392 `baseCommand`) replaces the templated launch in
  // both locations. The grant that authorises it is re-checked on the launch paths.
  expect(
    renderRemoteCliCommand('codex' as SessionMode, {
      mode: 'codex',
      sessionId: 'abc123',
      codexConfig: { baseCommand: 'codex --profile custom', model: 'ignored' },
    })
  ).toBe('codex --profile custom');
});

it('pins which CLIs refuse an in-container resume against a case-supplied command', () => {
  // A case's own `commands.<mode>` is opaque text. For these two, applying a resume to it would
  // silently start a fresh conversation, so the launch refuses and a human recovers instead.
  const refusing = STOCK_CLIS.filter((entry) => {
    const overlay = entry.overlays.docker;
    return !!overlay && !('disabled' in overlay) && overlay.resume?.refuseWhenOverridden === true;
  }).map((entry) => entry.id);
  expect([...refusing].sort()).toEqual(['codex', 'opencode']);
});

it('forwards exactly the declared docker exec env names', () => {
  // Was a two-arm conditional over codex/gemini; the same list has always been registry data.
  const declared = Object.fromEntries(
    STOCK_CLIS.filter((entry) => entry.env.dockerExecEnvNames.length > 0).map((entry) => [
      entry.id,
      entry.env.dockerExecEnvNames,
    ])
  );
  expect(declared).toEqual({
    codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  });
});

// ---------------------------------------------------------------------------
// COD-416 wave 4 — checkpoint terminal grammar
// ---------------------------------------------------------------------------

it('declares checkpoint grammar for exactly the CLIs whose prompt syntax is verified', () => {
  // ⚠️ ABSENT is meaningful: a CLI with no verified prompt syntax falls back to "ready unless
  // working". Declaring a GUESSED glyph would be worse than declaring none — a wrong glyph
  // never matches, so `ready` would latch false and every checkpoint would sit in waiting-ready
  // until it timed out. Widening this set requires watching that CLI's real frames first.
  const declared = Object.fromEntries(
    STOCK_CLIS.filter((e) => e.capabilities.checkpoint).map((e) => [
      e.id,
      [e.capabilities.checkpoint!.promptGlyph, e.capabilities.checkpoint!.workingFrameProfile],
    ])
  );
  expect(declared).toEqual({
    claude: ['❯', 'claude-checkpoint'],
    codex: ['›', 'codex-checkpoint'],
  });
  // Only claude runs without tmux, so only claude has a frameless readiness path.
  const directPty = STOCK_CLIS.filter((e) => e.capabilities.checkpoint?.directPtyPromptTransition).map((e) => e.id);
  expect(directPty).toEqual(['claude']);
});

it('names only checkpoint frame profiles this build implements', () => {
  // schema.ts rejects an unknown name at LOAD time; this pins the two lists together so
  // renaming a profile without updating the entry fails here rather than at a checkpoint.
  for (const entry of STOCK_CLIS) {
    const profile = entry.capabilities.checkpoint?.workingFrameProfile;
    if (profile) expect(isKnownCheckpointFrameProfile(profile), `${entry.id}: ${profile}`).toBe(true);
  }
  expect([...CHECKPOINT_FRAME_PROFILES]).toEqual(['codex-checkpoint', 'claude-checkpoint']);
});
