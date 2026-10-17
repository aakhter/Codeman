/**
 * @fileoverview Unit + integration tests for TmuxManager
 *
 * Unit tests (mocked): validation, command construction, parsing logic.
 * Integration tests (real tmux): session creation, input, kill, reconciliation.
 *
 * Port: N/A (no server needed)
 */

import { getCli } from '../src/config/cli-registry/registry.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TmuxManager,
  buildRemoteKillCommand,
  buildRemoteLaunchCommand,
  buildSpawnCommand,
  buildLocalPaneCommand,
  buildNofileLimitCommand,
  cliNotFoundMessage,
  buildDockerLaunchCommand,
  planCliEnvSetenv,
  formatPaneSnapshot,
  isUsableWorkingDir,
  parsePaneList,
  parsePaneRecords,
  parseTmuxCodexProviderEnvironment,
  readTmuxCodexProviderEnvironment,
  parsePaneRows,
  derivePaneExits,
  hasObservablePaneSession,
  type PaneRow,
  resolveActivePaneTarget,
  resolveTmuxPaneTarget,
  selectLaunchCommand,
  wrapSpawnCommandWithNice,
} from '../src/tmux-manager.js';
import type { SessionMode } from '../src/types.js';
import { loginShellArgs, resolveLocalShell } from '../src/utils/index.js';
import { execSync, exec } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { REMOTE_LOGIN_SHELL_RESOLVE } from '../src/remote-hosts.js';
import type { MuxSession } from '../src/mux-interface.js';

// ============================================================================
// Unit Tests (mocked)
// ============================================================================

// Mock child_process
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    // NOTE: plain vi.fn() mocks don't carry Node's internal `util.promisify.custom`
    // that the real `child_process.exec` uses to resolve `{stdout, stderr}` — without
    // it, `promisify(exec)` resolves with just the callback's 2nd arg. So the callback
    // here passes a single combined object (not separate stdout/stderr strings) to
    // match what `execAsync()` callers in tmux-manager.ts destructure.
    exec: vi.fn((_cmd: string, optionsOrCallback?: unknown, maybeCallback?: unknown) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      if (typeof callback === 'function') {
        setImmediate(() =>
          (callback as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
            stdout: '',
            stderr: '',
          })
        );
      }
      return {
        on: vi.fn(),
        kill: vi.fn(),
        pid: 12345,
      };
    }),
    execSync: vi.fn(),
    spawn: vi.fn(() => ({
      unref: vi.fn(),
      on: vi.fn(),
      pid: 12345,
    })),
  };
});

// Mock fs to avoid file I/O
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    statSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFile: vi.fn((_path: string, _data: string, cb: (err: Error | null) => void) => cb(null)),
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises');
  return {
    ...actual,
    writeFile: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
  };
});

