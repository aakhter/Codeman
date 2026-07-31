import { describe, expect, it, vi, beforeEach } from 'vitest';
import { access, writeFile } from 'node:fs/promises';
import { PassThrough, Writable } from 'node:stream';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, spawn };
});

import {
  buildSftpConnectionArgv,
  listRemoteWorkspaceDirectory,
  readRemoteWorkspaceFile,
  remoteWorkspacePath,
} from '../src/remote-sftp.js';
import type { SessionRemote } from '../src/types/session.js';

const REMOTE: SessionRemote = {
  hostId: 'h1',
  label: 'box',
  host: '10.0.0.9',
  username: 'ann',
  port: 2222,
  remotePath: '/home/ann/proj',
  identityFile: '/home/ann/.ssh/id remote',
  jumpHost: 'jump.example',
  socksProxy: '127.0.0.1:1080',
  extraSshOptions: ['StrictHostKeyChecking=yes'],
};

describe('remote SFTP connection and workspace paths', () => {
  it('derives SFTP argv from the saved SSH configuration', () => {
    expect(buildSftpConnectionArgv(REMOTE)).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-P',
      '2222',
      '-i',
      '/home/ann/.ssh/id remote',
      '-J',
      'jump.example',
      '-o',
      'ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p',
      '-o',
      'StrictHostKeyChecking=yes',
      'ann@10.0.0.9',
    ]);
  });

  it.each(['../secret', 'src/../../secret', '/etc/passwd', 'x\u0000y', 'x\ny', 'x\ry'])(
    'rejects unsafe workspace-relative paths: %j',
    (unsafePath) => {
      expect(() => remoteWorkspacePath(REMOTE, unsafePath)).toThrow('workspace-relative');
    }
  );

  it('resolves a relative path below the configured remote workspace', () => {
    expect(remoteWorkspacePath(REMOTE, 'src/file name.ts')).toBe('/home/ann/proj/src/file name.ts');
  });
});

