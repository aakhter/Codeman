/**
 * OpenSSH SFTP transport for remote session workspaces (COD-252).
 *
 * SFTP is deliberately invoked directly without a shell. Its connection argv is
 * derived from the SSH argv builder so remote File Viewer operations honour the
 * same identity, jump host, SOCKS proxy, and `-o` settings as terminal sessions.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix as pathPosix } from 'node:path';
import { buildSshConnectionArgv, remoteSshTarget } from './remote-hosts.js';
import type { SessionRemote } from './types/session.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export interface RemoteSftpOptions {
  timeoutMs?: number;
}

export interface RemoteWorkspaceEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
}

export interface StagedRemoteWorkspaceFile {
  path: string;
  cleanup: () => Promise<void>;
}

/** Build SFTP arguments from the canonical SSH connection arguments. */
export function buildSftpConnectionArgv(remote: SessionRemote): string[] {
  const sshArgs = buildSshConnectionArgv(remote);
  return [
    ...sshArgs.map((arg, index) => (arg === '-p' && /^\d+$/.test(sshArgs[index + 1] ?? '') ? '-P' : arg)),
    remoteSshTarget(remote),
  ];
}

/** Resolve a safe workspace-relative path to an absolute remote POSIX path. */
export function remoteWorkspacePath(remote: SessionRemote, relativePath = ''): string {
  if (
    relativePath.startsWith('/') ||
    relativePath.includes('\0') ||
    relativePath.includes('\r') ||
    relativePath.includes('\n') ||
    relativePath.split('/').includes('..')
  ) {
    throw new Error('Remote file path must be workspace-relative');
  }
  return relativePath ? pathPosix.join(remote.remotePath, relativePath) : remote.remotePath;
}

/** Quote an argument for SFTP's batch command parser (not a shell). */
function quoteSftpPath(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

async function runSftpBatch(remote: SessionRemote, batch: string, options: RemoteSftpOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<string>((resolve, reject) => {
    const child = spawn('sftp', ['-b', '-', ...buildSftpConnectionArgv(remote)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    };
    const timeout = setTimeout(() => {
      finish(() => {
        child.kill('SIGTERM');
        reject(new Error(`Remote SFTP operation timed out connecting to ${remote.host}`));
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => {
      if (code === 0) {
        finish(() => resolve(Buffer.concat(stdout).toString('utf8')));
        return;
      }
      const message = Buffer.concat(stderr).toString('utf8').trim();
      finish(() => reject(new Error(message || `Remote SFTP operation failed with exit code ${code ?? 'unknown'}`)));
    });
    child.stdin.end(batch);
  });
}

function parseSftpLongListing(stdout: string, relativeDir: string): RemoteWorkspaceEntry[] {
  const entries: RemoteWorkspaceEntry[] = [];
  for (const line of stdout.split('\n')) {
    // OpenSSH emits: mode links owner group size month day time-or-year name
    const match =
      /^([d-])[rwxStTs-]+\+?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d{1,2}\s+(?:\d{2}:\d{2}|\d{4})\s+(.+)$/.exec(line);
    if (!match) continue;
    const [, kind, size, name] = match;
    // A newline-containing name cannot be safely represented in SFTP batch input.
    if (!name || /[\0\r\n]/.test(name) || name === '.' || name === '..') continue;
    entries.push({
      name,
      path: relativeDir ? pathPosix.join(relativeDir, name) : name,
      type: kind === 'd' ? 'directory' : 'file',
      ...(kind === 'd' ? {} : { size: Number(size) }),
    });
  }
  return entries;
}

export async function listRemoteWorkspaceDirectory(
  remote: SessionRemote,
  relativePath = '',
  options: RemoteSftpOptions = {}
): Promise<RemoteWorkspaceEntry[]> {
  const remotePath = remoteWorkspacePath(remote, relativePath);
  const stdout = await runSftpBatch(remote, `ls -l ${quoteSftpPath(remotePath)}\n`, options);
  return parseSftpLongListing(stdout, relativePath);
}

/** Download a workspace-relative remote file into a private staging directory. */
export async function downloadRemoteWorkspaceFile(
  remote: SessionRemote,
  relativePath: string,
  options: RemoteSftpOptions = {}
): Promise<StagedRemoteWorkspaceFile> {
  const remotePath = remoteWorkspacePath(remote, relativePath);
  const directory = await mkdtemp(join(tmpdir(), 'codeman-sftp-'));
  const localPath = join(directory, 'download');
  try {
    await runSftpBatch(remote, `get ${quoteSftpPath(remotePath)} ${quoteSftpPath(localPath)}\n`, options);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { path: localPath, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

/** Read a remote workspace file, rejecting it before returning if it exceeds `maxBytes`. */
export async function readRemoteWorkspaceFile(
  remote: SessionRemote,
  relativePath: string,
  maxBytes: number,
  options: RemoteSftpOptions = {}
): Promise<Buffer> {
  const staged = await downloadRemoteWorkspaceFile(remote, relativePath, options);
  try {
    const info = await stat(staged.path);
    if (info.size > maxBytes) throw new Error(`Remote file exceeds the ${maxBytes}-byte read limit`);
    return await readFile(staged.path);
  } finally {
    await staged.cleanup();
  }
}