describe('TmuxManager (unit)', () => {
  let manager: TmuxManager;
  const mockedExecSync = vi.mocked(execSync);
  const mockedExec = vi.mocked(exec);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedExec.mockImplementation((_cmd: string, optionsOrCallback?: unknown, maybeCallback?: unknown) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      if (typeof callback === 'function') {
        setImmediate(() =>
          (callback as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
            stdout: '',
            stderr: '',
          })
        );
      }
      return {
        on: vi.fn(),
        kill: vi.fn(),
        pid: 12345,
      } as never;
    });
    // Default: which claude returns /usr/local/bin/claude
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('which claude')) {
        return '/usr/local/bin/claude\n';
      }
      if (typeof cmd === 'string' && cmd.includes('which tmux')) {
        return '/usr/bin/tmux\n';
      }
      return '';
    });
    manager = new TmuxManager();
  });

  afterEach(() => {
    manager.destroy();
    vi.restoreAllMocks();
  });

  describe('backend', () => {
    it('should report tmux as backend', () => {
      expect(manager.backend).toBe('tmux');
    });
  });

  describe('statusline user-command env', () => {
    // A tmux setenv survives respawn-pane, so the absence of a user statusline
    // must UNSET the variable rather than leave a stale one for the exporter
    // to wrap.
    it('unsets CODEMAN_USER_STATUSLINE_CMD when the user has no statusline', () => {
      mockedExecSync.mockClear();
      (
        manager as unknown as { _configureStatusLineUserCommand: (m: string, c?: string) => void }
      )._configureStatusLineUserCommand('codeman-abc', undefined);
      const cmds = mockedExecSync.mock.calls.map((c) => String(c[0]));
      expect(cmds.some((c) => c.includes("setenv -t 'codeman-abc' -u CODEMAN_USER_STATUSLINE_CMD"))).toBe(true);
    });

    it('sets CODEMAN_USER_STATUSLINE_CMD, shell-escaped, when the user has one', () => {
      mockedExecSync.mockClear();
      (
        manager as unknown as { _configureStatusLineUserCommand: (m: string, c?: string) => void }
      )._configureStatusLineUserCommand('codeman-abc', `printf '%s' "$1" | jq -r .model`);
      const cmds = mockedExecSync.mock.calls.map((c) => String(c[0]));
      const setCmd = cmds.find((c) => c.includes('CODEMAN_USER_STATUSLINE_CMD'));
      expect(setCmd).toBeDefined();
      expect(setCmd).not.toContain(' -u ');
      expect(setCmd).toContain("setenv -t 'codeman-abc' CODEMAN_USER_STATUSLINE_CMD ");
    });
  });

  describe('Codex command builder', () => {
    // COD-416 wave 3e: the hand-written buildCodexCommand is gone — the registry's launch spec
    // renders these, so the assertions now run through the one surviving builder.
    const codexCommand = (codexConfig?: Record<string, unknown>) =>
      buildSpawnCommand({ mode: 'codex', sessionId: 'abc123', codexConfig: codexConfig as never });

    it('controls decorative TUI animation through Codex config', () => {
      expect(codexCommand({ animations: false })).toBe('codex --config tui.animations=false');
      expect(codexCommand({ animations: true })).toBe('codex --config tui.animations=true');
      expect(codexCommand()).toBe('codex');
    });

    it('runs a resolved local case command exactly as saved', () => {
      expect(codexCommand({ baseCommand: 'codex --local-exact --model o3' })).toBe('codex --local-exact --model o3');
      expect(
        buildSpawnCommand({ mode: 'codex', sessionId: 'abc123', codexConfig: { baseCommand: 'codex --local-exact' } })
      ).toBe('codex --local-exact');
    });
  });

  describe('remote launch command builder', () => {
    it('wraps codex command overrides in a remote tmux attach-or-create', () => {
      const command = buildRemoteLaunchCommand({
        mode: 'codex',
        sessionId: 'abcd1234-5678',
        remote: {
          hostId: 'gpu-box',
          label: 'GPU Box',
          host: '10.0.0.42',
          username: 'ubuntu',
          remotePath: '/home/ubuntu/work',
          commands: { codex: 'exec codx personal' },
        },
      });

      expect(command).toContain('ssh');
      expect(command).toContain('BatchMode=yes');
      expect(command).toContain('ubuntu@10.0.0.42');
      expect(command).toContain('/home/ubuntu/work');
      expect(command).toContain('tmux -L codeman-remote new-session -A -s codeman-ssh-abcd1234');
      expect(command).toContain('exec codx personal');
      // COD-104: remote agent lives in remote tmux (attach-or-create), not a child of ssh.
      // A per-host override is used bare (no login-shell wrapper) — remote user-env
      // sourcing is handled by defaultRemoteCommandForMode/remoteLoginShellCommand.
      expect(command).not.toContain('bash -lc');
    });

    it('uses default shell command when no override is configured', () => {
      const command = buildRemoteLaunchCommand({
        mode: 'shell',
        sessionId: 'abcd1234-5678',
        remote: {
          hostId: 'gpu-box',
          label: 'GPU Box',
          host: '10.0.0.42',
          username: 'ubuntu',
          remotePath: '/home/ubuntu/work',
        },
      });

      expect(command).toContain(`${REMOTE_LOGIN_SHELL_RESOLVE}exec "$login_shell" -i -l`);
      // `failed`, not `on`: `on` also keeps the pane after a CLEAN exit, so typing
      // `exit` in a remote shell strands a dead pane that the next launch's `-A`
      // reattaches to instead of starting a shell.
      expect(command).toContain('remain-on-exit failed');
      expect(command).not.toContain('remain-on-exit on');
      // Last in the chain: tmux aborts the rest of a `\;` sequence after an error,
      // and `failed` needs tmux >= 3.2 on the REMOTE host. Trailing, a rejection
      // costs only this option instead of every setting after it.
      expect(command.trimEnd().endsWith("remain-on-exit failed'")).toBe(true);
    });

    it('defaults claude to a non-interactive launch (--dangerously-skip-permissions)', () => {
      const command = buildRemoteLaunchCommand({
        mode: 'claude',
        remote: { hostId: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', remotePath: '/w' },
        sessionId: 'abc123def456',
      });
      // Routed through an interactive login shell so ~/.local/bin (where `claude`
      // typically lives) is on PATH — ssh's remote-command execution is neither
      // interactive nor login, so a bare `exec claude` fails with "command not found".
      // The inner quoting is escaped twice over (once per shellescape() layer), so
      // assert on the unescaped substrings rather than the literal quoted form.
      expect(command).toContain(`${REMOTE_LOGIN_SHELL_RESOLVE}exec "$login_shell" -i -l -c`);
      expect(command).toContain('claude --dangerously-skip-permissions');
    });

    it('pins SSH-remote claude to the Codeman session id so a respawn resumes the same conversation', () => {
      // Regression (2026-08-29): remote claude was launched as a bare `claude …`,
      // so every reattach/respawn after a pane death (user ctrl-d or ctrl-c exit)
      // started a NEW conversation. The launch now mirrors the docker-claude shape:
      // `--session-id <id>` to create, with a `|| --resume <id>` fallback so the
      // idempotent re-run resumes instead of erroring ("already in use").
      const command = buildRemoteLaunchCommand({
        mode: 'claude',
        remote: { hostId: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', remotePath: '/w' },
        sessionId: 'abc123def456',
      });
      expect(command).toContain('claude --dangerously-skip-permissions --session-id abc123def456');
      expect(command).toContain('claude --dangerously-skip-permissions --resume abc123def456');
    });

    it('resumes an explicit resumeSessionId distinct from sessionId (mirrors claudeDockerPaneCommand)', () => {
      // The docker-claude builder (claudeDockerPaneCommand) has always handled a
      // resumeId that differs from sessionId — e.g. a resume-from-history launch —
      // by leading with `--resume <rid> || --session-id <sessionId>`. The remote
      // claude branch used to only mirror the SAME-id fallback shape and silently
      // dropped a distinct resumeSessionId, so a remote resume-from-history claude
      // launch created a brand-new conversation instead of resuming the named one.
      const command = buildRemoteLaunchCommand({
        mode: 'claude',
        remote: { hostId: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', remotePath: '/w' },
        sessionId: 'abc123def456',
        resumeSessionId: 'old-conversation-uuid',
      });
      expect(command).toContain('claude --dangerously-skip-permissions --resume old-conversation-uuid');
      expect(command).toContain('claude --dangerously-skip-permissions --session-id abc123def456');
      // The resume attempt must lead — session-id is the fallback here, reversed
      // from the same-id case.
      const resumeIdx = command.indexOf('--resume old-conversation-uuid');
      const sessionIdIdx = command.indexOf('--session-id abc123def456');
      expect(resumeIdx).toBeLessThan(sessionIdIdx);
    });
  });

  describe('codex command builder', () => {
    it('passes hook trust bypass only when explicitly configured for automation', () => {
      const codexCommand = (codexConfig?: Record<string, unknown>) =>
        buildSpawnCommand({ mode: 'codex', sessionId: 'abc123', codexConfig: codexConfig as never });
      expect(codexCommand()).not.toContain('--dangerously-bypass-hook-trust');

      expect(codexCommand({ dangerouslyBypassHookTrust: true })).toContain('--dangerously-bypass-hook-trust');
    });
  });

  describe('getAttachCommand', () => {
    it('should return tmux', () => {
      expect(manager.getAttachCommand()).toBe('tmux');
    });
  });

  describe('getAttachArgs', () => {
    it('should attach every session through the dedicated Codeman socket', () => {
      const args = manager.getAttachArgs('codeman-abc12345');
      expect(args).toEqual(['-L', 'codeman', 'attach-session', '-t', 'codeman-abc12345']);
    });

    it('should attach registered sessions on the same dedicated socket (no per-session socket)', () => {
      manager.registerSession({
        sessionId: 'some-session',
        muxName: 'codeman-abc12345',
        pid: 12345,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      const args = manager.getAttachArgs('codeman-abc12345');
      expect(args).toEqual(['-L', 'codeman', 'attach-session', '-t', 'codeman-abc12345']);
    });
  });

  describe('window sizing', () => {
    async function importWithTmuxCommandsEnabled(): Promise<typeof TmuxManager> {
      const originalVitest = process.env.VITEST;
      vi.resetModules();
      delete process.env.VITEST;
      try {
        return (await import('../src/tmux-manager.js')).TmuxManager;
      } finally {
        if (originalVitest === undefined) delete process.env.VITEST;
        else process.env.VITEST = originalVitest;
      }
    }

    function holdFirstTeardownExec(): {
      resizeCallbacks: Array<(error: Error | null) => void>;
      releaseTeardown: () => void;
      resizeCommandCount: () => number;
    } {
      const resizeCallbacks: Array<(error: Error | null) => void> = [];
      let teardownCallback: ((error: null, result: { stdout: string; stderr: string }) => void) | undefined;
      mockedExec.mockImplementation((command, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        if (String(command).includes('resize-window')) {
          resizeCallbacks.push(callback as (error: Error | null) => void);
        } else if (!teardownCallback) {
          teardownCallback = callback as (error: null, result: { stdout: string; stderr: string }) => void;
        } else if (typeof callback === 'function') {
          setImmediate(() =>
            (callback as (error: null, result: { stdout: string; stderr: string }) => void)(null, {
              stdout: '',
              stderr: '',
            })
          );
        }
        return { on: vi.fn(), kill: vi.fn(), pid: 12345 } as never;
      });
      return {
        resizeCallbacks,
        releaseTeardown: () => teardownCallback!(null, { stdout: '', stderr: '' }),
        resizeCommandCount: () =>
          mockedExec.mock.calls.filter(([command]) => String(command).includes('resize-window')).length,
      };
    }

    it('pins a tmux window to manual sizing before browser attach', () => {
      expect(manager.setManualWindowSize('codeman-abc12345')).toBe(true);

      expect(mockedExecSync).toHaveBeenCalledWith(
        "tmux -L 'codeman' set-window-option -t 'codeman-abc12345' window-size manual",
        expect.objectContaining({ stdio: 'ignore' })
      );
    });

    it('resizes the tmux window when Codeman accepts a desktop resize', () => {
      expect(manager.resizeWindow('codeman-abc12345', 140, 42)).toBe(true);

      // Non-blocking exec (not execSync) on the interactive resize hot path.
      expect(mockedExec).toHaveBeenCalledWith(
        "tmux -L 'codeman' resize-window -t 'codeman-abc12345' -x 140 -y 42",
        expect.objectContaining({ timeout: expect.any(Number) }),
        expect.any(Function)
      );
    });

    it('coalesces pending window resizes and finishes on the latest dimensions', () => {
      const callbacks: Array<(error: Error | null) => void> = [];
      mockedExec.mockImplementation((_cmd, _options, callback) => {
        callbacks.push(callback as (error: Error | null) => void);
        return {} as never;
      });

      expect(manager.resizeWindow('codeman-abc12345', 140, 42)).toBe(true);
      expect(manager.resizeWindow('codeman-abc12345', 75, 62)).toBe(true);
      expect(manager.resizeWindow('codeman-abc12345', 160, 48)).toBe(true);
      expect(mockedExec).toHaveBeenCalledTimes(1);

      callbacks.shift()!(null);

      expect(mockedExec).toHaveBeenCalledTimes(2);
      expect(mockedExec.mock.calls[1][0]).toContain('-x 160 -y 48');
      expect(mockedExec.mock.calls.map(([command]) => command)).not.toContain(expect.stringContaining('-x 75 -y 62'));
    });

    it('drains pending resizes after success or error and returns to idle', () => {
      const callbacks: Array<(error: Error | null) => void> = [];
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      mockedExec.mockImplementation((_cmd, _options, callback) => {
        callbacks.push(callback as (error: Error | null) => void);
        return {} as never;
      });

      manager.resizeWindow('codeman-abc12345', 140, 42);
      manager.resizeWindow('codeman-abc12345', 75, 62);
      callbacks.shift()!(null);
      expect(mockedExec).toHaveBeenCalledTimes(2);

      manager.resizeWindow('codeman-abc12345', 160, 48);
      callbacks.shift()!(new Error('tmux failed'));
      expect(mockedExec).toHaveBeenCalledTimes(3);
      expect(mockedExec.mock.calls[2][0]).toContain('-x 160 -y 48');

      callbacks.shift()!(null);
      expect(manager.resizeWindow('codeman-abc12345', 180, 55)).toBe(true);
      expect(mockedExec).toHaveBeenCalledTimes(4);
      expect(mockedExec.mock.calls[3][0]).toContain('-x 180 -y 55');
      expect(consoleError).toHaveBeenCalledWith('[TmuxManager] Failed to resize tmux window:', expect.any(Error));
      callbacks.shift()!(null);
      expect(
        (
          manager as unknown as {
            pendingWindowResizes: Map<string, unknown>;
          }
        ).pendingWindowResizes.has('codeman-abc12345')
      ).toBe(false);
      consoleError.mockRestore();
    });

    it('reports authoritative failure so an identical target can be retried', () => {
      const commandCallbacks: Array<(error: Error | null) => void> = [];
      const completions: boolean[] = [];
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      mockedExec.mockImplementation((_cmd, _options, callback) => {
        commandCallbacks.push(callback as (error: Error | null) => void);
        return {} as never;
      });

      expect(manager.resizeWindow('codeman-abc12345', 75, 62, (success) => completions.push(success))).toBe(true);
      commandCallbacks.shift()!(new Error('tmux failed'));
      expect(completions).toEqual([false]);

      expect(manager.resizeWindow('codeman-abc12345', 75, 62, (success) => completions.push(success))).toBe(true);
      expect(mockedExec).toHaveBeenCalledTimes(2);
      commandCallbacks.shift()!(null);
      expect(completions).toEqual([false, true]);
      consoleError.mockRestore();
    });

    it('retains serialization when error logging requests a re-entrant resize', () => {
      const callbacks: Array<(error: Error | null) => void> = [];
      mockedExec.mockImplementation((_cmd, _options, callback) => {
        callbacks.push(callback as (error: Error | null) => void);
        return {} as never;
      });
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {
        manager.resizeWindow('codeman-abc12345', 160, 48);
      });

      manager.resizeWindow('codeman-abc12345', 140, 42);
      callbacks.shift()!(new Error('tmux failed'));
      expect(mockedExec).toHaveBeenCalledTimes(2);

      manager.resizeWindow('codeman-abc12345', 180, 55);
      expect(mockedExec).toHaveBeenCalledTimes(2);
      callbacks.shift()!(null);
      expect(mockedExec).toHaveBeenCalledTimes(3);
      expect(mockedExec.mock.calls[2][0]).toContain('-x 180 -y 55');
      consoleError.mockRestore();
    });

    it('runs resize queues for different mux names independently', () => {
      const callbacks = new Map<string, Array<(error: Error | null) => void>>();
      mockedExec.mockImplementation((command, _options, callback) => {
        const muxName = String(command).includes('codeman-def67890') ? 'codeman-def67890' : 'codeman-abc12345';
        const muxCallbacks = callbacks.get(muxName) ?? [];
        muxCallbacks.push(callback as (error: Error | null) => void);
        callbacks.set(muxName, muxCallbacks);
        return {} as never;
      });

      manager.resizeWindow('codeman-abc12345', 140, 42);
      manager.resizeWindow('codeman-def67890', 120, 40);
      manager.resizeWindow('codeman-abc12345', 75, 62);
      manager.resizeWindow('codeman-def67890', 90, 50);
      expect(mockedExec).toHaveBeenCalledTimes(2);

      callbacks.get('codeman-abc12345')!.shift()!(null);
      expect(mockedExec).toHaveBeenCalledTimes(3);
      expect(mockedExec.mock.calls[2][0]).toContain("-t 'codeman-abc12345' -x 75 -y 62");

      callbacks.get('codeman-def67890')!.shift()!(null);
      expect(mockedExec).toHaveBeenCalledTimes(4);
      expect(mockedExec.mock.calls[3][0]).toContain("-t 'codeman-def67890' -x 90 -y 50");
    });

    it('rejects invalid resize requests without starting a command', () => {
      expect(manager.resizeWindow('unsafe;name', 140, 42)).toBe(false);
      expect(manager.resizeWindow('codeman-abc12345', 0, 42)).toBe(false);
      expect(manager.resizeWindow('codeman-abc12345', 140, 1001)).toBe(false);
      expect(manager.resizeWindow('codeman-abc12345', 140.5, 42)).toBe(false);
      expect(mockedExec).not.toHaveBeenCalled();
    });

    it('recovers after a synchronous resize executor throw', () => {
      const callbacks: Array<(error: Error | null) => void> = [];
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      mockedExec
        .mockImplementationOnce(() => {
          throw new Error('executor threw');
        })
        .mockImplementation((_cmd, _options, callback) => {
          callbacks.push(callback as (error: Error | null) => void);
          return {} as never;
        });

      expect(() => manager.resizeWindow('codeman-abc12345', 140, 42)).not.toThrow();
      expect(manager.resizeWindow('codeman-abc12345', 160, 48)).toBe(true);
      expect(mockedExec).toHaveBeenCalledTimes(2);
      expect(mockedExec.mock.calls[1][0]).toContain('-x 160 -y 48');
      expect(callbacks).toHaveLength(1);
      expect(consoleError).toHaveBeenCalledWith('[TmuxManager] Failed to resize tmux window:', expect.any(Error));
      consoleError.mockRestore();
    });

    it('retains latest resize requested re-entrantly while draining a callback', () => {
      const callbacks: Array<(error: Error | null) => void> = [];
      mockedExec.mockImplementation((_cmd, _options, callback) => {
        callbacks.push(callback as (error: Error | null) => void);
        if (mockedExec.mock.calls.length === 2) {
          manager.resizeWindow('codeman-abc12345', 90, 50);
          manager.resizeWindow('codeman-abc12345', 160, 48);
        }
        return {} as never;
      });

      manager.resizeWindow('codeman-abc12345', 140, 42);
      manager.resizeWindow('codeman-abc12345', 75, 62);
      callbacks.shift()!(null);
      expect(mockedExec).toHaveBeenCalledTimes(2);

      callbacks.shift()!(null);
      expect(mockedExec).toHaveBeenCalledTimes(3);
      expect(mockedExec.mock.calls[2][0]).toContain('-x 160 -y 48');
      expect(mockedExec.mock.calls.map(([command]) => command)).not.toContain(expect.stringContaining('-x 90 -y 50'));
    });

    it('ignores a duplicate completion from an older resize command', () => {
      const callbacks: Array<(error: Error | null) => void> = [];
      mockedExec.mockImplementation((_cmd, _options, callback) => {
        callbacks.push(callback as (error: Error | null) => void);
        return {} as never;
      });

      manager.resizeWindow('codeman-abc12345', 140, 42);
      manager.resizeWindow('codeman-abc12345', 160, 48);
      const firstCompletion = callbacks[0];
      firstCompletion(null);
      expect(mockedExec).toHaveBeenCalledTimes(2);

      firstCompletion(null);
      manager.resizeWindow('codeman-abc12345', 180, 55);
      expect(mockedExec).toHaveBeenCalledTimes(2);

      callbacks[1](null);
      expect(mockedExec).toHaveBeenCalledTimes(3);
      expect(mockedExec.mock.calls[2][0]).toContain('-x 180 -y 55');
    });

    it('ignores a synchronous executor throw after its callback completed', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      mockedExec.mockImplementationOnce((_cmd, _options, callback) => {
        (callback as (error: Error | null) => void)(null);
        throw new Error('throw after callback');
      });

      expect(() => manager.resizeWindow('codeman-abc12345', 140, 42)).not.toThrow();
      expect(consoleError).not.toHaveBeenCalled();
      expect(manager.resizeWindow('codeman-abc12345', 160, 48)).toBe(true);
      expect(mockedExec).toHaveBeenCalledTimes(2);
    });

    it('drains safely when error logging throws and later resizes stay serialized', () => {
      const callbacks: Array<(error: Error | null) => void> = [];
      mockedExec.mockImplementation((_cmd, _options, callback) => {
        callbacks.push(callback as (error: Error | null) => void);
        return {} as never;
      });
      vi.spyOn(console, 'error').mockImplementation(() => {
        throw new Error('logger failed');
      });

      manager.resizeWindow('codeman-abc12345', 140, 42);
      manager.resizeWindow('codeman-abc12345', 160, 48);
      expect(() => callbacks[0](new Error('tmux failed'))).not.toThrow();
      expect(mockedExec).toHaveBeenCalledTimes(2);

      manager.resizeWindow('codeman-abc12345', 180, 55);
      expect(mockedExec).toHaveBeenCalledTimes(2);
      callbacks[1](null);
      expect(mockedExec).toHaveBeenCalledTimes(3);
      expect(mockedExec.mock.calls[2][0]).toContain('-x 180 -y 55');
    });

    it('kill drops pending resize work and leaves independent mux queues running', async () => {
      const callbacks = new Map<string, Array<(error: Error | null) => void>>();
      mockedExec.mockImplementation((command, _options, callback) => {
        const muxName = String(command).includes('codeman-def67890') ? 'codeman-def67890' : 'codeman-abc12345';
        const muxCallbacks = callbacks.get(muxName) ?? [];
        muxCallbacks.push(callback as (error: Error | null) => void);
        callbacks.set(muxName, muxCallbacks);
        return {} as never;
      });
      manager.registerSession({
        sessionId: 'resize-kill',
        muxName: 'codeman-abc12345',
        pid: 123,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      manager.resizeWindow('codeman-abc12345', 140, 42);
      manager.resizeWindow('codeman-abc12345', 160, 48);
      manager.resizeWindow('codeman-def67890', 120, 40);
      manager.resizeWindow('codeman-def67890', 90, 50);
      expect(await manager.killSession('resize-kill')).toBe(true);

      callbacks.get('codeman-abc12345')![0](null);
      expect(mockedExec).toHaveBeenCalledTimes(2);
      callbacks.get('codeman-def67890')![0](null);
      expect(mockedExec).toHaveBeenCalledTimes(3);
      expect(mockedExec.mock.calls[2][0]).toContain("-t 'codeman-def67890' -x 90 -y 50");
    });

    it('destroy drops pending resize work for every mux', () => {
      const callbacks: Array<(error: Error | null) => void> = [];
      mockedExec.mockImplementation((_cmd, _options, callback) => {
        callbacks.push(callback as (error: Error | null) => void);
        return {} as never;
      });

      manager.resizeWindow('codeman-abc12345', 140, 42);
      manager.resizeWindow('codeman-abc12345', 160, 48);
      manager.resizeWindow('codeman-def67890', 120, 40);
      manager.resizeWindow('codeman-def67890', 90, 50);
      manager.destroy();
      callbacks.forEach((callback) => callback(null));

      expect(mockedExec).toHaveBeenCalledTimes(2);
      expect(
        (
          manager as unknown as {
            pendingWindowResizes: Map<string, unknown>;
          }
        ).pendingWindowResizes.size
      ).toBe(0);
    });

    it('recreates cancelled state without letting an old callback alter it', async () => {
      const callbacks: Array<(error: Error | null) => void> = [];
      mockedExec.mockImplementation((_cmd, _options, callback) => {
        callbacks.push(callback as (error: Error | null) => void);
        return {} as never;
      });
      manager.registerSession({
        sessionId: 'old-session',
        muxName: 'codeman-abc12345',
        pid: 123,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      manager.resizeWindow('codeman-abc12345', 140, 42);
      manager.resizeWindow('codeman-abc12345', 150, 45);
      expect(await manager.killSession('old-session')).toBe(true);
      manager.registerSession({
        sessionId: 'new-session',
        muxName: 'codeman-abc12345',
        pid: 456,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      manager.resizeWindow('codeman-abc12345', 160, 48);
      expect(mockedExec).toHaveBeenCalledTimes(2);
      callbacks[0](null);
      manager.resizeWindow('codeman-abc12345', 180, 55);
      expect(mockedExec).toHaveBeenCalledTimes(2);
      callbacks[1](null);
      expect(mockedExec).toHaveBeenCalledTimes(3);
      expect(mockedExec.mock.calls[2][0]).toContain('-x 180 -y 55');
    });

    it('does not cancel resize work when kill cannot find the session', async () => {
      const callbacks: Array<(error: Error | null) => void> = [];
      mockedExec.mockImplementation((_cmd, _options, callback) => {
        callbacks.push(callback as (error: Error | null) => void);
        return {} as never;
      });

      manager.resizeWindow('codeman-abc12345', 140, 42);
      manager.resizeWindow('codeman-abc12345', 160, 48);
      expect(await manager.killSession('missing-session')).toBe(false);
      callbacks[0](null);

      expect(mockedExec).toHaveBeenCalledTimes(2);
      expect(mockedExec.mock.calls[1][0]).toContain('-x 160 -y 48');
    });

    it('does not cancel resize work when self-kill is refused', async () => {
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();
      const callbacks: Array<(error: Error | null) => void> = [];
      const originalMuxName = process.env.CODEMAN_MUX_NAME;
      process.env.CODEMAN_MUX_NAME = 'codeman-abc12345';
      mockedExec.mockImplementation((_cmd, _options, callback) => {
        callbacks.push(callback as (error: Error | null) => void);
        return {} as never;
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      nonTestManager.registerSession({
        sessionId: 'self-session',
        muxName: 'codeman-abc12345',
        pid: 123,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      try {
        nonTestManager.resizeWindow('codeman-abc12345', 140, 42);
        nonTestManager.resizeWindow('codeman-abc12345', 160, 48);
        expect(await nonTestManager.killSession('self-session')).toBe(false);
        callbacks[0](null);
        expect(mockedExec).toHaveBeenCalledTimes(2);
        expect(mockedExec.mock.calls[1][0]).toContain('-x 160 -y 48');
      } finally {
        nonTestManager.destroy();
        if (originalMuxName === undefined) delete process.env.CODEMAN_MUX_NAME;
        else process.env.CODEMAN_MUX_NAME = originalMuxName;
      }
    });

    it('invalidates pending resize work before non-owned remote detach awaits', async () => {
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();
      const { resizeCallbacks, releaseTeardown, resizeCommandCount } = holdFirstTeardownExec();
      nonTestManager.registerSession({
        sessionId: 'remote-detach',
        muxName: 'codeman-abc12345',
        pid: 999_999_999,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
        remote: {
          hostId: 'remote-host',
          label: 'Remote',
          host: 'remote.example',
          username: 'user',
          remotePath: '/tmp',
          owned: false,
        },
      });

      try {
        nonTestManager.resizeWindow('codeman-abc12345', 140, 42);
        nonTestManager.resizeWindow('codeman-abc12345', 160, 48);
        const killing = nonTestManager.killSession('remote-detach');
        resizeCallbacks[0](null);
        expect(resizeCommandCount()).toBe(1);
        releaseTeardown();
        await expect(killing).resolves.toBe(true);
      } finally {
        nonTestManager.destroy();
      }
    });

    it('invalidates pending resize work before owned remote teardown awaits', async () => {
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();
      const { resizeCallbacks, releaseTeardown, resizeCommandCount } = holdFirstTeardownExec();
      nonTestManager.registerSession({
        sessionId: 'remote-owned',
        muxName: 'codeman-abc12345',
        pid: 999_999_999,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
        remote: {
          hostId: 'remote-host',
          label: 'Remote',
          host: 'remote.example',
          username: 'user',
          remotePath: '/tmp',
          owned: true,
        },
      });

      try {
        nonTestManager.resizeWindow('codeman-abc12345', 140, 42);
        nonTestManager.resizeWindow('codeman-abc12345', 160, 48);
        const killing = nonTestManager.killSession('remote-owned');
        resizeCallbacks[0](null);
        expect(resizeCommandCount()).toBe(1);
        releaseTeardown();
        await expect(killing).resolves.toBe(true);
      } finally {
        nonTestManager.destroy();
      }
    });

    it('invalidates pending resize work before local teardown awaits', async () => {
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();
      const { resizeCallbacks, releaseTeardown, resizeCommandCount } = holdFirstTeardownExec();
      nonTestManager.registerSession({
        sessionId: 'local-owned',
        muxName: 'codeman-abc12345',
        pid: 999_999_999,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      try {
        nonTestManager.resizeWindow('codeman-abc12345', 140, 42);
        nonTestManager.resizeWindow('codeman-abc12345', 160, 48);
        const killing = nonTestManager.killSession('local-owned');
        resizeCallbacks[0](null);
        expect(resizeCommandCount()).toBe(1);
        releaseTeardown();
        await expect(killing).resolves.toBe(true);
      } finally {
        nonTestManager.destroy();
      }
    });
  });

  describe('environment exports', () => {
    const callBuildEnvExports = (mode: string, truecolorEnabled?: boolean) =>
      (
        manager as unknown as {
          buildEnvExports(sessionId: string, muxName: string, mode: string, truecolorEnabled?: boolean): string[];
        }
      ).buildEnvExports('session-1', 'codeman-abc12345', mode, truecolorEnabled);

    // COD-210 is a deliberate fork difference: OpenCode is a Bubble Tea TUI that
    // negotiates its palette against 24-bit color, so this fork exports truecolor
    // for it where upstream leaves COLORTERM unset. buildEnvExports still
    // implements the fork behavior, so the assertion stays ours.
    it('COD-210: enables COLORTERM truecolor for OpenCode sessions', () => {
      const exports = callBuildEnvExports('opencode');
      expect(exports).toContain('export COLORTERM=truecolor');
      expect(exports).not.toContain('unset COLORTERM');
    });

    // Keep Bitbucket's COD-75 per-session opt-in: unset by default, truecolor when selected.
    it('keeps Claude truecolor opt-in', () => {
      expect(callBuildEnvExports('claude')).toContain('unset COLORTERM');
      expect(callBuildEnvExports('claude', true)).toContain('export COLORTERM=truecolor');
    });

    it('exports the server-stamped CODEMAN_API_URL verbatim', () => {
      const original = process.env.CODEMAN_API_URL;
      process.env.CODEMAN_API_URL = 'https://127.0.0.1:3199';
      try {
        expect(callBuildEnvExports('claude')).toContain('export CODEMAN_API_URL=https://127.0.0.1:3199');
      } finally {
        if (original === undefined) delete process.env.CODEMAN_API_URL;
        else process.env.CODEMAN_API_URL = original;
      }
    });

    // A hardcoded fallback exported the wrong scheme on HTTPS installs; unset must
    // stay unset so in-session guards fail closed instead of curling a bad URL.
    it('exports no CODEMAN_API_URL at all when the server has not stamped one', () => {
      const original = process.env.CODEMAN_API_URL;
      delete process.env.CODEMAN_API_URL;
      try {
        const exports = callBuildEnvExports('claude');
        expect(exports.some((line) => line.startsWith('export CODEMAN_API_URL'))).toBe(false);
        expect(exports.join(' ')).not.toContain('localhost:3000');
      } finally {
        if (original === undefined) delete process.env.CODEMAN_API_URL;
        else process.env.CODEMAN_API_URL = original;
      }
    });
  });

  describe('formatPaneSnapshot', () => {
    it('paints captured rows with absolute cursor positions to avoid newline autowrap scroll', () => {
      const fullWidthLine = 'x'.repeat(10);

      const snapshot = formatPaneSnapshot([fullWidthLine, 'next line'], {
        cols: 10,
        rows: 4,
        cursorX: 2,
        cursorY: 1,
      });

      // Full pane width is painted (10 cols); autowrap is avoided by the
      // absolute cursor positioning, not by dropping the last column.
      expect(snapshot).toBe(`\x1b[1;1H${'x'.repeat(10)}\x1b[2;1Hnext line\x1b[2;3H`);
      expect(snapshot).not.toContain('\n');
    });

    it('preserves the rightmost column of each captured row', () => {
      const snapshot = formatPaneSnapshot(['abcd'], {
        cols: 4,
        rows: 1,
        cursorX: 0,
        cursorY: 0,
      });

      // Previously truncated to cols - 1 ('abc'); the full width is now kept.
      expect(snapshot).toBe('\x1b[1;1Habcd\x1b[1;1H');
    });

    it('preserves SGR color while stripping non-style pane controls', () => {
      const snapshot = formatPaneSnapshot(['\x1b[32mgreen\x1b[0m\x1b[2K\x1b[10;20Htail'], {
        cols: 40,
        rows: 2,
        cursorX: 0,
        cursorY: 0,
      });

      expect(snapshot).toContain('\x1b[32mgreen\x1b[0m');
      expect(snapshot).toContain('tail');
      expect(snapshot).not.toContain('\x1b[2K');
      expect(snapshot).not.toContain('\x1b[10;20H');
    });

    it('truncates styled rows by visible columns without cutting SGR escapes', () => {
      const snapshot = formatPaneSnapshot(['\x1b[31mabcdef\x1b[0m'], {
        cols: 4,
        rows: 1,
        cursorX: 0,
        cursorY: 0,
      });

      expect(snapshot).toBe('\x1b[1;1H\x1b[31mabcd\x1b[0m\x1b[1;1H');
    });

    it('does not let full-width glyphs cross the paint boundary', () => {
      // cols 5 = 'abc' (3) + full-width \u754c (2) fits exactly; with cols 4 the
      // wide glyph would straddle the boundary and is dropped.
      expect(formatPaneSnapshot(['abc\u754cdef'], { cols: 5, rows: 1, cursorX: 0, cursorY: 0 })).toBe(
        '\x1b[1;1Habc\u754c\x1b[1;1H'
      );
      expect(formatPaneSnapshot(['abc\u754cdef'], { cols: 4, rows: 1, cursorX: 0, cursorY: 0 })).toBe(
        '\x1b[1;1Habc\x1b[1;1H'
      );
    });

    it('keeps combining marks attached without consuming a terminal column', () => {
      const snapshot = formatPaneSnapshot(['a\u0301bc'], {
        cols: 4,
        rows: 1,
        cursorX: 0,
        cursorY: 0,
      });

      expect(snapshot).toBe('\x1b[1;1Ha\u0301bc\x1b[1;1H');
    });
  });

  describe('resolveTmuxPaneTarget', () => {
    it('targets the active pane when no explicit pane is requested', () => {
      expect(resolveTmuxPaneTarget('codeman-abc12345')).toBe('codeman-abc12345');
      expect(resolveTmuxPaneTarget('codeman-abc12345', 'active')).toBe('codeman-abc12345');
    });

    it('treats numeric pane targets as pane indexes, not global pane ids', () => {
      expect(resolveTmuxPaneTarget('codeman-abc12345', '0')).toBe('codeman-abc12345.0');
      expect(resolveTmuxPaneTarget('codeman-abc12345', '12')).toBe('codeman-abc12345.12');
    });

    it('preserves explicit tmux pane ids without inventing %0', () => {
      expect(resolveTmuxPaneTarget('codeman-abc12345', '%3')).toBe('codeman-abc12345.%3');
    });

    it('rejects invalid session and pane targets', () => {
      expect(resolveTmuxPaneTarget('codeman-not-hex', '0')).toBeNull();
      expect(resolveTmuxPaneTarget('codeman-abc12345', 'pane-0')).toBeNull();
    });
  });

  describe('resolveActivePaneTarget', () => {
    it('selects the active pane instead of assuming pane zero', () => {
      expect(resolveActivePaneTarget('%1:0\n%18:1\n')).toBe('%18');
    });
  });

  describe('isAvailable', () => {
    it('should return true when tmux is found', () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('which tmux')) {
          return '/usr/bin/tmux\n';
        }
        return '';
      });
      expect(TmuxManager.isTmuxAvailable()).toBe(true);
    });

    it('should return false when tmux is not found', () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('which tmux')) {
          throw new Error('not found');
        }
        return '';
      });
      expect(TmuxManager.isTmuxAvailable()).toBe(false);
    });
  });

  // NOTE: In test mode (VITEST=1), sendInput is a no-op that returns true
  // without calling execSync. This prevents tests from sending input to real tmux.
  describe('sendInput (test mode safety)', () => {
    beforeEach(() => {
      manager.registerSession({
        sessionId: 'test-id',
        muxName: 'codeman-1e571234',
        pid: 12345,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });
    });

    it('should return true for registered session (no-op in test mode)', async () => {
      expect(await manager.sendInput('test-id', '/clear\r')).toBe(true);
    });

    it('should return false for unknown session', async () => {
      expect(await manager.sendInput('nonexistent', 'hello\r')).toBe(false);
    });

    it('should not call any tmux commands in test mode', async () => {
      mockedExecSync.mockClear();
      await manager.sendInput('test-id', 'hello\r');
      const sendKeyCalls = mockedExecSync.mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('send-keys')
      );
      expect(sendKeyCalls).toHaveLength(0);
    });
  });

  describe('checkpoint command delivery', () => {
    function checkpointManager(
      execute: (command: string) => Promise<void>,
      mode: 'codex' | 'claude' = 'codex'
    ): TmuxManager {
      const testManager = new TmuxManager({ checkpointExecutor: execute, checkpointDelayMs: 0 });
      testManager.registerSession({
        sessionId: 'checkpoint-id',
        muxName: 'codeman-1e571234',
        pid: 12345,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode,
        attached: false,
      });
      return testManager;
    }

    it('acknowledges text then Enter through the production adapter boundary', async () => {
      const commands: string[] = [];
      const testManager = checkpointManager(async (command) => void commands.push(command));

      await expect(testManager.sendCheckpointCommand('checkpoint-id', '/compact\r')).resolves.toEqual({
        ok: true,
        attempt: 1,
      });
      expect(commands).toHaveLength(2);
      expect(commands[0]).toContain('send-keys');
      expect(commands[0]).toContain('-l');
      expect(commands[0]).toContain('/compact');
      expect(commands[1]).toMatch(/send-keys.* Enter$/);
      testManager.destroy();
    });

    it.each(['- leading hyphen', '--help', '-n', '- quoted \"text\" $HOME; echo unsafe'])(
      'keeps %s literal by terminating tmux option parsing',
      async (text) => {
        const commands: string[] = [];
        const testManager = checkpointManager(async (command) => void commands.push(command));
        await expect(testManager.sendCheckpointCommand('checkpoint-id', `${text}\r`)).resolves.toEqual({
          ok: true,
          attempt: 1,
        });
        expect(commands).toHaveLength(2);
        expect(commands[0]).toContain(' -l -- ');
        expect(commands[1]).toMatch(/send-keys.* Enter$/);
        testManager.destroy();
      }
    );

    it('submits a Codex $skill checkpoint with text, selection Enter, then submission Enter', async () => {
      const commands: string[] = [];
      const testManager = checkpointManager(async (command) => void commands.push(command));

      await expect(testManager.sendCheckpointCommand('checkpoint-id', '$jira-autoloop\r')).resolves.toEqual({
        ok: true,
        attempt: 1,
      });
      expect(commands).toHaveLength(3);
      expect(commands[0]).toMatch(/send-keys.* -l .*\$jira-autoloop/);
      expect(commands.slice(1).every((command) => command.endsWith(' Enter'))).toBe(true);
      testManager.destroy();
    });

    it('retries only the Codex $skill submission Enter without replaying text or selection', async () => {
      const commands: string[] = [];
      let enterAttempts = 0;
      const testManager = checkpointManager(async (command) => {
        commands.push(command);
        if (command.endsWith(' Enter') && ++enterAttempts === 2) throw new Error('submission enter failed');
      });

      await expect(testManager.sendCheckpointCommand('checkpoint-id', '$jira-autoloop\r')).resolves.toEqual({
        ok: true,
        attempt: 2,
      });
      expect(commands.filter((command) => command.includes(' -l '))).toHaveLength(1);
      expect(commands.filter((command) => command.endsWith(' Enter'))).toHaveLength(3);
      testManager.destroy();
    });

    it('reports repeated Codex $skill submission failure as enter without replaying acknowledged stages', async () => {
      const commands: string[] = [];
      let enterAttempts = 0;
      const testManager = checkpointManager(async (command) => {
        commands.push(command);
        if (command.endsWith(' Enter') && ++enterAttempts >= 2) throw new Error('submission enter failed');
      });

      await expect(testManager.sendCheckpointCommand('checkpoint-id', '$jira-autoloop\r')).resolves.toMatchObject({
        ok: false,
        stage: 'enter',
        attempt: 2,
        error: 'submission enter failed',
      });
      expect(commands.filter((command) => command.includes(' -l '))).toHaveLength(1);
      expect(commands.filter((command) => command.endsWith(' Enter'))).toHaveLength(3);
      testManager.destroy();
    });

    it.each([
      ['ordinary Codex prompt', 'continue work\r', 'codex'],
      ['Claude $skill text', '$jira-autoloop\r', 'claude'],
    ] as const)('keeps one Enter for %s', async (_label, input, mode) => {
      const commands: string[] = [];
      const testManager = checkpointManager(async (command) => void commands.push(command), mode);

      await expect(testManager.sendCheckpointCommand('checkpoint-id', input)).resolves.toEqual({
        ok: true,
        attempt: 1,
      });
      expect(commands.filter((command) => command.includes(' -l '))).toHaveLength(1);
      expect(commands.filter((command) => command.endsWith(' Enter'))).toHaveLength(1);
      testManager.destroy();
    });

    it('retries the full submission once after a text-stage failure', async () => {
      const commands: string[] = [];
      let textAttempts = 0;
      const testManager = checkpointManager(async (command) => {
        commands.push(command);
        if (command.includes(' -l ') && ++textAttempts === 1) throw new Error('text failed');
      });

      await expect(testManager.sendCheckpointCommand('checkpoint-id', '/clear\r')).resolves.toEqual({
        ok: true,
        attempt: 2,
      });
      expect(commands.filter((command) => command.includes(' -l '))).toHaveLength(2);
      expect(commands.filter((command) => command.endsWith(' Enter'))).toHaveLength(1);
      testManager.destroy();
    });

    it('reports repeated text failure at the text stage without attempting Enter', async () => {
      const commands: string[] = [];
      const testManager = checkpointManager(async (command) => {
        commands.push(command);
        if (command.includes(' -l ')) throw new Error('text failed');
      });

      await expect(testManager.sendCheckpointCommand('checkpoint-id', '/clear\r')).resolves.toMatchObject({
        ok: false,
        stage: 'text',
        attempt: 2,
        error: 'text failed',
      });
      expect(commands.filter((command) => command.includes(' -l '))).toHaveLength(2);
      expect(commands.some((command) => command.endsWith(' Enter'))).toBe(false);
      testManager.destroy();
    });

    it('retries Enter only without duplicating acknowledged text', async () => {
      const commands: string[] = [];
      let enterAttempts = 0;
      const testManager = checkpointManager(async (command) => {
        commands.push(command);
        if (command.endsWith(' Enter') && ++enterAttempts === 1) throw new Error('enter failed');
      });

      await expect(testManager.sendCheckpointCommand('checkpoint-id', '/init\r')).resolves.toEqual({
        ok: true,
        attempt: 2,
      });
      expect(commands.filter((command) => command.includes(' -l '))).toHaveLength(1);
      expect(commands.filter((command) => command.endsWith(' Enter'))).toHaveLength(2);
      testManager.destroy();
    });

    it('reports repeated Enter-only failure at the Enter stage', async () => {
      const commands: string[] = [];
      const testManager = checkpointManager(async (command) => {
        commands.push(command);
        if (command.endsWith(' Enter')) throw new Error('enter failed');
      });

      await expect(testManager.sendCheckpointCommand('checkpoint-id', '\r')).resolves.toMatchObject({
        ok: false,
        stage: 'enter',
        attempt: 2,
        error: 'enter failed',
      });
      expect(commands).toHaveLength(2);
      expect(commands.every((command) => command.endsWith(' Enter'))).toBe(true);
      testManager.destroy();
    });
  });

  // NOTE: In test mode, reconcileSessions returns all registered sessions as
  // alive without running any real tmux commands. This prevents discovery of
  // or interaction with the user's real tmux sessions.
  describe('reconcileSessions (test mode safety)', () => {
    it('should return all registered sessions as alive', async () => {
      manager.registerSession({
        sessionId: 'alive-1',
        muxName: 'codeman-a11ce111',
        pid: 100,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      const result = await manager.reconcileSessions();
      expect(result.alive).toContain('alive-1');
      expect(result.dead).toHaveLength(0);
      expect(result.discovered).toHaveLength(0);
    });

    it('should never discover real tmux sessions', async () => {
      const result = await manager.reconcileSessions();
      expect(result.discovered).toHaveLength(0);
    });

    it('should not call any tmux commands in test mode', async () => {
      mockedExecSync.mockClear();
      await manager.reconcileSessions();
      const tmuxCalls = mockedExecSync.mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && (cmd.includes('has-session') || cmd.includes('list-sessions'))
      );
      expect(tmuxCalls).toHaveLength(0);
    });
  });

  // NOTE: In test mode, killSession removes from memory without running any
  // real kill commands. The self-kill protection is not needed because no real
  // tmux commands are executed — sessions are only removed from the in-memory map.
  describe('killSession (test mode safety)', () => {
    it('should remove session from memory in test mode', async () => {
      manager.registerSession({
        sessionId: 'kill-test',
        muxName: 'codeman-5e1f1111',
        pid: 999,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      const result = await manager.killSession('kill-test');
      expect(result).toBe(true);
      expect(manager.getSession('kill-test')).toBeUndefined();
    });

    it('should allow kill when session does NOT match CODEMAN_MUX_NAME', async () => {
      const originalEnv = process.env.CODEMAN_MUX_NAME;
      process.env.CODEMAN_MUX_NAME = 'codeman-0ther1111';

      try {
        manager.registerSession({
          sessionId: 'other-kill-test',
          muxName: 'codeman-d1ff1111',
          pid: 888,
          createdAt: Date.now(),
          workingDir: '/tmp',
          mode: 'claude',
          attached: false,
        });

        // Mock the kill flow
        mockedExecSync.mockImplementation(() => '');

        const result = await manager.killSession('other-kill-test');
        expect(result).toBe(true);

        // Session should be removed
        expect(manager.getSession('other-kill-test')).toBeUndefined();
      } finally {
        if (originalEnv === undefined) {
          delete process.env.CODEMAN_MUX_NAME;
        } else {
          process.env.CODEMAN_MUX_NAME = originalEnv;
        }
      }
    });

    it('should allow kill when CODEMAN_MUX_NAME is not set', async () => {
      const originalEnv = process.env.CODEMAN_MUX_NAME;
      delete process.env.CODEMAN_MUX_NAME;

      try {
        manager.registerSession({
          sessionId: 'no-env-test',
          muxName: 'codeman-aaa11111',
          pid: 777,
          createdAt: Date.now(),
          workingDir: '/tmp',
          mode: 'claude',
          attached: false,
        });

        mockedExecSync.mockImplementation(() => '');

        const result = await manager.killSession('no-env-test');
        expect(result).toBe(true);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.CODEMAN_MUX_NAME;
        } else {
          process.env.CODEMAN_MUX_NAME = originalEnv;
        }
      }
    });
  });

  describe('metadata operations', () => {
    beforeEach(() => {
      manager.registerSession({
        sessionId: 'meta-test',
        muxName: 'codeman-ae1a1234',
        pid: 300,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });
    });

    it('should update session name', () => {
      const result = manager.updateSessionName('meta-test', 'My Session');
      expect(result).toBe(true);
      expect(manager.getSession('meta-test')?.name).toBe('My Session');
    });

    it('should return false for unknown session name update', () => {
      const result = manager.updateSessionName('nonexistent', 'Name');
      expect(result).toBe(false);
    });

    it('should set attached status', () => {
      manager.setAttached('meta-test', true);
      expect(manager.getSession('meta-test')?.attached).toBe(true);
      manager.setAttached('meta-test', false);
      expect(manager.getSession('meta-test')?.attached).toBe(false);
    });

    it('should update respawn config', () => {
      const config = {
        enabled: true,
        idleTimeoutMs: 5000,
        updatePrompt: 'test',
        interStepDelayMs: 1000,
        sendClear: true,
        sendInit: true,
      };
      manager.updateRespawnConfig('meta-test', config);
      expect(manager.getSession('meta-test')?.respawnConfig).toEqual(config);
    });

    it('should clear respawn config', () => {
      manager.updateRespawnConfig('meta-test', {
        enabled: true,
        idleTimeoutMs: 5000,
        updatePrompt: 'test',
        interStepDelayMs: 1000,
        sendClear: true,
        sendInit: true,
      });
      manager.clearRespawnConfig('meta-test');
      expect(manager.getSession('meta-test')?.respawnConfig).toBeUndefined();
    });

    it('should update ralph enabled', () => {
      manager.updateRalphEnabled('meta-test', true);
      expect(manager.getSession('meta-test')?.ralphEnabled).toBe(true);
    });
  });

  describe('getSessions', () => {
    it('should return all registered sessions', () => {
      manager.registerSession({
        sessionId: 's1',
        muxName: 'codeman-51111111',
        pid: 1,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });
      manager.registerSession({
        sessionId: 's2',
        muxName: 'codeman-52222222',
        pid: 2,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'shell',
        attached: true,
      });

      const sessions = manager.getSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.sessionId)).toContain('s1');
      expect(sessions.map((s) => s.sessionId)).toContain('s2');
    });
  });

  describe('stats collection', () => {
    it('should start and stop stats collection', () => {
      manager.startStatsCollection(60000);
      // No error thrown
      manager.stopStatsCollection();
      // No error thrown
    });
  });

  describe('tmux launch cwd hardening', () => {
    async function importWithTmuxCommandsEnabled(): Promise<typeof TmuxManager> {
      const originalVitest = process.env.VITEST;
      vi.resetModules();
      delete process.env.VITEST;
      const module = await import('../src/tmux-manager.js');
      if (originalVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = originalVitest;
      }
      return module.TmuxManager;
    }

    beforeEach(() => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('which tmux')) {
          return '/usr/bin/tmux\n';
        }
        if (typeof cmd === 'string' && cmd.includes('display-message') && cmd.includes('#{pane_pid}')) {
          return '4242\n';
        }
        return '';
      });
      // COD-212: getPanePid/isPaneDead/sessionExists/reconcileSessions now run via the
      // async `exec` (promisified), not `execSync` — mirror the same pane_pid response.
      mockedExec.mockImplementation(
        (cmd: string, optionsOrCallback?: unknown, maybeCallback?: unknown): ReturnType<typeof exec> => {
          const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
          const respond = (stdout: string) => {
            if (typeof callback === 'function') {
              setImmediate(() =>
                (callback as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
                  stdout,
                  stderr: '',
                })
              );
            }
          };
          if (typeof cmd === 'string' && cmd.includes('display-message') && cmd.includes('#{pane_pid}')) {
            respond('4242\n');
          } else {
            respond('');
          }
          return { on: vi.fn(), kill: vi.fn(), pid: 12345 } as unknown as ReturnType<typeof exec>;
        }
      );
    });

    it('starts new tmux sessions from /tmp and cd-bounces into the requested workspace', async () => {
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();

      try {
        const session = await nonTestManager.createSession({
          sessionId: 'abc12345-1234-5678-90ab-cdef12345678',
          workingDir: '/mnt/gdrive/project with spaces',
          mode: 'shell',
          historyLimit: 250_000,
        });

        expect(session.workingDir).toBe('/mnt/gdrive/project with spaces');
        expect(session.pid).toBe(4242);

        const newSessionCall = mockedExecSync.mock.calls.find(
          ([cmd]) => typeof cmd === 'string' && cmd.includes(' new-session ')
        );
        // COD-189: history-limit rides in the SAME invocation, BEFORE new-session,
        // so the initial pane (reused by respawn-pane) inherits the configured limit.
        expect(newSessionCall?.[0]).toContain(`set-option -g history-limit`);
        expect(newSessionCall?.[0]).toContain(`new-session -ds "codeman-abc12345" -c /tmp`);
        expect(String(newSessionCall?.[0]).indexOf('history-limit')).toBeLessThan(
          String(newSessionCall?.[0]).indexOf('new-session')
        );
        expect(newSessionCall?.[1]).toEqual(expect.objectContaining({ cwd: '/tmp' }));

        const respawnCall = mockedExec.mock.calls.find(
          ([cmd]) => typeof cmd === 'string' && cmd.includes(' respawn-pane ')
        );
        expect(respawnCall?.[0]).toContain(`tmux -L 'codeman' respawn-pane -k -c /tmp -t "codeman-abc12345"`);
        expect(respawnCall?.[0]).toContain("bash -c 'cd '\\''");
        expect(respawnCall?.[0]).toContain('/mnt/gdrive/project with spaces');
      } finally {
        nonTestManager.destroy();
      }
    });

    it('changes the global history default on tmux versions that cannot resize panes', async () => {
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();

      try {
        await nonTestManager.setHistoryLimit(200_000);
        const historyCall = mockedExec.mock.calls.find(
          ([cmd]) => typeof cmd === 'string' && cmd.includes(' history-limit ')
        );
        expect(historyCall?.[0]).toBe(`tmux -L 'codeman' set-option -g history-limit 200000`);
        expect(historyCall?.[0]).not.toContain(' -t ');
      } finally {
        nonTestManager.destroy();
      }
    });

    it('targets only the new and tracked sessions on tmux 3.7+', async () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.endsWith(' -V')) return 'tmux 3.7b\n';
        if (typeof cmd === 'string' && cmd.includes('which tmux')) return '/usr/bin/tmux\n';
        if (typeof cmd === 'string' && cmd.includes('display-message') && cmd.includes('#{pane_pid}')) return '4242\n';
        return '';
      });
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();

      try {
        await nonTestManager.createSession({
          sessionId: 'def67890-1234-5678-90ab-cdef12345678',
          workingDir: '/project',
          mode: 'shell',
          historyLimit: 250_000,
        });
        const newSessionCall = mockedExecSync.mock.calls.find(
          ([cmd]) => typeof cmd === 'string' && cmd.includes(' new-session ')
        );
        expect(newSessionCall?.[0]).toBe(
          `tmux -L 'codeman' new-session -ds "codeman-def67890" -c /tmp \\; set-option -t "codeman-def67890" history-limit 250000`
        );
        expect(newSessionCall?.[0]).not.toContain('set-option -g');

        mockedExec.mockClear();
        await nonTestManager.setHistoryLimit(200_000);
        const historyCall = mockedExec.mock.calls.find(
          ([cmd]) => typeof cmd === 'string' && cmd.includes(' history-limit ')
        );
        expect(historyCall?.[0]).toBe(`tmux -L 'codeman' set-option -t 'codeman-def67890' history-limit 200000`);
        expect(historyCall?.[0]).not.toContain('set-option -g');
      } finally {
        nonTestManager.destroy();
      }
    });

    it('respawns existing panes from /tmp and cd-bounces into the requested workspace', async () => {
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();
      nonTestManager.registerSession({
        sessionId: 'respawn1234',
        muxName: 'codeman-abcd1234',
        pid: 1000,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'shell',
        attached: false,
      });

      try {
        const pid = await nonTestManager.respawnPane({
          sessionId: 'respawn1234',
          workingDir: '/mnt/gdrive/project',
          mode: 'shell',
        });

        expect(pid).toBe(4242);
        const { exec: currentExec } = await import('node:child_process');
        const respawnCall = vi
          .mocked(currentExec)
          .mock.calls.find(([cmd]) => typeof cmd === 'string' && cmd.includes(' respawn-pane '));
        expect(respawnCall?.[0]).toContain(`tmux -L 'codeman' respawn-pane -k -c /tmp -t "codeman-abcd1234"`);
        expect(respawnCall?.[0]).toContain("bash -c 'cd '\\''");
        expect(respawnCall?.[0]).toContain('/mnt/gdrive/project');
      } finally {
        nonTestManager.destroy();
      }
    });

    it.each([true, false])(
      'captures recovered named remote sessions on the ownership socket (owned=%s)',
      async (owned) => {
        const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
        const nonTestManager = new NonTestTmuxManager();
        const pool = (
          nonTestManager as unknown as {
            remoteFrameSshPool: { capture: (...args: unknown[]) => Promise<string> };
          }
        ).remoteFrameSshPool;
        const capture = vi.spyOn(pool, 'capture').mockResolvedValue('live frame\n');
        const remote = {
          hostId: 'worker',
          label: 'worker',
          host: '192.0.2.1',
          username: 'ubuntu',
          remotePath: '/remote-only/project',
          owned,
          remoteSessionName: 'codeman-ssh-original',
        };
        try {
          for (const options of [{ visibleFrame: true }, { fullHistory: true }]) {
            await nonTestManager.captureRemotePaneBuffer(remote, 'new-id', 'codeman-c0d51600', options);
            const command = capture.mock.calls.at(-1)?.[2];
            expect(command).toContain(`tmux -L ${owned ? 'codeman-remote' : 'codeman'} capture-pane`);
            expect(command).toContain("-t 'codeman-ssh-original'");
          }
        } finally {
          capture.mockRestore();
          nonTestManager.destroy();
        }
      }
    );

    it.each([false, true])('checks missing cwd only for local respawn (remote=%s)', async (isRemote) => {
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();
      const remote = isRemote
        ? {
            hostId: 'worker',
            label: 'worker',
            host: '192.0.2.1',
            username: 'ubuntu',
            remotePath: '/remote-only/project',
          }
        : undefined;
      nonTestManager.registerSession({
        sessionId: 'cwd12345',
        muxName: 'codeman-c0d51600',
        pid: 1000,
        createdAt: Date.now(),
        workingDir: '/remote-only/project',
        mode: 'shell',
        attached: false,
        remote,
      });
      vi.mocked(existsSync).mockImplementation((path) => path === '/remote-only');
      vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as never);
      const paneDead = vi.spyOn(nonTestManager, 'isPaneDead').mockResolvedValue(false);
      try {
        const pid = await nonTestManager.respawnPane({
          sessionId: 'cwd12345',
          workingDir: '/remote-only/project',
          mode: 'shell',
          remote,
        });
        expect(pid).toBe(isRemote ? 4242 : null);
        const { exec: currentExec } = await import('node:child_process');
        const respawnCalls = vi.mocked(currentExec).mock.calls.filter(([cmd]) => cmd.includes(' respawn-pane '));
        expect(respawnCalls).toHaveLength(isRemote ? 1 : 0);
        if (isRemote) {
          expect(respawnCalls[0][0]).toContain('ssh');
          expect(vi.mocked(statSync)).not.toHaveBeenCalledWith('/remote-only/project');
        }
      } finally {
        paneDead.mockRestore();
        vi.mocked(statSync).mockReset();
        vi.mocked(existsSync).mockReturnValue(false);
        nonTestManager.destroy();
      }
    });

    it('reconciles Codex Headroom config before capturing its successful respawn routing snapshot', async () => {
      const originalVitest = process.env.VITEST;
      vi.resetModules();
      delete process.env.VITEST;
      const routing = await import('../src/config/headroom-routing.js');
      let reconciled = false;
      const reconcile = vi.spyOn(routing, 'reconcileCodexHeadroomPatch').mockImplementation(async () => {
        reconciled = true;
      });
      vi.spyOn(routing, 'resolveHeadroomClaudeBaseUrl').mockResolvedValue(undefined);
      vi.spyOn(routing, 'resolveHeadroomRouted').mockImplementation(async () => reconciled);
      const { TmuxManager: NonTestTmuxManager } = await import('../src/tmux-manager.js');
      if (originalVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = originalVitest;
      }

      const nonTestManager = new NonTestTmuxManager();
      nonTestManager.registerSession({
        sessionId: 'codex-respawn-1',
        muxName: 'codeman-c0d25401',
        pid: 1000,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'codex',
        attached: false,
        headroomRouted: false,
      });

      try {
        const pid = await nonTestManager.respawnPane({
          sessionId: 'codex-respawn-1',
          workingDir: '/tmp',
          mode: 'codex',
        });

        expect(pid).toBe(4242);
        expect(reconcile).toHaveBeenCalledOnce();
        expect(nonTestManager.getSession('codex-respawn-1')).toMatchObject({ headroomRouted: true });
        expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(routing.resolveHeadroomRouted).mock.invocationCallOrder[0]
        );
      } finally {
        nonTestManager.destroy();
      }
    });

    it('treats a remote respawn as failed when ssh exits during the connect window', async () => {
      vi.useFakeTimers();
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();
      nonTestManager.registerSession({
        sessionId: 'remote1234',
        muxName: 'codeman-dead1234',
        pid: 1000,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'shell',
        attached: false,
        remote: {
          hostId: 'moneytrove-host',
          label: 'moneytrove',
          host: '192.168.21.109',
          username: 'saqebakhter',
          remotePath: '/Users/saqebakhter/repos/projects/moneytrove',
        },
      });
      const isPaneDead = vi.spyOn(nonTestManager, 'isPaneDead').mockResolvedValue(true);

      try {
        const pending = nonTestManager.respawnPane({
          sessionId: 'remote1234',
          workingDir: '/Users/saqebakhter/repos/projects/moneytrove',
          mode: 'shell',
          remote: {
            hostId: 'moneytrove-host',
            label: 'moneytrove',
            host: '192.168.21.109',
            username: 'saqebakhter',
            remotePath: '/Users/saqebakhter/repos/projects/moneytrove',
          },
        });

        await vi.runAllTimersAsync();

        await expect(pending).resolves.toBeNull();
        expect(isPaneDead).toHaveBeenCalledWith('codeman-dead1234');
      } finally {
        vi.useRealTimers();
        nonTestManager.destroy();
      }
    });

    it('cleans up untracked dead codeman panes during reconcile', async () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('which tmux')) {
          return '/usr/bin/tmux\n';
        }
        return '';
      });
      // COD-212: reconcileSessions() now lists panes and kills dead ones via the
      // async `exec` (promisified), not `execSync`.
      mockedExec.mockImplementation(
        (cmd: string, optionsOrCallback?: unknown, maybeCallback?: unknown): ReturnType<typeof exec> => {
          const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
          const respond = (stdout: string) => {
            if (typeof callback === 'function') {
              setImmediate(() =>
                (callback as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
                  stdout,
                  stderr: '',
                })
              );
            }
          };
          if (typeof cmd === 'string' && cmd.includes('list-panes')) {
            respond('codeman-aabb1111|111|0\ncodeman-aabb2222|222|1\n');
          } else {
            respond('');
          }
          return { on: vi.fn(), kill: vi.fn(), pid: 12345 } as unknown as ReturnType<typeof exec>;
        }
      );
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();

      try {
        const result = await nonTestManager.reconcileSessions();

        expect(result.discovered).toEqual(['restored-aabb1111']);
        expect(mockedExec).toHaveBeenCalledWith(
          `tmux -L 'codeman' kill-session -t "codeman-aabb2222" 2>/dev/null`,
          {
            timeout: expect.any(Number),
          },
          expect.any(Function)
        );
      } finally {
        nonTestManager.destroy();
      }
    });

    it('unsets retired env keys on the tmux session BEFORE re-applying the live overrides', async () => {
      // `tmux setenv` persists at the session level and is inherited by `respawn-pane`, so
      // a key that merely disappears from envOverrides comes back in the relaunched CLI
      // (measured: `setenv FOO bar` survived two `respawn-pane -k`). Clearing a custom-model
      // selection names the keys to drop; a key both dropped and re-set must end up SET.
      const NonTestTmuxManager = await importWithTmuxCommandsEnabled();
      const nonTestManager = new NonTestTmuxManager();
      nonTestManager.registerSession({
        sessionId: 'respawn5678',
        muxName: 'codeman-abcd5678',
        pid: 1000,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'shell',
        attached: false,
      });

      try {
        const pid = await nonTestManager.respawnPane({
          sessionId: 'respawn5678',
          workingDir: '/tmp',
          mode: 'shell',
          envOverrides: { CLAUDE_CODE_KEEP: '1', ANTHROPIC_API_KEY: 'again' },
          unsetEnvKeys: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'not-a-key; rm -rf /'],
        });
        expect(pid).toBe(4242);

        const unsetCalls = mockedExecSync.mock.calls
          .map(([cmd]) => cmd)
          .filter((cmd): cmd is string => typeof cmd === 'string' && cmd.includes(" setenv -t 'codeman-abcd5678'"));
        const setCalls = mockedExec.mock.calls.map(([cmd]) => String(cmd));
        const unsetBase = unsetCalls.findIndex((cmd) => cmd.endsWith(' -u ANTHROPIC_BASE_URL'));
        const unsetKey = unsetCalls.findIndex((cmd) => cmd.endsWith(' -u ANTHROPIC_API_KEY'));
        const setKeep = setCalls.findIndex((cmd) => cmd.includes(' CLAUDE_CODE_KEEP '));
        const setKey = setCalls.findIndex((cmd) => cmd.includes(' ANTHROPIC_API_KEY ') && !cmd.includes(' -u '));
        expect(unsetBase).toBeGreaterThanOrEqual(0);
        expect(unsetKey).toBeGreaterThanOrEqual(0);
        expect(setKeep).toBeGreaterThanOrEqual(0);
        expect(mockedExec.mock.invocationCallOrder[setKeep]).toBeGreaterThan(
          mockedExecSync.mock.invocationCallOrder[unsetBase]
        );
        // Re-set AFTER its own unset, so the live value wins.
        expect(setKey).toBeGreaterThanOrEqual(0);
        expect(mockedExec.mock.invocationCallOrder[setKey]).toBeGreaterThan(
          mockedExecSync.mock.invocationCallOrder[unsetKey]
        );
        // The shell-metachar key never reaches tmux at all.
        expect([...unsetCalls, ...setCalls].some((cmd) => cmd.includes('rm -rf'))).toBe(false);
      } finally {
        nonTestManager.destroy();
      }
    });
  });
});

