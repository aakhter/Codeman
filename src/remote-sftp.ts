/**
 * OpenSSH SFTP transport for remote session workspaces (COD-252).
 *
 * SFTP is deliberately invoked directly without a shell. Its connection argv is
 * derived from the SSH argv builder so remote File Viewer operations honour the
 * same identity, jump host, SOCKS proxy, and `-o` settings as terminal sessions.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix as pathPosix } from 'node:path';
import { buildSshConnectionArgv, remoteSshTarget, shellescape } from './remote-hosts.js';
import type { SessionRemote } from './types/session.js';

const DEFAULT_TIMEOUT_MS = 15_000;
/** Bounds an `sftp ls` response to roughly 5,000 long-list entries. */
export const MAX_SFTP_BATCH_STDOUT_BYTES = 5 * 1024 * 1024;
/** Retains a bounded diagnostic while refusing a peer that floods stderr. */
export const MAX_REMOTE_STDERR_BYTES = 1024 * 1024;

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

/** Minimal metadata needed to classify a remote File Viewer response safely. */
export interface RemoteWorkspaceFileInfo {
  size: number;
  mtimeMs?: number;
}

/** Buffer process diagnostics up to a fixed limit without retaining overflow. */
function createCappedStderrCollector(maxBytes = MAX_REMOTE_STDERR_BYTES): {
  append: (chunk: Buffer) => boolean;
  text: () => string;
} {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  return {
    append(chunk) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) return false;
      chunks.push(Buffer.from(chunk));
      return true;
    },
    text() {
      return Buffer.concat(chunks).toString('utf8').trim();
    },
  };
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
  if (/[\0\r\n]/.test(remote.remotePath)) {
    throw new Error('Remote workspace path must not contain NUL, CR, or LF');
  }
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
  if (/[\0\r\n]/.test(value)) throw new Error('Remote SFTP path must not contain NUL, CR, or LF');
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

async function runSftpBatch(remote: SessionRemote, batch: string, options: RemoteSftpOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<string>((resolve, reject) => {
    const child = spawn('sftp', ['-b', '-', ...buildSftpConnectionArgv(remote)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    const stderr = createCappedStderrCollector();
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

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_SFTP_BATCH_STDOUT_BYTES) {
        finish(() => {
          child.kill('SIGTERM');
          reject(new Error(`Remote SFTP stdout exceeded the ${MAX_SFTP_BATCH_STDOUT_BYTES}-byte limit`));
        });
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return;
      if (!stderr.append(chunk)) {
        finish(() => {
          child.kill('SIGTERM');
          reject(new Error(`Remote SFTP stderr exceeded the ${MAX_REMOTE_STDERR_BYTES}-byte diagnostic limit`));
        });
      }
    });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => {
      if (code === 0) {
        finish(() => resolve(Buffer.concat(stdout).toString('utf8')));
        return;
      }
      const message = stderr.text();
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
      /^([d-])[rwxStTs-]+\+?\s+(?:\d+|\?)\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d{1,2}\s+(?:\d{2}:\d{2}|\d{4})\s+(.+)$/.exec(
        line
      );
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

/** Read a file's SFTP long-list metadata without downloading its contents. */
export async function getRemoteWorkspaceFileInfo(
  remote: SessionRemote,
  relativePath: string,
  options: RemoteSftpOptions = {}
): Promise<RemoteWorkspaceFileInfo> {
  const remotePath = remoteWorkspacePath(remote, relativePath);
  const stdout = await runSftpBatch(remote, `ls -l ${quoteSftpPath(remotePath)}\n`, options);
  const entry = parseSftpLongListing(stdout, '').find((candidate) => candidate.type === 'file');
  if (!entry || entry.size === undefined) throw new Error('Remote file metadata was not returned by SFTP');
  return { size: entry.size };
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

/**
 * Read a remote text file through SSH with a strict client-side bound.
 *
 * SFTP's `get` has no maximum-byte option: even a size-preflight may race a
 * growing file and write an unbounded local temporary file. `head -c N+1`
 * streams at most one sentinel byte beyond the caller's limit, and the client
 * retains no more than that bounded amount in memory. The remote hosts are
 * already POSIX targets (remote sessions use a POSIX shell/tmux), while the
 * local side remains cross-platform because it stages no filesystem data.
 */
export async function readRemoteWorkspaceFile(
  remote: SessionRemote,
  relativePath: string,
  maxBytes: number,
  options: RemoteSftpOptions = {}
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Remote file read limit must be a non-negative safe integer');
  }
  const remotePath = remoteWorkspacePath(remote, relativePath);
  const limitWithSentinel = maxBytes + 1;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const command = `head -c ${limitWithSentinel} < ${shellescape(remotePath)}`;
  const args = [...buildSshConnectionArgv(remote), remoteSshTarget(remote), command];

  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr = createCappedStderrCollector();
    let total = 0;
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
        reject(new Error(`Remote file read timed out connecting to ${remote.host}`));
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        finish(() => {
          child.kill('SIGTERM');
          reject(new Error(`Remote file exceeds the ${maxBytes}-byte read limit`));
        });
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return;
      if (!stderr.append(chunk)) {
        finish(() => {
          child.kill('SIGTERM');
          reject(new Error(`Remote file read stderr exceeded the ${MAX_REMOTE_STDERR_BYTES}-byte diagnostic limit`));
        });
      }
    });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => {
      if (code === 0) {
        finish(() => resolve(Buffer.concat(stdout)));
        return;
      }
      const message = stderr.text();
      finish(() => reject(new Error(message || `Remote file read failed with exit code ${code ?? 'unknown'}`)));
    });
  });
}
