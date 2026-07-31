import { describe, expect, it, vi, beforeEach } from 'vitest';
import { access, readFile, writeFile } from 'node:fs/promises';
import { PassThrough, Writable } from 'node:stream';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, spawn };
});

import {
  buildSftpConnectionArgv,
  downloadRemoteWorkspaceFile,
  getRemoteWorkspaceFileInfo,
  listRemoteWorkspaceDirectory,
  MAX_SFTP_BATCH_STDOUT_BYTES,
  MAX_REMOTE_STDERR_BYTES,
  readRemoteWorkspaceFile,
  remoteWorkspacePath,
} from '../src/remote-sftp.js';
import type { SessionRemote } from '../src/types/session.js';
import { RemoteCaseLinkSchema } from '../src/web/schemas.js';

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

  it.each(['/workspace\nget "/etc/passwd"', '/workspace\rquit', '/workspace\u0000oops'])(
    'rejects an unsafe persisted remote workspace path: %j',
    (remotePath) => {
      expect(() => remoteWorkspacePath({ ...REMOTE, remotePath })).toThrow('Remote workspace path');
    }
  );

  it('rejects control characters in remote paths submitted for new cases', () => {
    expect(
      RemoteCaseLinkSchema.safeParse({ name: 'work', hostId: 'host-1', remotePath: '/workspace\nquit' }).success
    ).toBe(false);
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

  it('parses a macOS long listing with an unknown link count', async () => {
    mockSftp({
      stdout: '-rw-r--r--    ? ann      staff          12 Jul 30 20:11 /home/ann/proj/AGENTS.md\n',
    });

    await expect(listRemoteWorkspaceDirectory(REMOTE)).resolves.toEqual([
      { name: 'AGENTS.md', path: 'AGENTS.md', type: 'file', size: 12 },
    ]);
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

  it('terminates and rejects an SFTP listing whose stdout exceeds the hard byte cap', async () => {
    const { kill } = mockSftp({ stdout: 'x'.repeat(MAX_SFTP_BATCH_STDOUT_BYTES + 1) });

    await expect(listRemoteWorkspaceDirectory(REMOTE)).rejects.toThrow('stdout exceeded');

    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('terminates and rejects an SFTP operation whose stderr exceeds the diagnostic cap', async () => {
    const { kill } = mockSftp({ stderr: 'x'.repeat(MAX_REMOTE_STDERR_BYTES + 1) });

    await expect(listRemoteWorkspaceDirectory(REMOTE)).rejects.toThrow('stderr exceeded');

    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('getRemoteWorkspaceFileInfo', () => {
  beforeEach(() => spawn.mockReset());

  it('reads only SFTP long-list metadata for a workspace-relative file', async () => {
    const { stdin } = mockSftp({ stdout: '-rw-r--r--    1 ann      staff    11534336 Jan  2 12:34 archive.zip\n' });

    await expect(getRemoteWorkspaceFileInfo(REMOTE, 'archive.zip')).resolves.toEqual({ size: 11534336 });
    expect(Buffer.concat(stdin).toString('utf8')).toBe('ls -l "/home/ann/proj/archive.zip"\n');
  });
});

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
        const localPath = /^get "[^"]+" "([^"]+)"/.exec(batch)?.[1];
        if (!localPath) throw new Error(`Unexpected SFTP batch: ${batch}`);
        localPaths.push(localPath);
        void writeFile(localPath, bytes).then(() => child.emit('close', 0));
        cb();
      },
    });
    return child;
  });
  return { batches, localPaths };
}

function mockBoundedSshRead(bytes: Buffer): void {
  spawn.mockImplementation(() => {
    const child = new PassThrough() as unknown as {
      stdin: Writable;
      stdout: PassThrough;
      stderr: PassThrough;
      on: (event: string, cb: (...args: unknown[]) => void) => unknown;
      emit: (event: string, ...args: unknown[]) => boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = new Writable({
      write(_chunk, _encoding, cb) {
        cb();
      },
    });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    queueMicrotask(() => {
      child.stdout.emit('data', bytes);
      child.emit('close', 0);
    });
    return child;
  });
}

function mockSshStderr(stderr: Buffer): { kill: ReturnType<typeof vi.fn> } {
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
    child.stdin = new Writable({
      write(_chunk, _encoding, cb) {
        cb();
      },
    });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = kill;
    queueMicrotask(() => {
      child.stderr.emit('data', stderr);
      child.emit('close', 1);
    });
    return child;
  });
  return { kill };
}

describe('readRemoteWorkspaceFile', () => {
  beforeEach(() => spawn.mockReset());

  it('rejects an oversized remote file without issuing an SFTP get or staging it locally', async () => {
    mockBoundedSshRead(Buffer.alloc(101, 'x'));

    await expect(readRemoteWorkspaceFile(REMOTE, 'too-large.txt', 100)).rejects.toThrow('100-byte read limit');

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toBe('ssh');
  });

  it('downloads to a private staging location and exposes explicit cleanup', async () => {
    const { batches, localPaths } = mockSftpRead(Buffer.from('hello'));

    const staged = await downloadRemoteWorkspaceFile(REMOTE, 'small.txt');
    await expect(readFile(staged.path)).resolves.toEqual(Buffer.from('hello'));

    expect(batches).toEqual([expect.stringMatching(/^get "\/home\/ann\/proj\/small\.txt" "\/tmp\/codeman-sftp-/)]);
    await staged.cleanup();
    await expect(access(localPaths[0])).rejects.toThrow();
  });

  it('hard-caps a file that grows beyond a prior metadata observation without staging it', async () => {
    // A stale preflight could have observed 100 bytes; the live stream now has
    // 101. The bounded SSH command returns a sentinel byte and never creates a
    // local staging file, so this race cannot consume unbounded disk space.
    mockBoundedSshRead(Buffer.alloc(101, 'x'));

    await expect(readRemoteWorkspaceFile(REMOTE, 'growing.txt', 100)).rejects.toThrow('100-byte read limit');

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      'ssh',
      expect.arrayContaining(['BatchMode=yes', 'ann@10.0.0.9', expect.stringContaining('head -c 101')]),
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
  });

  it('terminates and rejects an SSH text read whose stderr exceeds the diagnostic cap', async () => {
    const { kill } = mockSshStderr(Buffer.alloc(MAX_REMOTE_STDERR_BYTES + 1, 'x'));

    await expect(readRemoteWorkspaceFile(REMOTE, 'unreadable.txt', 100)).rejects.toThrow('stderr exceeded');

    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });
});