// ============================================================================
// Parser Tests — locks in the '|' separator contract for `tmux list-panes -F`
// output, guarding against regressions in non-tty execution contexts where
// `\t` in tmux FORMAT strings can be emitted as the literal two characters
// `\` + `t` instead of a tab byte (launchd, systemd without TTYPath, docker
// exec without TTY). See PR #71.
// ============================================================================

describe('parsePaneRows', () => {
  /** Pull the name → pid map reconciliation builds, so these cases read as they used to. */
  const pids = (output: string) => new Map(parsePaneRows(output).map((row) => [row.sessionName, row.pid]));

  it('parses well-formed output into name → pid', () => {
    const out = 'codeman-aaaa|1234\ncodeman-bbbb|5678\nclaudeman-cccc|9999';
    const result = pids(out);
    expect(result.size).toBe(3);
    expect(result.get('codeman-aaaa')).toBe(1234);
    expect(result.get('codeman-bbbb')).toBe(5678);
    expect(result.get('claudeman-cccc')).toBe(9999);
  });

  it('returns no rows for empty output', () => {
    expect(parsePaneRows('')).toEqual([]);
  });

  it('skips blank lines', () => {
    const result = pids('\ncodeman-aaaa|100\n\n\ncodeman-bbbb|200\n');
    expect(result.size).toBe(2);
    expect(result.get('codeman-aaaa')).toBe(100);
    expect(result.get('codeman-bbbb')).toBe(200);
  });

  it('skips lines without the separator', () => {
    const result = pids('codeman-aaaa 1234\ncodeman-bbbb|5678');
    expect(result.size).toBe(1);
    expect(result.get('codeman-bbbb')).toBe(5678);
  });

  it('skips lines with a non-numeric pid', () => {
    const result = pids('codeman-aaaa|notapid\ncodeman-bbbb|5678');
    expect(result.size).toBe(1);
    expect(result.get('codeman-bbbb')).toBe(5678);
  });

  it('skips lines with an empty session name', () => {
    const result = pids('|1234\ncodeman-bbbb|5678');
    expect(result.size).toBe(1);
    expect(result.get('codeman-bbbb')).toBe(5678);
  });

  it('treats a literal backslash-t in input as part of the session name, not a delimiter', () => {
    // Reproduces the launchd/systemd regression: under non-tty contexts tmux
    // was emitting FORMAT '\t' as the two characters `\` + `t` rather than a
    // tab byte. With the '|' separator, such literals must not be silently
    // treated as a delimiter — the line is discarded because there is no '|'.
    const literalBackslashT = 'codeman-aaaa\\t1234';
    expect(parsePaneRows(literalBackslashT)).toEqual([]);
  });

  it('keeps a row whose pane_dead fields are missing, and calls its deadness unknown', () => {
    // A tmux old enough to have shipped the previous two-field format, or one
    // that dropped the trailing fields, must still yield its pid.
    const [row] = parsePaneRows('codeman-aaaa|1234');
    expect(row.pid).toBe(1234);
    expect(row.dead).toBeUndefined();
    expect(row.exitStatus).toBeUndefined();
    expect(row.exitSignal).toBeUndefined();
  });

  it('reads a live pane as not dead, with no status or signal', () => {
    // Measured against tmux 3.2a: a live pane leaves both numeric fields blank.
    const [row] = parsePaneRows('codeman-aaaa|1234|0|||1');
    expect(row.dead).toBe(false);
    expect(row.exitStatus).toBeUndefined();
    expect(row.exitSignal).toBeUndefined();
  });

  it('reads a dead pane with its exit status', () => {
    const [row] = parsePaneRows('codeman-aaaa|1234|1|7|');
    expect(row.dead).toBe(true);
    expect(row.exitStatus).toBe(7);
    expect(row.exitSignal).toBeUndefined();
  });

  it('reads a dead pane with its killing signal', () => {
    const [row] = parsePaneRows('codeman-aaaa|1234|1||9');
    expect(row.dead).toBe(true);
    expect(row.exitStatus).toBeUndefined();
    expect(row.exitSignal).toBe(9);
  });

  it('leaves a status of 0 as 0 rather than dropping it', () => {
    // The whole point of the field: a clean exit is the case part 2 acts on.
    const [row] = parsePaneRows('codeman-aaaa|1234|1|0|');
    expect(row.exitStatus).toBe(0);
  });

  it('still reads the pid when a trailing field is junk', () => {
    // Carried over from the retired parsePaneList case 'splits on the first separator only'.
    expect(pids('codeman-aaaa|1234|extra-field').get('codeman-aaaa')).toBe(1234);
  });

  it('calls a non-numeric dead flag unknown rather than false', () => {
    const [row] = parsePaneRows('codeman-aaaa|1234|?||');
    expect(row.dead).toBeUndefined();
  });

  it('returns one row per pane of a split session, in tmux order', () => {
    const rows = parsePaneRows('codeman-aaaa|100|0|||\ncodeman-aaaa|200|1|0|');
    expect(rows.map((row) => row.pid)).toEqual([100, 200]);
    expect(rows.map((row) => row.sessionName)).toEqual(['codeman-aaaa', 'codeman-aaaa']);
  });

  it('excludes dead panes (remain-on-exit) and keeps live panes', () => {
    // tmux keeps a crashed pane visible with remain-on-exit; #{pane_dead}=1.
    // Such panes must NOT count as alive, or reconcile restores a dead Codex
    // session as healthy and respawns it into a crash loop (COD-43).
    const out = 'codeman-aaaa|100|0\ncodeman-bbbb|200|1\ncodeman-cccc|300|0';
    const result = parsePaneList(out);
    expect(result.size).toBe(2);
    expect(result.get('codeman-aaaa')).toBe(100);
    expect(result.get('codeman-cccc')).toBe(300);
    expect(result.has('codeman-bbbb')).toBe(false);
  });

  it('treats a missing dead-flag field as live (backward compatible)', () => {
    // Legacy 2-field output (no #{pane_dead}) must still parse as alive.
    const result = parsePaneList('codeman-aaaa|1234');
    expect(result.get('codeman-aaaa')).toBe(1234);
  });

  it('can report dead panes for health cleanup without marking them alive', () => {
    const result = parsePaneRecords('codeman-dead|123|1\ncodeman-live|456|0\ncodeman-legacy|789');

    expect(result).toEqual([
      { name: 'codeman-dead', pid: 123, dead: true },
      { name: 'codeman-live', pid: 456, dead: false },
      { name: 'codeman-legacy', pid: 789, dead: false },
    ]);
  });
});

