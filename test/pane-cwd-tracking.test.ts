/**
 * COD-386 — the pane's live cwd, and what it is allowed to change.
 *
 * `workingDir` is fixed at create time and never follows a `cd`, so a relative
 * path an agent prints resolved against the wrong root and the file preview
 * 404'd on a file that was really there. These pin the two halves of the fix
 * that live server-side: parsing tmux's batched answer, and deciding which
 * sessions may carry one.
 */
import { describe, expect, it } from 'vitest';
import { parsePaneCurrentPaths } from '../src/tmux-manager.js';
import { Session } from '../src/session.js';

describe('parsePaneCurrentPaths', () => {
  it('keeps only the active pane of each session', () => {
    const parsed = parsePaneCurrentPaths(
      ['0|codeman-a|/home/u/inactive', '1|codeman-a|/home/u/active', '1|codeman-b|/srv/app'].join('\n')
    );

    expect(parsed.get('codeman-a')).toBe('/home/u/active');
    expect(parsed.get('codeman-b')).toBe('/srv/app');
    expect(parsed.size).toBe(2);
  });

  it('keeps a separator that belongs to the directory name', () => {
    // The path is the LAST field and is taken as the whole remainder, so a
    // directory legitimately containing "|" survives instead of being truncated.
    const parsed = parsePaneCurrentPaths('1|codeman-a|/home/u/weird|dir/sub');

    expect(parsed.get('codeman-a')).toBe('/home/u/weird|dir/sub');
  });

  it('drops rows that are blank, short, or not an absolute path', () => {
    const parsed = parsePaneCurrentPaths(
      ['', '1|codeman-a', 'garbage', '1||/orphan', '1|codeman-b|rel/ative'].join('\n')
    );

    expect(parsed.size).toBe(0);
  });
});

describe('Session.setCwd', () => {
  const make = (extra: Record<string, unknown> = {}) =>
    new Session({
      id: 'sess-1',
      workingDir: '/workspace/project',
      createdAt: Date.now(),
      mode: 'shell',
      ...extra,
    } as never);

  it('records an absolute cwd and reports the change exactly once', () => {
    const session = make();

    expect(session.setCwd('/workspace/other')).toBe(true);
    expect(session.cwd).toBe('/workspace/other');
    expect(session.setCwd('/workspace/other')).toBe(false);
    expect(session.toState().cwd).toBe('/workspace/other');
  });

  it('refuses a relative or missing value rather than storing a base nothing can resolve against', () => {
    const session = make();
    session.setCwd('/workspace/other');

    expect(session.setCwd('relative/path')).toBe(true);
    expect(session.cwd).toBeUndefined();
    expect(session.setCwd(undefined)).toBe(false);
  });

  it('refuses a cwd for a remote session, whose local pane runs the ssh client', () => {
    const session = make({ remote: { host: 'nas02', user: 'aakht' } });

    expect(session.setCwd('/home/aakht')).toBe(false);
    expect(session.cwd).toBeUndefined();
    expect(session.toState().cwd).toBeUndefined();
  });

  it('refuses a cwd for a docker session, whose local pane runs the docker-exec client', () => {
    const session = make({ docker: { containerName: 'codeman-case', image: 'codeman/agent:base' } });

    expect(session.setCwd('/workspace/project')).toBe(false);
    expect(session.cwd).toBeUndefined();
  });
});
