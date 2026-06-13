import { existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { RemoteCase, RemoteCommandMode, RemoteHost, SessionMode, SessionRemote } from './types.js';

const execAsync = promisify(exec);

const REMOTE_HOSTS_FILE = 'remote-hosts.json';
const REMOTE_CASES_FILE = 'remote-cases.json';

export function remoteHostsPath(configDir: string): string {
  return join(configDir, REMOTE_HOSTS_FILE);
}

export function remoteCasesPath(configDir: string): string {
  return join(configDir, REMOTE_CASES_FILE);
}

async function readJsonArray<T>(path: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function writeJsonArray<T>(configDir: string, path: string, value: T[]): Promise<void> {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  await fs.writeFile(path, JSON.stringify(value, null, 2));
}

export async function readRemoteHosts(configDir: string): Promise<RemoteHost[]> {
  return readJsonArray<RemoteHost>(remoteHostsPath(configDir));
}

export async function writeRemoteHosts(configDir: string, hosts: RemoteHost[]): Promise<void> {
  await writeJsonArray(configDir, remoteHostsPath(configDir), hosts);
}

export async function readRemoteCases(configDir: string): Promise<RemoteCase[]> {
  return readJsonArray<RemoteCase>(remoteCasesPath(configDir));
}

export async function writeRemoteCases(configDir: string, cases: RemoteCase[]): Promise<void> {
  await writeJsonArray(configDir, remoteCasesPath(configDir), cases);
}

export function defaultRemoteCommandForMode(mode: SessionMode): string {
  const commands: Record<RemoteCommandMode, string> = {
    shell: 'exec bash -l',
    claude: 'exec claude',
    opencode: 'exec opencode',
    codex: 'exec codex',
    gemini: 'exec gemini',
  };
  return commands[mode as RemoteCommandMode] || commands.shell;
}

export function remoteSshTarget(host: Pick<RemoteHost, 'username' | 'host'>): string {
  return `${host.username}@${host.host}`;
}

/**
 * COD-104 — build the SSH command that checks the remote host has tmux.
 *
 * Durable remote sessions run the agent inside a tmux server ON the remote host
 * (`tmux -L codeman new-session -A …`), so tmux is now a hard prerequisite there.
 * `command -v tmux` exits 0 (and prints the path) when tmux is installed.
 */
export function buildRemoteTmuxCheckCommand(host: Pick<RemoteHost, 'username' | 'host' | 'port'>): string {
  const parts = ['ssh', '-o BatchMode=yes', '-o ConnectTimeout=10'];
  if (host.port) parts.push(`-p ${host.port}`);
  parts.push(remoteSshTarget(host), "'command -v tmux'");
  return parts.join(' ');
}

export interface RemoteTmuxCheckResult {
  ok: boolean;
  /** Resolved tmux path on the remote (when ok). */
  tmuxPath?: string;
  /** Human-readable failure reason (when !ok). */
  error?: string;
}

/**
 * COD-104 — verify the remote host has tmux installed (required for durable
 * remote sessions). Returns a structured result with a clear, user-facing error
 * when tmux is missing or the host is unreachable. Never throws.
 */
export async function checkRemoteTmuxAvailable(
  host: Pick<RemoteHost, 'username' | 'host' | 'port'>
): Promise<RemoteTmuxCheckResult> {
  const command = buildRemoteTmuxCheckCommand(host);
  try {
    const { stdout } = await execAsync(command, { timeout: 15_000 });
    const tmuxPath = stdout.trim();
    if (!tmuxPath) {
      return {
        ok: false,
        error: `remote host ${host.host} needs tmux installed for durable remote sessions`,
      };
    }
    return { ok: true, tmuxPath };
  } catch (err) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr?: unknown }).stderr ?? '') : '';
    // `command -v tmux` exits non-zero when tmux is absent (no stderr); a real
    // connection failure surfaces ssh diagnostics on stderr.
    if (stderr.trim()) {
      return {
        ok: false,
        error: `could not verify tmux on remote host ${host.host}: ${stderr.trim()}`,
      };
    }
    return {
      ok: false,
      error: `remote host ${host.host} needs tmux installed for durable remote sessions`,
    };
  }
}

export function remoteDisplayPath(
  remote: Pick<SessionRemote, 'username' | 'host' | 'remotePath'> | { username: string; host: string; path: string }
): string {
  const path = 'remotePath' in remote ? remote.remotePath : remote.path;
  return `${remote.username}@${remote.host}:${path}`;
}

export function toSessionRemote(host: RemoteHost, remoteCase: RemoteCase): SessionRemote {
  return {
    hostId: host.id,
    label: host.label,
    host: host.host,
    username: host.username,
    port: host.port,
    remotePath: remoteCase.remotePath,
    commands: host.commands,
  };
}