describe('isUsableWorkingDir', () => {
  const mockedExistsSync = vi.mocked(existsSync);
  const mockedStatSync = vi.mocked(statSync);

  it('is true when the path exists and is a directory', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedStatSync.mockReturnValue({ isDirectory: () => true } as never);
    expect(isUsableWorkingDir('/tmp/real-dir')).toBe(true);
  });

  it('is false when the path exists but is not a directory', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedStatSync.mockReturnValue({ isDirectory: () => false } as never);
    expect(isUsableWorkingDir('/tmp/some-file')).toBe(false);
  });

  // Reconcile COD-43 (refuse missing cwd) with upstream's FUSE cd-bounce: refuse
  // only a real deletion (dir gone, parent healthy); tolerate a transient mount
  // blip (dir AND parent unreachable) so the pane's cd-bounce can recover.
  it('refuses (false) when the dir is gone but its parent is a healthy directory — a real deletion (COD-43)', () => {
    mockedExistsSync.mockImplementation((p) => p === '/home/u/parent');
    mockedStatSync.mockReturnValue({ isDirectory: () => true } as never);
    expect(isUsableWorkingDir('/home/u/parent/gone')).toBe(false);
  });

  it('proceeds (true) when the dir AND its parent are unreachable — a transient FUSE/mount blip', () => {
    mockedExistsSync.mockReturnValue(false);
    expect(isUsableWorkingDir('/mnt/gdrive/project')).toBe(true);
  });

  it('proceeds (true) when statSync throws on both dir and parent (mount EIO)', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedStatSync.mockImplementation(() => {
      throw new Error('EIO');
    });
    expect(isUsableWorkingDir('/mnt/gdrive/racy')).toBe(true);
  });

  it('refuses (false) on a removal race when the parent is still healthy', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedStatSync.mockImplementation((p) => {
      if (String(p).endsWith('/racy')) throw new Error('ENOENT');
      return { isDirectory: () => true } as never;
    });
    expect(isUsableWorkingDir('/home/u/racy')).toBe(false);
  });
});

