import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  refreshRestoredClaudeHookCapability,
  resolveRestoredCodexProviderIdentity,
  resolveRestoredSessionName,
  resolveRestoredSessionRemote,
} from '../src/web/server.js';
import { generateHooksConfig } from '../src/hooks-config.js';
import { Session } from '../src/session.js';
import type { SessionRemote } from '../src/types.js';

describe('server mux restore remote metadata', () => {
  const muxRemote: SessionRemote = {
    hostId: 'mac-mini',
    label: 'mac-mini',
    host: '192.168.21.109',
    username: 'saqebakhter',
    remotePath: '/Users/saqebakhter/repos/projects/flux-player',
    commands: { codex: 'exec /Users/saqebakhter/.local/bin/codx personal' },
  };

  it('falls back to mux-sessions remote metadata for legacy state rows', () => {
    expect(resolveRestoredSessionRemote(undefined, muxRemote)).toEqual(muxRemote);
  });

  it('prefers state remote metadata when both sources are present', () => {
    const savedRemote: SessionRemote = {
      ...muxRemote,
      host: 'new-host.local',
    };

    expect(resolveRestoredSessionRemote(savedRemote, muxRemote)).toEqual(savedRemote);
  });

  it('fails closed for restored remote Claude fresh-thread identity hooks', async () => {
    await expect(refreshRestoredClaudeHookCapability('claude', '/remote/project', muxRemote)).resolves.toBe(false);
  });

  it('does not fence non-Claude restored sessions', async () => {
    await expect(refreshRestoredClaudeHookCapability('codex', '/remote/project', muxRemote)).resolves.toBe(true);
  });

  it('migrates a local restored Claude case before enabling fresh-thread identity', async () => {
    const workingDir = await mkdtemp(join(tmpdir(), 'codeman-restored-claude-hooks-'));
    const claudeDir = join(workingDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.local.json');
    await mkdir(claudeDir, { recursive: true });
    const hooks = generateHooksConfig().hooks;
    delete hooks.SessionStart;
    await writeFile(settingsPath, JSON.stringify({ hooks }, null, 2));

    await expect(refreshRestoredClaudeHookCapability('claude', workingDir, undefined)).resolves.toBe(true);
    expect(await readFile(settingsPath, 'utf8')).toContain('session_start');
  });

  it('reads only the private Codex provider provenance needed by Session recovery', () => {
    expect(
      resolveRestoredCodexProviderIdentity('codex', {
        __codexProviderIdentity: {
          version: 1,
          credentialSource: 'session-key',
          codexHome: '/tmp/alternate-codex-home',
          OPENAI_API_KEY: 'must-not-be-restored',
        },
      })
    ).toEqual({ version: 1, credentialSource: 'session-key', codexHome: '/tmp/alternate-codex-home' });
    expect(resolveRestoredCodexProviderIdentity('claude', undefined)).toBeUndefined();
  });

  it('distinguishes explicit restorable provenance from missing, legacy, and unknown Codex recovery state', () => {
    const explicit = resolveRestoredCodexProviderIdentity('codex', {
      __codexProviderIdentity: { version: 1, credentialSource: 'restorable', codexHome: '/tmp/auth-file-home' },
    });
    expect(explicit).toEqual({ version: 1, credentialSource: 'restorable', codexHome: '/tmp/auth-file-home' });
    expect(
      new Session({
        workingDir: '/tmp',
        mode: 'codex',
        codexProviderIdentity: explicit,
      }).hasLostCodexProviderCredentials()
    ).toBe(false);

    for (const savedState of [
      undefined,
      {},
      { __codexProviderIdentity: { CODEX_HOME: '/tmp/legacy-home', credentialsLost: false } },
      { __codexProviderIdentity: { version: 2, credentialSource: 'restorable' } },
      { __codexProviderIdentity: { version: 1, credentialSource: 'unknown' } },
    ]) {
      const unavailable = resolveRestoredCodexProviderIdentity('codex', savedState);
      expect(unavailable).toBeNull();
      expect(
        new Session({
          workingDir: '/tmp',
          mode: 'codex',
          codexProviderIdentity: unavailable,
        }).hasLostCodexProviderCredentials()
      ).toBe(true);
    }
  });
});

describe('server mux restore session names', () => {
  it('preserves an explicit saved name', () => {
    expect(resolveRestoredSessionName('home-mon', '', 'codeman-a9d1e821')).toBe('home-mon');
  });

  it('uses a non-empty mux name when state has no saved name', () => {
    expect(resolveRestoredSessionName(undefined, 'custom mux label', 'codeman-a9d1e821')).toBe('custom mux label');
  });

  it('does not turn an unnamed restored session into its mux id', () => {
    expect(resolveRestoredSessionName(undefined, '', 'codeman-a9d1e821')).toBe('');
  });
});
