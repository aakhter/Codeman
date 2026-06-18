/**
 * @fileoverview COD-104 — durable remote sessions inside a remote tmux server.
 *
 * Unit tests for `buildRemoteLaunchCommand`: it must emit an attach-or-create
 * (`tmux -L codeman new-session -A -s codeman-<id> …`) against a remote tmux
 * server so the remote agent survives an SSH drop, and reattaches on reconnect.
 *
 * These tests are tmux-safe (pure command-string construction; no real tmux,
 * no server). Port: N/A.
 */

import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { REMOTE_PATH_BOOTSTRAP } from '../src/remote-hosts.js';
import { buildRemoteLaunchCommand } from '../src/tmux-manager.js';
import type { SessionRemote } from '../src/types.js';

const baseRemote: SessionRemote = {
  hostId: 'gpu-box',
  label: 'GPU Box',
  host: '10.0.0.42',
  username: 'ubuntu',
  remotePath: '/home/ubuntu/work',
};

const SESSION_ID = 'abcd1234-5678-90ab-cdef-1234567890ab';
// The remote session name is derived from the same stable field the local
// muxName uses: codeman-${sessionId.slice(0, 8)}.
const EXPECTED_NAME = 'codeman-abcd1234';

describe('COD-104 buildRemoteLaunchCommand — remote tmux attach-or-create', () => {
  it('emits ssh + remote tmux new-session -A on the canonical -L codeman socket', () => {
    const command = buildRemoteLaunchCommand({
      mode: 'shell',
      sessionId: SESSION_ID,
      remote: baseRemote,
    });

    expect(command).toContain('ssh');
    expect(command).toContain('BatchMode=yes');
    expect(command).toContain('-t');
    expect(command).toContain('ubuntu@10.0.0.42');

    // Remote tmux server on the canonical socket, idempotent attach-or-create.
    expect(command).toContain('tmux -L codeman new-session -A');
    expect(command).toContain(`-s ${EXPECTED_NAME}`);
    // Must NOT use the old bash -lc exec form (remote agent was a child of ssh).
    expect(command).not.toContain('bash -lc');
  });

  it('includes the cd && exec remote command and tmux config (status off / prefix C-q)', () => {
    const command = buildRemoteLaunchCommand({
      mode: 'shell',
      sessionId: SESSION_ID,
      remote: baseRemote,
    });

    expect(command).toContain('/home/ubuntu/work');
    expect(command).toContain('exec bash -l');
    expect(command).toContain('set -g status off');
    expect(command).toContain('set -g mouse off');
    expect(command).toContain('set -sg escape-time 0');
    expect(command).toContain('set -g prefix C-q');
  });

  it('honors per-mode command overrides inside the remote tmux session', () => {
    const command = buildRemoteLaunchCommand({
      mode: 'codex',
      sessionId: SESSION_ID,
      remote: { ...baseRemote, commands: { codex: 'exec codx personal' } },
    });

    expect(command).toContain('tmux -L codeman new-session -A');
    expect(command).toContain('exec codx personal');
  });

  it('omits -p when no port is set', () => {
    const command = buildRemoteLaunchCommand({
      mode: 'shell',
      sessionId: SESSION_ID,
      remote: baseRemote,
    });
    expect(command).not.toContain(' -p ');
  });

  it('threads the optional remote port into the ssh invocation', () => {
    const command = buildRemoteLaunchCommand({
      mode: 'shell',
      sessionId: SESSION_ID,
      remote: { ...baseRemote, port: 2222 },
    });
    expect(command).toContain('-p 2222');
    // Port belongs to ssh, not tmux.
    expect(command).toMatch(/ssh[\s\S]*-p 2222[\s\S]*ubuntu@10\.0\.0\.42/);
  });

  it('keeps shell-escaping intact for a remote path containing a space (real round-trip)', () => {
    const spacePath = '/home/ubuntu/my work';
    const command = buildRemoteLaunchCommand({
      mode: 'shell',
      sessionId: SESSION_ID,
      remote: { ...baseRemote, remotePath: spacePath },
    });

    // The riskiest part of COD-104 is the nested quoting: the whole tmux line is
    // a single ssh argument (parsed by the remote login shell), and the pane
    // command is in turn a single tmux argument (parsed by tmux's /bin/sh).
    // Prove it survives by actually parsing it: stub `ssh` to dump each argv
    // entry on its own line, then re-parse the captured tmux arg the same way.
    const dumpArgs = (name: string, prefix: string) =>
      `${name}() { for a in "$@"; do printf '${prefix}:%s\\n' "$a"; done; }`;

    const sshOut = execFileSync('/bin/sh', ['-c', `${dumpArgs('ssh', 'A')}\n${command}`], {
      encoding: 'utf8',
    });
    const sshArgs = sshOut
      .split('\n')
      .filter((l) => l.startsWith('A:'))
      .map((l) => l.slice(2));

    // The remote target and the (single) tmux invocation arrived as distinct args.
    expect(sshArgs).toContain('ubuntu@10.0.0.42');
    const tmuxArg = sshArgs.find((a) => a.includes('new-session'));
    expect(tmuxArg).toBeDefined();

    // Re-parse the captured tmux invocation. tmux's own argv must contain the
    // space path verbatim as the -c value, and the pane command as one argument.
    const tmuxOut = execFileSync('/bin/sh', ['-c', `${dumpArgs('tmux', 'T')}\n${tmuxArg!}`], {
      encoding: 'utf8',
    });
    const tmuxArgs = tmuxOut
      .split('\n')
      .filter((l) => l.startsWith('T:'))
      .map((l) => l.slice(2));

    // -c <path> received the space path unmangled (no word-splitting on the space).
    expect(tmuxArgs).toContain(spacePath);
    // The pane command is a SINGLE tmux argument (no word-splitting), with the
    // path still quoted for the /bin/sh -c that tmux runs it under.
    // The pane command is one tmux argument; the path is still single-quoted for
    // the /bin/sh -c that tmux runs it under, so the deepest `cd` gets the space
    // path intact and `exec bash -l` follows.
    const paneCmd = tmuxArgs.find((a) => a.includes('&& export PATH='));
    expect(paneCmd).toBe(`cd '${spacePath}' && ${REMOTE_PATH_BOOTSTRAP}; exec bash -l`);
  });

  it('derives a deterministic, reattach-stable session name from sessionId', () => {
    const a = buildRemoteLaunchCommand({ mode: 'shell', sessionId: SESSION_ID, remote: baseRemote });
    const b = buildRemoteLaunchCommand({ mode: 'shell', sessionId: SESSION_ID, remote: baseRemote });
    // Same sessionId -> identical command -> reattaches to the same remote session.
    expect(a).toBe(b);
    expect(a).toContain(`-s ${EXPECTED_NAME}`);
  });
});