describe('COD-276 buildLocalPaneCommand', () => {
  const agentCases: Array<{ mode: Exclude<SessionMode, 'shell'>; path: string; command: string }> = [
    { mode: 'claude', path: '/u/.claude/local', command: 'claude --session-id abc' },
    { mode: 'opencode', path: '/u/.opencode/bin', command: 'opencode --model sonnet' },
    { mode: 'codex', path: '/u/.npm-global/bin', command: 'codex --model o3' },
    { mode: 'gemini', path: '/u/.local/bin', command: 'gemini --model pro' },
    { mode: 'antigravity', path: '/u/.antigravity/bin', command: 'agy --model pro' },
    { mode: 'pi', path: '/u/.pi/bin', command: 'pi --model sonnet' },
  ];

  it.each(agentCases)(
    'routes $mode through the resolved login shell with ordered exports',
    ({ mode, path, command }) => {
      const pathExport = `export PATH="${path}:$PATH"`;
      const out = buildLocalPaneCommand({
        mode,
        pathExport: `${pathExport} && `,
        envExports: ['export CODEMAN_MUX=1', 'export CODEMAN_SESSION_ID=abc'],
        cmd: command,
      });
      const shell = resolveLocalShell();
      expect(out).toContain(buildNofileLimitCommand());
      expect(out).toContain(shell);
      expect(out).toContain(`${loginShellArgs(shell)} -c `);
      expect(out).toContain(
        `${pathExport} && export CODEMAN_MUX=1 && export CODEMAN_SESSION_ID=abc && exec ${command}`
      );
      expect(out.indexOf(pathExport)).toBeLessThan(out.indexOf('export CODEMAN_MUX=1'));
      expect(out.indexOf('export CODEMAN_MUX=1')).toBeLessThan(out.indexOf(`exec ${command}`));
      // pathExport trailing ' && ' is normalized for the inner command
      expect(out).not.toContain('" &&   &&');
    }
  );

  it('leaves shell mode unchanged', () => {
    const out = buildLocalPaneCommand({
      mode: 'shell',
      pathExport: '',
      envExports: ['export CODEMAN_MUX=1'],
      cmd: '$SHELL',
    });
    expect(out).toBe(`${buildNofileLimitCommand()} && export CODEMAN_MUX=1 && $SHELL`);
  });

  it('runs a saved Codex shell command without prepending another exec', () => {
    const command = 'exec /home/ubuntu/.local/bin/codx cisco';
    const out = buildLocalPaneCommand({
      mode: 'codex',
      pathExport: '',
      envExports: ['export CODEMAN_MUX=1'],
      cmd: command,
      exactCommand: true,
    });

    expect(out).toContain(`export CODEMAN_MUX=1 && ${command}`);
    expect(out).not.toContain('exec exec /home/ubuntu/.local/bin/codx');
  });

  it('nices both controlled Claude resume legs and execs only the final fallback', () => {
    const base = buildSpawnCommand({
      mode: 'claude',
      sessionId: 'new-session',
      resumeSessionId: 'aaaa-bbbb',
      claudeCliVersion: null,
    });
    const command = wrapSpawnCommandWithNice(base, { enabled: true, niceValue: 7 });
    expect(command).toBe(
      'nice -n 7 claude --dangerously-skip-permissions --resume "aaaa-bbbb" || ' +
        'nice -n 7 claude --dangerously-skip-permissions --session-id "new-session"'
    );

    const launch = buildLocalPaneCommand({ mode: 'claude', pathExport: '', envExports: [], cmd: command });
    expect(launch).toContain(
      'nice -n 7 claude --dangerously-skip-permissions --resume "aaaa-bbbb" || ' +
        'exec nice -n 7 claude --dangerously-skip-permissions --session-id "new-session"'
    );
  });
});

