/**
 * @fileoverview COD-107 — Remote-host SSH: custom port + advanced connection options.
 *
 * Unit tests for the shared, pure `buildSshConnectionArgs(remote)` and its two
 * consumers (`buildRemoteLaunchCommand`, `buildRemoteTmuxCheckCommand`). The
 * acceptance target is the aa-desktop option set (custom port 2222, ed25519
 * identity under `~`, a cloudflared SOCKS5 ProxyCommand, plus an arbitrary
 * `-o` escape-hatch option) — the same connection `~/repos/claude-config/bin/
 * ssh-aa-desktop` makes, WITHOUT shelling out to that wrapper.
 *
 * Critical, easy-to-break invariants pinned here:
 *  - `%h %p` in the ProxyCommand reach ssh LITERALLY (one shellescaped
 *    `-o ProxyCommand=…` token; the local shell must not expand/mangle them).
 *  - a leading `~`/`$HOME` in `identityFile` is expanded to an absolute path at
 *    build time (ssh does NOT expand `~` in `-i`), then shellescaped.
 *  - every connection has a bounded default timeout unless explicitly overridden.
 *
 * Pure command-string construction; no real tmux, no ssh. Port: N/A.
 */

import { homedir } from 'node:os';
import { describe, it, expect } from 'vitest';
import {
  buildSshConnectionArgs,
  buildRemoteTmuxCheckCommand,
  REMOTE_PATH_BOOTSTRAP,
  remoteSshTarget,
} from '../src/remote-hosts.js';
import { buildRemoteLaunchCommand } from '../src/tmux-manager.js';
import type { SessionRemote } from '../src/types.js';

const HOME = homedir();

const baseRemote: SessionRemote = {
  hostId: 'gpu-box',
  label: 'GPU Box',
  host: '10.0.0.42',
  username: 'ubuntu',
  remotePath: '/home/ubuntu/work',
};

// The acceptance host: aa-desktop reached over the cloudflared SOCKS5 proxy.
const aaDesktop: SessionRemote = {
  hostId: 'aa-desktop',
  label: 'aa-desktop',
  host: '192.168.55.170',
  username: 'aakht',
  port: 2222,
  remotePath: '/tmp',
  identityFile: '~/.ssh/remote_ed25519',
  socksProxy: '127.0.0.1:1080',
  extraSshOptions: ['StrictHostKeyChecking=accept-new'],
  commands: { shell: 'exec bash -l' },
};

const SESSION_ID = 'cod107chk';

describe('COD-107 buildSshConnectionArgs — shared ssh connection tokens', () => {
  it('always leads with -o BatchMode=yes', () => {
    expect(buildSshConnectionArgs(baseRemote)).toEqual(['ssh', '-o BatchMode=yes', '-o ConnectTimeout=10']);
  });

  it('emits the full aa-desktop option set in order with escaping + %h %p intact', () => {
    const args = buildSshConnectionArgs(aaDesktop);
    const joined = args.join(' ');

    // -p before -i before the proxy -o; identity ~ expanded absolute, then escaped.
    expect(joined).toContain('-o BatchMode=yes');
    expect(joined).toContain('-p 2222');
    expect(joined).toContain(`-i '${HOME}/.ssh/remote_ed25519'`);
    // No literal tilde survives into the -i token.
    expect(joined).not.toContain('-i ~');
    expect(joined).not.toContain("-i '~");

    // The whole ProxyCommand (with its spaces and %h %p) is ONE shellescaped -o token.
    expect(joined).toContain("-o 'ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p'");
    // %h %p must survive verbatim — they are ssh tokens, not shell tokens.
    expect(joined).toContain('%h %p');

    // The escape-hatch extra option, shellescaped.
    expect(joined).toContain("-o 'StrictHostKeyChecking=accept-new'");

    // Ordering: BatchMode -> timeout -> port -> identity -> ProxyCommand -> extras.
    const idxBatch = joined.indexOf('BatchMode=yes');
    const idxTimeout = joined.indexOf('ConnectTimeout=10');
    const idxPort = joined.indexOf('-p 2222');
    const idxIdentity = joined.indexOf('-i ');
    const idxProxy = joined.indexOf('ProxyCommand=');
    const idxExtra = joined.indexOf('StrictHostKeyChecking');
    expect(idxBatch).toBeLessThan(idxTimeout);
    expect(idxTimeout).toBeLessThan(idxPort);
    expect(idxPort).toBeLessThan(idxIdentity);
    expect(idxIdentity).toBeLessThan(idxProxy);
    expect(idxProxy).toBeLessThan(idxExtra);
  });

  it('supports an explicit -J jump host (shellescaped, like its siblings)', () => {
    const args = buildSshConnectionArgs({ ...baseRemote, jumpHost: 'bastion@10.0.0.1:22' });
    expect(args.join(' ')).toContain("-J 'bastion@10.0.0.1:22'");
  });

  it('shellescapes a -J jump host containing shell metacharacters (no injection)', () => {
    // Defense-in-depth: even if a metachar-laden value slipped past schema validation,
    // it must stay a single shell token and never break out of the ssh command.
    const args = buildSshConnectionArgs({ ...baseRemote, jumpHost: 'x; touch /tmp/pwned' });
    const joined = args.join(' ');
    // The whole value is wrapped in single quotes — the `;` cannot start a new command.
    expect(joined).toContain("-J 'x; touch /tmp/pwned'");
    expect(joined).not.toContain('-J x;');
  });

  it('expands a $HOME-prefixed identity path', () => {
    const args = buildSshConnectionArgs({ ...baseRemote, identityFile: '$HOME/.ssh/id_ed25519' });
    expect(args.join(' ')).toContain(`-i '${HOME}/.ssh/id_ed25519'`);
  });

  it('adds a default timeout and allows an explicit timeout override', () => {
    expect(buildSshConnectionArgs(baseRemote)).toEqual(['ssh', '-o BatchMode=yes', '-o ConnectTimeout=10']);
    expect(buildSshConnectionArgs({ ...baseRemote, port: 2200 })).toEqual([
      'ssh',
      '-o BatchMode=yes',
      '-o ConnectTimeout=10',
      '-p 2200',
    ]);
    expect(buildSshConnectionArgs({ ...baseRemote, extraSshOptions: ['ConnectTimeout=3'] })).toEqual([
      'ssh',
      '-o BatchMode=yes',
      "-o 'ConnectTimeout=3'",
    ]);
  });
});

