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
  rehydrateRemoteHostFields,
  remoteDisplayPath,
  remoteSshTarget,
  toSessionRemote,
  writeRemoteCases,
  writeRemoteHosts,
} from '../src/remote-hosts.js';
import { StateStore } from '../src/state-store.js';
import { migrateLegacyRemoteCaseCodexCommands } from '../src/codex-command-profiles.js';
import { RemoteHostSchema } from '../src/web/schemas.js';

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

  it('carries the wake command from host config into the session', () => {
    // The input route reads `session.remote.wakeCommand` — it must survive the host
    // -> session mapping, or wake-on-LAN silently degrades to "no wake command".
    const remote = toSessionRemote(
      {
        id: 'hufflepuff',
        label: 'Hufflepuff',
        host: '192.168.50.137',
        username: 'j',
        wakeCommand: '/home/joe/bin/whuff',
      },
      { name: 'c', type: 'remote', hostId: 'hufflepuff', remotePath: '/home/j/work' }
    );
    expect(remote.wakeCommand).toBe('/home/joe/bin/whuff');
  });

  it('omits the wake command by default (feature off without a config entry)', () => {
    const remote = toSessionRemote(
      { id: 'h', label: 'H', host: '10.0.0.1', username: 'j' },
      { name: 'c', type: 'remote', hostId: 'h', remotePath: '/tmp' }
    );
    expect(remote.wakeCommand).toBeUndefined();
  });

  describe('RemoteHostSchema wakeCommand', () => {
    const host = { id: 'hufflepuff', label: 'Hufflepuff', host: '192.168.50.137', username: 'j' };

    it('accepts an optional absolute executable path', () => {
      expect(RemoteHostSchema.safeParse({ ...host, wakeCommand: '/home/joe/bin/whuff' }).success).toBe(true);
      expect(RemoteHostSchema.safeParse(host).success).toBe(true);
    });

    it('rejects an argument list (spawn runs the path without a shell)', () => {
      // `spawn('/home/joe/bin/whuff --mac 00:11:22')` would fail as a confusing
      // ENOENT at wake time — refuse it at config time instead.
      expect(RemoteHostSchema.safeParse({ ...host, wakeCommand: '/home/joe/bin/whuff --now' }).success).toBe(false);
    });

    it('rejects shell metacharacters as defence in depth', () => {
      expect(RemoteHostSchema.safeParse({ ...host, wakeCommand: '/bin/sh$(id)' }).success).toBe(false);
      expect(RemoteHostSchema.safeParse({ ...host, wakeCommand: '/bin/`id`' }).success).toBe(false);
    });

    it('accepts one or more MAC addresses and rejects anything else', () => {
      expect(RemoteHostSchema.safeParse({ ...host, wakeMac: '04:d9:f5:80:c6:58' }).success).toBe(true);
      expect(RemoteHostSchema.safeParse({ ...host, wakeMac: '04-d9-f5-80-c6-58, 1C:61:B4:20:58:EB' }).success).toBe(
        true
      );
      expect(RemoteHostSchema.safeParse({ ...host, wakeMac: '04:d9:f5:80:c6' }).success).toBe(false);
      expect(RemoteHostSchema.safeParse({ ...host, wakeMac: '04:d9:f5:80:c6:58; rm -rf /' }).success).toBe(false);
    });
  });

  describe('rehydrateRemoteHostFields', () => {
    const persisted = {
      hostId: 'hufflepuff',
      label: 'Hufflepuff',
      host: '192.168.50.137',
      username: 'j',
      remotePath: '/home/j/work',
    };
    const hosts = (wakeCommand?: string) =>
      new Map([
        [
          'hufflepuff',
          {
            id: 'hufflepuff',
            label: 'Hufflepuff',
            host: '192.168.50.137',
            username: 'j',
            ...(wakeCommand ? { wakeCommand } : {}),
          },
        ],
      ]);

    it('adds a wake command that only exists in the host config', () => {
      // The pre-existing-session case: the field was added to remote-hosts.json after
      // this session was persisted, so recovery is the only place it can arrive.
      expect(rehydrateRemoteHostFields(persisted, hosts('/home/joe/bin/whuff'))?.wakeCommand).toBe(
        '/home/joe/bin/whuff'
      );
    });

    it('treats the host config as authoritative (removing it turns the feature off)', () => {
      const remote = { ...persisted, wakeCommand: '/home/joe/bin/whuff' };
      expect(rehydrateRemoteHostFields(remote, hosts())?.wakeCommand).toBeUndefined();
    });

    it('refreshes a MAC that only exists in the host config', () => {
      const withMac = new Map(
        hosts()
          .entries()
          .map(([id, host]) => [id, { ...host, wakeMac: '04:d9:f5:80:c6:58' }] as const)
      );
      expect(rehydrateRemoteHostFields(persisted, withMac)?.wakeMac).toBe('04:d9:f5:80:c6:58');
    });

    it('leaves the block untouched when the host is gone or the session is local', () => {
      expect(rehydrateRemoteHostFields(persisted, new Map())).toBe(persisted);
      expect(rehydrateRemoteHostFields(undefined, hosts('/x'))).toBeUndefined();
    });

    it('keeps the other host-level fields as persisted', () => {
      // Only wakeCommand is refreshed: silently re-pointing an existing pane's ssh
      // options would be a behavior change nobody asked for.
      const remote = { ...persisted, identityFile: '~/.ssh/pinned_key' };
      const rehydrated = rehydrateRemoteHostFields(remote, hosts('/home/joe/bin/whuff'));
      expect(rehydrated?.identityFile).toBe('~/.ssh/pinned_key');
    });
  });
});
