import { describe, expect, it } from 'vitest';
import { buildRemoteRecoveryProbeCommand } from '../src/remote-hosts.js';

const host = { id: 'remote-1', label: 'Remote', username: 'alice', host: 'example.test', port: 2222 };

describe('remote recovery probe', () => {
  it('uses the owned remote socket and canonical owned session name without creating a pane', () => {
    const command = buildRemoteRecoveryProbeCommand(host, { owned: true, sessionId: 'abc123' });
    expect(command).toContain('ssh -o BatchMode=yes -o ConnectTimeout=10 -p 2222 alice@example.test');
    expect(command).toContain('tmux -L codeman-remote has-session -t');
    expect(command).toContain('codeman-ssh-abc123');
    expect(command).not.toContain('new-session');
  });

  it('uses the discovery socket and exact discovered session name for an unowned target', () => {
    const command = buildRemoteRecoveryProbeCommand(host, {
      owned: false,
      sessionId: 'local-id',
      remoteSessionName: 'codeman-discovered',
    });
    expect(command).toContain('tmux -L codeman has-session -t');
    expect(command).toContain('codeman-discovered');
    expect(command).not.toContain('new-session');
  });

  it('keeps an owned reboot-reconnect source on the private socket even when its name is explicit', () => {
    const command = buildRemoteRecoveryProbeCommand(host, {
      owned: true,
      sessionId: 'local-id',
      remoteSessionName: 'codeman-ssh-source1',
    });

    expect(command).toContain('tmux -L codeman-remote has-session -t');
    expect(command).toContain('codeman-ssh-source1');
    expect(command).not.toContain('new-session');
  });
});
