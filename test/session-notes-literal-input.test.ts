import { afterEach, expect, it, vi } from 'vitest';
import { TmuxManager } from '../src/tmux-manager.js';
import { Session } from '../src/session.js';
const managers: TmuxManager[] = [];
afterEach(() => managers.splice(0).forEach((manager) => manager.destroy()));
function adapter(execute: (command: string) => Promise<void>) {
  const manager = new TmuxManager({ notesExecutor: execute, notesDelayMs: 0 } as any);
  managers.push(manager);
  manager.registerSession({
    sessionId: 'notes-id',
    muxName: 'codeman-12345678',
    pid: 123,
    createdAt: Date.now(),
    workingDir: '/tmp',
    mode: 'claude',
    attached: false,
  });
  return manager as any;
}
it('preserves line breaks, quotes, spaces and literal shell substitutions inside a bracketed paste, then separate Enter', async () => {
  const commands: string[] = [];
  const manager = adapter(async (command) => {
    commands.push(command);
  });
  const text = "first\r\nsecond\n\nquotes ' $(touch sentinel) `literal`  ";
  expect(await manager.sendNotesInput('notes-id', text)).toBe(true);
  expect(commands).toHaveLength(2);
  expect(commands[0]).toContain('\x1b[200~first\r\nsecond\n\n');
  expect(commands[0]).toContain('  \x1b[201~');
  expect(commands[0]).toContain('-l ');
  expect(commands[1]).toMatch(/ Enter$/);
});
it('does not repeat text or Enter after an ambiguous adapter failure', async () => {
  const execute = vi.fn(async (_command: string) => {
    if (execute.mock.calls.length === 2) throw Error('lost ACK');
  });
  const manager = adapter(execute);
  expect(await manager.sendNotesInput('notes-id', 'notes')).toBe(false);
  expect(execute).toHaveBeenCalledTimes(2);
});
it('Session preserves literal input through mux and retains ordinary fromUser prompt and activity tracking', async () => {
  const session = new Session({ id: 'notes-id', workingDir: '/tmp', mode: 'claude' });
  const access = session as any;
  access._mux = { sendNotesInput: vi.fn(async () => true) };
  access._muxSession = { muxName: 'codeman-12345678' };
  const activity = vi.fn();
  session.on('terminalActivity', activity);
  expect(await access.writeNotesInput('line one\nline two')).toBe(true);
  expect(access._mux.sendNotesInput).toHaveBeenCalledWith('notes-id', 'line one\nline two', expect.any(Function));
  expect(activity).toHaveBeenCalledTimes(1);
  expect(session.lastSubmitAt).toBeGreaterThan(0);
});

it('stops before Enter if eligibility is revoked while the literal paste is in flight', async () => {
  let eligible = true;
  const commands: string[] = [];
  const manager = adapter(async (command) => {
    commands.push(command);
    eligible = false;
  });
  expect(await manager.sendNotesInput('notes-id', 'notes', () => eligible)).toBe(false);
  expect(commands).toHaveLength(1);
});
it('does not mark a notes submission acknowledged when no transport or a failed mux exists', async () => {
  const session = new Session({ id: 'failed-notes-id', workingDir: '/tmp', mode: 'claude' });
  const access = session as any;
  expect(await access.writeNotesInput('notes')).toBe(false);
  access._mux = { sendNotesInput: vi.fn(async () => false) };
  access._muxSession = { muxName: 'codeman-12345678' };
  expect(await access.writeNotesInput('notes')).toBe(false);
  expect(session.terminalActivityEpoch).toBe(0);
  expect(session.lastSubmitAt).toBe(0);
});
