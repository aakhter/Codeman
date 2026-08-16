/**
 * @fileoverview envOverrides allowlist: exact-key entries alongside the prefixes.
 *
 * CLAUDE_CONFIG_DIR (#255) relocates the Claude CLI's user config (credentials,
 * settings, stats) so a case can run on a separate Claude subscription. It starts
 * with `CLAUDE_`, not `CLAUDE_CODE_`, so the prefix allowlist alone rejects it;
 * ALLOWED_ENV_KEYS in schemas.ts admits it as an exact match. These tests pin:
 * the exact key is accepted, near-misses stay rejected (no accidental prefix
 * widening), blocked keys stay blocked, and the key survives persist filtering
 * (losing it on restart would silently move a session back to the default account).
 */

import { describe, it, expect } from 'vitest';
import { CreateSessionSchema } from '../src/web/schemas.js';
import { Session } from '../src/session.js';

describe('envOverrides exact-key allowlist', () => {
  it('accepts CLAUDE_CONFIG_DIR', () => {
    const parsed = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'claude',
      envOverrides: { CLAUDE_CONFIG_DIR: '/home/user/.claude-clients/acme' },
    });
    expect(parsed.envOverrides).toEqual({ CLAUDE_CONFIG_DIR: '/home/user/.claude-clients/acme' });
  });

  it('accepts CLAUDE_CONFIG_DIR alongside prefix-allowlisted keys', () => {
    const parsed = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'claude',
      envOverrides: {
        CLAUDE_CONFIG_DIR: '/home/user/.claude-clients/acme',
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      },
    });
    expect(Object.keys(parsed.envOverrides ?? {})).toHaveLength(2);
  });

  it('rejects other CLAUDE_-prefixed keys (exact match only, no prefix widening)', () => {
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        envOverrides: { CLAUDE_SOMETHING_ELSE: 'x' },
      })
    ).toThrow();
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        envOverrides: { CLAUDE_CONFIG_DIR_EXTRA: '/tmp/x' },
      })
    ).toThrow();
  });

  it('still blocks security-sensitive keys', () => {
    for (const key of ['PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'CODEMAN_MUX_NAME']) {
      expect(() =>
        CreateSessionSchema.parse({
          workingDir: '/tmp',
          envOverrides: { [key]: 'x' },
        })
      ).toThrow();
    }
  });

  it('keeps OPENAI_API_KEY process-level while allowing CODEX_API_KEY through CODEX_*', () => {
    expect(() =>
      CreateSessionSchema.parse({ workingDir: '/tmp', mode: 'codex', envOverrides: { OPENAI_API_KEY: 'secret' } })
    ).toThrow();
    expect(
      CreateSessionSchema.parse({ workingDir: '/tmp', mode: 'codex', envOverrides: { CODEX_API_KEY: 'secret' } })
        .envOverrides
    ).toEqual({ CODEX_API_KEY: 'secret' });
  });
});

describe('CLAUDE_CONFIG_DIR persistence', () => {
  it('survives the state.json persist filter (path, not a secret)', () => {
    const session = new Session({
      workingDir: '/tmp',
      envOverrides: {
        CLAUDE_CONFIG_DIR: '/home/user/.claude-clients/acme',
        OPENCODE_API_KEY: 'secret-must-not-persist',
      },
    });
    expect(session.getEnvOverridesForPersist()).toEqual({
      CLAUDE_CONFIG_DIR: '/home/user/.claude-clients/acme',
    });
  });
});

