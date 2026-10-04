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

it('rejects a concurrent direct tmux notes send before its paste and releases after the first delivery', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commands: string[][] = [];
  const manager = adapter(async (_file, args) => {
    commands.push(args);
    if (commands.length === 1) await gate;
  });
  const first = manager.sendNotesInput('notes-id', 'first');
  const overlap = manager.sendNotesInput('notes-id', 'overlap').catch((error) => error);
  try {
    expect(await overlap).toMatchObject({ name: 'SessionNotesInputBusyError' });
    expect(commands).toHaveLength(1);
  } finally {
    release();
    await first;
  }
  expect(commands.map((args) => args.at(-1))).toEqual(['\x1b[200~first\x1b[201~', 'Enter']);
  expect(await manager.sendNotesInput('notes-id', 'later')).toBe(true);
});

it('rejects concurrent PTY notes before paste and releases its boundary after acknowledgment', async () => {
  vi.useFakeTimers();
  const session = new Session({ id: 'pty-notes', workingDir: '/tmp', mode: 'claude' });
  const writes: string[] = [];
  (session as any).ptyProcess = { write: (text: string) => writes.push(text) };
  try {
    const first = session.writeNotesInput('first');
    const overlap = session.writeNotesInput('overlap').catch((error) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await overlap).toMatchObject({ name: 'SessionNotesInputBusyError' });
    expect(await first).toBe(true);
    expect(writes).toEqual(['\x1b[200~first\x1b[201~', '\r']);
    const later = session.writeNotesInput('later');
    await vi.advanceTimersByTimeAsync(50);
    expect(await later).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it('reports an overlapping Session delivery as definitely unsent rather than an ambiguous acknowledgment', async () => {
  const { deliverNotesInput } = await import('../src/web/notes-input.js');
  const session = new Session({ id: 'live', owner: 'alice', workingDir: '/tmp', mode: 'claude' });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const access = session as any;
  access._pid = 123;
  let calls = 0;
  access._mux = {
    sendNotesInput: async () => {
      if (++calls === 1) await gate;
      return true;
    },
  };
  access._muxSession = { muxName: 'codeman-12345678' };
  const first = session.writeNotesInput('first');
  try {
    const result = await deliverNotesInput(
      new Map([['live', session]]),
      { isPaneDead: async () => false },
      null,
      'live',
      'alice',
      'overlap'
    );
    expect(result).toMatchObject({ delivery: 'failed' });
    expect(result.message).toContain('Nothing was sent');
    expect(calls).toBe(1);
  } finally {
    release();
    await first;
  }
});

it('releases direct tmux notes boundaries after paste or Enter failures without retrying the original text', async () => {
  for (const failAt of [1, 2]) {
    const commands: string[][] = [];
    const manager = adapter(async (_file, args) => {
      commands.push(args);
      if (commands.length === failAt) throw Error('lost ACK');
    });
    expect(await manager.sendNotesInput('notes-id', 'failed')).toBe(false);
    expect(await manager.sendNotesInput('notes-id', 'later')).toBe(true);
    expect(commands.filter((args) => args.at(-1) === '\x1b[200~failed\x1b[201~')).toHaveLength(1);
    expect(commands.slice(-2).map((args) => args.at(-1))).toEqual(['\x1b[200~later\x1b[201~', 'Enter']);
  }
});

it('keeps a replacement tmux identity from bypassing an in-flight boundary and releases after the stale send stops', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commands: string[][] = [];
  const manager = adapter(async (_file, args) => {
    commands.push(args);
    if (commands.length === 1) await gate;
  });
  const first = manager.sendNotesInput('notes-id', 'old');
  manager.registerSession({
    sessionId: 'notes-id',
    muxName: 'codeman-87654321',
    pid: 234,
    createdAt: Date.now(),
    workingDir: '/tmp',
    mode: 'claude',
    attached: false,
  });
  try {
    await expect(manager.sendNotesInput('notes-id', 'replacement overlap')).rejects.toMatchObject({
      name: 'SessionNotesInputBusyError',
    });
    expect(commands).toHaveLength(1);
  } finally {
    release();
    expect(await first).toBe(false);
  }
  expect(await manager.sendNotesInput('notes-id', 'replacement later')).toBe(true);
  expect(commands.map((args) => args.at(-1))).toEqual([
    '\x1b[200~old\x1b[201~',
    '\x1b[200~replacement later\x1b[201~',
    'Enter',
  ]);
  expect(commands.slice(-2).map((args) => args[4])).toEqual(['codeman-87654321', 'codeman-87654321']);
});

it('releases PTY notes boundaries after failed writes and revoked eligibility or replaced transport', async () => {
  vi.useFakeTimers();
  try {
    for (const failAt of [1, 2]) {
      const session = new Session({ id: 'pty-failure-' + failAt, workingDir: '/tmp', mode: 'claude' });
      const writes: string[] = [];
      (session as any).ptyProcess = {
        write: (text: string) => {
          writes.push(text);
          if (writes.length === failAt) throw Error('write failed');
        },
      };
      const failed = session.writeNotesInput('failed').catch((error) => error);
      await vi.advanceTimersByTimeAsync(50);
      expect(await failed).toMatchObject({ message: 'write failed' });
      expect(session.terminalActivityEpoch).toBe(0);
      const later = session.writeNotesInput('later');
      await vi.advanceTimersByTimeAsync(50);
      expect(await later).toBe(true);
      expect(writes.filter((text) => text === '\x1b[200~failed\x1b[201~')).toHaveLength(1);
    }
    for (const change of ['owner', 'transport']) {
      const session = new Session({ id: 'pty-change-' + change, owner: 'alice', workingDir: '/tmp', mode: 'claude' });
      const oldWrites: string[] = [],
        newWrites: string[] = [];
      (session as any).ptyProcess = { write: (text: string) => oldWrites.push(text) };
      const first = session.writeNotesInput('old', () => session.owner === 'alice');
      if (change === 'owner') session.owner = 'bob';
      else (session as any).ptyProcess = { write: (text: string) => newWrites.push(text) };
      await vi.advanceTimersByTimeAsync(50);
      expect(await first).toBe(false);
      expect(oldWrites).toEqual(['\x1b[200~old\x1b[201~']);
      session.owner = 'alice';
      const later = session.writeNotesInput('later', () => session.owner === 'alice');
      await vi.advanceTimersByTimeAsync(50);
      expect(await later).toBe(true);
      expect(change === 'owner' ? oldWrites.slice(-2) : newWrites).toEqual(['\x1b[200~later\x1b[201~', '\r']);
    }
  } finally {
    vi.useRealTimers();
  }
});
