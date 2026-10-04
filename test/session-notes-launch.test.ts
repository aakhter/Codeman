import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';

describe('trusted notes launch snapshot', () => {
  it('persists a chosen launch case separately from live cwd and restores it', () => {
    const info = { name: 'Repo', path: '/repo', hasClaudeMd: false };
    const session = new Session({ workingDir: '/repo/sub', useMux: false });
    session.setNotesLaunchCase(info);
    expect(session.toState().notesLaunchCase).toEqual(info);
    const restored = new Session({
      workingDir: '/repo/sub',
      useMux: false,
      notesLaunchCase: session.toState().notesLaunchCase,
    });
    expect(restored.toState().notesLaunchCase).toEqual(info);
  });
});
