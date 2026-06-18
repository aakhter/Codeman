import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRemoteTmuxCheckCommand,
  defaultRemoteCommandForMode,
  readRemoteCases,
  readRemoteHosts,
  REMOTE_PATH_BOOTSTRAP,
  remoteDisplayPath,
  remoteSshTarget,
  writeRemoteCases,
  writeRemoteHosts,
} from '../src/remote-hosts.js';

describe('remote-hosts domain', () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function configDir(): string {
    dir = mkdtempSync(join(tmpdir(), 'codeman-remote-hosts-'));
    return dir;
  }

  it('round-trips remote hosts and remote cases from a config directory', async () => {
    const root = configDir();
    await writeRemoteHosts(root, [
      {
        id: 'gpu-box',
        label: 'GPU Box',
        host: '10.0.0.42',
        username: 'ubuntu',
        commands: { codex: 'exec codx personal' },
      },
    ]);
    await writeRemoteCases(root, [
      { name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' },
    ]);

    await expect(readRemoteHosts(root)).resolves.toEqual([
      {
        id: 'gpu-box',
        label: 'GPU Box',
        host: '10.0.0.42',
        username: 'ubuntu',
        commands: { codex: 'exec codx personal' },
      },
    ]);
    await expect(readRemoteCases(root)).resolves.toEqual([
      { name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' },
    ]);
  });

  it('returns safe mode defaults and remote display values', () => {
    expect(defaultRemoteCommandForMode('shell')).toBe('exec bash -l');
    expect(defaultRemoteCommandForMode('codex')).toBe('exec codex');
    expect(defaultRemoteCommandForMode('claude')).toBe('exec claude');
    expect(remoteSshTarget({ id: 'h1', label: 'H1', host: 'box.local', username: 'aamer' })).toBe('aamer@box.local');
    expect(remoteDisplayPath({ username: 'aamer', host: 'box.local', path: '/opt/work' })).toBe(
      'aamer@box.local:/opt/work'
    );
  });

  describe('COD-104 remote tmux prerequisite check command', () => {
    it('builds an ssh command-v-tmux probe (no port)', () => {
      const cmd = buildRemoteTmuxCheckCommand({ username: 'ubuntu', host: '10.0.0.42' });
      expect(cmd).toBe(
        `ssh -o BatchMode=yes -o ConnectTimeout=10 ubuntu@10.0.0.42 '${REMOTE_PATH_BOOTSTRAP}; command -v tmux'`
      );
      expect(cmd).not.toContain(' -p ');
    });

    it('threads the optional port into the probe', () => {
      const cmd = buildRemoteTmuxCheckCommand({ username: 'ubuntu', host: '10.0.0.42', port: 2222 });
      expect(cmd).toContain('-p 2222');
      expect(cmd).toMatch(/-p 2222 ubuntu@10\.0\.0\.42/);
    });
  });
});
