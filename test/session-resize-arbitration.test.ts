import { describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';

type ResizeableSessionInternals = {
  ptyProcess: { resize: (cols: number, rows: number) => void };
  _ptyCols: number;
  _ptyRows: number;
};

function attachFakePty(session: Session, cols = 160, rows = 48) {
  const resize = vi.fn();
  const internals = session as unknown as ResizeableSessionInternals;
  internals.ptyProcess = { resize };
  internals._ptyCols = cols;
  internals._ptyRows = rows;
  return resize;
}

describe('Session resize arbitration', () => {
  it('ignores mobile resizes that would shrink a wider desktop PTY', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);

    session.resize(48, 28, { viewportType: 'mobile' });

    expect(resize).not.toHaveBeenCalled();
  });

  it('allows desktop resizes to change the shared PTY dimensions', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);

    session.resize(120, 40, { viewportType: 'desktop' });

    expect(resize).toHaveBeenCalledWith(120, 40);
  });
});