describe('COD-334 launch transport selection', () => {
  function builders() {
    const localResolver = vi.fn();
    const localBuilder = vi.fn(() => 'local-command');
    return {
      localResolver,
      localBuilder,
      local: vi.fn(() => {
        localResolver();
        return localBuilder();
      }),
      remote: vi.fn(() => 'remote-command'),
      docker: vi.fn(() => 'docker-command'),
    };
  }

  it('invokes only the local builder for a local launch', () => {
    const build = builders();
    expect(selectLaunchCommand({ local: build.local })).toBe('local-command');
    expect(build.local).toHaveBeenCalledOnce();
    expect(build.localResolver).toHaveBeenCalledOnce();
    expect(build.localBuilder).toHaveBeenCalledOnce();
    expect(build.remote).not.toHaveBeenCalled();
    expect(build.docker).not.toHaveBeenCalled();
  });

  it('invokes only the remote builder for a remote launch', () => {
    const build = builders();
    expect(selectLaunchCommand({ local: build.local, remote: build.remote })).toBe('remote-command');
    expect(build.local).not.toHaveBeenCalled();
    expect(build.localResolver).not.toHaveBeenCalled();
    expect(build.localBuilder).not.toHaveBeenCalled();
    expect(build.remote).toHaveBeenCalledOnce();
    expect(build.docker).not.toHaveBeenCalled();
  });

  it('invokes only the Docker builder and gives it precedence', () => {
    const build = builders();
    expect(selectLaunchCommand({ local: build.local, remote: build.remote, docker: build.docker })).toBe(
      'docker-command'
    );
    expect(build.local).not.toHaveBeenCalled();
    expect(build.localResolver).not.toHaveBeenCalled();
    expect(build.localBuilder).not.toHaveBeenCalled();
    expect(build.remote).not.toHaveBeenCalled();
    expect(build.docker).toHaveBeenCalledOnce();
  });
});

