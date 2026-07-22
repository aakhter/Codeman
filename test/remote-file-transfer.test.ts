/**
 * @fileoverview Unit tests for the shared remote file-write helper (COD-241 final unit).
 *
 * Covers the PURE script builder (buildRemoteFileWriteScript) — shell-escaping of
 * dir/file/tmp names with metacharacters, the atomic temp→`mv -n` sequence, the
 * symlink/not-a-directory guard, `umask 077`, and PATH bootstrap — and the spawn
 * wrapper (writeRemoteFileBytes) with `ssh` mocked (success streams bytes on
 * stdin; non-zero exit + timeout reject with a labeled error).
 *
 * Port: N/A (no server, no real ssh).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough, Writable } from 'node:stream';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, spawn };
});

import { buildRemoteFileWriteScript, writeRemoteFileBytes } from '../src/remote-file-transfer.js';
import type { SessionRemote } from '../src/types/session.js';

const REMOTE: SessionRemote = {
  hostId: 'h1',
  label: 'box',
  host: '10.0.0.9',
  username: 'ann',
  remotePath: '/home/ann/proj',
};

describe('buildRemoteFileWriteScript (pure)', () => {
  it('single-quote-escapes dir/file/tmp and keeps the atomic mv -n sequence', () => {
    const script = buildRemoteFileWriteScript({
      dir: '/home/ann/pr oj/.codeman-attachments',
      filePath: '/home/ann/pr oj/.codeman-attachments/a b.pdf',
      tmpPath: '/home/ann/pr oj/.codeman-attachments/a b.pdf.tmp-deadbeef',
      notADirectoryMessage: '.codeman-attachments is not a regular directory',
    });
    // Assignments are single-quoted tokens (spaces stay inside one token).
    expect(script).toContain("dir='/home/ann/pr oj/.codeman-attachments'");
    expect(script).toContain("file='/home/ann/pr oj/.codeman-attachments/a b.pdf'");
    expect(script).toContain("tmp='/home/ann/pr oj/.codeman-attachments/a b.pdf.tmp-deadbeef'");
    // Symlink / not-a-directory guard + mkdir-if-absent + umask + atomic staging.
    expect(script).toContain('if [ -L "$dir" ] || { [ -e "$dir" ] && [ ! -d "$dir" ]; }; then');
    expect(script).toContain('exit 73');
    expect(script).toContain('if [ ! -e "$dir" ]; then mkdir "$dir"; fi');
    expect(script).toContain('umask 077');
    expect(script).toContain('cat > "$tmp"');
    expect(script).toContain('mv -n "$tmp" "$file"');
    expect(script).toContain('rm -f "$tmp"');
    // PATH bootstrap present so a login-less ssh shell still finds coreutils.
    expect(script).toContain('export PATH=');
  });

  it('neutralizes single quotes, $, backticks in the not-a-directory message and paths', () => {
    const script = buildRemoteFileWriteScript({
      dir: "/x/$(rm -rf ~)/`id`/'quote'",
      filePath: '/x/a.pdf',
      tmpPath: '/x/a.pdf.tmp',
      notADirectoryMessage: "it's $HOME `bad`",
    });
    // The dangerous dir is a single escaped token — the $() / backticks are inert.
    expect(script).toContain("dir='/x/$(rm -rf ~)/`id`/'\\''quote'\\'''");
    // The message is single-quoted (escaped), so $HOME/backticks never expand.
    expect(script).toContain("echo 'it'\\''s $HOME `bad`' >&2");
    // The dangerous dir is emitted as ONE fully single-quoted token: the value
    // opens with `dir='`, and its literal single quote is closed+escaped+reopened
    // (`'\''`), so the `$(...)`/backticks can never reach the remote shell live.
    expect(script).toContain("dir='/x/$(rm -rf ~)/`id`/'\\''quote'\\'''");
  });
});

function mockSuccessfulSsh(exitCode = 0): { stdin: Buffer[]; calls: () => unknown[][] } {
  const stdinChunks: Buffer[] = [];
  spawn.mockImplementation(() => {
    const child = new PassThrough() as unknown as {
      stdin: Writable;
      stdout: PassThrough;
      stderr: PassThrough;
      on: (event: string, cb: (...args: unknown[]) => void) => unknown;
      emit: (event: string, ...args: unknown[]) => boolean;
      kill: (sig?: string) => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin = new Writable({
      write(chunk, _enc, cb) {
        stdinChunks.push(Buffer.from(chunk));
        cb();
      },
      final(cb) {
        queueMicrotask(() => child.emit('close', exitCode));
        cb();
      },
    });
    return child;
  });
  return { stdin: stdinChunks, calls: () => spawn.mock.calls };
}

describe('writeRemoteFileBytes (spawn wrapper, ssh mocked)', () => {
  beforeEach(() => spawn.mockReset());

  it('spawns ssh with the connection argv + ConnectTimeout + target and streams bytes on stdin', async () => {
    const { stdin, calls } = mockSuccessfulSsh(0);
    const bytes = Buffer.from('%PDF-1.4 hello');
    await writeRemoteFileBytes(REMOTE, {
      dir: '/home/ann/proj/.codeman-attachments',
      filePath: '/home/ann/proj/.codeman-attachments/x.pdf',
      bytes,
      timeoutMs: 5_000,
      transferLabel: 'remote document upload',
      notADirectoryMessage: '.codeman-attachments is not a regular directory',
    });
    const [bin, argv] = calls()[0] as [string, string[]];
    expect(bin).toBe('ssh');
    expect(argv).toContain('BatchMode=yes');
    expect(argv).toContain('ConnectTimeout=10');
    expect(argv).toContain('ann@10.0.0.9');
    expect(String(argv.at(-1))).toContain('mv -n "$tmp" "$file"');
    expect(Buffer.concat(stdin)).toEqual(bytes);
  });

  it('rejects with a labeled error on non-zero exit (stderr surfaced)', async () => {
    spawn.mockImplementation(() => {
      const child = new PassThrough() as unknown as {
        stdin: Writable;
        stdout: PassThrough;
        stderr: PassThrough;
        on: (event: string, cb: (...args: unknown[]) => void) => unknown;
        emit: (event: string, ...args: unknown[]) => boolean;
        kill: (sig?: string) => void;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      child.stdin = new Writable({
        write(_c, _e, cb) {
          cb();
        },
        final(cb) {
          queueMicrotask(() => {
            child.stderr.emit('data', Buffer.from('.codeman-attachments is not a regular directory'));
            child.emit('close', 73);
          });
          cb();
        },
      });
      return child;
    });
    await expect(
      writeRemoteFileBytes(REMOTE, {
        dir: '/x/.codeman-attachments',
        filePath: '/x/.codeman-attachments/x.pdf',
        bytes: Buffer.from('z'),
        timeoutMs: 5_000,
        transferLabel: 'remote document upload',
        notADirectoryMessage: '.codeman-attachments is not a regular directory',
      })
    ).rejects.toThrow('.codeman-attachments is not a regular directory');
  });

  it('rejects with a timeout error when ssh never closes', async () => {
    spawn.mockImplementation(() => {
      const child = new PassThrough() as unknown as {
        stdin: Writable;
        stdout: PassThrough;
        stderr: PassThrough;
        on: (event: string, cb: (...args: unknown[]) => void) => unknown;
        emit: (event: string, ...args: unknown[]) => boolean;
        kill: (sig?: string) => void;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      child.stdin = new Writable({
        write(_c, _e, cb) {
          cb();
        },
        final(cb) {
          cb(); // never emits 'close'
        },
      });
      return child;
    });
    await expect(
      writeRemoteFileBytes(REMOTE, {
        dir: '/x/.codeman-attachments',
        filePath: '/x/.codeman-attachments/x.pdf',
        bytes: Buffer.from('z'),
        timeoutMs: 20,
        transferLabel: 'remote document upload',
        notADirectoryMessage: '.codeman-attachments is not a regular directory',
      })
    ).rejects.toThrow('timed out connecting to 10.0.0.9');
  });
});
