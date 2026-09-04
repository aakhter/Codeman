import { describe, expect, it } from 'vitest';

import {
  deriveCodexProfileName,
  findMatchingCodexProfile,
  getCodexProfileUsage,
  resolveCodexCommandSelection,
  resolveCodexRecoveryStrategy,
  resolveLocalCaseCodexCommand,
} from '../src/codex-command-profiles.js';

const profiles = [
  { id: 'personal', name: 'Personal', command: 'exec codx personal' },
  { id: 'work', name: 'Work', command: 'exec codx work' },
];

describe('Codex command profile helpers', () => {
  it('derives a case-insensitive unique name from a command and falls back for unnameable commands', () => {
    expect(deriveCodexProfileName('exec codx personal', [])).toBe('Personal');
    expect(deriveCodexProfileName('exec codx personal', ['PERSONAL'])).toBe('Personal 2');
    expect(deriveCodexProfileName('***', [])).toBe('Imported 1');
    expect(deriveCodexProfileName('***', ['IMPORTED 1'])).toBe('Imported 2');
  });

  it('matches commands exactly after trimming whitespace', () => {
    expect(findMatchingCodexProfile('  exec codx personal  ', profiles)).toEqual(profiles[0]);
    expect(findMatchingCodexProfile('exec codx Personal', profiles)).toBeUndefined();
  });

  it('returns matching case names in deterministic order', () => {
    expect(
      getCodexProfileUsage(
        [
          { name: 'Zulu', type: 'remote', hostId: 'host', remotePath: '/z', codexCommandProfileId: 'personal' },
          { name: 'Alpha', type: 'remote', hostId: 'host', remotePath: '/a', codexCommandProfileId: 'personal' },
          { name: 'Other', type: 'remote', hostId: 'host', remotePath: '/o', codexCommandProfileId: 'work' },
        ],
        'personal'
      )
    ).toEqual(['Alpha', 'Zulu']);
  });

  it('resolves profiles before custom and host commands, failing closed when a selected profile is absent', () => {
    expect(
      resolveCodexCommandSelection(
        { codexCommandProfileId: 'personal', commands: { codex: 'exec custom' } },
        profiles,
        'exec host'
      )
    ).toEqual({ ok: true, command: 'exec codx personal' });
    expect(resolveCodexCommandSelection({ commands: { codex: 'exec custom' } }, profiles, 'exec host')).toEqual({
      ok: true,
      command: 'exec custom',
    });
    expect(
      resolveCodexCommandSelection(
        { codexCommandProfileId: 'recoverable' },
        [
          {
            id: 'recoverable',
            name: 'Recoverable',
            command: 'exec codex-router start',
            resumeCommandTemplate: 'exec resume {{resumeId}}',
          },
        ],
        'exec host'
      )
    ).toEqual({
      ok: true,
      command: 'exec codex-router start',
      resumeCommandTemplate: 'exec resume {{resumeId}}',
    });
    expect(resolveCodexCommandSelection({}, profiles, 'exec host')).toEqual({ ok: true, command: 'exec host' });
    expect(resolveCodexCommandSelection({ codexCommandProfileId: 'missing' }, profiles, 'exec host')).toEqual({
      ok: false,
      error: 'Saved Codex command profile is unavailable',
    });
  });

  it('uses a declared recovery template and refuses to rewrite an opaque custom command', () => {
    expect(
      resolveCodexRecoveryStrategy(
        { command: 'exec codex-router start', resumeCommandTemplate: 'exec codex-router resume {{resumeId}}' },
        'rollout_123'
      )
    ).toEqual({ kind: 'template', command: 'exec codex-router resume rollout_123' });
    expect(resolveCodexRecoveryStrategy({ command: 'exec codex-router start' }, 'rollout_123')).toEqual({
      kind: 'manual_required',
    });
    expect(resolveCodexRecoveryStrategy({}, 'rollout_123')).toEqual({ kind: 'built-in' });
  });

  it('fails closed for an invalid recovery id even with a declared template', () => {
    expect(
      resolveCodexRecoveryStrategy(
        { command: 'exec codex-router start', resumeCommandTemplate: 'exec codex-router resume {{resumeId}}' },
        'rollout id; unsafe'
      )
    ).toEqual({ kind: 'manual_required' });
  });

  it('resolves local case selections including owned profiles and exact custom commands', () => {
    expect(resolveLocalCaseCodexCommand(undefined, profiles)).toEqual({ ok: true, command: undefined });
    expect(resolveLocalCaseCodexCommand({ kind: 'profile', profileId: 'personal' }, profiles)).toEqual({
      ok: true,
      command: 'exec codx personal',
    });
    expect(resolveLocalCaseCodexCommand({ kind: 'custom', command: 'codex --yolo' }, profiles)).toEqual({
      ok: true,
      command: 'codex --yolo',
    });
    expect(resolveLocalCaseCodexCommand({ kind: 'profile', profileId: 'missing' }, profiles)).toEqual({
      ok: false,
      error: 'Saved Codex command profile is unavailable',
    });
  });
});
