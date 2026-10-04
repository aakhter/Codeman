import { afterEach, expect, it, vi } from 'vitest';
import { TmuxManager } from '../src/tmux-manager.js';
import { Session } from '../src/session.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const managers: TmuxManager[] = [];
afterEach(() => managers.splice(0).forEach((manager) => manager.destroy()));
function adapter(execute: (file: string, args: string[]) => Promise<void>) {
  const manager = new TmuxManager({ notesExecutor: execute, notesDelayMs: 0 });
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
  return manager;
}
it('preserves line breaks, quotes, spaces and literal shell substitutions inside a bracketed paste, then separate Enter', async () => {
  const commands: string[][] = [];
  const manager = adapter(async (file, args) => {
    expect(file).toBe('tmux');
    commands.push(args);
  });
  const text = "first\r\nsecond\n\nquotes ' $(touch sentinel) `literal`  ";
  expect(await manager.sendNotesInput('notes-id', text)).toBe(true);
  expect(commands).toHaveLength(2);
  expect(commands[0]).toEqual([
    '-L',
    manager.muxSocket,
    'send-keys',
    '-t',
    'codeman-12345678',
    '-l',
    '\x1b[200~' + text + '\x1b[201~',
  ]);
  expect(commands[1]).toEqual(['-L', manager.muxSocket, 'send-keys', '-t', 'codeman-12345678', 'Enter']);
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
  const commands: string[][] = [];
  const manager = adapter(async (file, args) => {
    expect(file).toBe('tmux');
    commands.push(args);
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

it('delivers the accepted quote boundary through a real harmless process without shell argument expansion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notes-argv-'));
  const capturedPath = join(root, 'args.json');
  const calls: string[][] = [];
  const texts = ["'".repeat(65535), '😀'.repeat(16383) + 'abc', "quotes ' $(literal) `literal`\r\nnext\n\n  "];
  const execute = async (file: string, args: string[]) => {
    expect(file).toBe('tmux');
    await promisify(execFile)(process.execPath, [
      '-e',
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))",
      '--',
      capturedPath,
      ...args,
    ]);
    calls.push(JSON.parse(await readFile(capturedPath, 'utf8')));
  };
  const manager = adapter(execute);
  try {
    for (const text of texts) {
      calls.length = 0;
      expect(await manager.sendNotesInput('notes-id', text)).toBe(true);
      expect(calls).toEqual([
        ['-L', manager.muxSocket, 'send-keys', '-t', 'codeman-12345678', '-l', '\x1b[200~' + text + '\x1b[201~'],
        ['-L', manager.muxSocket, 'send-keys', '-t', 'codeman-12345678', 'Enter'],
      ]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
