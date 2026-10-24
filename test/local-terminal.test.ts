/** @fileoverview Local-only tmux operators: bounded evidence and one-shot guarded submission. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Command } from 'commander';
import { LocalTerminal, type LocalTmuxRunner } from '../src/local-terminal.js';
import { registerLocalCommands } from '../src/cli-local.js';
import * as registry from '../src/config/cli-registry/registry.js';

let dir: string;
let composer: string;
let footer: string;
let pid: string;
let pasteMode: string;
let failPaste: boolean;
let failEnter: boolean;
let time: number;
let calls: Array<{ args: string[]; input?: string }>;
let terminal: LocalTerminal;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const options = { socket: 'unit-socket', target: 'project:1.0' };
const frame = () => [
  'Previous answer',
  ...composer.split('\n').map((v, i) => (i === 0 ? `› ${v}` : `  ${v}`)),
  `  ${footer}`,
  '',
];
const run: LocalTmuxRunner = async (args, input) => {
  calls.push({ args, input });
  const verb = args[2];
  if (verb === 'display-message') {
    const cursorY = composer.split('\n').length;
    const cursorX = 2 + (composer.split('\n').at(-1)?.length ?? 0);
    return (
      [
        '99',
        '%7',
        pid,
        '/dev/pts/7',
        '0',
        '100',
        String(frame().length),
        String(cursorX),
        String(cursorY),
        '1',
        pasteMode,
      ].join('\t') + '\n'
    );
  }
  if (verb === 'capture-pane')
    return (
      frame()
        .map((line) => line.trimEnd())
        .join('\n') + '\n'
    );
  if (verb === 'load-buffer') return '';
  if (verb === 'paste-buffer') {
    if (failPaste) throw Error('paste delivery ambiguous');
    composer = calls.findLast((c) => c.args[2] === 'load-buffer')!.input!;
    return '';
  }
  if (verb === 'delete-buffer') return '';
  if (verb === 'send-keys') {
    if (failEnter) throw Error('Enter delivery ambiguous');
    composer = '';
    return '';
  }
  throw Error(`unexpected tmux verb ${verb}`);
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cod549-local-'));
  composer = '';
  footer = '100% context left';
  pid = '700';
  pasteMode = '1';
  failPaste = failEnter = false;
  time = 1000;
  calls = [];
  terminal = new LocalTerminal({ run, receiptDir: join(dir, 'receipts'), now: () => time, env: {}, paintTimeoutMs: 0 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
const message = async (text = 'Review the tests') => {
  const path = join(dir, 'message.txt');
  await writeFile(path, text);
  return path;
};
const stage = async (text = 'Review the tests') =>
  terminal.stage({ ...options, mode: 'codex', messageFile: await message(text) });

describe('local terminal evidence', () => {
  it('uses the actual tmux bracket_paste_flag and tolerates unsupported empty mode flags', async () => {
    pasteMode = '';
    await terminal.inspect(options);
    expect(calls[0].args.at(-1)).toContain('#{bracket_paste_flag}');
    await expect(
      terminal.stage({ ...options, mode: 'codex', messageFile: await message('one\ntwo'), multiline: true })
    ).rejects.toThrow(/bracketed/i);
  });
  it('requires an explicit socket and target and never interpolates a shell', async () => {
    await expect(terminal.inspect({ socket: '', target: '%7' })).rejects.toThrow(/socket/i);
    await expect(terminal.inspect({ socket: 'unit', target: '' })).rejects.toThrow(/target/i);
    const target = 'project$(touch /tmp/should-not-exist):0.0';
    await terminal.inspect({ socket: 'unit socket', target, maxBytes: 100 });
    expect(calls[0].args).toEqual(['-L', 'unit socket', 'display-message', '-p', '-t', target, expect.any(String)]);
    expect(calls.some((c) => c.args.includes('send-keys'))).toBe(false);
  });
  it('does not confuse equal pane IDs on different tmux servers', async () => {
    terminal = new LocalTerminal({
      run,
      receiptDir: join(dir, 'receipts'),
      env: { TMUX_PANE: '%7', TMUX: '/tmp/other,100,0' },
      paintTimeoutMs: 0,
    });
    await stage();
    expect(calls.filter((c) => c.args[2] === 'paste-buffer')).toHaveLength(1);
  });
  it('refuses the current process ancestry even without TMUX_PANE', async () => {
    pid = String(process.pid);
    await expect(stage()).rejects.toThrow(/own pane/i);
    expect(calls.some((c) => c.args[2] === 'load-buffer')).toBe(false);
  });
  it('returns UTF8 bounded labeled pane evidence and identifies nonincremental captures', async () => {
    composer = '🙂'.repeat(25);
    const result = await terminal.inspect({ ...options, maxBytes: 17 });
    expect(result.source).toBe('pane-snapshot');
    expect(result.incremental).toBe(false);
    expect(result.cursor).toBeNull();
    expect(Buffer.byteLength(result.evidence)).toBeLessThanOrEqual(17);
    expect(result.evidence).not.toContain('�');
    expect(result.truncated).toBe(true);
  });
  it('refuses its own explicit pane before writing', async () => {
    terminal = new LocalTerminal({
      run,
      receiptDir: join(dir, 'receipts'),
      env: { TMUX_PANE: '%7', TMUX: '/tmp/unit,99,0' },
      paintTimeoutMs: 0,
    });
    await expect(stage()).rejects.toThrow(/self|own/i);
    expect(calls.some((c) => c.args[2] === 'load-buffer')).toBe(false);
  });
});

describe('local guarded stage and submit', () => {
  it('selects characterized composers through registry capabilities for custom CLI IDs', async () => {
    const codex = registry.getCli('codex')!;
    vi.spyOn(registry, 'getCli').mockImplementation((mode) => (mode === 'review-worker' ? codex : undefined));
    const receipt = await terminal.stage({ ...options, mode: 'review-worker', messageFile: await message('Review') });
    await terminal.submit({ ...options, stageId: receipt.stageId, confirmSha: receipt.sha256 });
    expect(calls.filter((c) => c.args[2] === 'send-keys')).toHaveLength(1);
  });
  it('types without Enter, stores private content-free receipt, then sends Enter once', async () => {
    const receipt = await stage('Review tests\n');
    expect(composer).toBe('Review tests');
    expect(calls.some((c) => c.args[2] === 'send-keys')).toBe(false);
    expect(receipt.sha256).toBe(sha('Review tests'));
    const path = join(dir, 'receipts', `${receipt.stageId}.json`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).not.toContain('Review tests');
    expect((await stat(join(dir, 'receipts'))).mode & 0o777).toBe(0o700);
    await terminal.submit({ ...options, stageId: receipt.stageId, confirmSha: receipt.sha256 });
    expect(calls.filter((c) => c.args[2] === 'send-keys').map((c) => c.args)).toEqual([
      ['-L', 'unit-socket', 'send-keys', '-t', '%7', 'Enter'],
    ]);
    await expect(
      terminal.submit({ ...options, stageId: receipt.stageId, confirmSha: receipt.sha256 })
    ).rejects.toThrow();
  });
  it('rejects changed composer and consumes the receipt even if text is restored', async () => {
    const receipt = await stage();
    composer = 'changed';
    await expect(terminal.submit({ ...options, stageId: receipt.stageId, confirmSha: receipt.sha256 })).rejects.toThrow(
      /composer|changed/i
    );
    composer = 'Review the tests';
    await expect(
      terminal.submit({ ...options, stageId: receipt.stageId, confirmSha: receipt.sha256 })
    ).rejects.toThrow();
    expect(calls.some((c) => c.args[2] === 'send-keys')).toBe(false);
  });
  it('rejects pane replacement, expiry and wrong hash without Enter', async () => {
    for (const change of [
      () => {
        pid = '701';
      },
      () => {
        time += 120001;
      },
    ]) {
      composer = '';
      pid = '700';
      time = 1000;
      const receipt = await stage();
      change();
      await expect(
        terminal.submit({ ...options, stageId: receipt.stageId, confirmSha: receipt.sha256 })
      ).rejects.toThrow();
    }
    composer = '';
    pid = '700';
    time = 1000;
    const receipt = await stage();
    await expect(
      terminal.submit({ ...options, stageId: receipt.stageId, confirmSha: '0'.repeat(64) })
    ).rejects.toThrow();
    await expect(
      terminal.submit({ ...options, stageId: receipt.stageId, confirmSha: receipt.sha256 })
    ).rejects.toThrow();
    expect(calls.some((c) => c.args[2] === 'send-keys')).toBe(false);
  });
  it('refuses malformed receipt lifetimes instead of treating missing expiry as valid', async () => {
    const receipt = await stage();
    const path = join(dir, 'receipts', `${receipt.stageId}.json`);
    const record = JSON.parse(await readFile(path, 'utf8'));
    delete record.expiresAt;
    await writeFile(path, JSON.stringify(record));
    await expect(terminal.submit({ ...options, stageId: receipt.stageId, confirmSha: receipt.sha256 })).rejects.toThrow(
      /receipt/i
    );
    expect(calls.some((c) => c.args[2] === 'send-keys')).toBe(false);
  });
  it('stages and submits an explicitly authorized multiline bracketed paste', async () => {
    const receipt = await terminal.stage({
      ...options,
      mode: 'codex',
      messageFile: await message('one\ntwo'),
      multiline: true,
    });
    expect(composer).toBe('one\ntwo');
    expect(calls.find((c) => c.args[2] === 'paste-buffer')!.args).toContain('-p');
    expect(calls.some((c) => c.args[2] === 'send-keys')).toBe(false);
    await terminal.submit({ ...options, stageId: receipt.stageId, confirmSha: receipt.sha256 });
    expect(calls.filter((c) => c.args[2] === 'send-keys')).toHaveLength(1);
  });
  it('permits only one of concurrent submit attempts', async () => {
    const receipt = await stage();
    const results = await Promise.allSettled(
      [0, 1].map(() => terminal.submit({ ...options, stageId: receipt.stageId, confirmSha: receipt.sha256 }))
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(calls.filter((c) => c.args[2] === 'send-keys')).toHaveLength(1);
  });
  it('consumes ambiguous delivery without retry', async () => {
    const receipt = await stage();
    failEnter = true;
    await expect(terminal.submit({ ...options, stageId: receipt.stageId, confirmSha: receipt.sha256 })).rejects.toThrow(
      /ambiguous|inspect/i
    );
    failEnter = false;
    await expect(
      terminal.submit({ ...options, stageId: receipt.stageId, confirmSha: receipt.sha256 })
    ).rejects.toThrow();
    expect(calls.filter((c) => c.args[2] === 'send-keys')).toHaveLength(1);
  });
  it('rejects unsupported/nonempty composers and terminal controls before paste', async () => {
    for (const text of ['danger\u001b[31m', 'danger\rEnter', 'tab\ttext', 'one\ntwo']) {
      await expect(stage(text)).rejects.toThrow();
    }
    composer = 'already present';
    await expect(stage()).rejects.toThrow(/empty/i);
    composer = '';
    footer = 'unrecognized shell';
    await expect(stage()).rejects.toThrow(/composer/i);
    expect(calls.some((c) => c.args[2] === 'load-buffer')).toBe(false);
  });
  it('requires bracketed paste mode and explicit multiline authorization', async () => {
    pasteMode = '0';
    await expect(
      terminal.stage({ ...options, mode: 'codex', messageFile: await message('one\ntwo'), multiline: true })
    ).rejects.toThrow(/bracketed/i);
    expect(calls.some((c) => c.args[2] === 'load-buffer')).toBe(false);
  });
  it('refuses multiline paste if bracketed mode changed before dispatch', async () => {
    terminal = new LocalTerminal({
      receiptDir: join(dir, 'receipts'),
      env: {},
      paintTimeoutMs: 0,
      run: async (args, input) => {
        const result = await run(args, input);
        if (args[2] === 'load-buffer') pasteMode = '0';
        return result;
      },
    });
    await expect(
      terminal.stage({ ...options, mode: 'codex', messageFile: await message('one\ntwo'), multiline: true })
    ).rejects.toThrow(/bracketed/i);
    expect(calls.some((c) => c.args[2] === 'paste-buffer')).toBe(false);
  });
  it('does not issue a receipt after ambiguous paste and cleans its exact buffer', async () => {
    failPaste = true;
    await expect(stage()).rejects.toThrow(/ambiguous|inspect/i);
    expect(calls.some((c) => c.args[2] === 'delete-buffer')).toBe(true);
    expect(calls.some((c) => c.args[2] === 'send-keys')).toBe(false);
  });
  it('rejects symlink message and receipt files and path traversal receipt IDs', async () => {
    const path = await message();
    const link = join(dir, 'message-link');
    await symlink(path, link);
    await expect(terminal.stage({ ...options, mode: 'codex', messageFile: link })).rejects.toThrow(/regular|symlink/i);
    const receipt = await stage();
    const receiptPath = join(dir, 'receipts', `${receipt.stageId}.json`);
    const bytes = await readFile(receiptPath);
    await rm(receiptPath);
    const external = join(dir, 'foreign');
    await writeFile(external, bytes, { mode: 0o600 });
    await symlink(external, receiptPath);
    await expect(
      terminal.submit({ ...options, stageId: receipt.stageId, confirmSha: receipt.sha256 })
    ).rejects.toThrow();
    expect(await readFile(external)).toEqual(bytes);
    await expect(terminal.submit({ ...options, stageId: '../foreign', confirmSha: receipt.sha256 })).rejects.toThrow();
  });
});

it('registers local command help without needing a server or managed-session environment', async () => {
  const program = new Command().exitOverride();
  registerLocalCommands(program);
  const local = program.commands.find((c) => c.name() === 'local')!;
  expect(local.commands.map((c) => c.name())).toEqual(['inspect', 'stage', 'submit']);
  expect(local.commands.find((c) => c.name() === 'stage')!.options.map((o) => o.long)).toContain('--multiline');
});