describe('COD-334 cliNotFoundMessage', () => {
  type AgentCliMode = Exclude<SessionMode, 'shell'>;
  /**
   * COD-416 wave 3b: the ten-arm switch became a delegate to the registry's generic
   * `missingCliMessage()`. Seven of the nine messages are byte-identical; TWO CHANGED, and
   * they are updated here DELIBERATELY rather than to make a test pass:
   *
   *  - claude: "Install it with" -> "Install with". Claude was the only one of the nine that
   *    said "it"; the other eight already read "Install with", so this is the odd one out
   *    being normalised, not eight regressing.
   *  - deepseek: "DeepSeek Harness CLI (dsh) not found" -> "DeepSeek CLI not found". The `dsh`
   *    binary name is still present in the install command on the same line, so the hint that
   *    matters (Debian ships an unrelated `dsh`) is not lost.
   *
   * grok/deepseek/omp were MISSING from this table despite the `satisfies` clause, so the
   * three newest CLIs had no coverage here at all. Added.
   */
  const installHints = {
    claude: 'Claude Code CLI not found. Install with: curl -fsSL https://claude.ai/install.sh | bash',
    opencode: 'OpenCode CLI not found. Install with: curl -fsSL https://opencode.ai/install | bash',
    codex: 'Codex CLI not found. Install with: npm install -g @openai/codex',
    gemini: 'Gemini CLI not found. Install with: npm install -g @google/gemini-cli',
    antigravity: 'Antigravity CLI not found. Install with: curl -fsSL https://antigravity.google/cli/install.sh | bash',
    pi: 'Pi CLI not found. Install with: npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
    grok: 'Grok CLI not found. Install with: curl -fsSL https://x.ai/cli/install.sh | bash',
    // Upstream #616 installs pnpm alongside dsh when none is on PATH.
    deepseek:
      'DeepSeek CLI not found. Install with: npm install -g @deepseek-ai/dsh && (command -v pnpm >/dev/null || npm install -g pnpm)',
    omp: 'OMP CLI not found. Install with: curl -fsSL https://omp.sh/install | sh',
  } satisfies Record<AgentCliMode, string>;
  const agentMessages = Object.entries(installHints) as Array<[AgentCliMode, string]>;

  it.each(agentMessages)('maps %s to its detailed wrapper message', (mode, installHint) => {
    const message = cliNotFoundMessage(mode);
    expect(message.split('\n')[0]).toBe(installHint);
    expect(message).toContain('\nServer PATH: ');
    expect(message).toContain('\nLogin shell: ');
    expect(message).toContain('\nChecked directories: ');
  });

  it('rejects shell mode explicitly', () => {
    expect(() => cliNotFoundMessage('shell')).toThrow('No external CLI error exists for shell mode');
  });
});

/**
 * COD-416 wave 3b — `appendResumeFlag` now reads `launch.resumeAppend` instead of a nine-arm
 * switch. That field was DECLARED-FOR-LATER and read by nothing until this change, so nothing
 * pinned it; the switch it replaces had no direct coverage either.
 *
 * Driven through `buildDockerLaunchCommand`, its only real call site, so the assertion is
 * about a command that actually reaches a container rather than about a private helper.
 */
describe('COD-416 docker resume flag comes from registry data', () => {
  const SID = '11111111-2222-3333-4444-555555555555';
  const RID = 'resume-id-1234';

  function launch(mode: SessionMode): string {
    const docker = {
      hostId: 'h1',
      label: 'local',
      engine: 'docker' as const,
      containerName: 'c1',
      containerWorkdir: '/work',
      image: 'img',
      runsAsRoot: false,
    } as never;
    return buildDockerLaunchCommand({
      mode,
      docker,
      sessionId: SID,
      resumeSessionId: RID,
      createContext: {
        docker,
        sessionId: SID,
        instance: 'default',
        userArgs: [],
        credentialMounts: [],
        extraMounts: [],
        envCreate: {},
        addHostGateway: false,
        gatewayAlias: 'host.docker.internal',
      },
      execEnv: {},
      execEnvNames: [],
      seedCopies: [],
    } as never);
  }

  // Exactly the pairs the removed switch hardcoded, mode by mode.
  it.each([
    ['gemini', `--resume ${RID}`],
    ['codex', `resume ${RID}`],
    ['antigravity', `--conversation ${RID}`],
    ['pi', `--session ${RID}`],
    ['grok', `--resume ${RID}`],
    ['deepseek', `--resume ${RID}`],
    ['omp', `--resume ${RID}`],
  ] as const)('appends %s resume as "%s"', (mode, expected) => {
    expect(launch(mode as SessionMode)).toContain(expected);
  });

  // The old `default:` arm. `shell` declares no `resumeAppend`, and inventing one would put a
  // flag onto a live pane command that no shell accepts.
  it('appends nothing for shell, which declares no resumeAppend', () => {
    expect(launch('shell' as SessionMode)).not.toContain(RID);
  });

  /**
   * ⚠️ opencode and claude also declare no `resumeAppend`, and they still resume — because they
   * never reach this helper. `buildDockerLaunchCommand` handles both in DEDICATED branches
   * ABOVE it: claude via `claudeDockerPaneCommand` (its `--session-id … || resume` form) and
   * opencode via `buildOpenCodeCommand({ continueSession })`, which refuses outright when a
   * custom command override is present rather than silently starting a fresh conversation.
   *
   * Pinned because the absent `resumeAppend` reads like "cannot resume" and is not: the first
   * version of this test asserted opencode appended nothing and failed against a command that
   * correctly carried `--session`.
   */
  it('resumes opencode through its dedicated branch, not the generic append', () => {
    const cmd = launch('opencode' as SessionMode);
    expect(cmd).toContain(`opencode --session ${RID}`);
  });
});

/**
 * COD-416 wave 3c — two more registry conversions in the pane-launch path, neither of which
 * had direct coverage before. Both were verified against a captured golden of the OLD
 * implementation across every mode before the swap; these tests are the durable form of that.
 */
describe('COD-416 pane env + PATH come from registry data', () => {
  type Internals = {
    buildEnvExports(sid: string, mux: string, mode: SessionMode, tc?: boolean, hr?: string): string[];
    buildPathExport(mode: SessionMode): { pathExport: string; dir: string | null };
  };
  const tm = () => new TmuxManager() as unknown as Internals;
  const envFor = (mode: SessionMode, truecolor?: boolean) => tm().buildEnvExports('SID', 'MUX', mode, truecolor);

  /**
   * ⚠️ The trap this pins. Upstream's opencode entry UNSETS COLORTERM; this tree has always
   * EXPORTED truecolor for it, because opencode's Bubble Tea TUI negotiates its palette
   * against xterm's 24-bit renderer. Adopting upstream's data wholesale would have regressed
   * opencode's colours — invisible to every test, visible only on screen. The registry entry
   * was corrected to match the behaviour rather than the behaviour bent to match the data.
   */
  it.each(['opencode', 'codex', 'gemini', 'antigravity', 'pi', 'grok', 'deepseek', 'omp'] as const)(
    'always exports truecolor for %s, even with the user setting off',
    (mode) => {
      expect(envFor(mode as SessionMode, false)).toContain('export COLORTERM=truecolor');
    }
  );

  // Claude is the one agent CLI that does NOT get truecolor by default — an empirical
  // rendering choice — and COD-75's per-user setting is what opts it back in. Both halves of
  // that union are load-bearing, so both directions are pinned.
  it('unsets COLORTERM for claude by default and honours the COD-75 opt-in', () => {
    expect(envFor('claude' as SessionMode, false)).toContain('unset COLORTERM');
    expect(envFor('claude' as SessionMode, true)).toContain('export COLORTERM=truecolor');
  });

  // `unset NO_COLOR` covers every external CLI EXCEPT opencode — a real asymmetry in the
  // original chain, preserved because it is behaviour, not an oversight to tidy up.
  it('unsets NO_COLOR for the CLIs that declare it, and not for opencode or claude', () => {
    for (const m of ['codex', 'gemini', 'antigravity', 'pi', 'grok', 'deepseek', 'omp'] as const) {
      expect(envFor(m as SessionMode), `${m}`).toContain('unset NO_COLOR');
    }
    expect(envFor('opencode' as SessionMode)).not.toContain('unset NO_COLOR');
    expect(envFor('claude' as SessionMode)).not.toContain('unset NO_COLOR');
  });

  // Ordering is part of the pane command: `unset CLAUDECODE` sits BEFORE the COLORTERM line.
  it('places unset CLAUDECODE before the COLORTERM line, for claude only', () => {
    const claude = envFor('claude' as SessionMode);
    expect(claude.indexOf('unset CLAUDECODE')).toBe(2);
    expect(claude.indexOf('unset CLAUDECODE')).toBeLessThan(claude.indexOf('unset COLORTERM'));
    expect(envFor('codex' as SessionMode)).not.toContain('unset CLAUDECODE');
  });

  // The codex originator stamp is an `env.exports` entry with an ENGINE value, so the old
  // `mode === 'codex'` test became "which entry asks for this".
  it('stamps the codex originator from its declared engine-valued export', () => {
    expect(envFor('codex' as SessionMode)).toContain('export CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codeman_SID');
    expect(envFor('gemini' as SessionMode).join('\n')).not.toContain('ORIGINATOR');
  });

  // `shell` resolves no CLI directory — the old nine-arm fallthrough.
  it('emits no PATH export for shell', () => {
    expect(tm().buildPathExport('shell' as SessionMode)).toEqual({ pathExport: '', dir: null });
  });

  /**
   * ⚠️ Every arm now SHELL-ESCAPES the directory. Six already did; grok/deepseek/omp
   * hand-built `export PATH="<dir>:$PATH"` with the path unescaped inside double quotes.
   * Identical PATH for an ordinary directory, broken and injectable for one containing a
   * quote or `$` — so this pins the safe form the majority already used.
   */
  it('shell-escapes the resolved binary directory when one is found', () => {
    for (const m of ['claude', 'codex', 'opencode', 'gemini', 'antigravity'] as const) {
      const { pathExport, dir } = tm().buildPathExport(m as SessionMode);
      if (dir === null) continue; // not installed on this machine — nothing to assert
      expect(pathExport, `${m}`).toBe(`export PATH='${dir}':"$PATH" && `);
    }
  });
});

/**
 * COD-416 wave 3d — the four per-CLI `_configure<Cli>` methods became one registry-driven
 * `_configureCliEnv`, and the DECISION half was extracted into the pure `planCliEnvSetenv`.
 *
 * The helpers this replaces were async side-effect loops, so nothing could assert which vars
 * they would set for which CLI — the key lists were only verifiable by reading them. These
 * are the first tests of that behaviour.
 */
