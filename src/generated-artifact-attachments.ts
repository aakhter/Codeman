/**
 * @fileoverview Codex generated-artifact attachment registration.
 *
 * Codex image generation prints paths such as `Saved to: file://...`. For local
 * sessions these paths can be registered directly when they are safe. For remote
 * SSH sessions the path exists on the remote host, so Codeman first copies the
 * bytes into its instance data directory and then serves that cached copy through
 * the existing attachment registry.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, posix as posixPath } from 'node:path';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { dataPath } from './config/instance.js';
import {
  attachmentRecordToEvent,
  attachmentRegistry,
  registerExternalAttachment,
  type AttachmentRegistrationResult,
} from './attachment-registry.js';
import { buildSshConnectionArgv, remoteSshTarget, shellescape } from './remote-hosts.js';
import type { SessionRemote } from './types/session.js';

const execFileAsync = promisify(execFile);

const MAX_GENERATED_ARTIFACT_BYTES = 50 * 1024 * 1024;
const REMOTE_FETCH_TIMEOUT_MS = 30_000;

const CODEX_GENERATED_DIRS = [
  '.codex-personal/generated_images',
  '.codex/generated_images',
  '.codex-personal/generated_artifacts',
  '.codex/generated_artifacts',
];

const SUPERPOWERS_ARTIFACT_DIR_MARKERS = ['/output/', '/docs/mockups/'];

export interface GeneratedArtifactRegistrationOptions {
  sessionId: string;
  filePath: string;
  sessionWorkingDir: string;
  remote?: SessionRemote;
}

export async function registerGeneratedArtifactAttachment(
  options: GeneratedArtifactRegistrationOptions
): Promise<AttachmentRegistrationResult> {
  if (options.remote) {
    if (!isAllowedRemoteGeneratedArtifactPath(options.filePath, options.remote)) {
      throw new Error('Generated artifact path is outside allowed remote locations');
    }
    const localPath = buildRemoteGeneratedArtifactCachePath(options.sessionId, options.remote, options.filePath);
    const existing = registeredArtifact(options.sessionId, localPath);
    if (existing) return existing;
    await materializeRemoteGeneratedArtifact(options.sessionId, options.remote, options.filePath);
    return registerExternalAttachment(options.sessionId, localPath, { sessionWorkingDir: options.sessionWorkingDir });
  }

  let resolvedPath = options.filePath;
  let resolvedWorkingDir = options.sessionWorkingDir;
  try {
    resolvedPath = realpathSync(options.filePath);
  } catch {
    // Missing/unresolvable files stay force-confined; registration reports the final error.
  }
  try {
    resolvedWorkingDir = realpathSync(options.sessionWorkingDir);
  } catch {
    // Keep the configured workspace path when it cannot be resolved.
  }
  const forceWorkspaceConfinement = !isAllowedGeneratedArtifactPath(resolvedPath, resolvedWorkingDir);
  return registerExternalAttachment(options.sessionId, options.filePath, {
    sessionWorkingDir: options.sessionWorkingDir,
    forceWorkspaceConfinement,
  });
}

function registeredArtifact(sessionId: string, localPath: string): AttachmentRegistrationResult | undefined {
  const existing = attachmentRegistry.findByFilePath(sessionId, localPath);
  return existing ? attachmentRecordToEvent(existing) : undefined;
}

export function isAllowedGeneratedArtifactPath(
  filePath: string,
  workingDir: string,
  homeDir: string = homedir()
): boolean {
  const normalizedPath = posixPath.normalize(filePath);
  if (isPathInside(normalizedPath, workingDir)) return true;
  if (CODEX_GENERATED_DIRS.some((dir) => isPathInside(normalizedPath, posixPath.join(homeDir, dir)))) return true;
  return isAllowedSuperpowersArtifactPath(normalizedPath, homeDir);
}

function isAllowedSuperpowersArtifactPath(normalizedPath: string, homeDir: string): boolean {
  const worktreeRoot = posixPath.join(homeDir, '.config/superpowers/worktrees');
  if (!isPathInside(normalizedPath, worktreeRoot)) return false;
  const pathInWorktrees = normalizedPath.slice(ensureTrailingSlash(posixPath.normalize(worktreeRoot)).length);
  return SUPERPOWERS_ARTIFACT_DIR_MARKERS.some((marker) => pathInWorktrees.includes(marker));
}

function isAllowedRemoteGeneratedArtifactPath(filePath: string, remote: SessionRemote): boolean {
  const candidateHomes =
    remote.username === 'root' ? ['/root'] : [`/home/${remote.username}`, `/Users/${remote.username}`];
  return candidateHomes.some((home) => isAllowedGeneratedArtifactPath(filePath, remote.remotePath, home));
}

function isPathInside(filePath: string, rootPath: string): boolean {
  const normalizedRoot = ensureTrailingSlash(posixPath.normalize(rootPath));
  const normalizedPath = posixPath.normalize(filePath);
  return normalizedPath === normalizedRoot.slice(0, -1) || normalizedPath.startsWith(normalizedRoot);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

async function materializeRemoteGeneratedArtifact(
  sessionId: string,
  remote: SessionRemote,
  remotePath: string
): Promise<string> {
  const localPath = buildRemoteGeneratedArtifactCachePath(sessionId, remote, remotePath);
  await mkdir(posixPath.dirname(localPath), { recursive: true });

  const args = buildRemoteGeneratedArtifactFetchArgs(remote, remotePath);
  const { stdout } = (await execFileAsync('ssh', args, {
    encoding: 'buffer',
    timeout: REMOTE_FETCH_TIMEOUT_MS,
    maxBuffer: MAX_GENERATED_ARTIFACT_BYTES,
  })) as { stdout: Buffer };

  await fs.writeFile(localPath, stdout);
  return localPath;
}

export function buildRemoteGeneratedArtifactCachePath(
  sessionId: string,
  remote: Pick<SessionRemote, 'username' | 'host' | 'port'>,
  remotePath: string
): string {
  const digest = createHash('sha256')
    .update(`${remote.username}@${remote.host}:${remote.port ?? 22}:${remotePath}`)
    .digest('hex')
    .slice(0, 16);
  return join(dataPath('generated-artifacts', sessionId, digest), sanitizeCacheFileName(basename(remotePath)));
}

export function buildRemoteGeneratedArtifactFetchArgs(remote: SessionRemote, remotePath: string): string[] {
  return [...buildSshConnectionArgv(remote), remoteSshTarget(remote), `cat -- ${shellescape(remotePath)}`];
}

function sanitizeCacheFileName(fileName: string): string {
  return fileName.replace(/[^A-Za-z0-9._-]/g, '_') || 'artifact';
}
