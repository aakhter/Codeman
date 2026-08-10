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
  MAX_GENERATED_ARTIFACT_BYTES,
  attachmentRecordToEvent,
  attachmentRegistry,
  isSupportedAttachmentExtension,
  registerExternalAttachment,
  type AttachmentRegistrationResult,
} from './attachment-registry.js';
import { buildSshConnectionArgv, remoteSshTarget, shellescape } from './remote-hosts.js';
import type { SessionRemote } from './types/session.js';
import { isSensitivePath } from './web/sensitive-path.js';

const execFileAsync = promisify(execFile);

const REMOTE_OPERATION_TIMEOUT_MS = 30_000;
const REMOTE_OPERATION_HEADER_MAX_BYTES = 16 * 1024;
const REMOTE_SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

const CODEX_GENERATED_DIRS = [
  '.codex-personal/generated_images',
  '.codex/generated_images',
  '.codex-personal/generated_artifacts',
  '.codex/generated_artifacts',
];

const SUPERPOWERS_ARTIFACT_DIR_MARKERS = ['/output/', '/docs/mockups/'];

export const _REMOTE_GENERATED_ARTIFACT_SCRIPT_FOR_TEST = `
PATH=${REMOTE_SYSTEM_PATH}
export PATH

resolve_path() {
  candidate=$1
  hops=0
  while :; do
    hops=$((hops + 1))
    [ "$hops" -le 40 ] || return 1
    dir=$(/usr/bin/dirname "$candidate") || return 1
    base=$(/usr/bin/basename "$candidate") || return 1
    resolved_dir=$(CDPATH= cd -P "$dir" 2>/dev/null && pwd -P) || return 1
    candidate=$resolved_dir/$base
    if [ -L "$candidate" ]; then
      target=$(/usr/bin/readlink "$candidate") || return 1
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

requested=$1
file=$(resolve_path "$requested") || exit 66
[ -f "$file" ] && [ ! -L "$file" ] || exit 66
exec 3< "$file" || exit 66

confirmed_file=$(resolve_path "$requested") || exit 73
[ "$confirmed_file" = "$file" ] || exit 73
[ -f "$confirmed_file" ] && [ ! -L "$confirmed_file" ] || exit 73

platform=$(/usr/bin/uname -s) || exit 69
case "$platform" in
  Linux)
    fd_path=/proc/$$/fd/3
    path_meta=$(/usr/bin/stat -L -c '%d:%i:%s' "$confirmed_file") || exit 73
    fd_meta=$(/usr/bin/stat -L -c '%d:%i:%s' "$fd_path") || exit 73
    ;;
  Darwin)
    fd_path=/dev/fd/3
    # /dev/fd is mounted from devfs on macOS, so st_dev is synthetic and
    # differs from the target file. The file ID and size still bind the path
    # to the already-open descriptor.
    path_meta=$(/usr/bin/stat -L -f '%i:%z' "$confirmed_file") || exit 73
    fd_meta=$(/usr/bin/stat -L -f '%i:%z' "$fd_path") || exit 73
    ;;
  *) exit 69 ;;
esac

[ -f "$fd_path" ] || exit 73
[ "\${path_meta%:*}" = "\${fd_meta%:*}" ] || exit 73
size=\${fd_meta##*:}
case "$size" in ''|*[!0-9]*) exit 66 ;; esac
printf 'FILE\\000%s\\000SIZE\\000%s\\000' "$confirmed_file" "$size"

workspace=$(resolve_path "$2" 2>/dev/null) || workspace=
if [ -n "$workspace" ] && [ -d "$workspace" ]; then
  printf 'WORKSPACE\\000%s\\000' "$workspace"
fi

home0=$(resolve_path "$3" 2>/dev/null) || home0=
if [ -n "$home0" ] && [ -d "$home0" ]; then
  printf 'HOME0\\000%s\\000' "$home0"
fi

home1=$(resolve_path "$4" 2>/dev/null) || home1=
if [ -n "$home1" ] && [ -d "$home1" ]; then
  printf 'HOME1\\000%s\\000' "$home1"
fi

max_bytes=$6
case "$max_bytes" in ''|*[!0-9]*) exit 64 ;; esac
stream_data=0
case "$5" in
  stream)
    if [ "$size" -le "$max_bytes" ]; then
      data_size=$size
      stream_data=1
    else
      data_size=0
    fi
    ;;
  inspect) data_size=0 ;;
  *) exit 64 ;;
esac
printf 'DATA_SIZE\\000%s\\000DATA\\000' "$data_size"
if [ "$stream_data" -eq 1 ]; then
  /bin/cat <&3 || exit 74
fi
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
      hasControlCharacters(options.remote.remotePath) ||
      !posixPath.isAbsolute(options.remote.remotePath) ||
      !isAllowedRemoteGeneratedArtifactPath(options.filePath, options.remote)
    ) {
      throw new AttachmentRegistrationError('Access to this file is blocked', 403);
    }
    const localPath = buildRemoteGeneratedArtifactCachePath(options.sessionId, options.remote, options.filePath);
    const existing = registeredArtifact(options.sessionId, resolvedPathOrOriginal(localPath));
    const inspection = await runRemoteGeneratedArtifactOperation(options.remote, options.filePath, !existing);
    if (
      !isAllowedCanonicalRemoteGeneratedArtifactPath(inspection) ||
      !isSupportedAttachmentExtension(posixPath.extname(inspection.filePath)) ||
      isSensitiveRemoteGeneratedArtifactPath(inspection)
    ) {
      throw new AttachmentRegistrationError('Access to this file is blocked', 403);
    }
    assertGeneratedArtifactSize(inspection.size);
    if (!existing) await materializeRemoteGeneratedArtifact(localPath, inspection.data);
    return registerExternalAttachment(options.sessionId, localPath, {
      sessionWorkingDir: options.sessionWorkingDir,
      generatedArtifactBoundary: resolvedPathOrOriginal(posixPath.dirname(localPath)),
    });
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
  const generatedArtifactBoundary = findGeneratedArtifactBoundary(resolvedPath, resolvedWorkingDir);
  if (!generatedArtifactBoundary) {
    throw new AttachmentRegistrationError('Access to this file is blocked', 403);
  }
  return registerExternalAttachment(options.sessionId, resolvedPath, {
    sessionWorkingDir: options.sessionWorkingDir,
    generatedArtifactBoundary,
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
  return findGeneratedArtifactBoundary(filePath, workingDir, homeDir) !== undefined;
}

function findGeneratedArtifactBoundary(
  filePath: string,
  workingDir: string,
  homeDir: string = homedir()
): string | undefined {
  const normalizedPath = posixPath.normalize(filePath);
  const normalizedWorkingDir = posixPath.normalize(workingDir);
  if (isPathInside(normalizedPath, normalizedWorkingDir)) return normalizedWorkingDir;

  for (const dir of CODEX_GENERATED_DIRS) {
    const root = posixPath.join(homeDir, dir);
    if (isPathInside(normalizedPath, root)) return root;
  }

  const worktreeRoot = posixPath.join(homeDir, '.config/superpowers/worktrees');
  if (!isPathInside(normalizedPath, worktreeRoot)) return undefined;
  const pathInWorktrees = normalizedPath.slice(ensureTrailingSlash(posixPath.normalize(worktreeRoot)).length);
  for (const marker of SUPERPOWERS_ARTIFACT_DIR_MARKERS) {
    const markerIndex = pathInWorktrees.indexOf(marker);
    if (markerIndex >= 0) {
      return posixPath.join(worktreeRoot, pathInWorktrees.slice(0, markerIndex + marker.length - 1));
    }
  }
  return undefined;
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
  data: Buffer;
}

function hasUnsafeRemotePathCharacters(filePath: string): boolean {
  return /[\0\r\n]/.test(filePath) || !posixPath.isAbsolute(filePath);
}

async function runRemoteGeneratedArtifactOperation(
  remote: SessionRemote,
  remotePath: string,
  streamBytes: boolean
): Promise<RemoteGeneratedArtifactInspection> {
  const args = buildRemoteGeneratedArtifactInspectionArgs(remote, remotePath, streamBytes);
  let stdout: Buffer;
  try {
    ({ stdout } = (await execFileAsync('ssh', args, {
      encoding: 'buffer',
      timeout: REMOTE_OPERATION_TIMEOUT_MS,
      maxBuffer: streamBytes
        ? MAX_GENERATED_ARTIFACT_BYTES + REMOTE_OPERATION_HEADER_MAX_BYTES + 1
        : REMOTE_OPERATION_HEADER_MAX_BYTES,
    })) as { stdout: Buffer });
  } catch (err) {
    throwRemoteGeneratedArtifactProcessError(err);
  }
  return parseRemoteGeneratedArtifactInspection(stdout, streamBytes);
}

function parseRemoteGeneratedArtifactInspection(
  stdout: Buffer,
  streamBytes: boolean
): RemoteGeneratedArtifactInspection {
  let filePath: string | undefined;
  let size: number | undefined;
  let dataSize: number | undefined;
  let workspace: string | undefined;
  const homes: string[] = [];
  const seenKinds = new Set<string>();
  let data: Buffer | undefined;
  let offset = 0;

  const readField = (): string => {
    const end = stdout.indexOf(0, offset);
    if (end < 0) throw new Error('Invalid remote artifact inspection response');
    const value = stdout.subarray(offset, end).toString('utf8');
    offset = end + 1;
    return value;
  };

  while (offset < stdout.length) {
    const kind = readField();
    if (!kind || seenKinds.has(kind)) {
      throw new Error('Invalid remote artifact inspection response');
    }
    seenKinds.add(kind);
    if (kind === 'DATA') {
      data = stdout.subarray(offset);
      offset = stdout.length;
      break;
    }
    const value = readField();
    if (kind === 'FILE') filePath = value;
    else if (kind === 'SIZE' && /^\d+$/.test(value)) size = Number(value);
    else if (kind === 'DATA_SIZE' && /^\d+$/.test(value)) dataSize = Number(value);
    else if (kind === 'WORKSPACE') workspace = value;
    else if (kind === 'HOME0' || kind === 'HOME1') homes.push(value);
    else throw new Error('Invalid remote artifact inspection response');
  }

  if (
    filePath === undefined ||
    size === undefined ||
    dataSize === undefined ||
    data === undefined ||
    !Number.isSafeInteger(dataSize) ||
    data.length !== dataSize ||
    dataSize !== (streamBytes && size <= MAX_GENERATED_ARTIFACT_BYTES ? size : 0)
  ) {
    throw new Error('Invalid remote artifact inspection response');
  }

  if (
    !filePath ||
    !Number.isSafeInteger(size) ||
    hasControlCharacters(filePath) ||
    !posixPath.isAbsolute(filePath) ||
    (workspace !== undefined && (hasControlCharacters(workspace) || !posixPath.isAbsolute(workspace))) ||
    homes.some((home) => hasControlCharacters(home) || !posixPath.isAbsolute(home))
  ) {
    throw new AttachmentRegistrationError('Access to this file is blocked', 403);
  }

  return { filePath, size, workspace, homes, data };
}

export function _parseRemoteGeneratedArtifactOutputForTest(
  stdout: Buffer,
  streamBytes: boolean
): RemoteGeneratedArtifactInspection {
  return parseRemoteGeneratedArtifactInspection(stdout, streamBytes);
}

function throwRemoteGeneratedArtifactProcessError(err: unknown): never {
  if ((err as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    throw new AttachmentRegistrationError('Attachment file is too large', 413);
  }
  throw err;
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

function isSensitiveRemoteGeneratedArtifactPath(inspection: RemoteGeneratedArtifactInspection): boolean {
  if (isSensitivePath(inspection.filePath)) return true;
  return inspection.homes.some((home) => isPathInside(inspection.filePath, posixPath.join(home, '.ssh')));
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

async function materializeRemoteGeneratedArtifact(localPath: string, data: Buffer): Promise<string> {
  await mkdir(posixPath.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, data);
  return localPath;
}

export function buildRemoteGeneratedArtifactInspectionArgs(
  remote: SessionRemote,
  remotePath: string,
  streamBytes = false
): string[] {
  const candidateHomes =
    remote.username === 'root' ? ['/root', '/root'] : [`/home/${remote.username}`, `/Users/${remote.username}`];
  const command = [
    `PATH=${REMOTE_SYSTEM_PATH}`,
    '/bin/sh -c',
    shellescape(_REMOTE_GENERATED_ARTIFACT_SCRIPT_FOR_TEST),
    'codeman-generated-artifact',
    shellescape(remotePath),
    shellescape(remote.remotePath),
    ...candidateHomes.map(shellescape),
    streamBytes ? 'stream' : 'inspect',
    String(MAX_GENERATED_ARTIFACT_BYTES),
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

function sanitizeCacheFileName(fileName: string): string {
  return fileName.replace(/[^A-Za-z0-9._-]/g, '_') || 'artifact';
}
