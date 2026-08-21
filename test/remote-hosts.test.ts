import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRemoteSshAccessCheckCommand,
  buildRemoteListDirectoriesCommand,
  buildRemoteTmuxCheckCommand,
  defaultRemoteCommandForMode,
  parseRemoteDirectoryList,
  readRemoteCases,
  readRemoteHosts,
  REMOTE_PATH_BOOTSTRAP,
  REMOTE_LOGIN_SHELL_RESOLVE,
  remoteDisplayPath,
  remoteSshTarget,
  writeRemoteCases,
  writeRemoteHosts,
} from '../src/remote-hosts.js';
import { StateStore } from '../src/state-store.js';
import { migrateLegacyRemoteCaseCodexCommands } from '../src/codex-command-profiles.js';

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

  it("migrates only an owner's legacy raw Codex overrides, preserving other overrides and remaining idempotent", async () => {
    const root = configDir();
    const store = new StateStore(join(root, 'state.json'));
    await writeRemoteCases(root, [
      {
        name: 'alice case',
        type: 'remote',
        owner: 'alice',
        hostId: 'a',
        remotePath: '/a',
        commands: { codex: ' codex --fast ', claude: 'claude' },
      },
      {
        name: 'bob case',
        type: 'remote',
        owner: 'bob',
        hostId: 'b',
        remotePath: '/b',
        commands: { codex: 'codex --fast' },
      },
      { name: 'legacy case', type: 'remote', hostId: 'l', remotePath: '/l', commands: { codex: 'codex legacy' } },
    ]);

    const first = await migrateLegacyRemoteCaseCodexCommands(root, 'alice', store, { allowOwnerlessSingleUser: false });
    expect(first.profiles).toHaveLength(1);
    expect(first.cases.find((item) => item.name === 'alice case')).toMatchObject({
      codexCommandProfileId: first.profiles[0].id,
      commands: { claude: 'claude' },
    });
    expect(first.cases.find((item) => item.name === 'bob case')?.commands?.codex).toBe('codex --fast');
    expect(first.cases.find((item) => item.name === 'legacy case')?.commands?.codex).toBe('codex legacy');
    expect(
      await migrateLegacyRemoteCaseCodexCommands(root, 'alice', store, { allowOwnerlessSingleUser: false })
    ).toEqual(first);
  });

  it('migrates ownerless legacy cases only in single-user mode under the @single library', async () => {
    const root = configDir();
    const store = new StateStore(join(root, 'state.json'));
    await writeRemoteCases(root, [
      { name: 'legacy case', type: 'remote', hostId: 'l', remotePath: '/l', commands: { codex: 'codex legacy' } },
    ]);

    const result = await migrateLegacyRemoteCaseCodexCommands(root, '@single', store, {
      allowOwnerlessSingleUser: true,
    });
    expect(result.profiles).toEqual([expect.objectContaining({ name: expect.any(String), command: 'codex legacy' })]);
    expect(result.cases[0]).toMatchObject({ codexCommandProfileId: result.profiles[0].id });
    expect(result.cases[0].commands?.codex).toBeUndefined();
  });

  it('does not persist a case profile ID when profile durability fails', async () => {
    const root = configDir();
    await writeRemoteCases(root, [
      {
        name: 'alice case',
        type: 'remote',
        owner: 'alice',
        hostId: 'a',
        remotePath: '/a',
        commands: { codex: 'codex' },
      },
    ]);
    const profiles: Record<string, Array<{ id: string; name: string; command: string }>> = {};
    const failingStore = {
      getCodexCommandProfiles: (owner: string) => profiles[owner] ?? [],
      setCodexCommandProfiles: (owner: string, next: Array<{ id: string; name: string; command: string }>) => {
        profiles[owner] = next;
      },
      saveNowAsync: async () => Promise.reject(new Error('state disk full')),
      getConfig: () => ({ stateFilePath: join(root, 'state.json') }),
    };

    await expect(
      migrateLegacyRemoteCaseCodexCommands(root, 'alice', failingStore, { allowOwnerlessSingleUser: false })
    ).rejects.toThrow('state disk full');
    expect((await readRemoteCases(root))[0]).toMatchObject({ commands: { codex: 'codex' } });
    expect((await readRemoteCases(root))[0].codexCommandProfileId).toBeUndefined();
  });

  it('does not reuse an in-memory profile after a failed save without durable acknowledgement', async () => {
    const root = configDir();
    await writeRemoteCases(root, [
      {
        name: 'alice case',
        type: 'remote',
        owner: 'alice',
        hostId: 'a',
        remotePath: '/a',
        commands: { codex: 'codex retry' },
      },
    ]);
    const profiles: Record<string, Array<{ id: string; name: string; command: string }>> = {};
    let saveAttempts = 0;
    const failingStore = {
      getCodexCommandProfiles: (owner: string) => profiles[owner] ?? [],
      setCodexCommandProfiles: (owner: string, next: Array<{ id: string; name: string; command: string }>) => {
        profiles[owner] = next;
      },
      saveNowAsync: async () => {
        saveAttempts++;
        throw new Error('state disk full');
      },
      getConfig: () => ({ stateFilePath: join(root, 'state.json') }),
    };

    await expect(
      migrateLegacyRemoteCaseCodexCommands(root, 'alice', failingStore, { allowOwnerlessSingleUser: false })
    ).rejects.toThrow('state disk full');
    expect(profiles.alice).toHaveLength(1);

    await expect(
      migrateLegacyRemoteCaseCodexCommands(root, 'alice', failingStore, { allowOwnerlessSingleUser: false })
    ).rejects.toThrow('state disk full');
    expect(saveAttempts).toBe(2);
    expect((await readRemoteCases(root))[0]).toMatchObject({ commands: { codex: 'codex retry' } });
    expect((await readRemoteCases(root))[0].codexCommandProfileId).toBeUndefined();
  });

  it('serializes simultaneous first migrations so Alice and Bob both keep their cases and profiles', async () => {
    const root = configDir();
    const store = new StateStore(join(root, 'state.json'));
    await writeRemoteCases(root, [
      {
        name: 'alice case',
        type: 'remote',
        owner: 'alice',
        hostId: 'a',
        remotePath: '/a',
        commands: { codex: 'codex alice' },
      },
      {
        name: 'bob case',
        type: 'remote',
        owner: 'bob',
        hostId: 'b',
        remotePath: '/b',
        commands: { codex: 'codex bob' },
      },
    ]);

    await Promise.all([
      migrateLegacyRemoteCaseCodexCommands(root, 'alice', store, { allowOwnerlessSingleUser: false }),
      migrateLegacyRemoteCaseCodexCommands(root, 'bob', store, { allowOwnerlessSingleUser: false }),
    ]);

    expect(store.getCodexCommandProfiles('alice')).toHaveLength(1);
    expect(store.getCodexCommandProfiles('bob')).toHaveLength(1);
    const cases = await readRemoteCases(root);
    expect(cases).toHaveLength(2);
    expect(cases.every((remoteCase) => remoteCase.codexCommandProfileId !== undefined)).toBe(true);
  });

  it('returns safe mode defaults and remote display values', () => {
    // Login shell is resolved from the passwd entry (getent/dscl), not the tmux
    // server's $SHELL, so a macOS/zsh user gets zsh and ~/.zshrc is sourced (COD-277).
    expect(defaultRemoteCommandForMode('shell')).toBe(`${REMOTE_LOGIN_SHELL_RESOLVE}exec "$login_shell" -i -l`);
    // Routed through an interactive login shell so per-user PATH entries (e.g.
    // ~/.local/bin, ~/.opencode/bin) resolve — a bare `exec codex` sees only
    // sshd's minimal default PATH and fails with "command not found".
    expect(defaultRemoteCommandForMode('codex')).toBe(
      `${REMOTE_LOGIN_SHELL_RESOLVE}exec "$login_shell" -i -l -c 'codex'`
    );
    // Mirrors the local claude default so the remote agent runs non-interactively.
    expect(defaultRemoteCommandForMode('claude')).toBe(
      `${REMOTE_LOGIN_SHELL_RESOLVE}exec "$login_shell" -i -l -c 'claude --dangerously-skip-permissions'`
    );
    // The resolver must consult the passwd entry (getent Linux / dscl macOS), not $SHELL.
    expect(REMOTE_LOGIN_SHELL_RESOLVE).toContain('getent passwd');
    expect(REMOTE_LOGIN_SHELL_RESOLVE).toContain('dscl . -read');
    expect(REMOTE_LOGIN_SHELL_RESOLVE).toContain('"${SHELL:-/bin/sh}"');
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

  describe('remote directory browsing', () => {
    it('builds a shell-safe immediate-directory listing command', () => {
      const cmd = buildRemoteListDirectoriesCommand(
        {
          username: 'ubuntu',
          host: '10.0.0.42',
          port: 2222,
          identityFile: '~/.ssh/remote key',
        },
        "/home/ubuntu/Project's"
      );

      expect(cmd).toContain('ssh -o BatchMode=yes -o ConnectTimeout=10 -p 2222');
      expect(cmd).toContain(`-i '${homedir()}/.ssh/remote key'`);
      expect(cmd).toContain('ubuntu@10.0.0.42');
      expect(cmd).toContain('find ');
      expect(cmd).toContain('-mindepth 1 -maxdepth 1 -type d -print');
      expect(cmd).toContain("'\\''");
    });

    it('parses remote directory output into directory entries', () => {
      expect(parseRemoteDirectoryList('/srv/app\n/srv/.hidden\n/srv/with space\n\n')).toEqual([
        { name: 'app', path: '/srv/app' },
        { name: 'with space', path: '/srv/with space' },
      ]);
    });
  });

  describe('remote SSH access verification', () => {
    it('builds a shell-safe SSH access check command', () => {
      const cmd = buildRemoteSshAccessCheckCommand({
        username: 'ubuntu',
        host: '10.0.0.42',
        port: 2222,
        identityFile: '~/.ssh/remote key',
      });

      expect(cmd).toContain('ssh -o BatchMode=yes -o ConnectTimeout=10 -p 2222');
      expect(cmd).toContain(`-i '${homedir()}/.ssh/remote key'`);
      expect(cmd).toContain('ubuntu@10.0.0.42');
      expect(cmd).toContain('printf codeman-ssh-ok');
    });
  });
});
