import { describe, it, expect } from 'vitest';
import { resolveRestoredSessionName, resolveRestoredSessionRemote } from '../src/web/server.js';
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