describe('COD-416 planCliEnvSetenv — per-CLI tmux setenv from registry data', () => {
  const entryFor = (id: string) => {
    const e = getCli(id);
    if (!e) throw new Error(`no registry entry for ${id}`);
    return e;
  };
  const keys = (id: string, cfg?: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) =>
    planCliEnvSetenv(entryFor(id), cfg, env).map((p) => p.key);

  /**
   * ⚠️ The trap this pins. Upstream's opencode entry omits OPENROUTER_API_KEY; this tree has
   * always forwarded it. Adopting the registry list wholesale would have silently stopped the
   * key reaching opencode panes — OpenRouter auth would just fail, with nothing to point at.
   * The DATA was corrected to match the behaviour, exactly as with opencode's COLORTERM.
   */
  it('forwards every server-env key the CLI declares, opencode OPENROUTER included', () => {
    const env = {
      ANTHROPIC_API_KEY: 'a',
      OPENAI_API_KEY: 'o',
      GOOGLE_API_KEY: 'g',
      OPENROUTER_API_KEY: 'r',
    };
    expect(keys('opencode', undefined, env)).toEqual([
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GOOGLE_API_KEY',
      'OPENROUTER_API_KEY',
    ]);
    expect(keys('codex', undefined, { OPENAI_API_KEY: 'o', CODEX_HOME: '/h' })).toEqual([
      'OPENAI_API_KEY',
      'CODEX_HOME',
    ]);
    expect(keys('gemini', undefined, { GEMINI_API_KEY: 'k', GOOGLE_CLOUD_PROJECT: 'p' })).toEqual([
      'GEMINI_API_KEY',
      'GOOGLE_CLOUD_PROJECT',
    ]);
  });

  // Absent server vars are skipped rather than exported empty — an empty API key is worse
  // than none, since it looks configured and fails at the provider.
  it('skips a declared key the server does not have', () => {
    expect(keys('codex', undefined, {})).toEqual([]);
  });

  // claude and shell declare none: claude authenticates from its own config dir.
  it.each(['claude', 'shell'] as const)('sets nothing for %s', (id) => {
    expect(keys(id, undefined, { OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a' })).toEqual([]);
  });

  /**
   * `configSetenv` values come from the CALLER, and for dsh the value IS a permission level,
   * so the planner re-validates against the declared enum. An invalid one is DROPPED, not
   * defaulted — the var goes unset and dsh falls back to its own `workspace-write` (which
   * asks) rather than to something we guessed.
   */
  it('accepts a valid deepseek permission mode and drops an invalid one', () => {
    const ok = planCliEnvSetenv(entryFor('deepseek'), { permissionMode: 'danger-full-access' }, {});
    expect(ok).toEqual([{ key: 'DSH_PERMISSION_MODE', value: 'danger-full-access' }]);
    expect(planCliEnvSetenv(entryFor('deepseek'), { permissionMode: 'root' }, {})).toEqual([]);
    // Absent = the harness's own default, which is the shape the multi-user clamp relies on.
    expect(planCliEnvSetenv(entryFor('deepseek'), {}, {})).toEqual([]);
  });

  // opencode's config blob: autoAllowTools layers a blanket allow OVER caller JSON.
  it('builds opencode config content, with autoAllowTools winning over caller permission', () => {
    const [pair] = planCliEnvSetenv(entryFor('opencode'), { autoAllowTools: true, configContent: '{"model":"m"}' }, {});
    expect(pair.key).toBe('OPENCODE_CONFIG_CONTENT');
    expect(JSON.parse(pair.value)).toEqual({ permission: { '*': 'allow' }, model: 'm' });
  });

  // Invalid caller JSON is refused rather than passed through to the CLI as config.
  it('refuses invalid opencode config JSON', () => {
    expect(planCliEnvSetenv(entryFor('opencode'), { configContent: '{oops' }, {})).toEqual([]);
  });
});

describe('derivePaneExits', () => {
  const NOW = 1_700_000_000_000;

  it('reports a single dead pane with its exit status', () => {
    const exits = derivePaneExits(parsePaneRows('codeman-aaaa|1234|1|0|'), NOW);
    expect(exits.get('codeman-aaaa')).toEqual({ panePid: 1234, exit: { status: 0, at: NOW } });
  });

  it('reports a signalled death without inventing a status', () => {
    // Folding an absent status into 0 would turn an unexplained death into the
    // clean exit part 2 closes on sight.
    const exits = derivePaneExits(parsePaneRows('codeman-aaaa|1234|1||9'), NOW);
    expect(exits.get('codeman-aaaa')).toEqual({ panePid: 1234, exit: { signal: 9, at: NOW } });
  });

  it('reports a death tmux could not explain at all', () => {
    // Measured on tmux 3.2a: a SIGKILLed pane reports pane_dead=1 and nothing else.
    const exits = derivePaneExits(parsePaneRows('codeman-aaaa|1234|1||'), NOW);
    expect(exits.get('codeman-aaaa')).toEqual({ panePid: 1234, exit: { at: NOW } });
  });

  it('says nothing about a live pane', () => {
    const exits = derivePaneExits(parsePaneRows('codeman-aaaa|1234|0|||'), NOW);
    expect(exits.has('codeman-aaaa')).toBe(false);
  });

  it('says nothing about a pane whose deadness tmux did not report', () => {
    expect(derivePaneExits(parsePaneRows('codeman-aaaa|1234'), NOW).size).toBe(0);
  });

  it('says nothing about a session with more than one pane, even when all are dead', () => {
    // A session the user split by hand has no single "the agent" to report on,
    // and guessing which pane speaks for it could call a live session exited.
    const exits = derivePaneExits(parsePaneRows('codeman-aaaa|100|1|0|\ncodeman-aaaa|200|1|0|'), NOW);
    expect(exits.size).toBe(0);
  });

  it("answers per session, so one session's split does not silence another", () => {
    const exits = derivePaneExits(
      parsePaneRows('codeman-aaaa|100|1|0|\ncodeman-bbbb|200|1|0|\ncodeman-bbbb|201|0|||'),
      NOW
    );
    expect([...exits.keys()]).toEqual(['codeman-aaaa']);
  });
});

describe('TmuxManager pane-exit bookkeeping', () => {
  const NOW = 1_700_000_000_000;

  it('reports nothing before any tick has run', () => {
    const manager = new TmuxManager();
    expect(manager.getPaneExit('codeman-aaaa')).toBeUndefined();
  });

  it('keeps the timestamp of the FIRST tick that saw an unchanged exit', () => {
    // The stamp says when the agent was found gone, so a pane that stays dead
    // must not have its age reset every two seconds.
    const manager = new TmuxManager();
    manager.applyPaneExits(derivePaneExits(parsePaneRows('codeman-aaaa|100|1|0|'), NOW));
    manager.applyPaneExits(derivePaneExits(parsePaneRows('codeman-aaaa|100|1|0|'), NOW + 2000));
    expect(manager.getPaneExit('codeman-aaaa')).toEqual({ status: 0, at: NOW });
  });

  it('starts a new observation when the exit status changes', () => {
    const manager = new TmuxManager();
    manager.applyPaneExits(derivePaneExits(parsePaneRows('codeman-aaaa|100|1|0|'), NOW));
    manager.applyPaneExits(derivePaneExits(parsePaneRows('codeman-aaaa|100|1|137|'), NOW + 2000));
    expect(manager.getPaneExit('codeman-aaaa')).toEqual({ status: 137, at: NOW + 2000 });
  });

  it('forgets the exit once the same session reports a live pane', () => {
    const manager = new TmuxManager();
    manager.applyPaneExits(derivePaneExits(parsePaneRows('codeman-aaaa|100|1|0|'), NOW));
    manager.applyPaneExits(derivePaneExits(parsePaneRows('codeman-aaaa|101|0|||'), NOW + 2000));
    expect(manager.getPaneExit('codeman-aaaa')).toBeUndefined();
  });

  it('prunes an exit for a session an authoritative read did not mention', () => {
    // `list-panes -a` lists every pane on the socket, so a session missing from
    // a successful read has no pane at all and no exit to report. Keeping the
    // entry would grow the map forever as tmux sessions come and go outside
    // killSession(). A FAILED or empty read never reaches here — refreshPaneExits
    // returns before calling this, which is the case the next test covers.
    const manager = new TmuxManager();
    manager.applyPaneExits(derivePaneExits(parsePaneRows('codeman-aaaa|100|1|0|'), NOW));
    manager.applyPaneExits(derivePaneExits(parsePaneRows('codeman-bbbb|200|1|0|'), NOW));
    expect(manager.getPaneExit('codeman-aaaa')).toBeUndefined();
    expect(manager.getPaneExit('codeman-bbbb')).toEqual({ status: 0, at: NOW });
  });

  it('starts a new observation when the same status comes from a different pane pid', () => {
    // A second command in the same pane that also exited 0 is a NEW death, and
    // its `at` must say so. Only reachable when the respawn bypassed
    // respawnPane() — a hand-run `tmux respawn-pane` — since every Codeman path
    // clears the entry outright.
    const manager = new TmuxManager();
    manager.applyPaneExits(derivePaneExits(parsePaneRows('codeman-aaaa|100|1|0|'), NOW));
    manager.applyPaneExits(derivePaneExits(parsePaneRows('codeman-aaaa|101|1|0|'), NOW + 60_000));
    expect(manager.getPaneExit('codeman-aaaa')).toEqual({ status: 0, at: NOW + 60_000 });
  });

  it('forgets an exit on request, which is what a respawned pane needs', () => {
    const manager = new TmuxManager();
    manager.applyPaneExits(derivePaneExits(parsePaneRows('codeman-aaaa|100|1|0|'), NOW));
    manager.clearPaneExit('codeman-aaaa');
    expect(manager.getPaneExit('codeman-aaaa')).toBeUndefined();
    expect(manager.getPaneExitReadCount('codeman-aaaa')).toBe(0);
  });

  // The clean-exit sweep closes a session only once two reads agreed on its
  // exit (Ark0N/Codeman#446), so the count must rise only on an exact repeat.
  it('counts the reads that agreed on one exit', () => {
    const manager = new TmuxManager();
    expect(manager.getPaneExitReadCount('codeman-aaaa')).toBe(0);
    manager.applyPaneExits(derivePaneExits(parsePaneRows('codeman-aaaa|100|1|0|'), NOW));
    expect(manager.getPaneExitReadCount('codeman-aaaa')).toBe(1);
    manager.applyPaneExits(derivePaneExits(parsePaneRows('codeman-aaaa|100|1|0|'), NOW + 2000));
    expect(manager.getPaneExitReadCount('codeman-aaaa')).toBe(2);
  });

  it('starts the count again when the status or the pane pid changes', () => {
    const manager = new TmuxManager();
    manager.applyPaneExits(derivePaneExits(parsePaneRows('codeman-aaaa|100|1|0|'), NOW));
    manager.applyPaneExits(derivePaneExits(parsePaneRows('codeman-aaaa|100|1|0|'), NOW + 2000));
    manager.applyPaneExits(derivePaneExits(parsePaneRows('codeman-aaaa|100|1|1|'), NOW + 4000));
    expect(manager.getPaneExitReadCount('codeman-aaaa')).toBe(1);
    manager.applyPaneExits(derivePaneExits(parsePaneRows('codeman-aaaa|101|1|1|'), NOW + 6000));
    expect(manager.getPaneExitReadCount('codeman-aaaa')).toBe(1);
  });

  it('drops the count once a read sees the pane alive again', () => {
    const manager = new TmuxManager();
    manager.applyPaneExits(derivePaneExits(parsePaneRows('codeman-aaaa|100|1|0|'), NOW));
    manager.applyPaneExits(derivePaneExits(parsePaneRows('codeman-aaaa|101|0|||'), NOW + 2000));
    expect(manager.getPaneExitReadCount('codeman-aaaa')).toBe(0);
    manager.applyPaneExits(derivePaneExits(parsePaneRows('codeman-aaaa|101|1|0|'), NOW + 4000));
    expect(manager.getPaneExitReadCount('codeman-aaaa')).toBe(1);
  });
});

describe('the pane-exit watcher tick', () => {
  // Every guard in `refreshPaneExits()` used to be unreachable: the method
  // began with `if (IS_TEST_MODE) return;`, so deleting the generation check,
  // the in-flight suppression, the empty-read rule or the read gate left the
  // whole suite green. The tmux read now sits alone in `readPaneRows()`, which
  // a subclass can answer for.
  const NOW = 1_700_000_000_000;

  class TestManager extends TmuxManager {
    rows: PaneRow[] = [];
    reads = 0;
    /** While true, a read parks until releaseAll(), so a test can hold one in flight. */
    hold = false;
    private pending: (() => void)[] = [];

    protected override async readPaneRows(): Promise<PaneRow[]> {
      this.reads++;
      // Every parked read is tracked, not just the latest: with the in-flight
      // guard removed a second one starts, and a harness that could release
      // only the last would deadlock instead of failing.
      if (this.hold) await new Promise<void>((resolve) => this.pending.push(resolve));
      return this.rows;
    }

    releaseAll(): void {
      this.hold = false;
      for (const resolve of this.pending.splice(0)) resolve();
    }
  }

  const localSession = (sessionId = 's1'): MuxSession =>
    ({
      sessionId,
      muxName: `codeman-${sessionId}`,
      pid: 100,
      createdAt: 0,
      workingDir: '/tmp',
      mode: 'claude',
      attached: true,
    }) as MuxSession;

  const withLocalSession = () => {
    const manager = new TestManager();
    manager.registerSession(localSession());
    return manager;
  };

  it('does not read tmux when no session could answer', async () => {
    const manager = new TestManager();
    await manager.refreshPaneExits(NOW);
    expect(manager.reads).toBe(0);
  });

  it('reads tmux once a local session exists', async () => {
    const manager = withLocalSession();
    manager.rows = parsePaneRows('codeman-s1|100|1|0|');
    await manager.refreshPaneExits(NOW);
    expect(manager.reads).toBe(1);
    expect(manager.getPaneExit('codeman-s1')).toEqual({ status: 0, at: NOW });
  });

  it('suppresses a second read while one is still in flight', async () => {
    // EXEC_TIMEOUT_MS is 5000 against a 2000 ms tick, so a slow read outlives
    // two ticks; without this the older one can resolve last and win.
    const manager = withLocalSession();
    manager.hold = true;
    const first = manager.refreshPaneExits(NOW);
    const second = manager.refreshPaneExits(NOW);
    const reads = manager.reads;
    manager.releaseAll();
    await Promise.all([first, second]);
    expect(reads).toBe(1);
  });

  it('retracts nothing when the read comes back empty', async () => {
    // An empty read is "tmux did not answer". Retracting there would turn a
    // transient failure into a silent denial of a death already observed.
    const manager = withLocalSession();
    manager.rows = parsePaneRows('codeman-s1|100|1|137|');
    await manager.refreshPaneExits(NOW);
    manager.rows = [];
    await manager.refreshPaneExits(NOW + 2000);
    expect(manager.getPaneExit('codeman-s1')).toEqual({ status: 137, at: NOW });
  });

  it('does not count an empty read as confirming an exit', async () => {
    // The clean-exit sweep closes on the second agreeing read. A read tmux did
    // not answer agrees with nothing, so it must not supply that second read.
    const manager = withLocalSession();
    manager.rows = parsePaneRows('codeman-s1|100|1|0|');
    await manager.refreshPaneExits(NOW);
    manager.rows = [];
    await manager.refreshPaneExits(NOW + 2000);
    expect(manager.getPaneExitReadCount('codeman-s1')).toBe(1);
    manager.rows = parsePaneRows('codeman-s1|100|1|0|');
    await manager.refreshPaneExits(NOW + 4000);
    expect(manager.getPaneExitReadCount('codeman-s1')).toBe(2);
  });

  it('discards a read that started before the pane was cleared', async () => {
    // The guard that stops an in-flight read from republishing a death over
    // the pane that has just replaced it.
    const manager = withLocalSession();
    manager.rows = parsePaneRows('codeman-s1|100|1|0|');
    manager.hold = true;
    const pending = manager.refreshPaneExits(NOW);
    manager.clearPaneExit('codeman-s1');
    manager.releaseAll();
    await pending;
    expect(manager.getPaneExit('codeman-s1')).toBeUndefined();
  });

  it('announces each tick so the server can publish it', async () => {
    // Losing this emit, or the server's own startPaneExitWatcher() call,
    // disables the whole feature with nothing failing.
    vi.useFakeTimers();
    try {
      const manager = withLocalSession();
      manager.rows = parsePaneRows('codeman-s1|100|1||9');
      const updates: number[] = [];
      manager.on('paneExitsUpdated', () => updates.push(1));
      manager.startPaneExitWatcher(10);
      await vi.advanceTimersByTimeAsync(25);
      manager.stopPaneExitWatcher();
      expect(updates.length).toBeGreaterThan(0);
      expect(manager.getPaneExit('codeman-s1')).toMatchObject({ signal: 9 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hasObservablePaneSession', () => {
  // The pane-exit watcher is always-on, so a tick with nothing to observe is
  // the normal case on an instance running only remote or Docker work. This
  // predicate is what keeps that tick from exec'ing tmux to find out.
  const base = {
    sessionId: 's1',
    muxName: 'codeman-aaaa',
    pid: 100,
    createdAt: 0,
    workingDir: '/tmp',
    mode: 'claude' as const,
    attached: true,
  };

  it('says no for an empty manager', () => {
    expect(hasObservablePaneSession([])).toBe(false);
  });

  it('says yes for a local session, which is the whole reason the watcher runs', () => {
    expect(hasObservablePaneSession([base])).toBe(true);
  });

  it('says no for a remote session, whose local pane holds the ssh client', () => {
    expect(hasObservablePaneSession([{ ...base, remote: { host: 'box', user: 'me' } }])).toBe(false);
  });

  it('says no for a Docker case, whose local pane holds a `docker exec`', () => {
    expect(hasObservablePaneSession([{ ...base, docker: { containerName: 'c1' } }])).toBe(false);
  });

  it('says no for a record rebuilt from the socket, which carries no provenance', () => {
    // `reconcileSessions()` gives it a synthetic id that matches no state.json
    // entry, so a remote session rediscovered that way looks local. Session
    // forces UNKNOWN for it, so reading tmux for it buys nothing.
    expect(hasObservablePaneSession([{ ...base, discovered: true }])).toBe(false);
  });

  it('says yes when one local session sits among sessions that cannot answer', () => {
    // The read is one batched call for the whole socket, so a single local
    // session is enough to make the tick worth paying for.
    expect(
      hasObservablePaneSession([
        { ...base, sessionId: 's1', remote: { host: 'box', user: 'me' } },
        { ...base, sessionId: 's2', discovered: true },
        { ...base, sessionId: 's3' },
      ])
    ).toBe(true);
  });

  // The predicate has to agree with `Session.paneExitApplies`, which is where
  // the rule is enforced; that pairing is pinned in session-pane-exit.test.ts,
  // where a real Session can answer for itself.
});
