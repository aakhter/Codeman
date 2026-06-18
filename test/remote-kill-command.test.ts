import { describe, it, expect } from 'vitest';
import { buildRemoteKillCommand } from '../src/tmux-manager.js';
import { REMOTE_PATH_BOOTSTRAP } from '../src/remote-hosts.js';
import type { SessionRemote } from '../src/types.js';

// COD-109 — kill an OWNED remote tmux session by propagating `kill-session` to the
// remote `-L codeman` socket. Pure command-builder; the killSession integration is
// exercised against the real remote.
describe('COD-109 buildRemoteKillCommand', () => {
  const base: SessionRemote = {
    hostId: 'h',
    label: 'aa',
    host: '192.168.55.170',
    username: 'aakht',
    remotePath: '/tmp',
  };

  it('emits a remote kill-session against the codeman socket (no -t — non-interactive)', () => {
    const cmd = buildRemoteKillCommand(base, 'codeman-abc12345');
    expect(cmd).toContain(
      `aakht@192.168.55.170 '${REMOTE_PATH_BOOTSTRAP}; tmux -L codeman kill-session -t '\\''codeman-abc12345'\\'''`
    );
    expect(cmd.startsWith('ssh -o BatchMode=yes ')).toBe(true);
    // kill-session needs no PTY — must NOT request the ssh `-t` flag (attach uses
    // `ssh -o BatchMode=yes -t …`; kill must not). The ` -t ` inside the quoted
    // `kill-session -t <name>` is the tmux target flag, which is expected.
    expect(cmd).not.toContain('-o BatchMode=yes -t');
  });

  it('reuses the COD-107 connection options (port / identity / SOCKS proxy)', () => {
    const cmd = buildRemoteKillCommand(
      { ...base, port: 2222, identityFile: '~/.ssh/remote_ed25519', socksProxy: '127.0.0.1:1080' },
      'codeman-abc12345'
    );
    expect(cmd).toContain('-p 2222');
    expect(cmd).toMatch(/-i '.*\/\.ssh\/remote_ed25519'/);
    expect(cmd).toContain("-o 'ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p'");
  });

  it('shell-escapes the session name so metachars stay one token', () => {
    const cmd = buildRemoteKillCommand(base, "codeman-x'; rm -rf /");
    expect(cmd).not.toMatch(/rm -rf \/\s*$/); // not a bare trailing command
    expect(cmd).toContain('kill-session -t');
  });
});
