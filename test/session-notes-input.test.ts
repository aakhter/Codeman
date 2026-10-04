import { expect, it, vi } from 'vitest';
import { deliverNotesInput, notesDestination } from '../src/web/notes-input.js';
function setup() {
  const session = {
    owner: 'alice',
    pid: 12,
    status: 'idle',
    usesMux: true,
    muxName: 'pane',
    cancelCheckpoint: vi.fn(),
    writeNotesInput: vi.fn(async () => true),
    write: vi.fn(() => true),
  };
  const sessions = new Map([['live', session]]);
  const mux = { isPaneDead: vi.fn(async () => false) };
  return {
    session,
    sessions,
    mux,
    send: (owner = 'alice') => deliverNotesInput(sessions as any, mux, null, 'live', owner, 'literal\nnotes'),
  };
}
it('requires exact live owner even admin, never writes to inactive or dead workers', async () => {
  const h = setup();
  expect(await h.send('root')).toMatchObject({ delivery: 'failed' });
  h.session.pid = null as any;
  expect(notesDestination(h.session as any, 'alice')).toBe(false);
  expect(await h.send()).toMatchObject({ delivery: 'failed' });
  h.session.pid = 12;
  for (const status of ['stopped', 'error']) {
    h.session.status = status;
    expect(await h.send()).toMatchObject({ delivery: 'failed' });
  }
  h.session.status = 'idle';
  h.mux.isPaneDead.mockResolvedValue(true);
  expect(await h.send()).toMatchObject({ delivery: 'failed' });
  expect(h.session.writeNotesInput).not.toHaveBeenCalled();
  expect(h.session.cancelCheckpoint).not.toHaveBeenCalled();
});
it('rechecks ownership after a delayed probe and submits through ordinary fromUser mux input', async () => {
  const h = setup();
  h.mux.isPaneDead.mockImplementation(async () => {
    h.session.owner = 'bob';
    return false;
  });
  expect(await h.send()).toMatchObject({ delivery: 'failed' });
  expect(h.session.writeNotesInput).not.toHaveBeenCalled();
  h.session.owner = 'alice';
  h.mux.isPaneDead.mockResolvedValue(false);
  expect(await h.send()).toMatchObject({ delivery: 'submitted' });
  expect(h.session.cancelCheckpoint).toHaveBeenCalledWith('manual-takeover');
  expect(h.session.writeNotesInput).toHaveBeenCalledWith('literal\nnotes', expect.any(Function));
});
it('reports ambiguous mux failure without retry or direct-write fallback', async () => {
  const h = setup();
  h.session.writeNotesInput.mockResolvedValue(false);
  expect(await h.send()).toMatchObject({ delivery: 'unknown' });
  expect(h.session.write).not.toHaveBeenCalled();
  expect(h.session.writeNotesInput).toHaveBeenCalledTimes(1);
});
