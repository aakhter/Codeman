import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PassThrough, Writable } from 'node:stream';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, spawn };
});

import {
  buildSftpConnectionArgv,
  getRemoteWorkspaceFileInfo,
  listRemoteWorkspaceDirectory,
  MAX_SFTP_BATCH_STDOUT_BYTES,
  MAX_REMOTE_STDERR_BYTES,
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