describe('Codex provider environment', () => {
  it('returns only exact provider keys as a fresh closed copy', () => {
    const session = new Session({
      workingDir: '/tmp',
      mode: 'codex',
      envOverrides: {
        CODEX_HOME: '/tmp/session-codex-home',
        OPENAI_API_KEY: 'openai-secret',
        CODEX_API_KEY: 'codex-secret',
        CODEX_UNRELATED: 'must-not-leak',
        OPENCODE_API_KEY: 'also-must-not-leak',
      },
    });

    const first = session.getCodexProviderEnvironment();
    expect(first).toEqual({
      CODEX_HOME: '/tmp/session-codex-home',
      OPENAI_API_KEY: 'openai-secret',
      CODEX_API_KEY: 'codex-secret',
    });
    first.CODEX_HOME = '/tmp/mutated';
    expect(session.getCodexProviderEnvironment()).toEqual({
      CODEX_HOME: '/tmp/session-codex-home',
      OPENAI_API_KEY: 'openai-secret',
      CODEX_API_KEY: 'codex-secret',
    });
  });

  it('does not expose or persist Codex provider identity', () => {
    const session = new Session({
      workingDir: '/tmp',
      mode: 'codex',
      envOverrides: {
        CODEX_HOME: '/tmp/session-codex-home',
        OPENAI_API_KEY: 'openai-secret',
        CODEX_API_KEY: 'codex-secret',
      },
    });

    for (const state of [session.toState(), session.toDetailedState()]) {
      const serialized = JSON.stringify(state);
      expect(serialized).not.toContain('CODEX_HOME');
      expect(serialized).not.toContain('OPENAI_API_KEY');
      expect(serialized).not.toContain('CODEX_API_KEY');
      expect(serialized).not.toContain('session-codex-home');
      expect(serialized).not.toContain('openai-secret');
      expect(serialized).not.toContain('codex-secret');
    }
    expect(session.getEnvOverridesForPersist()).toBeUndefined();
  });

  it('persists only Codex provider provenance and restores lost-credential state', () => {
    const active = new Session({
      workingDir: '/tmp',
      mode: 'codex',
      envOverrides: {
        CODEX_HOME: '/tmp/alternate-codex-home',
        OPENAI_API_KEY: 'openai-secret',
        CODEX_API_KEY: 'codex-secret',
      },
    });
    expect(active.getCodexProviderIdentityForPersist()).toEqual({
      version: 1,
      credentialSource: 'session-key',
      codexHome: '/tmp/alternate-codex-home',
    });
    expect(JSON.stringify(active.getCodexProviderIdentityForPersist())).not.toContain('secret');

    const restored = new Session({
      workingDir: '/tmp',
      mode: 'codex',
      codexProviderIdentity: active.getCodexProviderIdentityForPersist(),
    });
    expect(restored.getCodexProviderEnvironment()).toEqual({ CODEX_HOME: '/tmp/alternate-codex-home' });
    expect(restored.getCodexHomeOverride()).toBe('/tmp/alternate-codex-home');
    expect(restored.hasLostCodexProviderCredentials()).toBe(true);
    expect(restored.getCodexProviderIdentityForPersist()).toEqual({
      version: 1,
      credentialSource: 'session-key',
      codexHome: '/tmp/alternate-codex-home',
    });
    expect(JSON.stringify(restored.toState())).not.toContain('alternate-codex-home');
    expect(JSON.stringify(restored.toDetailedState())).not.toContain('credentialSource');
    expect(JSON.stringify(restored.toDetailedState())).not.toContain('__codexProviderIdentity');

    const homeOnly = new Session({
      workingDir: '/tmp',
      mode: 'codex',
      envOverrides: { CODEX_HOME: '/tmp/process-credential-home' },
    });
    const restoredHomeOnly = new Session({
      workingDir: '/tmp',
      mode: 'codex',
      codexProviderIdentity: homeOnly.getCodexProviderIdentityForPersist(),
    });
    expect(restoredHomeOnly.getCodexProviderEnvironment()).toEqual({ CODEX_HOME: '/tmp/process-credential-home' });
    expect(restoredHomeOnly.hasLostCodexProviderCredentials()).toBe(false);

    const processCredentialSession = new Session({ workingDir: '/tmp', mode: 'codex' });
    expect(processCredentialSession.hasLostCodexProviderCredentials()).toBe(false);
    expect(processCredentialSession.getCodexProviderIdentityForPersist()).toEqual({
      version: 1,
      credentialSource: 'restorable',
    });
  });

  it('fails closed only for restored Codex sessions whose provider provenance is unavailable', () => {
    const explicitRestorable = new Session({
      workingDir: '/tmp',
      mode: 'codex',
      codexProviderIdentity: { version: 1, credentialSource: 'restorable', codexHome: '/tmp/auth-file-home' },
    });
    expect(explicitRestorable.getCodexProviderEnvironment()).toEqual({ CODEX_HOME: '/tmp/auth-file-home' });
    expect(explicitRestorable.hasLostCodexProviderCredentials()).toBe(false);

    const unavailable = new Session({ workingDir: '/tmp', mode: 'codex', codexProviderIdentity: null });
    expect(unavailable.hasLostCodexProviderCredentials()).toBe(true);
    expect(unavailable.getCodexProviderIdentityForPersist()).toEqual({
      version: 1,
      credentialSource: 'session-key',
    });

    const unaffectedClaude = new Session({ workingDir: '/tmp', mode: 'claude', codexProviderIdentity: null });
    expect(unaffectedClaude.hasLostCodexProviderCredentials()).toBe(false);
    expect(unaffectedClaude.getCodexProviderIdentityForPersist()).toBeUndefined();
  });
});