function mockSftp({ stdout = '', stderr = '', code = 0, neverClose = false } = {}): {
  stdin: Buffer[];
  kill: ReturnType<typeof vi.fn>;
} {
  const stdin: Buffer[] = [];
  const kill = vi.fn();
  spawn.mockImplementation(() => {
    const child = new PassThrough() as unknown as {
      stdin: Writable;
      stdout: PassThrough;
      stderr: PassThrough;
      on: (event: string, cb: (...args: unknown[]) => void) => unknown;
      emit: (event: string, ...args: unknown[]) => boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = kill;
    child.stdin = new Writable({
      write(chunk, _encoding, cb) {
        stdin.push(Buffer.from(chunk));
        cb();
      },
      final(cb) {
        if (!neverClose)
          queueMicrotask(() => {
            if (stdout) child.stdout.emit('data', Buffer.from(stdout));
            if (stderr) child.stderr.emit('data', Buffer.from(stderr));
            child.emit('close', code);
          });
        cb();
      },
    });
    return child;
  });
  return { stdin, kill };
}

describe('listRemoteWorkspaceDirectory', () => {
  beforeEach(() => spawn.mockReset());

  it('uses a quoted batch ls command and parses directory entries', async () => {
    const { stdin } = mockSftp({
      stdout:
        'drwxr-xr-x    2 ann      staff        4096 Jan  2 12:34 src\n-rw-r--r--    1 ann      staff          12 Jan  2 12:34 hello world.txt\n',
    });
    await expect(listRemoteWorkspaceDirectory(REMOTE, 'folder with spaces')).resolves.toEqual([
      { name: 'src', path: 'folder with spaces/src', type: 'directory' },
      { name: 'hello world.txt', path: 'folder with spaces/hello world.txt', type: 'file', size: 12 },
    ]);
    expect(spawn).toHaveBeenCalledWith('sftp', ['-b', '-', ...buildSftpConnectionArgv(REMOTE)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(Buffer.concat(stdin).toString('utf8')).toBe('ls -l "/home/ann/proj/folder with spaces"\n');
  });

  it('returns an empty listing when SFTP has no stdout', async () => {
    mockSftp();
    await expect(listRemoteWorkspaceDirectory(REMOTE)).resolves.toEqual([]);
  });

  it('escapes backslashes and double quotes in the SFTP batch path', async () => {
    const { stdin } = mockSftp();
    await listRemoteWorkspaceDirectory(REMOTE, 'a "quoted" \\ path');
    expect(Buffer.concat(stdin).toString('utf8')).toBe('ls -l "/home/ann/proj/a \\"quoted\\" \\\\ path"\n');
  });

  it('surfaces SFTP stderr failures', async () => {
    mockSftp({ stderr: 'Permission denied', code: 1 });
    await expect(listRemoteWorkspaceDirectory(REMOTE)).rejects.toThrow('Permission denied');
  });

  it('times out and terminates a stalled SFTP process', async () => {
    const { kill } = mockSftp({ neverClose: true });
    await expect(listRemoteWorkspaceDirectory(REMOTE, '', { timeoutMs: 10 })).rejects.toThrow('timed out');
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });
});

function mockSftpSequence(responses: { stdout?: string; stderr?: string; code?: number }[]): { batches: string[] } {
  const batches: string[] = [];
  spawn.mockImplementation(() => {
    const response = responses[batches.length] ?? {};
    const child = new PassThrough() as unknown as {
      stdin: Writable;
      stdout: PassThrough;
      stderr: PassThrough;
      on: (event: string, cb: (...args: unknown[]) => void) => unknown;
      emit: (event: string, ...args: unknown[]) => boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const chunks: Buffer[] = [];
    child.stdin = new Writable({
      write(chunk, _encoding, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
      final(cb) {
        batches.push(Buffer.concat(chunks).toString('utf8'));
        queueMicrotask(() => {
          if (response.stdout) child.stdout.emit('data', Buffer.from(response.stdout));
          if (response.stderr) child.stderr.emit('data', Buffer.from(response.stderr));
          child.emit('close', response.code ?? 0);
        });
        cb();
      },
    });
    return child;
  });
  return { batches };
}

function mockSftpRead(bytes: Buffer): { batches: string[]; localPaths: string[] } {
  const batches: string[] = [];
  const localPaths: string[] = [];
  spawn.mockImplementation(() => {
    const child = new PassThrough() as unknown as {
      stdin: Writable;
      stdout: PassThrough;
      stderr: PassThrough;
      on: (event: string, cb: (...args: unknown[]) => void) => unknown;
      emit: (event: string, ...args: unknown[]) => boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const chunks: Buffer[] = [];
    child.stdin = new Writable({
      write(chunk, _encoding, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
      final(cb) {
        const batch = Buffer.concat(chunks).toString('utf8');
        batches.push(batch);
        if (batch.startsWith('ls -ln ')) {
          queueMicrotask(() => {
            child.stdout.emit('data', Buffer.from(`-rw-r--r-- 1 1000 1000 ${bytes.length} Jan 2 12:34 small.txt\n`));
            child.emit('close', 0);
          });
        } else {
          const localPath = /^get "[^"]+" "([^"]+)"/.exec(batch)?.[1];
          if (!localPath) throw new Error(`Unexpected SFTP batch: ${batch}`);
          localPaths.push(localPath);
          void writeFile(localPath, bytes).then(() => child.emit('close', 0));
        }
        cb();
      },
    });
    return child;
  });
  return { batches, localPaths };
}

describe('readRemoteWorkspaceFile', () => {
  beforeEach(() => spawn.mockReset());

  it('rejects an oversized remote file before issuing a get or staging it locally', async () => {
    const { batches } = mockSftpSequence([
      { stdout: '-rw-r--r--    1 ann      staff         101 Jan  2 12:34 too-large.txt\n' },
    ]);

    await expect(readRemoteWorkspaceFile(REMOTE, 'too-large.txt', 100)).rejects.toThrow('100-byte read limit');

    expect(batches).toEqual(['ls -ln "/home/ann/proj/too-large.txt"\n']);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('reads a preflight-sized file and cleans up the private staging location', async () => {
    const { batches, localPaths } = mockSftpRead(Buffer.from('hello'));

    await expect(readRemoteWorkspaceFile(REMOTE, 'small.txt', 100)).resolves.toEqual(Buffer.from('hello'));

    expect(batches).toEqual([
      'ls -ln "/home/ann/proj/small.txt"\n',
      expect.stringMatching(/^get "\/home\/ann\/proj\/small\.txt" "\/tmp\/codeman-sftp-/),
    ]);
    await expect(access(localPaths[0])).rejects.toThrow();
  });
});
