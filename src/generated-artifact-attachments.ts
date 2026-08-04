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
  AttachmentRegistrationError,
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
const REMOTE_INSPECTION_TIMEOUT_MS = 10_000;
const REMOTE_INSPECTION_MAX_BUFFER_BYTES = 16 * 1024;

const CODEX_GENERATED_DIRS = [
  '.codex-personal/generated_images',
  '.codex/generated_images',
  '.codex-personal/generated_artifacts',
  '.codex/generated_artifacts',
];

const SUPERPOWERS_ARTIFACT_DIR_MARKERS = ['/output/', '/docs/mockups/'];

const REMOTE_INSPECTION_SCRIPT = `
resolve_path() {
  candidate=$1
  hops=0
  while :; do
    hops=$((hops + 1))
    [ "$hops" -le 40 ] || return 1
    dir=$(dirname "$candidate") || return 1
    base=$(basename "$candidate") || return 1
    resolved_dir=$(CDPATH= cd -P "$dir" 2>/dev/null && pwd -P) || return 1
    candidate=$resolved_dir/$base
    if [ -L "$candidate" ]; then
      target=$(readlink "$candidate") || return 1
      case "$target" in
        /*) candidate=$target ;;
        *) candidate=$resolved_dir/$target ;;
      esac
      continue
    fi
    printf '%s\n' "$candidate"
    return 0
  done
}

file=$(resolve_path "$1") || exit 66
[ -f "$file" ] || exit 66
size=$(wc -c < "$file" 2>/dev/null | tr -d '[:space:]') || exit 66
case "$size" in ''|*[!0-9]*) exit 66 ;; esac
printf 'FILE\t%s\nSIZE\t%s\n' "$file" "$size"

workspace=$(resolve_path "$2" 2>/dev/null) || workspace=
if [ -n "$workspace" ] && [ -d "$workspace" ]; then
  printf 'WORKSPACE\t%s\n' "$workspace"
fi

for root in "$3" "$4"; do
  home=$(resolve_path "$root" 2>/dev/null) || home=
  if [ -n "$home" ] && [ -d "$home" ]; then
    printf 'HOME\t%s\n' "$home"
  fi
done
`.trim();

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
    if (
      hasUnsafeRemotePathCharacters(options.filePath) ||
      !isAllowedRemoteGeneratedArtifactPath(options.filePath, options.remote)
    ) {
      throw new AttachmentRegistrationError('Access to this file is blocked', 403);
    }
    const inspection = await inspectRemoteGeneratedArtifact(options.remote, options.filePath);
    if (!isAllowedCanonicalRemoteGeneratedArtifactPath(inspection)) {
      throw new AttachmentRegistrationError('Access to this file is blocked', 403);
    }
    assertGeneratedArtifactSize(inspection.size);
    const localPath = buildRemoteGeneratedArtifactCachePath(options.sessionId, options.remote, options.filePath);
    const existing = registeredArtifact(options.sessionId, resolvedPathOrOriginal(localPath));
    if (existing) return existing;
    await materializeRemoteGeneratedArtifact(options.sessionId, options.remote, options.filePath, inspection.filePath);
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
  try {
    const stat = await fs.stat(resolvedPath);
    assertGeneratedArtifactSize(stat.size);
  } catch (err) {
    if (err instanceof AttachmentRegistrationError) throw err;
    // Let registerExternalAttachment preserve its existing missing/not-a-file errors.
  }
  return registerExternalAttachment(options.sessionId, options.filePath, {
    sessionWorkingDir: options.sessionWorkingDir,
    forceWorkspaceConfinement,
  });
}

function registeredArtifact(sessionId: string, localPath: string): AttachmentRegistrationResult | undefined {
  const existing = attachmentRegistry.findByFilePath(sessionId, localPath);
  return existing ? attachmentRecordToEvent(existing) : undefined;
}