describe('COD-107 buildRemoteLaunchCommand — threads connection args', () => {
  it('bootstraps common remote binary paths before tmux and the pane command', () => {
    const command = buildRemoteLaunchCommand({
      mode: 'codex',
      remote: { ...baseRemote, commands: { codex: 'exec /Users/me/.local/bin/codx personal' } },
      sessionId: SESSION_ID,
    });

    expect(command).toContain(`${REMOTE_PATH_BOOTSTRAP}; tmux -L codeman`);
    expect(command).toContain(`&& ${REMOTE_PATH_BOOTSTRAP}; exec /Users/me/.local/bin/codx personal`);
  });

  it('emits the aa-desktop ssh connection options ahead of -t and the target', () => {
    const command = buildRemoteLaunchCommand({ mode: 'shell', remote: aaDesktop, sessionId: SESSION_ID });

    expect(command).toContain('-p 2222');
    expect(command).toContain('-o ConnectTimeout=10');
    expect(command).toContain(`-i '${HOME}/.ssh/remote_ed25519'`);
    expect(command).toContain("-o 'ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p'");
    expect(command).toContain("-o 'StrictHostKeyChecking=accept-new'");
    expect(command).toContain('-t');
    expect(command).toContain('aakht@192.168.55.170');
    expect(command).toContain('tmux -L codeman new-session -A');

    // Connection options come BEFORE -t / the target / the tmux command.
    const idxProxy = command.indexOf('ProxyCommand=');
    const idxTarget = command.indexOf('aakht@192.168.55.170');
    expect(idxProxy).toBeLessThan(idxTarget);
  });

  it('builds the exact default remote launch command with the PATH bootstrap', () => {
    const command = buildRemoteLaunchCommand({ mode: 'shell', remote: baseRemote, sessionId: SESSION_ID });
    // Reconstruct the command using the SAME nested POSIX
    // single-quote escaping the production code uses, to prove byte-identity.
    const sh = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
    const remoteName = `codeman-${SESSION_ID.slice(0, 8)}`;
    const path = sh('/home/ubuntu/work');
    const paneCommand = `cd ${path} && ${REMOTE_PATH_BOOTSTRAP}; exec bash -l`;
    const tmuxInvocation = `${REMOTE_PATH_BOOTSTRAP}; ${[
      `tmux -L codeman new-session -A -s ${remoteName} -c ${path} ${sh(paneCommand)}`,
      'set -g status off',
      'set -g mouse off',
      'set -sg escape-time 0',
      'set -g prefix C-q',
      'set -g window-size latest',
    ].join(' \\; ')}`;
    const expected = `ssh -o BatchMode=yes -o ConnectTimeout=10 -t ${remoteSshTarget(baseRemote)} ${sh(tmuxInvocation)}`;
    expect(command).toBe(expected);
  });

  it('back-compat: port-only remote matches the historical -p placement', () => {
    const command = buildRemoteLaunchCommand({
      mode: 'shell',
      remote: { ...baseRemote, port: 2222 },
      sessionId: SESSION_ID,
    });
    expect(command).toMatch(/^ssh -o BatchMode=yes -o ConnectTimeout=10 -p 2222 -t ubuntu@10\.0\.0\.42 /);
  });
});

describe('COD-107 buildRemoteTmuxCheckCommand — same connection options as the launch', () => {
  it('bootstraps common remote binary paths before probing for tmux', () => {
    const cmd = buildRemoteTmuxCheckCommand({ username: 'saqebakhter', host: '192.168.21.109' });
    expect(cmd).toContain(`'${REMOTE_PATH_BOOTSTRAP}; command -v tmux'`);
  });

  it('uses the shared connection args (proxy/identity/port) plus ConnectTimeout', () => {
    const cmd = buildRemoteTmuxCheckCommand(aaDesktop);
    expect(cmd).toContain('-o BatchMode=yes');
    expect(cmd).toContain('-o ConnectTimeout=10');
    expect(cmd).toContain('-p 2222');
    expect(cmd).toContain(`-i '${HOME}/.ssh/remote_ed25519'`);
    expect(cmd).toContain("-o 'ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p'");
    expect(cmd).toContain('aakht@192.168.55.170');
    expect(cmd).toContain(`'${REMOTE_PATH_BOOTSTRAP}; command -v tmux'`);
  });

  it('keeps default ssh options while adding the remote PATH bootstrap', () => {
    expect(buildRemoteTmuxCheckCommand({ username: 'ubuntu', host: '10.0.0.42' })).toBe(
      `ssh -o BatchMode=yes -o ConnectTimeout=10 ubuntu@10.0.0.42 '${REMOTE_PATH_BOOTSTRAP}; command -v tmux'`
    );
    expect(buildRemoteTmuxCheckCommand({ username: 'ubuntu', host: '10.0.0.42', port: 2222 })).toContain('-p 2222');
  });
});