function resolvedPathOrOriginal(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

export function isAllowedGeneratedArtifactPath(
  filePath: string,
  workingDir: string,
  homeDir: string = homedir()
): boolean {
  const normalizedPath = posixPath.normalize(filePath);
  if (isPathInside(normalizedPath, workingDir)) return true;
  return isAllowedGeneratedArtifactHomePath(normalizedPath, homeDir);
}

function isAllowedGeneratedArtifactHomePath(normalizedPath: string, homeDir: string): boolean {
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

interface RemoteGeneratedArtifactInspection {
  filePath: string;
  size: number;
  workspace?: string;
  homes: string[];
}

function hasUnsafeRemotePathCharacters(filePath: string): boolean {
  return /[\0\r\n]/.test(filePath) || !posixPath.isAbsolute(filePath);
}

async function inspectRemoteGeneratedArtifact(
  remote: SessionRemote,
  remotePath: string
): Promise<RemoteGeneratedArtifactInspection> {
  const args = buildRemoteGeneratedArtifactInspectionArgs(remote, remotePath);
  const { stdout } = (await execFileAsync('ssh', args, {
    encoding: 'utf8',
    timeout: REMOTE_INSPECTION_TIMEOUT_MS,
    maxBuffer: REMOTE_INSPECTION_MAX_BUFFER_BYTES,
  })) as { stdout: string };
  return parseRemoteGeneratedArtifactInspection(stdout);
}

function parseRemoteGeneratedArtifactInspection(stdout: string): RemoteGeneratedArtifactInspection {
  let filePath: string | undefined;
  let size: number | undefined;
  let workspace: string | undefined;
  const homes: string[] = [];

  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const separator = line.indexOf('\t');
    if (separator < 1) throw new Error('Invalid remote artifact inspection response');
    const kind = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (kind === 'FILE' && filePath === undefined) filePath = value;
    else if (kind === 'SIZE' && size === undefined && /^\d+$/.test(value)) size = Number(value);
    else if (kind === 'WORKSPACE' && workspace === undefined) workspace = value;
    else if (kind === 'HOME') homes.push(value);
    else throw new Error('Invalid remote artifact inspection response');
  }

  if (
    !filePath ||
    size === undefined ||
    !Number.isSafeInteger(size) ||
    hasControlCharacters(filePath) ||
    !posixPath.isAbsolute(filePath) ||
    (workspace !== undefined && (hasControlCharacters(workspace) || !posixPath.isAbsolute(workspace))) ||
    homes.some((home) => hasControlCharacters(home) || !posixPath.isAbsolute(home))
  ) {
    throw new AttachmentRegistrationError('Access to this file is blocked', 403);
  }

  return { filePath, size, workspace, homes };
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isAllowedCanonicalRemoteGeneratedArtifactPath(inspection: RemoteGeneratedArtifactInspection): boolean {
  if (inspection.workspace && isPathInside(inspection.filePath, inspection.workspace)) return true;
  return inspection.homes.some((home) => isAllowedGeneratedArtifactHomePath(inspection.filePath, home));
}

function assertGeneratedArtifactSize(size: number): void {
  if (size > MAX_GENERATED_ARTIFACT_BYTES) {
    throw new AttachmentRegistrationError('Attachment file is too large', 413);
  }
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
  cacheKeyPath: string,
  canonicalRemotePath: string
): Promise<string> {
  const localPath = buildRemoteGeneratedArtifactCachePath(sessionId, remote, cacheKeyPath);
  await mkdir(posixPath.dirname(localPath), { recursive: true });

  const args = buildRemoteGeneratedArtifactFetchArgs(remote, canonicalRemotePath);
  let stdout: Buffer;
  try {
    ({ stdout } = (await execFileAsync('ssh', args, {
      encoding: 'buffer',
      timeout: REMOTE_FETCH_TIMEOUT_MS,
      maxBuffer: MAX_GENERATED_ARTIFACT_BYTES + 1,
    })) as { stdout: Buffer });
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new AttachmentRegistrationError('Attachment file is too large', 413);
    }
    throw err;
  }

  assertGeneratedArtifactSize(stdout.length);

  await fs.writeFile(localPath, stdout);
  return localPath;
}

export function buildRemoteGeneratedArtifactInspectionArgs(remote: SessionRemote, remotePath: string): string[] {
  const candidateHomes =
    remote.username === 'root' ? ['/root', '/root'] : [`/home/${remote.username}`, `/Users/${remote.username}`];
  const command = [
    'sh -c',
    shellescape(REMOTE_INSPECTION_SCRIPT),
    'sh',
    shellescape(remotePath),
    shellescape(remote.remotePath),
    ...candidateHomes.map(shellescape),
  ].join(' ');
  return [...buildSshConnectionArgv(remote), remoteSshTarget(remote), command];
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
