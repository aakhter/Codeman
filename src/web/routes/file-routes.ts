/**
 * @fileoverview File browser and streaming routes.
 * Provides directory listing, file content preview, raw file serving, tail
 * streaming, and the File Viewer edit-mode write path (edit=1 read +
 * PUT /api/sessions/:id/file-content; policy in src/config/file-editing.ts,
 * design in docs/file-viewer-edit-plan.md).
 */

import { FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  basename as pathBasename,
  dirname,
  extname,
  isAbsolute,
  join,
  posix as pathPosix,
  relative,
  resolve,
  sep,
} from 'node:path';
import { createReadStream, realpathSync, type ReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  ApiErrorCode,
  createErrorResponse,
  getErrorMessage,
  type ApiResponse,
  type FilesystemBrowseData,
  type FilesystemBrowseEntry,
  type FilesystemBrowseRoot,
  type FilesystemPreviewKind,
  type FileWriteData,
  type SessionAttachmentHistoryItem,
  type SessionState,
  type AuthUser,
} from '../../types.js';
import { fileStreamManager } from '../../file-stream-manager.js';
import {
  AttachmentRegistrationError,
  attachmentRecordToEvent,
  attachmentRegistry,
  buildAttachmentRoutes,
  buildFileThumbnailRoute,
  getAttachmentType,
  isSupportedAttachmentExtension,
  resolveGeneratedArtifactReadPath,
  registerExternalAttachment,
  type AttachmentRecord,
} from '../../attachment-registry.js';
import {
  documentMagicMatchesExt,
  isAllowedUploadExtension,
  sanitizeUploadFilename,
  UPLOAD_ALLOWED_EXTENSIONS,
} from '../document-upload.js';
import { MAX_PASTE_IMAGE_BYTES } from '../../config/buffer-limits.js';
import { buildExternalAttachmentHistoryItem, sanitizeAttachmentHistoryItem } from '../../session-attachment-history.js';
import { generateFirstPageThumbnail } from '../../document-thumbnailer.js';
import { getOfficePreviewPdfPath, getPreviewPdfDownloadName } from '../../document-preview-cache.js';
import {
  buildTextExportHtml,
  classifyExportBranch,
  convertHtmlToPdf,
  isSupportedExportFormat,
} from '../../document-pdf-export.js';
import { documentVersionStore } from '../../document-version-store.js';
import {
  convertDocxToHtml,
  extractDocumentText,
  isBinaryDocExtension,
  isDiffableDocExtension,
} from '../../document-text-extract.js';
import { wordDiff } from '../../utils/word-diff.js';
import { compileFileQuery } from '../../utils/file-query.js';
import { isMultiUserMode, userSpacePath } from '../../config/multiuser.js';
import {
  CASES_DIR,
  canAccessOwned,
  findSessionOrFail,
  getAuthUser,
  parseBody,
  validateSessionFilePath,
} from '../route-helpers.js';
import { parseByteRange } from '../http-range.js';
import { isSensitivePath } from '../sensitive-path.js';
import {
  isBlockedAttachmentPath,
  loadAttachmentGuardConfig,
  resolveLocalUploadDirectory,
  UploadDirectoryResolutionError,
} from '../../config/attachment-guard.js';
import { SseEvent } from '../sse-events.js';
import { writeRemoteFileBytes } from '../../remote-file-transfer.js';
import {
  downloadRemoteWorkspaceFile,
  getRemoteWorkspaceFileInfo,
  listRemoteWorkspaceDirectory,
  readRemoteWorkspaceFile,
  remoteWorkspacePath,
} from '../../remote-sftp.js';
import { dataPath } from '../../config/instance.js';
import { registerGeneratedArtifactAttachment } from '../../generated-artifact-attachments.js';
import type { ConfigPort, EventPort, SessionPort } from '../ports/index.js';
import { FilesystemBrowseQuerySchema, FilesystemPreviewQuerySchema, FileWriteSchema } from '../schemas.js';
import {
  MAX_EDITABLE_BYTES,
  applyEol,
  detectEol,
  isDeniedEditRelativePath,
  isEditableFileName,
} from '../../config/file-editing.js';

// Client-side hard timeout for the remote document-upload ssh transfer. Mirrors
// the paste-image timeout (session-routes.ts) so both remote writes behave the same.
const REMOTE_ATTACHMENT_SSH_TIMEOUT_MS = 15_000;
export const MAX_XLSX_BROWSER_PREVIEW_BYTES = 10 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
};

function sanitizeDownloadName(fileName: string): string {
  return fileName.replace(/["\\\r\n]/g, '_');
}

function parsePreviewFileUri(uri: unknown): string {
  if (typeof uri !== 'string' || uri.trim().length === 0) {
    throw new AttachmentRegistrationError('Missing file URI', 400);
  }

  let filePath: string;
  try {
    if (!/^file:\/\/\//i.test(uri)) throw new Error('form');
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:' || parsed.hostname !== '') throw new Error('scheme');
    filePath = fileURLToPath(parsed);
  } catch {
    throw new AttachmentRegistrationError('Invalid file URI', 400);
  }

  const extension = extname(filePath).slice(1).toLowerCase();
  if (!isAbsolute(filePath) || !isSupportedAttachmentExtension(extension)) {
    throw new AttachmentRegistrationError('Unsupported file URI', 400);
  }
  return filePath;
}

function buildContentDisposition(disposition: 'inline' | 'attachment', fileName: string): string {
  const cleaned = fileName.replace(/["\\\r\n]/g, '_');
  const fallback = cleaned.replace(/[^\x20-\x7e]/g, '_') || 'file';
  const encoded = encodeURIComponent(cleaned).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function sendRawStream(reply: FastifyReply, content: ReadStream, onClose?: () => void): void {
  const headers = reply.getHeaders();
  // hijack() answers on reply.raw, which keeps Fastify's own status handling out
  // of the picture — so a 206 set with reply.code() has to be carried across by
  // hand or a partial body would go out labelled 200 and the browser would treat
  // it as the whole file.
  const statusCode = reply.statusCode;
  reply.hijack();
  reply.raw.statusCode = statusCode;

  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      reply.raw.setHeader(name, value);
    }
  }

  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    onClose?.();
  };
  content.on('error', (err) => {
    finish();
    if (reply.raw.headersSent) {
      reply.raw.destroy(err);
      return;
    }

    reply.raw.statusCode = 500;
    reply.raw.end('Failed to read file');
  });
  content.once('close', finish);
  content.pipe(reply.raw);
}

/**
 * Stream a file body, honoring a `Range` request header.
 *
 * Callers set Content-Type/Content-Disposition first; this adds the
 * range-related headers and the body. Range support is what makes the file
 * viewer's `<video>`/`<audio>` seekable: with a plain 200 and no
 * `Accept-Ranges`, Chrome reports `video.seekable` as `[0, 0]`, the scrub bar
 * does nothing and `currentTime = x` is silently reverted (measured against an
 * 18MB mp4 before this existed). It also stops each seek from re-reading the
 * whole file into memory.
 */
function sendFileBody(
  reply: FastifyReply,
  resolvedPath: string,
  size: number,
  rangeHeader: string | string[] | undefined,
  onClose?: () => void
): void {
  reply.header('Accept-Ranges', 'bytes');
  const range = parseByteRange(rangeHeader, size);

  if (range.kind === 'unsatisfiable') {
    reply
      .code(416)
      .header('Content-Range', `bytes */${size}`)
      .type('application/json; charset=utf-8')
      .send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Requested range not satisfiable'));
    onClose?.();
    return;
  }

  if (range.kind === 'partial') {
    reply.code(206);
    reply.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    reply.header('Content-Length', range.end - range.start + 1);
    sendRawStream(reply, createReadStream(resolvedPath, { start: range.start, end: range.end }), onClose);
    return;
  }

  reply.header('Content-Length', size);
  sendRawStream(reply, createReadStream(resolvedPath), onClose);
}

async function serveRawFile(
  reply: FastifyReply,
  resolvedPath: string,
  fileName: string,
  extension: string,
  download?: boolean,
  rangeHeader?: string | string[],
  maxSizeBytes?: number,
  onClose?: () => void
): Promise<void> {
  const stat = await fs.stat(resolvedPath);
  // Optional cap: the by-id attachment raw route bounds its response (an
  // attacker-influenceable registry id resolves to an arbitrary host file), but
  // the workspace-scoped file-raw route streams without an app-level cap.
  if (maxSizeBytes !== undefined && stat.size > maxSizeBytes) {
    reply
      .code(413)
      .send(
        createErrorResponse(
          ApiErrorCode.INVALID_INPUT,
          `File too large (${Math.round(stat.size / 1024 / 1024)}MB > ${maxSizeBytes / 1024 / 1024}MB limit)`
        )
      );
    return;
  }
  if (download || extension === 'svg') {
    reply.header(
      'Content-Type',
      extension === 'svg' ? 'application/octet-stream' : MIME_TYPES[extension] || 'application/octet-stream'
    );
    reply.header('Content-Disposition', buildContentDisposition('attachment', fileName));
    reply.header('X-Content-Type-Options', 'nosniff');
    sendFileBody(reply, resolvedPath, stat.size, rangeHeader, onClose);
    return;
  }

  reply.header('Content-Type', MIME_TYPES[extension] || 'application/octet-stream');
  reply.header('Content-Disposition', buildContentDisposition('inline', fileName));
  reply.header('X-Content-Type-Options', 'nosniff');
  sendFileBody(reply, resolvedPath, stat.size, rangeHeader, onClose);
}

async function serveConvertedPreview(
  reply: FastifyReply,
  resolvedPath: string,
  fileName: string,
  extension: string
): Promise<void> {
  if (extension !== 'docx' && extension !== 'pptx') {
    reply
      .code(400)
      .send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Preview is not supported for this file type'));
    return;
  }

  try {
    const previewPath = await getOfficePreviewPdfPath(resolvedPath, extension);
    if (!previewPath) {
      reply.code(500).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Document preview conversion failed'));
      return;
    }

    const content = await fs.readFile(previewPath);
    reply.header('Content-Type', 'application/pdf');
    reply.header(
      'Content-Disposition',
      buildContentDisposition('inline', getPreviewPdfDownloadName(fileName, extension))
    );
    reply.header('Cache-Control', 'no-cache');
    reply.header('Content-Length', content.length);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.send(content);
  } catch (err) {
    reply
      .code(500)
      .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to generate preview: ${getErrorMessage(err)}`));
  }
}

async function sendPdfDownload(reply: FastifyReply, content: Buffer, downloadName: string): Promise<void> {
  reply.header('Content-Type', 'application/pdf');
  reply.header('Content-Disposition', `attachment; filename="${sanitizeDownloadName(downloadName)}"`);
  reply.header('Cache-Control', 'no-cache');
  reply.header('Content-Length', content.length);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.send(content);
}

async function serveThumbnail(reply: FastifyReply, resolvedPath: string, extension: string): Promise<void> {
  const thumbnail = await generateFirstPageThumbnail(resolvedPath, extension);
  if (!thumbnail) {
    reply.code(204).send();
    return;
  }

  reply.header('Content-Type', thumbnail.contentType);
  reply.header('Cache-Control', 'no-cache');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.send(thumbnail.content);
}

function getAttachmentOr404(
  reply: FastifyReply,
  sessionId: string,
  attachmentId: string
): AttachmentRecord | undefined {
  const record = attachmentRegistry.get(sessionId, attachmentId);
  if (!record) {
    reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Attachment not found'));
    return undefined;
  }
  return record;
}

/**
 * COD-53 defense-in-depth: refuse to stream a record whose underlying path is
 * blocked by the active attachment-guard policy, even though registration
 * already blocks them. Guards against records that predate the guard or were
 * crafted to point at a sensitive file. Resolves symlinks before the check so a
 * record pointing at a symlink that now resolves to a sensitive target is also
 * caught; if the path can't be resolved (deleted/unreadable) the check still
 * runs on the stored path. Uses the broadened blocklist (secret locations +
 * `/root`/`/etc` trees + operator extras); when workspace confinement is
 * enabled it additionally rejects any record outside the session workspace.
 *
 * Returns the path that is SAFE to stream — the freshly realpath-resolved target
 * when resolvable, else the stored path — or null (after sending a 403) when
 * blocked. Streaming the resolved path closes a TOCTOU window: a path component
 * swapped to a symlink after registration would otherwise redirect the stream to
 * a different file than the guard checked. The metadata/preview/thumbnail routes
 * that only need the boolean verdict treat a null result as "blocked".
 */
async function resolveServableAttachmentPath(
  reply: FastifyReply,
  record: AttachmentRecord,
  sessionWorkingDir?: string
): Promise<string | null> {
  let pathToCheck = record.filePath;
  let resolved = false;
  try {
    const generatedPath = await resolveGeneratedArtifactReadPath(record);
    if (generatedPath) {
      pathToCheck = generatedPath;
      resolved = true;
    }
  } catch (err) {
    if (err instanceof AttachmentRegistrationError) {
      reply.code(err.statusCode).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, err.message));
      return null;
    }
    throw err;
  }

  if (!resolved) {
    try {
      pathToCheck = realpathSync(record.filePath);
      resolved = true;
    } catch {
      // Fall back to the stored (already realpath-resolved at registration) path.
    }
  }

  const guard = await loadAttachmentGuardConfig();

  const blocked =
    isBlockedAttachmentPath(pathToCheck, guard.blockedTrees) ||
    isBlockedAttachmentPath(record.filePath, guard.blockedTrees) ||
    (guard.confineToWorkspace && (!sessionWorkingDir || !validateSessionFilePath(sessionWorkingDir, pathToCheck)));

  if (blocked) {
    reply.code(403).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Access to this file is blocked'));
    return null;
  }
  // Serve the freshly-resolved path, not the stored one: if a path component
  // became a symlink after registration, the guard checked the resolved target
  // but streaming record.filePath would follow the symlink to a swapped file.
  return resolved ? pathToCheck : record.filePath;
}

// Persisted sessions carry the private (externalPath-bearing) history under a
// `__attachmentHistory` key so the list route can re-register external files.
type StoredSessionWithPrivateAttachmentHistory = SessionState & {
  __attachmentHistory?: SessionAttachmentHistoryItem[];
};

type AttachmentHistoryRouteItem = Omit<SessionAttachmentHistoryItem, 'externalPath' | 'generatedArtifactBoundary'> & {
  missing: boolean;
  rawUrl?: string;
  url?: string;
  previewUrl?: string;
  thumbnailUrl?: string;
  downloadUrl?: string;
  attachmentId?: string;
};

const FILESYSTEM_PICKER_ENTRY_LIMIT = 500;
const FILESYSTEM_TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;
const FILESYSTEM_BINARY_PREVIEW_LIMIT = 50 * 1024 * 1024;
const FILESYSTEM_IMAGE_PREVIEW_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const FILESYSTEM_TEXT_PREVIEW_EXTENSIONS = new Set(['md', 'txt', 'json']);
const FILESYSTEM_DOCUMENT_PREVIEW_EXTENSIONS = new Set(['pdf', 'docx', 'pptx']);

function isPathWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function findMatchingPickerRoot(roots: FilesystemBrowseRoot[], candidate: string): FilesystemBrowseRoot | undefined {
  return roots
    .filter((root) => isPathWithinRoot(root.path, candidate))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/**
 * Whether a path has a dot-prefixed segment anywhere below its browse root.
 *
 * Checked against the REALPATH, so a plainly-named symlink pointing into a
 * hidden tree is caught too. Callers skip it when the request opts into hidden
 * entries (`showHidden`), which is why the sensitive-path blocklist and the
 * blocked-tree checks must stand on their own: with the toggle on, this is no
 * longer the thing keeping `~/.config/gh/hosts.yml` out of reach.
 */
function containsHiddenPickerSegment(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && rel.split(sep).some((segment) => segment.startsWith('.'));
}

/** Parses the picker's opt-in `showHidden` query flag (absent means off). */
function wantsHiddenPickerEntries(showHidden?: string): boolean {
  return showHidden === 'true';
}

function getFilesystemPreviewKind(fileName: string): FilesystemPreviewKind | undefined {
  const extension = extname(fileName).slice(1).toLowerCase();
  if (FILESYSTEM_IMAGE_PREVIEW_EXTENSIONS.has(extension)) return 'image';
  if (FILESYSTEM_TEXT_PREVIEW_EXTENSIONS.has(extension)) return 'text';
  if (FILESYSTEM_DOCUMENT_PREVIEW_EXTENSIONS.has(extension)) return 'document';
  return undefined;
}

function isBlockedPickerPath(path: string, blockedTrees: readonly string[], directory = false): boolean {
  if (isBlockedAttachmentPath(path, blockedTrees)) return true;
  // The shared sensitive-path matcher describes file locations such as
  // ~/.ssh/<key>. Probe a child path as well so the directory itself cannot be
  // opened and used to enumerate those filenames.
  return directory && isBlockedAttachmentPath(join(path, '__codeman_path_picker_probe__'), blockedTrees);
}

function extraConfiguredPickerRoots(): Array<{ label: string; path: string }> {
  const extraRoots = process.env.CODEMAN_FILE_PICKER_ROOTS;
  if (!extraRoots) return [];
  return extraRoots
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((path, index) => ({ label: `Configured ${index + 1}`, path }));
}

/**
 * Browse roots for the requesting identity.
 *
 * Single-user mode (and multi-user admins) get the host-wide set. ⚠️ A regular
 * multi-user user must NOT: per-user spaces live at `<USER_SPACES_DIR>/<name>`,
 * which is *inside* `homedir()`, so handing out a `Home` root would let any
 * authenticated user browse and preview every other user's workspace. The
 * shared `CASES_DIR` leaks the same way, and `/mnt/d` is a broad host mount
 * that a multi-user deployment should not expose by default. Operators who
 * genuinely want a shared area can still name it in `CODEMAN_FILE_PICKER_ROOTS`,
 * which stays an explicit opt-in in both modes.
 */
function configuredFilesystemPickerRoots(req: FastifyRequest): Array<{ label: string; path: string }> {
  const user = getAuthUser(req);
  if (isMultiUserMode() && user.role !== 'admin') {
    return [{ label: 'My Space', path: userSpacePath(user.username) }, ...extraConfiguredPickerRoots()];
  }
  return [
    { label: 'Home', path: homedir() },
    { label: 'Codeman Cases', path: CASES_DIR },
    { label: 'WSL D:', path: '/mnt/d' },
    ...extraConfiguredPickerRoots(),
  ];
}

async function resolveFilesystemPickerRoots(
  ctx: SessionPort & ConfigPort,
  req: FastifyRequest,
  sessionId?: string
): Promise<FilesystemBrowseRoot[]> {
  const candidates = configuredFilesystemPickerRoots(req);
  if (sessionId) {
    const session = ctx.sessions.get(sessionId) ?? ctx.store.getSession(sessionId);
    // ⚠️ Ownership must be checked here, exactly as `findSessionOrFail` does for
    // the other session-scoped handlers in this file. Without it a multi-user
    // caller could pin ANOTHER user's `workingDir` as a browse root just by
    // passing their sessionId. Report not-found rather than forbidden so the
    // endpoint does not confirm that a session id exists.
    if (!session || !canAccessOwned(getAuthUser(req), (session as { owner?: string }).owner)) {
      throw Object.assign(new Error(`Session ${sessionId} not found`), {
        statusCode: 404,
        body: createErrorResponse(ApiErrorCode.NOT_FOUND, `Session ${sessionId} not found`),
      });
    }
    candidates.unshift({ label: 'Current Folder', path: session.workingDir });
  }

  const guard = await loadAttachmentGuardConfig();
  const roots: FilesystemBrowseRoot[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!isAbsolute(candidate.path)) continue;
    try {
      const resolved = realpathSync(candidate.path);
      if (seen.has(resolved) || isBlockedPickerPath(resolved, guard.blockedTrees, true)) continue;
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) continue;
      seen.add(resolved);
      roots.push({ label: candidate.label, path: resolved });
    } catch {
      // Optional roots (for example /mnt/d on non-WSL hosts) are omitted.
    }
  }
  return roots;
}

type ResolvedFilesystemPickerPath = {
  candidatePath: string;
  resolvedPath: string;
  roots: FilesystemBrowseRoot[];
  matchingRoot: FilesystemBrowseRoot;
  blockedTrees: readonly string[];
};

function throwFilesystemPickerError(statusCode: number, code: ApiErrorCode, message: string): never {
  throw Object.assign(new Error(message), {
    statusCode,
    body: createErrorResponse(code, message),
  });
}

async function resolveFilesystemPickerPath(
  ctx: SessionPort & ConfigPort,
  req: FastifyRequest,
  requestedPath: string | undefined,
  sessionId?: string,
  showHidden = false
): Promise<ResolvedFilesystemPickerPath> {
  const roots = await resolveFilesystemPickerRoots(ctx, req, sessionId);
  if (roots.length === 0) {
    throwFilesystemPickerError(403, ApiErrorCode.INVALID_INPUT, 'No filesystem browse roots are available');
  }

  const fallbackRoot =
    roots.find((root) => root.label === 'Current Folder') ?? roots.find((root) => root.path === '/mnt/d') ?? roots[0];
  const candidatePath = resolve(requestedPath ?? fallbackRoot.path);

  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(candidatePath);
  } catch {
    throwFilesystemPickerError(404, ApiErrorCode.NOT_FOUND, `Path not found: ${candidatePath}`);
  }

  const matchingRoot = findMatchingPickerRoot(roots, resolvedPath);
  if (!matchingRoot) {
    throwFilesystemPickerError(403, ApiErrorCode.INVALID_INPUT, 'Path is outside the allowed browse roots');
  }
  if (!showHidden && containsHiddenPickerSegment(matchingRoot.path, resolvedPath)) {
    throwFilesystemPickerError(403, ApiErrorCode.INVALID_INPUT, 'Hidden paths are not available in the file picker');
  }

  const guard = await loadAttachmentGuardConfig();
  return { candidatePath, resolvedPath, roots, matchingRoot, blockedTrees: guard.blockedTrees };
}

function appendDownloadFlag(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}download=true`;
}

/**
 * Resolve a session's working dir from the live session, falling back to the
 * persisted record so preview/thumbnail requests keep working for a session
 * that has since detached. Sends a 404 and returns undefined when unknown.
 */
function getKnownSessionWorkingDir(
  ctx: SessionPort & ConfigPort,
  sessionId: string,
  reply: FastifyReply,
  req: FastifyRequest
): string | undefined {
  // Multi-user: a non-admin may only reach their OWN session's files. A foreign
  // (or missing) session is reported identically as 404 so existence isn't leaked.
  const user = getAuthUser(req);
  const liveSession = ctx.sessions.get(sessionId);
  if (liveSession && canAccessOwned(user, liveSession.owner)) return liveSession.workingDir;

  const stored = ctx.store.getSession(sessionId) as StoredSessionWithPrivateAttachmentHistory | undefined;
  if (stored && canAccessOwned(user, (stored as { owner?: string }).owner)) return stored.workingDir;

  reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, `Session ${sessionId} not found`));
  return undefined;
}

// ===== File Viewer edit mode (issue #212) =====
// Policy lives in src/config/file-editing.ts; design in docs/file-viewer-edit-plan.md.

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** NUL byte in the first 8KB — same binary signal the plain read path uses. */
function sniffsBinary(buf: Buffer): boolean {
  const sniffLength = Math.min(buf.length, 8192);
  for (let i = 0; i < sniffLength; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Structured-throw variant for the edit read/write paths. Identical mechanics to
 * throwFilesystemPickerError (rendered by the central route error handler both
 * in prod and in the app.inject() test harness); a separate name only so edit
 * failures grep distinctly.
 */
function throwFileEditError(statusCode: number, code: ApiErrorCode, message: string): never {
  throw Object.assign(new Error(message), {
    statusCode,
    body: createErrorResponse(code, message),
  });
}

/**
 * Gate a resolved workspace file for edit-mode read/write. Throws a structured
 * error when the file may not be edited; returns void when it may. Order
 * matters for the message a user sees: confinement (the caller's 404) →
 * sensitive/blocked (403) → .git (403) → extension allowlist (400).
 */
function assertEditableTarget(resolvedPath: string, relativePath: string, blockedTrees: readonly string[]): void {
  if (isSensitivePath(resolvedPath) || isBlockedAttachmentPath(resolvedPath, blockedTrees)) {
    throwFileEditError(403, ApiErrorCode.FORBIDDEN, 'Editing this file is blocked');
  }
  if (isDeniedEditRelativePath(relativePath)) {
    throwFileEditError(403, ApiErrorCode.FORBIDDEN, 'Files under .git cannot be edited');
  }
  if (!isEditableFileName(pathBasename(resolvedPath))) {
    throwFileEditError(400, ApiErrorCode.INVALID_INPUT, 'This file type is not editable');
  }
}

/**
 * Decode a candidate edit buffer, refusing binary and non-UTF-8 content. The
 * round-trip compare is what protects against silent corruption: decoding
 * latin-1 (or any non-UTF-8) bytes yields U+FFFD replacements, and writing
 * those back would destroy the original bytes. A UTF-8 BOM round-trips and is
 * deliberately preserved.
 */
function decodeEditableText(buf: Buffer): string {
  if (sniffsBinary(buf)) {
    throwFileEditError(400, ApiErrorCode.INVALID_INPUT, 'Binary files cannot be edited');
  }
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) {
    throwFileEditError(400, ApiErrorCode.INVALID_INPUT, 'Only UTF-8 text files can be edited');
  }
  return text;
}

function getSessionAttachmentHistory(
  ctx: SessionPort & ConfigPort,
  sessionId: string,
  req: FastifyRequest
): { workingDir: string; history: SessionAttachmentHistoryItem[] } | undefined {
  const user = getAuthUser(req);
  const liveSession = ctx.sessions.get(sessionId);
  if (liveSession) {
    if (!canAccessOwned(user, liveSession.owner)) return undefined;
    return {
      workingDir: liveSession.workingDir,
      history: liveSession.getAttachmentHistoryForPersist() ?? liveSession.attachmentHistory ?? [],
    };
  }

  const stored = ctx.store.getSession(sessionId) as StoredSessionWithPrivateAttachmentHistory | undefined;
  if (!stored || !canAccessOwned(user, (stored as { owner?: string }).owner)) return undefined;

  return {
    workingDir: stored.workingDir,
    history: stored.__attachmentHistory ?? stored.attachmentHistory ?? [],
  };
}

// History item for a file detected inside the workspace: re-stat for live
// size/mtime and resolve preview/thumbnail/raw routes off the relative path.
async function buildDetectedAttachmentRouteItem(
  sessionId: string,
  workingDir: string,
  item: SessionAttachmentHistoryItem
): Promise<AttachmentHistoryRouteItem> {
  const safe = sanitizeAttachmentHistoryItem(item);
  if (!item.relativePath) {
    return { ...safe, missing: true };
  }

  const validated = validateSessionFilePath(workingDir, item.relativePath);
  if (!validated) {
    return { ...safe, missing: true };
  }

  let size = item.size;
  let mtimeMs = item.mtimeMs;
  try {
    const stat = await fs.stat(validated.resolvedPath);
    size = stat.size;
    mtimeMs = stat.mtimeMs ?? mtimeMs;
  } catch {
    return { ...safe, missing: true };
  }

  const encodedPath = encodeURIComponent(item.relativePath);
  const rawUrl = `/api/sessions/${sessionId}/file-raw?path=${encodedPath}`;
  const previewUrl =
    item.extension === 'docx' || item.extension === 'pptx'
      ? `/api/sessions/${sessionId}/file-preview?path=${encodedPath}`
      : item.extension === 'xlsx'
        ? `${rawUrl}&preview=true`
        : rawUrl;
  const thumbnailUrl = isSupportedAttachmentExtension(item.extension)
    ? buildFileThumbnailRoute(sessionId, item.relativePath)
    : undefined;

  return {
    ...safe,
    size,
    mtimeMs,
    missing: false,
    rawUrl,
    url: rawUrl,
    previewUrl,
    thumbnailUrl,
    downloadUrl: appendDownloadFlag(rawUrl),
  };
}

// History item for an explicitly published external file: re-register it to mint
// a fresh id + by-id routes (the guard runs again), or mark it missing.
async function buildExternalAttachmentRouteItem(
  sessionId: string,
  item: SessionAttachmentHistoryItem,
  sessionWorkingDir: string | undefined,
  authUser: AuthUser
): Promise<AttachmentHistoryRouteItem> {
  const safe = sanitizeAttachmentHistoryItem(item);
  if (!item.externalPath) {
    return { ...safe, missing: true };
  }

  try {
    let trustedUploadBoundary: string | undefined;
    if (item.uploadProvenance === 'codeman-upload' && sessionWorkingDir) {
      const uploadDirectory = await resolveLocalUploadDirectory(sessionWorkingDir, authUser);
      if (uploadDirectory.kind === 'trusted') {
        const canonicalFile = realpathSync(item.externalPath);
        if (dirname(canonicalFile) !== uploadDirectory.canonicalDir || pathBasename(canonicalFile) !== item.fileName) {
          throw new AttachmentRegistrationError('Access to this file is blocked', 403);
        }
        trustedUploadBoundary = uploadDirectory.canonicalDir;
      }
    }
    const event = await registerExternalAttachment(sessionId, item.externalPath, {
      sessionWorkingDir,
      generatedArtifactBoundary: item.uploadProvenance ? undefined : item.generatedArtifactBoundary,
      trustedUploadBoundary,
    });
    // COD-241 unit 3: expose a workspace-relative path for Codeman-uploaded
    // copies (those inside .codeman-attachments/). The frontend gates its
    // "Remove" affordance on `relativePath` starting with `.codeman-attachments/`
    // and feeds that path to DELETE …/attachments/uploaded. externalPath itself
    // stays stripped (never leaves the server); only the confined relative path
    // is surfaced. Non-workspace published files resolve to null → no relativePath
    // → no Remove button.
    const validated = sessionWorkingDir ? validateSessionFilePath(sessionWorkingDir, item.externalPath) : null;
    const ownedRelativePath = trustedUploadBoundary
      ? pathPosix.join('.codeman-attachments', event.fileName)
      : validated &&
          (validated.relativePath === '.codeman-attachments' ||
            validated.relativePath.startsWith(`.codeman-attachments${sep}`))
        ? validated.relativePath
        : undefined;
    return {
      ...safe,
      fileName: event.fileName,
      extension: event.extension,
      attachmentType: event.attachmentType,
      size: event.size,
      missing: false,
      attachmentId: event.attachmentId,
      relativePath: ownedRelativePath,
      rawUrl: event.rawUrl,
      url: event.rawUrl,
      previewUrl: event.previewUrl,
      thumbnailUrl: event.thumbnailUrl,
      downloadUrl: appendDownloadFlag(event.rawUrl),
    };
  } catch (err) {
    if (err instanceof AttachmentRegistrationError) {
      return { ...safe, missing: true };
    }
    throw err;
  }
}

/**
 * Snapshot a document into the version store if it changed (COD-59/COD-66).
 * Called off the live-preview poll and the document endpoints, so the authoring
 * loop accumulates a diffable history without a file watcher. Text docs (md/txt)
 * store their UTF-8 content; binary docs (docx) store raw bytes for byte-perfect
 * rollback plus pandoc-extracted text for the word diff.
 */
async function captureDocumentVersion(sessionId: string, filePath: string, extension: string): Promise<void> {
  if (!isDiffableDocExtension(extension)) return;
  try {
    const stat = await fs.stat(filePath);
    const latest = documentVersionStore.latest(sessionId, filePath);
    if (latest && latest.mtimeMs === (stat.mtimeMs ?? 0) && latest.size === stat.size) return;
    if (isBinaryDocExtension(extension)) {
      const raw = await fs.readFile(filePath); // Buffer
      const text = await extractDocumentText(filePath, extension);
      documentVersionStore.record(sessionId, filePath, text, stat.mtimeMs ?? 0, stat.size, raw);
    } else {
      const content = await fs.readFile(filePath, 'utf-8');
      documentVersionStore.record(sessionId, filePath, content, stat.mtimeMs ?? 0, stat.size);
    }
  } catch {
    // File mid-write or unreadable — skip this capture.
  }
}

interface DocumentTarget {
  filePath: string;
  extension: string;
}

/**
 * Resolve a document request (by attachmentId or workspace-relative path) to an
 * absolute file path + extension, or send an error response and return undefined.
 */
async function resolveDocumentTarget(
  ctx: SessionPort & ConfigPort,
  reply: FastifyReply,
  sessionId: string,
  target: { attachmentId?: string; path?: string },
  req: FastifyRequest
): Promise<DocumentTarget | undefined> {
  if (target.attachmentId) {
    const record = attachmentRegistry.get(sessionId, target.attachmentId);
    if (!record) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Attachment not found'));
      return undefined;
    }
    const workingDir = getKnownSessionWorkingDir(ctx, sessionId, reply, req);
    if (!workingDir) return undefined;
    const servePath = await resolveServableAttachmentPath(reply, record, workingDir);
    if (!servePath) return undefined;
    return { filePath: servePath, extension: record.extension };
  }
  if (target.path) {
    const workingDir = getKnownSessionWorkingDir(ctx, sessionId, reply, req);
    if (!workingDir) return undefined;
    const validated = validateSessionFilePath(workingDir, target.path);
    if (!validated) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
      return undefined;
    }
    const extension = target.path.split('.').pop()?.toLowerCase() || '';
    return { filePath: validated.resolvedPath, extension };
  }
  reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing attachmentId or path'));
  return undefined;
}

// Per-(IP, sessionId) token bucket for document upload. 20 requests/minute.
// Distinct from the paste-image bucket (session-routes.ts) — a private module
// bucket here so the two disk-fill surfaces are rate-limited independently.
// Entries are pruned when they drift > 1h stale to bound memory against a flood
// of unique IP keys.
const UPLOAD_RATE_TOKENS = 20;
const UPLOAD_RATE_REFILL_PER_MS = UPLOAD_RATE_TOKENS / 60_000;
const UPLOAD_BUCKET_TTL_MS = 60 * 60 * 1000;
const UPLOAD_BUCKET_GC_THRESHOLD = 1000;
const uploadRateBuckets = new Map<string, { tokens: number; lastRefill: number }>();

function consumeUploadToken(key: string, now: number = Date.now()): boolean {
  if (uploadRateBuckets.size > UPLOAD_BUCKET_GC_THRESHOLD) {
    for (const [k, b] of uploadRateBuckets) {
      if (now - b.lastRefill > UPLOAD_BUCKET_TTL_MS) uploadRateBuckets.delete(k);
    }
  }
  let b = uploadRateBuckets.get(key);
  if (!b) {
    b = { tokens: UPLOAD_RATE_TOKENS, lastRefill: now };
    uploadRateBuckets.set(key, b);
  }
  const delta = (now - b.lastRefill) * UPLOAD_RATE_REFILL_PER_MS;
  b.tokens = Math.min(UPLOAD_RATE_TOKENS, b.tokens + delta);
  b.lastRefill = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** Test hook: reset the upload rate buckets between runs. */
export function _resetUploadRateBuckets(): void {
  uploadRateBuckets.clear();
}

/**
 * Headers Fastify already put on the reply, in a shape `writeHead` accepts.
 *
 * `reply.raw.writeHead()` writes straight to the Node response and bypasses
 * Fastify's header store, so anything the security `onRequest` hook granted — CORS
 * for localhost origins, nosniff, frame-options, CSP — is silently dropped on every
 * route that answers this way. Spread this first and let the route's own headers
 * win over it.
 */
function inheritedHeaders(reply: {
  getHeaders(): NodeJS.Dict<number | string | string[]>;
}): Record<string, number | string | string[]> {
  const out: Record<string, number | string | string[]> = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export function registerFileRoutes(app: FastifyInstance, ctx: SessionPort & EventPort & ConfigPort): void {
  // Lazy filesystem listing for the Link Existing and mobile input path pickers.
  app.get('/api/filesystem/browse', async (req, reply): Promise<ApiResponse<FilesystemBrowseData>> => {
    const { path: requestedPath, sessionId, showHidden } = parseBody(FilesystemBrowseQuerySchema, req.query);
    const includeHidden = wantsHiddenPickerEntries(showHidden);
    const { candidatePath, resolvedPath, roots, matchingRoot, blockedTrees } = await resolveFilesystemPickerPath(
      ctx,
      req,
      requestedPath,
      sessionId,
      includeHidden
    );

    if (isBlockedPickerPath(resolvedPath, blockedTrees, true)) {
      reply.code(403);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Access to this folder is blocked');
    }

    try {
      const stat = await fs.stat(resolvedPath);
      if (!stat.isDirectory()) {
        reply.code(400);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'The browse path must be a directory');
      }
    } catch {
      reply.code(404);
      return createErrorResponse(ApiErrorCode.NOT_FOUND, `Folder not found: ${candidatePath}`);
    }

    let dirEntries;
    try {
      dirEntries = await fs.readdir(resolvedPath, { withFileTypes: true });
    } catch {
      reply.code(403);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'This folder cannot be read');
    }

    dirEntries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    const entries: FilesystemBrowseEntry[] = [];
    let truncated = false;
    for (const entry of dirEntries) {
      if (!includeHidden && entry.name.startsWith('.')) continue;
      if (entries.length >= FILESYSTEM_PICKER_ENTRY_LIMIT) {
        truncated = true;
        break;
      }

      const visiblePath = join(candidatePath, entry.name);
      let targetPath: string;
      try {
        targetPath = realpathSync(visiblePath);
      } catch {
        continue;
      }

      const targetRoot = findMatchingPickerRoot(roots, targetPath);
      if (!targetRoot) continue;
      if (!includeHidden && containsHiddenPickerSegment(targetRoot.path, targetPath)) continue;

      let type: FilesystemBrowseEntry['type'];
      let size: number | undefined;
      const symlink = entry.isSymbolicLink();
      if (entry.isDirectory()) {
        type = 'directory';
      } else if (entry.isFile()) {
        type = 'file';
      } else if (symlink) {
        try {
          const targetStat = await fs.stat(targetPath);
          type = targetStat.isDirectory() ? 'directory' : 'file';
          if (type === 'file') size = targetStat.size;
        } catch {
          continue;
        }
      } else {
        continue;
      }

      if (isBlockedPickerPath(targetPath, blockedTrees, type === 'directory')) continue;
      if (type === 'file' && size === undefined) {
        try {
          size = (await fs.stat(targetPath)).size;
        } catch {
          // The path is still selectable even when a size lookup races a change.
        }
      }
      entries.push({
        name: entry.name,
        path: visiblePath,
        type,
        size,
        symlink: symlink || undefined,
        previewKind: type === 'file' ? getFilesystemPreviewKind(entry.name) : undefined,
      });
    }

    const parentCandidate = resolve(candidatePath, '..');
    let parent: string | null = null;
    if (candidatePath !== matchingRoot.path) {
      try {
        const resolvedParent = realpathSync(parentCandidate);
        if (isPathWithinRoot(matchingRoot.path, resolvedParent)) parent = parentCandidate;
      } catch {
        // A concurrently removed parent simply disables upward navigation.
      }
    }

    return {
      success: true,
      data: {
        path: candidatePath,
        parent,
        root: matchingRoot.path,
        roots,
        entries,
        truncated,
      },
    };
  });

  // Inline preview for files selected through the root-confined filesystem picker.
  app.get('/api/filesystem/preview', { compress: false }, async (req, reply): Promise<void> => {
    const { path: requestedPath, sessionId, showHidden } = parseBody(FilesystemPreviewQuerySchema, req.query);
    const { candidatePath, resolvedPath, blockedTrees } = await resolveFilesystemPickerPath(
      ctx,
      req,
      requestedPath,
      sessionId,
      wantsHiddenPickerEntries(showHidden)
    );
    if (isBlockedPickerPath(resolvedPath, blockedTrees)) {
      throwFilesystemPickerError(403, ApiErrorCode.INVALID_INPUT, 'Access to this file is blocked');
    }

    let stat;
    try {
      stat = await fs.stat(resolvedPath);
    } catch {
      throwFilesystemPickerError(404, ApiErrorCode.NOT_FOUND, `File not found: ${candidatePath}`);
    }
    if (!stat.isFile()) {
      throwFilesystemPickerError(400, ApiErrorCode.INVALID_INPUT, 'The preview path must be a file');
    }

    const fileName = pathBasename(candidatePath);
    const extension = extname(fileName).slice(1).toLowerCase();
    const previewKind = getFilesystemPreviewKind(fileName);
    if (!previewKind) {
      throwFilesystemPickerError(400, ApiErrorCode.INVALID_INPUT, 'This file type cannot be previewed');
    }
    const sizeLimit = previewKind === 'text' ? FILESYSTEM_TEXT_PREVIEW_LIMIT : FILESYSTEM_BINARY_PREVIEW_LIMIT;
    if (stat.size > sizeLimit) {
      throwFilesystemPickerError(
        413,
        ApiErrorCode.INVALID_INPUT,
        `File too large to preview (${Math.ceil(stat.size / 1024 / 1024)}MB limit: ${sizeLimit / 1024 / 1024}MB)`
      );
    }

    reply.header('Cache-Control', 'no-cache');
    reply.header('X-Content-Type-Options', 'nosniff');
    if (previewKind === 'text') {
      const content = await fs.readFile(resolvedPath, 'utf8');
      reply.type('text/plain; charset=utf-8').send(content);
      return;
    }
    if (extension === 'docx' || extension === 'pptx') {
      await serveConvertedPreview(reply, resolvedPath, fileName, extension);
      return;
    }
    await serveRawFile(reply, resolvedPath, fileName, extension, false, req.headers.range);
  });

  // File tree listing (tree mode) + server-side search (search mode, COD-236).
  // Remote workspaces are listed lazily via the saved SFTP connection.
  app.get('/api/sessions/:id/files', async (req, reply) => {
    const { id } = req.params as { id: string };
    const {
      depth,
      showHidden,
      q,
      path: requestedPath,
    } = req.query as {
      depth?: string;
      showHidden?: string;
      q?: string;
      path?: string;
    };
    const session = findSessionOrFail(ctx, id, req);

    // Remote workspaces cannot be walked through this server's filesystem. List
    // one directory at a time via the saved SSH/SFTP connection; the client
    // expands these lazy nodes on demand.
    if (session.remote) {
      if (q?.trim()) {
        return reply
          .code(400)
          .send(
            createErrorResponse(
              ApiErrorCode.INVALID_INPUT,
              'Remote file search is limited to folders already loaded in the File Viewer'
            )
          );
      }
      const relativePath = requestedPath ?? '';
      try {
        remoteWorkspacePath(session.remote, relativePath);
      } catch (err) {
        return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err)));
      }
      try {
        const entries = await listRemoteWorkspaceDirectory(session.remote, relativePath);
        const tree = entries.map((entry) => ({
          ...entry,
          ...(entry.type === 'directory'
            ? { children: [] }
            : { extension: entry.name.includes('.') ? entry.name.split('.').pop()?.toLowerCase() : undefined }),
        }));
        return {
          success: true,
          data: {
            root: session.remote.remotePath,
            tree,
            totalFiles: entries.filter((entry) => entry.type === 'file').length,
            totalDirectories: entries.filter((entry) => entry.type === 'directory').length,
            truncated: false,
            mode: 'tree' as const,
            lazy: true,
          },
        };
      } catch (err) {
        throw Object.assign(new Error(`Failed to list remote files: ${getErrorMessage(err)}`), { statusCode: 500 });
      }
    }

    const maxDepth = Math.min(parseInt(depth || '5', 10), 10);
    const includeHidden = showHidden === 'true';
    const workingDir = session.workingDir;
    // Normalize the root prefix ONCE so relative-path computation is
    // trailing-separator-safe (COD-243): a workingDir ending in `sep` made the
    // old `slice(len + 1)` chop the first char of every relative path.
    const rootPrefix = workingDir.endsWith(sep) ? workingDir : workingDir + sep;
    const matcher = compileFileQuery(q ?? '');

    // Default excludes - large/generated directories
    const excludeDirs = new Set([
      '.git',
      'node_modules',
      'dist',
      'build',
      '__pycache__',
      '.cache',
      '.next',
      '.nuxt',
      'coverage',
      '.venv',
      'venv',
      '.tox',
      'target',
      'vendor',
    ]);

    interface FileTreeNode {
      name: string;
      path: string;
      type: 'file' | 'directory';
      size?: number;
      extension?: string;
      children?: FileTreeNode[];
    }

    let totalFiles = 0;
    let totalDirectories = 0;
    let truncated = false;
    const maxFiles = 5000;
    // Bounded-concurrency stat pool: stat file nodes in batches so the walk
    // isn't serialized on one fs.stat at a time (Direction 3, AC1).
    const STAT_CONCURRENCY = 16;
    const extensionOf = (name: string): string | undefined =>
      name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;

    const sortEntriesDirsFirst = (entries: import('node:fs').Dirent[]): void => {
      entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });
    };

    // ===== Search mode: collect a FLAT match list, recursing everywhere. =====
    if (matcher) {
      const matches: FileTreeNode[] = [];
      const maxMatches = 1000;

      const searchDirectory = async (dirPath: string, currentDepth: number): Promise<void> => {
        if (currentDepth > maxDepth || totalFiles + totalDirectories > maxFiles || matches.length >= maxMatches) {
          truncated = true;
          return;
        }

        let entries: import('node:fs').Dirent[];
        try {
          entries = await fs.readdir(dirPath, { withFileTypes: true });
        } catch {
          // Can't read directory (permission denied, etc.)
          return;
        }
        sortEntriesDirsFirst(entries);

        for (const entry of entries) {
          if (totalFiles + totalDirectories > maxFiles || matches.length >= maxMatches) {
            truncated = true;
            break;
          }
          if (!includeHidden && entry.name.startsWith('.')) continue;
          if (entry.isDirectory() && excludeDirs.has(entry.name)) continue;

          const fullPath = join(dirPath, entry.name);
          const relativePath = fullPath.slice(rootPrefix.length);

          if (entry.isDirectory()) {
            totalDirectories++;
            if (matcher(entry.name, relativePath)) {
              matches.push({ name: entry.name, path: relativePath, type: 'directory' });
            }
            // Always recurse so deeper matches are found.
            await searchDirectory(fullPath, currentDepth + 1);
          } else {
            totalFiles++;
            if (matcher(entry.name, relativePath)) {
              let size: number | undefined;
              try {
                size = (await fs.stat(fullPath)).size;
              } catch {
                // Skip size if we can't stat the match.
              }
              matches.push({
                name: entry.name,
                path: relativePath,
                type: 'file',
                size,
                extension: extensionOf(entry.name),
              });
            }
          }
        }
      };

      await searchDirectory(workingDir, 1);

      return {
        success: true,
        data: {
          root: workingDir,
          tree: [],
          matches,
          totalFiles,
          totalDirectories,
          truncated,
          matchCount: matches.length,
          query: (q ?? '').trim(),
          mode: 'search' as const,
        },
      };
    }

    // ===== Tree mode: nested tree, sizes filled via a bounded stat pool. =====
    const scanDirectory = async (dirPath: string, currentDepth: number): Promise<FileTreeNode[]> => {
      if (currentDepth > maxDepth || totalFiles + totalDirectories > maxFiles) {
        truncated = true;
        return [];
      }

      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        sortEntriesDirsFirst(entries);

        const nodes: FileTreeNode[] = [];
        // File nodes awaiting a size — filled in bounded batches after the loop.
        const pendingSize: { node: FileTreeNode; fullPath: string }[] = [];

        for (const entry of entries) {
          if (totalFiles + totalDirectories > maxFiles) {
            truncated = true;
            break;
          }

          // Skip hidden files unless requested
          if (!includeHidden && entry.name.startsWith('.')) continue;

          // Skip excluded directories
          if (entry.isDirectory() && excludeDirs.has(entry.name)) continue;

          const fullPath = join(dirPath, entry.name);
          const relativePath = fullPath.slice(rootPrefix.length);

          if (entry.isDirectory()) {
            totalDirectories++;
            const children = await scanDirectory(fullPath, currentDepth + 1);
            nodes.push({
              name: entry.name,
              path: relativePath,
              type: 'directory',
              children,
            });
          } else {
            totalFiles++;
            const node: FileTreeNode = {
              name: entry.name,
              path: relativePath,
              type: 'file',
              extension: extensionOf(entry.name),
            };
            nodes.push(node);
            pendingSize.push({ node, fullPath });
          }
        }

        // Fill file sizes with bounded concurrency (Direction 3, AC1).
        for (let i = 0; i < pendingSize.length; i += STAT_CONCURRENCY) {
          const batch = pendingSize.slice(i, i + STAT_CONCURRENCY);
          await Promise.all(
            batch.map(async ({ node, fullPath }) => {
              try {
                node.size = (await fs.stat(fullPath)).size;
              } catch {
                // Skip if can't stat
              }
            })
          );
        }

        return nodes;
      } catch {
        // Can't read directory (permission denied, etc.)
        return [];
      }
    };

    const tree = await scanDirectory(workingDir, 1);

    return {
      success: true,
      data: {
        root: workingDir,
        tree,
        totalFiles,
        totalDirectories,
        truncated,
        mode: 'tree' as const,
      },
    };
  });

  // Get file content for preview (File Browser)
  app.get('/api/sessions/:id/file-content', async (req) => {
    const { id } = req.params as { id: string };
    const {
      path: filePath,
      lines,
      raw,
      edit,
    } = req.query as { path?: string; lines?: string; raw?: string; edit?: string };
    const liveSession = ctx.sessions.get(id);
    const remote = liveSession?.remote;
    // Keep stored/local attachment-history previews on their existing path. A
    // remote workspace must be live so its saved connection configuration is
    // available, and findSessionOrFail preserves ownership checks.
    if (remote) findSessionOrFail(ctx, id, req);
    const workingDir =
      getSessionAttachmentHistory(ctx, id, req)?.workingDir ?? findSessionOrFail(ctx, id, req).workingDir;

    if (!filePath) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter');
    }

    let resolvedPath: string | undefined;
    let relativePath: string | undefined;
    if (remote) {
      try {
        remoteWorkspacePath(remote, filePath);
      } catch {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found');
      }
    } else {
      // Validate path is within working directory (security: resolve symlinks to prevent traversal)
      const validated = validateSessionFilePath(workingDir, filePath);
      if (!validated) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found');
      }
      resolvedPath = validated.resolvedPath;
      relativePath = validated.relativePath;
    }

    // Read-for-edit: never truncated (a truncated buffer must never become an
    // edit buffer), tighter size cap, full editability gate, and the hash/eol
    // the client must echo back on PUT. Outside the shared try/catch below so
    // its structured errors keep their status codes instead of collapsing into
    // OPERATION_FAILED.
    if (edit === '1' || edit === 'true') {
      // Edit mode reads real local bytes; a remote workspace has no local path.
      if (remote || !resolvedPath || relativePath === undefined) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Editing remote workspace files is not supported');
      }
      const guard = await loadAttachmentGuardConfig();
      assertEditableTarget(resolvedPath, relativePath, guard.blockedTrees);

      let editStat;
      try {
        editStat = await fs.stat(resolvedPath);
      } catch {
        throwFileEditError(404, ApiErrorCode.NOT_FOUND, 'File not found');
      }
      if (!editStat.isFile()) {
        throwFileEditError(400, ApiErrorCode.INVALID_INPUT, 'Only regular files can be edited');
      }
      if (editStat.size > MAX_EDITABLE_BYTES) {
        throwFileEditError(
          413,
          ApiErrorCode.INVALID_INPUT,
          `File too large to edit here (${Math.ceil(editStat.size / 1024)}KB > ${MAX_EDITABLE_BYTES / 1024}KB limit)`
        );
      }

      const editBuf = await fs.readFile(resolvedPath);
      const editText = decodeEditableText(editBuf);
      return {
        success: true,
        data: {
          path: filePath,
          content: editText,
          size: editBuf.length,
          mtimeMs: editStat.mtimeMs,
          totalLines: editText.split('\n').length,
          truncated: false,
          extension: filePath.split('.').pop()?.toLowerCase() || '',
          editable: true,
          hash: sha256Hex(editBuf),
          eol: detectEol(editText),
        },
      };
    }

    try {
      const remoteInfo = remote ? await getRemoteWorkspaceFileInfo(remote, filePath) : null;
      const stat = remoteInfo ?? (await fs.stat(resolvedPath!));

      // Classify by extension. Known media types render with a dedicated player;
      // other known-binary types are flagged so the client offers a download
      // affordance instead of trying to decode the bytes as text. Matches the
      // breadth of formats the attachments viewer renders (image/audio/video/pdf)
      // so the file viewer can open the same files.
      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
      const videoExts = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
      const audioExts = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus']);
      const otherBinaryExts = new Set([
        'pdf',
        'zip',
        'tar',
        'gz',
        'bz2',
        'xz',
        '7z',
        'rar',
        'exe',
        'dll',
        'so',
        'dylib',
        'bin',
        'wasm',
        'class',
        'o',
        'a',
        'woff',
        'woff2',
        'ttf',
        'eot',
        'otf',
        'xlsx',
        'xls',
        'doc',
        'docx',
        'ppt',
        'pptx',
        'odt',
        'ods',
        'odp',
        'avi',
        'mkv',
        'wmv',
        'flv',
      ]);

      const mediaType = imageExts.has(ext)
        ? 'image'
        : videoExts.has(ext)
          ? 'video'
          : audioExts.has(ext)
            ? 'audio'
            : null;

      const fileRawUrl = `/api/sessions/${id}/file-raw?path=${encodeURIComponent(filePath)}`;

      if (raw === 'true' || mediaType || otherBinaryExts.has(ext)) {
        // Return metadata for media/binary files (no text body). COD-58: docx/pptx
        // expose a server-converted PDF previewUrl + a thumbnailUrl so the document
        // preview overlay can render them inline rather than dumping raw bytes.
        const type =
          mediaType ??
          (ext === 'pdf'
            ? 'pdf'
            : ext === 'xlsx'
              ? 'spreadsheet'
              : !remote && ext === 'docx'
                ? 'document'
                : !remote && ext === 'pptx'
                  ? 'presentation'
                  : 'binary');
        // DOCX/PPTX conversion and thumbnails read server-local paths. Remote
        // workspaces therefore expose those files as safe raw downloads instead
        // of handing the browser an endpoint that cannot access the SSH host.
        const previewUrl =
          !remote && (ext === 'docx' || ext === 'pptx')
            ? `/api/sessions/${id}/file-preview?path=${encodeURIComponent(filePath)}`
            : ext === 'xlsx'
              ? `${fileRawUrl}&preview=true`
              : fileRawUrl;
        const thumbnailUrl =
          !remote && isSupportedAttachmentExtension(ext) ? buildFileThumbnailRoute(id, filePath) : undefined;
        return {
          success: true,
          data: {
            path: filePath,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            type,
            extension: ext,
            url: fileRawUrl,
            previewUrl,
            thumbnailUrl,
          },
        };
      }

      // Validate file size before reading (DoS protection - prevent memory exhaustion)
      const MAX_TEXT_FILE_SIZE = 10 * 1024 * 1024; // 10MB
      if (stat.size > MAX_TEXT_FILE_SIZE) {
        return createErrorResponse(
          ApiErrorCode.INVALID_INPUT,
          `File too large (${Math.round(stat.size / 1024 / 1024)}MB > ${MAX_TEXT_FILE_SIZE / 1024 / 1024}MB limit)`
        );
      }

      // Read as raw bytes so we can sniff for binary content before decoding. An
      // unrecognized extension (none at all, or a format not listed above) that
      // is actually binary would otherwise be dumped to the viewer as UTF-8
      // mojibake; a NUL byte in the first 8KB is a reliable binary signal that
      // (unlike a static extension list) catches arbitrary binary formats.
      const remoteBuffer = remote ? await readRemoteWorkspaceFile(remote, filePath, MAX_TEXT_FILE_SIZE) : null;
      const fileBuffer = remoteBuffer ?? (await fs.readFile(resolvedPath!));
      const buf = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(String(fileBuffer));
      const sniffLength = Math.min(buf.length, 8192);
      let looksBinary = false;
      for (let i = 0; i < sniffLength; i++) {
        if (buf[i] === 0) {
          looksBinary = true;
          break;
        }
      }

      if (looksBinary) {
        return {
          success: true,
          data: {
            path: filePath,
            size: stat.size,
            type: 'binary',
            extension: ext,
            url: fileRawUrl,
          },
        };
      }

      // Read text file with line limit (bounded to prevent DoS)
      const MAX_LINES_LIMIT = 10000;
      const maxLines = Math.min(parseInt(lines || '500', 10) || 500, MAX_LINES_LIMIT);
      const content = buf.toString('utf-8');
      const allLines = content.split('\n');
      const truncatedContent = allLines.length > maxLines;
      const displayContent = truncatedContent ? allLines.slice(0, maxLines).join('\n') : content;

      // COD-234: classify text vs. markdown so the shared document viewer renders
      // markdown as rich prose (outline, reading view, export) instead of a raw
      // <pre> dump, matching the attachment viewer. Markdown family aligns with the
      // PDF-export renderer (isMarkdownExtension: md/markdown/mdown) for consistency.
      const markdownExts = new Set(['md', 'markdown', 'mdown']);
      const textType = markdownExts.has(ext) ? 'markdown' : 'text';

      // Additive edit-mode advertisement: whether an edit=1 re-fetch would
      // succeed. The UTF-8 round-trip compare is a cheap memcmp and mirrors
      // decodeEditableText; no hash here — the Edit action re-fetches with
      // edit=1, which is where the baseHash comes from. Remote workspaces have
      // no local path, so they are never advertised as editable.
      const guard = await loadAttachmentGuardConfig();
      const editable =
        !remote &&
        resolvedPath !== undefined &&
        relativePath !== undefined &&
        isEditableFileName(pathBasename(resolvedPath)) &&
        !isDeniedEditRelativePath(relativePath) &&
        !isSensitivePath(resolvedPath) &&
        !isBlockedAttachmentPath(resolvedPath, guard.blockedTrees) &&
        stat.size <= MAX_EDITABLE_BYTES &&
        Buffer.from(content, 'utf8').equals(buf);

      return {
        success: true,
        data: {
          path: filePath,
          content: displayContent,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          totalLines: allLines.length,
          truncated: truncatedContent,
          extension: ext,
          type: textType,
          editable,
        },
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`);
    }
  });

  // File Viewer edit mode: save a text file back into the session workspace.
  // Edit-in-place ONLY — there is deliberately no O_CREAT path in this handler,
  // so it can never create, and it never deletes. Confinement is identical to
  // the read path (realpath + workspace boundary + ownership via
  // findSessionOrFail), plus the sensitive-path/attachment-guard blocklists and
  // the extension allowlist. Concurrency is optimistic: the client echoes the
  // sha256 it loaded (baseHash) and a mismatch is a 409 unless force is set.
  // bodyLimit: JSON escaping can expand content up to ~6x (each control char
  // becomes \uXXXX), so the 512KB content cap needs headroom over Fastify's
  // 1MB default.
  app.put(
    '/api/sessions/:id/file-content',
    { bodyLimit: 4 * 1024 * 1024 },
    async (req): Promise<ApiResponse<FileWriteData>> => {
      const { id } = req.params as { id: string };
      const session = findSessionOrFail(ctx, id, req);
      const body = parseBody(FileWriteSchema, req.body);

      // Exact byte cap — the schema's .max() counts UTF-16 code units and is
      // only a coarse pre-filter.
      if (Buffer.byteLength(body.content, 'utf8') > MAX_EDITABLE_BYTES) {
        throwFileEditError(413, ApiErrorCode.INVALID_INPUT, `Content too large (${MAX_EDITABLE_BYTES / 1024}KB limit)`);
      }

      const validated = validateSessionFilePath(session.workingDir, body.path);
      if (!validated) {
        // Covers missing files, traversal, and symlink escapes alike — a write
        // target that fails confinement is reported identically to a missing
        // one, matching the read route.
        throwFileEditError(404, ApiErrorCode.NOT_FOUND, 'File not found');
      }
      const { resolvedPath, relativePath } = validated;

      const guard = await loadAttachmentGuardConfig();
      assertEditableTarget(resolvedPath, relativePath, guard.blockedTrees);

      let stat;
      try {
        stat = await fs.stat(resolvedPath);
      } catch {
        throwFileEditError(404, ApiErrorCode.NOT_FOUND, 'File not found');
      }
      if (!stat.isFile()) {
        throwFileEditError(400, ApiErrorCode.INVALID_INPUT, 'Only regular files can be edited');
      }
      if (stat.size > MAX_EDITABLE_BYTES) {
        throwFileEditError(
          413,
          ApiErrorCode.INVALID_INPUT,
          `File too large to edit here (${MAX_EDITABLE_BYTES / 1024}KB limit)`
        );
      }

      const currentBuf = await fs.readFile(resolvedPath);
      const currentText = decodeEditableText(currentBuf);
      const currentHash = sha256Hex(currentBuf);
      if (currentHash !== body.baseHash && !body.force) {
        throwFileEditError(
          409,
          ApiErrorCode.CONFLICT,
          'File changed on disk since it was loaded — reload it or overwrite'
        );
      }

      // Re-apply the file's original line endings (a <textarea> normalizes to
      // LF; without this a two-line edit of a CRLF file rewrites every line).
      const eol = body.eol ?? detectEol(currentText);
      const outText = applyEol(body.content, eol);
      const outBuf = Buffer.from(outText, 'utf8');
      if (outBuf.length > MAX_EDITABLE_BYTES) {
        throwFileEditError(413, ApiErrorCode.INVALID_INPUT, `Content too large (${MAX_EDITABLE_BYTES / 1024}KB limit)`);
      }

      // Atomic replace: O_EXCL temp in the same directory, then rename.
      // 'wx' cannot follow a pre-existing symlink and rename() replaces (not
      // follows) a symlink in the final component, which closes the
      // validate-then-write TOCTOU window. fchmod because open()'s mode is
      // masked by the process umask; fsync so the rename never publishes a
      // partially-durable file. Trade-off (same as vim's default): the inode
      // changes, so hardlinks keep the old content.
      const fileMode = stat.mode & 0o777;
      const tmpPath = join(
        dirname(resolvedPath),
        `.${pathBasename(resolvedPath)}.codeman-tmp-${randomBytes(6).toString('hex')}`
      );
      let handle;
      try {
        handle = await fs.open(tmpPath, 'wx', fileMode);
        await handle.chmod(fileMode);
        await handle.writeFile(outBuf);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.rename(tmpPath, resolvedPath);
      } catch (err) {
        if (handle) await handle.close().catch(() => {});
        await fs.unlink(tmpPath).catch(() => {});
        throwFileEditError(500, ApiErrorCode.OPERATION_FAILED, `Failed to save file: ${getErrorMessage(err)}`);
      }

      const newStat = await fs.stat(resolvedPath).catch(() => undefined);
      return {
        success: true,
        data: {
          path: body.path,
          size: outBuf.length,
          mtimeMs: newStat?.mtimeMs ?? Date.now(),
          hash: sha256Hex(outBuf),
          totalLines: outText.split('\n').length,
          eol,
        },
      };
    }
  );

  // Resolve a Codex terminal file:// URI through the generated-artifact guard
  // and return only the registry's opaque, sanitized attachment event.
  app.post('/api/sessions/:id/file-uri-preview', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    if (session.mode !== 'codex') {
      reply
        .code(403)
        .send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'File URI preview is only available for Codex sessions'));
      return;
    }

    try {
      const uri = req.body && typeof req.body === 'object' ? (req.body as { uri?: unknown }).uri : undefined;
      const filePath = parsePreviewFileUri(uri);
      const registered = await registerGeneratedArtifactAttachment({
        sessionId: id,
        filePath,
        sessionWorkingDir: session.workingDir,
        remote: session.remote,
      });
      const record = attachmentRegistry.get(id, registered.attachmentId);
      if (!record) throw new Error('Registered attachment record is unavailable');

      session.upsertAttachmentHistory(
        buildExternalAttachmentHistoryItem({
          sessionId: id,
          externalPath: record.filePath,
          fileName: record.fileName,
          extension: record.extension,
          size: record.size,
          mtimeMs: record.mtimeMs,
          timestamp: record.timestamp,
          generatedArtifactBoundary: record.generatedArtifactBoundary,
        })
      );
      ctx.persistSessionState(session);

      const event = attachmentRecordToEvent(record);
      ctx.broadcast(SseEvent.AttachmentDetected, event);
      return { success: true, data: event };
    } catch (err) {
      if (err instanceof AttachmentRegistrationError) {
        reply.code(err.statusCode).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, err.message));
        return;
      }
      req.log.warn(
        {
          category: 'file-uri-preview',
          code: session.remote ? 'remote-unavailable' : 'local-unavailable',
          sessionId: id,
          remote: Boolean(session.remote),
        },
        'File URI preview registration failed'
      );
      reply.code(500).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'File is unavailable'));
      return;
    }
  });

  // Register a live external file as an explicit attachment card.
  app.post('/api/sessions/:id/attachments', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    const body = (req.body || {}) as { path?: string };

    if (!body.path || typeof body.path !== 'string') {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing attachment path'));
      return;
    }

    try {
      const event = await registerExternalAttachment(id, body.path, { sessionWorkingDir: session.workingDir });
      const record = attachmentRegistry.get(id, event.attachmentId);
      if (record) {
        session.upsertAttachmentHistory(
          buildExternalAttachmentHistoryItem({
            sessionId: id,
            externalPath: record.filePath,
            fileName: record.fileName,
            extension: record.extension,
            size: record.size,
            mtimeMs: record.mtimeMs,
            timestamp: event.timestamp,
            generatedArtifactBoundary: record.generatedArtifactBoundary,
          })
        );
        ctx.persistSessionState(session);
      }
      ctx.broadcast(SseEvent.AttachmentDetected, event);
      return { success: true, data: event };
    } catch (err) {
      if (err instanceof AttachmentRegistrationError) {
        reply.code(err.statusCode).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, err.message));
        return;
      }
      return reply
        .code(500)
        .send(
          createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to register attachment: ${getErrorMessage(err)}`)
        );
    }
  });

  // COD-241 unit 1: upload a document file (multipart) into the session
  // workspace's .codeman-attachments/ dir and register it as an 'upload'
  // attachment. LOCAL sessions only — remote byte transfer is a later unit.
  // Structure mirrors the paste-image route (session-routes.ts): explicit CSRF
  // Origin/Referer==Host check, per-(IP, sessionId) token bucket, byte-signature
  // validation over the attacker-controlled filename/Content-Type, and the same
  // symlink-safe (lstat + non-recursive mkdir + O_EXCL|O_NOFOLLOW) write.
  app.post('/api/sessions/:id/attachments/upload', async (req, reply) => {
    // CSRF defense: multipart/form-data is a "simple" CORS request (no
    // preflight), so a cross-origin form submit would attach the session cookie.
    // Reject unless Origin/Referer host matches req.host; non-browser clients
    // (no Origin AND no Referer) must supply X-Codeman-CSRF (a header browsers
    // cannot add cross-origin without a preflight our CORS config disallows).
    const reqHost = req.headers.host;
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    let csrfOk = false;
    if (origin) {
      try {
        csrfOk = new URL(origin).host === reqHost;
      } catch {
        /* invalid Origin → not ok */
      }
    } else if (referer) {
      try {
        csrfOk = new URL(referer).host === reqHost;
      } catch {
        /* invalid Referer → not ok */
      }
    } else {
      csrfOk = !!req.headers['x-codeman-csrf'];
    }
    if (!csrfOk) {
      reply.code(403);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'CSRF check failed');
    }

    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    // Rate limit per (IP, sessionId): 20/min. Defends against disk-fill DoS.
    if (!consumeUploadToken(`${req.ip}:${id}`)) {
      reply.code(429);
      reply.header('Retry-After', '60');
      return createErrorResponse(ApiErrorCode.RATE_LIMITED, 'Rate limit exceeded (20 uploads/min per session)');
    }

    if (!req.isMultipart()) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Expected multipart/form-data');
    }

    // Read the single file part. @fastify/multipart enforces the per-file size
    // cap (MAX_PASTE_IMAGE_BYTES) and the 1-file/4-field count limits (server.ts).
    let part: import('@fastify/multipart').MultipartFile | undefined;
    try {
      part = await req.file();
    } catch (err: unknown) {
      reply.code(413);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err) || 'Invalid multipart payload');
    }
    if (!part) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'No document uploaded');
    }
    if (part.fieldname !== 'document') {
      reply.code(400);
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        `Unexpected field "${part.fieldname}", expected "document"`
      );
    }

    let bytes: Buffer;
    try {
      bytes = await part.toBuffer();
    } catch (err: unknown) {
      reply.code(413);
      const maxMb = Math.round(MAX_PASTE_IMAGE_BYTES / (1024 * 1024));
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err) || `File too large (max ${maxMb}MB)`);
    }
    if (bytes.length === 0) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Empty file');
    }

    // Extension from the (attacker-controlled) filename — lowercased, no dot.
    const rawName = part.filename || '';
    const ext = extname(rawName).toLowerCase().replace(/^\./, '');
    if (!isAllowedUploadExtension(ext)) {
      reply.code(415);
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        `Unsupported document type: ${ext || '(none)'}. Allowed: ${[...UPLOAD_ALLOWED_EXTENSIONS].join(', ')}`
      );
    }

    // Byte-signature check — filename/Content-Type are attacker-supplied, bytes
    // are not (mirrors paste-image's imageMagicMatchesExt).
    if (!documentMagicMatchesExt(bytes, ext)) {
      reply.code(415);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'File content does not match its type');
    }

    // Display base name (card label) preserves the user's original filename;
    // the on-disk name adds a random suffix so it is collision- and traversal-safe.
    // Computed BEFORE the local/remote split — the names are host-independent.
    const displayName = sanitizeUploadFilename(rawName);
    const diskBase = sanitizeUploadFilename(rawName.replace(/\.[^.]*$/, ''));
    const diskName = `${diskBase}-${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`;

    // ── Remote sessions (COD-241 final unit) ──────────────────────────────────
    // The agent runs ON the remote host, so the bytes must land in the remote
    // workspace's .codeman-attachments/ and the inserted `[Attachments: "…"]`
    // reference must be the REMOTE path. All validation above (extension, byte
    // signature, sanitization, empty-file) already ran on the uploaded bytes —
    // it is host-independent, so it happens before any transfer.
    const remote = session.remote;
    if (remote) {
      // 1) Push the bytes to the remote host FIRST (the primary deliverable),
      //    reusing the exact symlink-safe, atomic, umask-077 remote-write path as
      //    paste-image (shared remote-file-transfer.ts). A transfer failure returns
      //    a specific 502 and leaves nothing behind locally.
      const remoteAttachmentsDir = pathPosix.join(remote.remotePath, '.codeman-attachments');
      const remoteFilePath = pathPosix.join(remoteAttachmentsDir, diskName);
      const agentPath = pathPosix.join('.codeman-attachments', diskName);
      try {
        await writeRemoteFileBytes(remote, {
          dir: remoteAttachmentsDir,
          filePath: remoteFilePath,
          bytes,
          timeoutMs: REMOTE_ATTACHMENT_SSH_TIMEOUT_MS,
          transferLabel: 'remote document upload',
          notADirectoryMessage: '.codeman-attachments is not a regular directory',
        });
      } catch (err) {
        req.log.warn({ category: 'attachment-upload', code: 'remote-transfer-failed', sessionId: id, err });
        reply.code(502);
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Failed to transfer document to remote host');
      }

      // 2) Cache a local copy so the attachment registry can serve preview /
      //    thumbnail / raw for the remote file — mirroring generated-artifact-
      //    attachments.ts, which materializes remote bytes locally before
      //    registering. We already hold the bytes in memory (no extra ssh fetch).
      const cacheDir = dataPath('remote-attachment-uploads', id);
      const localCachePath = join(cacheDir, diskName);
      try {
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.writeFile(localCachePath, bytes, { mode: 0o600 });
      } catch (err) {
        // The remote file is already in place (the agent can use it); we just
        // cannot serve a local preview. Surface it rather than half-register.
        req.log.warn({ category: 'attachment-upload', code: 'remote-cache-failed', sessionId: id, err });
        reply.code(500);
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'Uploaded document could not be prepared for preview'
        );
      }

      // 3) Register the local cache copy as an 'upload' attachment, then history
      //    + SSE (same tail as the local path). Confinement is OFF here: the cache
      //    lives under the instance data dir, outside the remote workspace.
      let remoteAttachmentId: string;
      try {
        const event = await registerExternalAttachment(id, localCachePath, {
          sessionWorkingDir: session.workingDir,
          source: 'upload',
        });
        remoteAttachmentId = event.attachmentId;
        const record = attachmentRegistry.get(id, event.attachmentId);
        if (record) {
          session.upsertAttachmentHistory(
            buildExternalAttachmentHistoryItem({
              sessionId: id,
              externalPath: record.filePath,
              fileName: record.fileName,
              extension: record.extension,
              size: record.size,
              mtimeMs: record.mtimeMs,
              timestamp: event.timestamp,
              generatedArtifactBoundary: record.generatedArtifactBoundary,
              uploadProvenance: 'codeman-upload',
            })
          );
          ctx.persistSessionState(session);
        }
        ctx.broadcast(SseEvent.AttachmentDetected, event);
      } catch (err) {
        await fs.rm(localCachePath, { force: true }).catch(() => {});
        if (err instanceof AttachmentRegistrationError) {
          reply.code(err.statusCode);
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, err.message);
        }
        req.log.warn({ category: 'attachment-upload', code: 'remote-registration-failed', sessionId: id, err });
        reply.code(500);
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Failed to register upload');
      }

      const remoteRoutes = buildAttachmentRoutes(id, remoteAttachmentId, ext);
      return {
        success: true,
        data: {
          attachmentId: remoteAttachmentId,
          fileName: displayName,
          agentPath,
          size: bytes.length,
          extension: ext,
          attachmentType: getAttachmentType(ext),
          ...remoteRoutes,
        },
      };
    }

    // ── Local sessions ────────────────────────────────────────────────────────
    // Destination: {workingDir}/.codeman-attachments/. Refuse a symlinked dir
    // (an agent could plant `.codeman-attachments -> ~/.ssh/`). lstat (not stat)
    // so we see the symlink itself; non-recursive mkdir + O_EXCL|O_NOFOLLOW on
    // the file open keep both dir-leaf creation and the write symlink-safe.
    let uploadDirectory;
    try {
      uploadDirectory = await resolveLocalUploadDirectory(session.workingDir, getAuthUser(req));
    } catch (err) {
      if (err instanceof UploadDirectoryResolutionError) {
        reply.code(err.statusCode);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, err.message);
      }
      req.log.warn({ category: 'attachment-upload', code: 'directory-resolution-failed', sessionId: id, err });
      reply.code(500);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Upload directory is unavailable');
    }

    const dest = join(uploadDirectory.canonicalDir, diskName);

    try {
      if ((await fs.realpath(uploadDirectory.canonicalDir)) !== uploadDirectory.canonicalDir) {
        throw new Error('upload directory changed');
      }
      const fh = await fs.open(
        dest,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600
      );
      try {
        await fh.writeFile(bytes);
      } finally {
        await fh.close();
      }
    } catch (err: unknown) {
      req.log.warn({ category: 'attachment-upload', code: 'write-failed', sessionId: id, err });
      reply.code(500);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Failed to write upload');
    }

    // Register as an 'upload' attachment (workspace-confined), then surface it
    // in the session's attachment history and broadcast AttachmentDetected so
    // the paperclip drawer + attachment cards update live — mirroring the tail
    // of the external-path route above (COD-241 unit 2).
    let attachmentId: string;
    try {
      const event = await registerExternalAttachment(id, dest, {
        sessionWorkingDir: session.workingDir,
        forceWorkspaceConfinement: uploadDirectory.kind === 'workspace',
        trustedUploadBoundary: uploadDirectory.kind === 'trusted' ? uploadDirectory.canonicalDir : undefined,
        source: 'upload',
      });
      attachmentId = event.attachmentId;
      const record = attachmentRegistry.get(id, event.attachmentId);
      if (record) {
        session.upsertAttachmentHistory(
          buildExternalAttachmentHistoryItem({
            sessionId: id,
            externalPath: record.filePath,
            fileName: record.fileName,
            extension: record.extension,
            size: record.size,
            mtimeMs: record.mtimeMs,
            timestamp: event.timestamp,
            generatedArtifactBoundary: record.generatedArtifactBoundary,
            uploadProvenance: 'codeman-upload',
          })
        );
        ctx.persistSessionState(session);
      }
      ctx.broadcast(SseEvent.AttachmentDetected, event);
    } catch (err) {
      // Roll back the written file so a rejected registration leaves no orphan.
      await fs.rm(dest, { force: true }).catch(() => {});
      if (err instanceof AttachmentRegistrationError) {
        reply.code(err.statusCode);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, err.message);
      }
      req.log.warn({ category: 'attachment-upload', code: 'registration-failed', sessionId: id, err });
      reply.code(500);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Failed to register upload');
    }

    const agentPath = pathPosix.join('.codeman-attachments', diskName);
    const routes = buildAttachmentRoutes(id, attachmentId, ext);
    return {
      success: true,
      data: {
        attachmentId,
        fileName: displayName,
        agentPath,
        size: bytes.length,
        extension: ext,
        attachmentType: getAttachmentType(ext),
        ...routes,
      },
    };
  });

  // List a session's attachment history (live session or persisted), resolving
  // each entry to current metadata + routes. External entries are re-registered.
  // COD-241 unit 3: remove a Codeman-uploaded attachment copy. Deletes ONLY
  // files Codeman itself wrote under {workingDir}/.codeman-attachments/ — a
  // `detected`/`external` reference to the user's own file is never in that dir,
  // so it is refused. The ownership gate is restart-safe: it depends on the
  // resolved path being inside the (realpath'd) attachments dir, NOT on the
  // in-memory registry, so it holds across a server restart.
  app.delete('/api/sessions/:id/attachments/uploaded', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rawPath = (req.query as { path?: string }).path;

    const session = findSessionOrFail(ctx, id, req);

    if (!rawPath || typeof rawPath !== 'string') {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter');
    }

    let uploadDirectory;
    try {
      uploadDirectory = await resolveLocalUploadDirectory(session.workingDir, getAuthUser(req));
    } catch (err) {
      if (err instanceof UploadDirectoryResolutionError) {
        reply.code(err.statusCode);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, err.message);
      }
      req.log.warn({ category: 'attachment-remove', code: 'directory-resolution-failed', sessionId: id, err });
      reply.code(500);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Upload directory is unavailable');
    }

    if (uploadDirectory.kind === 'trusted') {
      const prefix = '.codeman-attachments/';
      const leaf = rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : '';
      if (!leaf || leaf === '.' || leaf === '..' || leaf.includes('/') || leaf.includes('\\') || leaf.includes(sep)) {
        reply.code(403);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Only Codeman-uploaded files can be removed');
      }

      const target = join(uploadDirectory.canonicalDir, leaf);
      let targetStat;
      try {
        if ((await fs.realpath(uploadDirectory.canonicalDir)) !== uploadDirectory.canonicalDir) {
          throw new Error('trusted root changed');
        }
        targetStat = await fs.lstat(target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reply.code(404);
          return createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found');
        }
        req.log.warn({ category: 'attachment-remove', code: 'target-validation-failed', sessionId: id, err });
        reply.code(403);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Only Codeman-uploaded files can be removed');
      }
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
        reply.code(403);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Only Codeman-uploaded files can be removed');
      }

      const persistedHistory = session.getAttachmentHistoryForPersist() ?? [];
      const owningHistory = persistedHistory.find((item) => {
        if (item.uploadProvenance !== 'codeman-upload' || !item.externalPath) return false;
        try {
          return (
            realpathSync(item.externalPath) === target &&
            dirname(realpathSync(item.externalPath)) === uploadDirectory.canonicalDir
          );
        } catch {
          return false;
        }
      });
      if (!owningHistory) {
        reply.code(403);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Only Codeman-uploaded files can be removed');
      }

      try {
        await fs.unlink(target);
      } catch (err) {
        req.log.warn({ category: 'attachment-remove', code: 'unlink-failed', sessionId: id, err });
        reply.code(500);
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Failed to remove file');
      }

      const record = attachmentRegistry.findByFilePath(id, target);
      if (record) attachmentRegistry.remove(id, record.attachmentId);
      const removed = session.removeAttachmentHistory((item) => item.id === owningHistory.id);
      if (removed > 0) ctx.persistSessionState(session);
      return { success: true, data: { removed: true, path: pathPosix.join(prefix, leaf) } };
    }

    // Resolve (symlink-safe) and confine to the workspace. A traversal/escape or
    // a nonexistent path returns null → 404 (also covers an already-deleted file).
    const validated = validateSessionFilePath(session.workingDir, rawPath);
    if (!validated) {
      reply.code(404);
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found');
    }

    // Ownership gate: the realpath'd target MUST sit inside the realpath'd
    // .codeman-attachments/ dir. Comparing realpaths (not a lexical join on the
    // raw workingDir) closes a symlinked-dir / symlinked-workingDir escape.
    const attachmentsDir = validateSessionFilePath(session.workingDir, '.codeman-attachments');
    const insideAttachments =
      !!attachmentsDir &&
      (validated.resolvedPath === attachmentsDir.resolvedPath ||
        validated.resolvedPath.startsWith(attachmentsDir.resolvedPath + sep));
    if (!insideAttachments) {
      reply.code(403);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Only Codeman-uploaded files can be removed');
    }

    // Delete the file. force:true tolerates a TOCTOU vanish between the gate and
    // the unlink. fs.rm on a symlink removes the link itself, not its target.
    try {
      await fs.rm(validated.resolvedPath, { force: true });
    } catch (err: unknown) {
      req.log.warn({ category: 'attachment-remove', code: 'workspace-remove-failed', sessionId: id, err });
      reply.code(500);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Failed to remove file');
    }

    // Best-effort cleanup of the in-memory registry + persisted history so the
    // paperclip drawer stops surfacing a file that no longer exists.
    const record = attachmentRegistry.findByFilePath(id, validated.resolvedPath);
    if (record) attachmentRegistry.remove(id, record.attachmentId);

    const removed = session.removeAttachmentHistory(
      (item) => item.externalPath === validated.resolvedPath || item.relativePath === validated.relativePath
    );
    if (removed > 0) ctx.persistSessionState(session);

    return { success: true, data: { removed: true, path: validated.relativePath } };
  });

  app.get('/api/sessions/:id/attachments', async (req, reply) => {
    const { id } = req.params as { id: string };
    const sessionHistory = getSessionAttachmentHistory(ctx, id, req);
    if (!sessionHistory) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, `Session ${id} not found`));
      return;
    }

    const items = await Promise.all(
      sessionHistory.history.map((item) =>
        (item.source === 'external'
          ? buildExternalAttachmentRouteItem(id, item, sessionHistory.workingDir, getAuthUser(req))
          : buildDetectedAttachmentRouteItem(id, sessionHistory.workingDir, item)
        ).catch(() => ({ ...sanitizeAttachmentHistoryItem(item), missing: true }))
      )
    );

    return {
      success: true,
      data: {
        items,
        count: items.length,
      },
    };
  });

  // Metadata poll for a single registered attachment (re-stats for live
  // size/mtime as the underlying file is rewritten).
  app.get('/api/sessions/:id/attachments/:attachmentId', async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply, req);
    if (!workingDir) return;
    const record = getAttachmentOr404(reply, id, attachmentId);
    if (!record) return;
    const servePath = await resolveServableAttachmentPath(reply, record, workingDir);
    if (!servePath) return;
    const event = attachmentRecordToEvent(record);
    // Re-stat so the live preview poller sees current size/mtime as the agent
    // rewrites the underlying file (COD-58). Fall back to the cached record on error.
    let size = record.size;
    let mtimeMs = record.mtimeMs;
    try {
      const stat = await fs.stat(servePath);
      size = stat.size;
      mtimeMs = stat.mtimeMs ?? mtimeMs;
    } catch {
      // File temporarily unavailable mid-write — keep cached values.
    }
    // Snapshot revision history off the live-preview poll (COD-59).
    await captureDocumentVersion(id, servePath, record.extension);
    return {
      success: true,
      data: {
        path: record.fileName,
        size,
        mtimeMs,
        type: record.attachmentType,
        extension: record.extension,
        url: event.rawUrl,
        previewUrl: event.previewUrl,
        thumbnailUrl: event.thumbnailUrl,
        attachmentId: record.attachmentId,
        fileName: record.fileName,
      },
    };
  });

  // Serve the raw bytes of a registered attachment by id. Re-checks the
  // attachment-guard policy on every request (defense-in-depth) before streaming.
  app.get('/api/sessions/:id/attachments/:attachmentId/raw', async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    const { download, preview } = req.query as { download?: string; preview?: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply, req);
    if (!workingDir) return;
    const record = getAttachmentOr404(reply, id, attachmentId);
    if (!record) return;
    // Stream the freshly-resolved path (TOCTOU): a path component swapped to a
    // symlink after registration would otherwise redirect the stream to a file
    // the guard never checked.
    const servePath = await resolveServableAttachmentPath(reply, record, workingDir);
    if (!servePath) return;

    try {
      // XLSX preview parsing is intentionally browser-local, but the preview
      // response is capped before a stream is opened. Explicit downloads retain
      // the existing attachment-route limit.
      const maxSizeBytes =
        record.extension === 'xlsx' && preview === 'true' && download !== 'true'
          ? MAX_XLSX_BROWSER_PREVIEW_BYTES
          : 50 * 1024 * 1024;
      await serveRawFile(
        reply,
        servePath,
        record.fileName,
        record.extension,
        download === 'true',
        req.headers.range,
        maxSizeBytes
      );
    } catch (err) {
      reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`));
    }
  });

  // Serve a converted PDF preview of a registered attachment by id. Office docs
  // convert server-side; PDF/PNG/text redirect to the raw route.
  app.get('/api/sessions/:id/attachments/:attachmentId/preview', async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply, req);
    if (!workingDir) return;
    const record = getAttachmentOr404(reply, id, attachmentId);
    if (!record) return;
    const servePath = await resolveServableAttachmentPath(reply, record, workingDir);
    if (!servePath) return;

    // Only Office formats need server-side conversion; PDF/PNG and text formats
    // (md/txt) preview directly from their raw bytes.
    if (record.extension !== 'docx' && record.extension !== 'pptx') {
      const previewQuery = record.extension === 'xlsx' ? '?preview=true' : '';
      reply.redirect(`/api/sessions/${id}/attachments/${encodeURIComponent(attachmentId)}/raw${previewQuery}`);
      return;
    }

    await serveConvertedPreview(reply, servePath, record.fileName, record.extension);
  });

  // Serve a first-page thumbnail of a registered attachment by id.
  app.get('/api/sessions/:id/attachments/:attachmentId/thumbnail', async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply, req);
    if (!workingDir) return;
    const record = getAttachmentOr404(reply, id, attachmentId);
    if (!record) return;
    const servePath = await resolveServableAttachmentPath(reply, record, workingDir);
    if (!servePath) return;
    await serveThumbnail(reply, servePath, record.extension);
  });

  // ===== Document revision history (COD-59) =====
  // Versions are captured off the live-preview poll; these endpoints list them,
  // diff two versions (word-level), and roll a document back to a prior version.
  app.get('/api/sessions/:id/documents/versions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = await resolveDocumentTarget(
      ctx,
      reply,
      id,
      req.query as { attachmentId?: string; path?: string },
      req
    );
    if (!target) return;
    await captureDocumentVersion(id, target.filePath, target.extension);
    return { success: true, data: { versions: documentVersionStore.list(id, target.filePath) } };
  });

  app.get('/api/sessions/:id/documents/diff', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { attachmentId?: string; path?: string; from?: string; to?: string };
    const target = await resolveDocumentTarget(ctx, reply, id, query, req);
    if (!target) return;
    await captureDocumentVersion(id, target.filePath, target.extension);
    const versions = documentVersionStore.list(id, target.filePath);
    if (versions.length === 0) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'No versions recorded for this document yet'));
      return;
    }
    // Default: diff the most recent change (previous -> latest).
    const toId = query.to || versions[versions.length - 1].id;
    const fromId =
      query.from || (versions.length >= 2 ? versions[versions.length - 2].id : versions[versions.length - 1].id);
    const fromVersion = documentVersionStore.get(id, target.filePath, fromId);
    const toVersion = documentVersionStore.get(id, target.filePath, toId);
    if (!fromVersion || !toVersion) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Requested version not found'));
      return;
    }
    return {
      success: true,
      data: { from: fromId, to: toId, ops: wordDiff(fromVersion.content, toVersion.content) },
    };
  });

  app.post('/api/sessions/:id/documents/rollback', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body || {}) as { attachmentId?: string; path?: string; versionId?: string };
    const target = await resolveDocumentTarget(ctx, reply, id, body, req);
    if (!target) return;
    if (!body.versionId) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing versionId'));
      return;
    }
    const version = documentVersionStore.get(id, target.filePath, body.versionId);
    if (!version) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Requested version not found'));
      return;
    }
    // Restores a prior snapshot of this same document. Writes only content we
    // previously read from this path; attachment-path containment is governed
    // separately by COD-53. Binary docs (docx) restore byte-perfect from raw.
    try {
      if (version.raw) {
        await fs.writeFile(target.filePath, version.raw);
      } else {
        await fs.writeFile(target.filePath, version.content, 'utf-8');
      }
      const restoredSize = version.raw ? version.raw.length : Buffer.byteLength(version.content);
      documentVersionStore.record(id, target.filePath, version.content, Date.now(), restoredSize, version.raw);
      return { success: true, data: { restored: body.versionId } };
    } catch (err) {
      return reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to roll back: ${getErrorMessage(err)}`));
    }
  });

  // Selectable HTML rendering of a .docx for the annotatable preview view (COD-68).
  app.get('/api/sessions/:id/documents/html', async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = await resolveDocumentTarget(
      ctx,
      reply,
      id,
      req.query as { attachmentId?: string; path?: string },
      req
    );
    if (!target) return;
    if (target.extension.toLowerCase().replace(/^\./, '') !== 'docx') {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'HTML view is only available for .docx'));
      return;
    }
    try {
      const html = await convertDocxToHtml(target.filePath);
      return { success: true, data: { html } };
    } catch (err) {
      return reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to render HTML: ${getErrorMessage(err)}`));
    }
  });

  // One-click PDF export of the open document (COD-61). GET (so a browser link
  // can download it) + Content-Disposition: attachment, mirroring the
  // file-raw/file-preview download pattern (the ticket said POST — deviation
  // noted). PDF is the only supported format today (DOCX/templates deferred).
  // docx/pptx reuse the LibreOffice preview-PDF cache; md/markdown/txt are
  // rendered to HTML server-side (pandoc, else vendored marked) then converted
  // HTML→PDF via the same soffice invocation.
  app.get('/api/sessions/:id/documents/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { attachmentId?: string; path?: string; format?: string };

    if (!isSupportedExportFormat(query.format)) {
      reply
        .code(400)
        .send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Only PDF export is supported (format=pdf)'));
      return;
    }

    const target = await resolveDocumentTarget(ctx, reply, id, query, req);
    if (!target) return;

    // Resolve symlinks before the sensitive-path guard so a symlink pointing at
    // a secret target is also caught (COD-53 ordering requirement).
    let realPath = target.filePath;
    try {
      realPath = realpathSync(target.filePath);
    } catch {
      // Unreadable/deleted — check the stored path; conversion below will 500 if truly gone.
    }
    if (isSensitivePath(realPath)) {
      reply.code(403).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Access to this file is blocked'));
      return;
    }

    const branch = classifyExportBranch(target.extension);
    if (branch === 'unsupported') {
      reply
        .code(400)
        .send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'PDF export is not supported for this file type'));
      return;
    }

    const fileName = pathBasename(realPath);
    const downloadName = getPreviewPdfDownloadName(fileName, target.extension);

    try {
      if (branch === 'office') {
        // Reuse the existing docx/pptx → PDF preview cache.
        const previewPath = await getOfficePreviewPdfPath(realPath, target.extension);
        if (!previewPath) {
          reply.code(500).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Document conversion to PDF failed'));
          return;
        }
        const content = await fs.readFile(previewPath);
        await sendPdfDownload(reply, content, downloadName);
        return;
      }

      // text branch: md/markdown/txt → standalone HTML → soffice HTML→PDF.
      const raw = await fs.readFile(realPath, 'utf-8');
      const { html } = await buildTextExportHtml(raw, target.extension, fileName);
      const pdfPath = await convertHtmlToPdf(html);
      if (!pdfPath) {
        reply.code(500).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Document conversion to PDF failed'));
        return;
      }
      try {
        const content = await fs.readFile(pdfPath);
        await sendPdfDownload(reply, content, downloadName);
      } finally {
        // convertHtmlToPdf returns a path inside a per-call work dir; remove it.
        await fs.rm(join(pdfPath, '..'), { recursive: true, force: true }).catch(() => {});
      }
    } catch (err) {
      reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to export PDF: ${getErrorMessage(err)}`));
    }
  });

  // Write collected annotations to a markdown review file in the workspace (COD-69).
  app.post('/api/sessions/:id/documents/review', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body || {}) as {
      attachmentId?: string;
      path?: string;
      annotations?: { passage?: string; note?: string }[];
    };
    const target = await resolveDocumentTarget(ctx, reply, id, body, req);
    if (!target) return;
    const annotations = Array.isArray(body.annotations) ? body.annotations.filter((a) => a && a.note) : [];
    if (annotations.length === 0) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'No annotations provided'));
      return;
    }
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply, req);
    if (!workingDir) return;
    const docName = pathBasename(target.filePath);
    const reviewName = `codeman-review-${docName.replace(/[^a-zA-Z0-9._-]/g, '_')}.md`;
    const md =
      `# Review comments for ${docName}\n\n` +
      annotations
        .map((a, i) => `${i + 1}. In "${(a.passage || '').replace(/\s+/g, ' ').trim()}":\n   ${(a.note || '').trim()}`)
        .join('\n\n') +
      '\n';
    try {
      await fs.writeFile(join(workingDir, reviewName), md, 'utf-8');
      return { success: true, data: { path: reviewName, count: annotations.length } };
    } catch (err) {
      return reply
        .code(500)
        .send(
          createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to write review file: ${getErrorMessage(err)}`)
        );
    }
  });

  // Serve raw file content (for images/binary files)
  app.get('/api/sessions/:id/file-raw', async (req, reply) => {
    const { id } = req.params as { id: string };
    const {
      path: filePath,
      download,
      preview,
    } = req.query as {
      path?: string;
      download?: string;
      preview?: string;
    };
    const liveSession = ctx.sessions.get(id);
    if (liveSession?.remote) {
      // Uses the live session deliberately: remote connection details are not
      // persisted in the detached-session record. This call enforces the same
      // ownership rule as every other live-session file operation.
      const session = findSessionOrFail(ctx, id, req);
      if (!filePath) {
        reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
        return;
      }
      try {
        remoteWorkspacePath(session.remote!, filePath);
      } catch {
        reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
        return;
      }
      try {
        const ext = filePath.split('.').pop()?.toLowerCase() || '';
        if (ext === 'xlsx' && preview === 'true' && download !== 'true') {
          const remoteInfo = await getRemoteWorkspaceFileInfo(session.remote!, filePath);
          if (remoteInfo.size > MAX_XLSX_BROWSER_PREVIEW_BYTES) {
            reply
              .code(413)
              .send(
                createErrorResponse(
                  ApiErrorCode.INVALID_INPUT,
                  `File too large (${Math.round(remoteInfo.size / 1024 / 1024)}MB > 10MB limit)`
                )
              );
            return;
          }
        }
        const staged = await downloadRemoteWorkspaceFile(session.remote!, filePath);
        const rawBasename = filePath.split('/').pop() || 'download';
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          void staged.cleanup();
        };
        try {
          await serveRawFile(
            reply,
            staged.path,
            rawBasename,
            ext,
            download === 'true',
            req.headers.range,
            undefined,
            cleanup
          );
        } catch (err) {
          cleanup();
          throw err;
        }
      } catch (err) {
        reply
          .code(500)
          .send(
            createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read remote file: ${getErrorMessage(err)}`)
          );
      }
      return;
    }
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply, req);
    if (!workingDir) return;

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    // Validate path is within working directory (security: resolve symlinks to prevent traversal)
    const validated = validateSessionFilePath(workingDir, filePath);
    if (!validated) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
      return;
    }
    const { resolvedPath } = validated;

    try {
      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const rawBasename = filePath!.split('/').pop() || 'download';
      const maxSizeBytes =
        ext === 'xlsx' && preview === 'true' && download !== 'true' ? MAX_XLSX_BROWSER_PREVIEW_BYTES : undefined;
      await serveRawFile(reply, resolvedPath, rawBasename, ext, download === 'true', req.headers.range, maxSizeBytes);
    } catch (err) {
      reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`));
    }
  });

  // Serve converted document previews for a workspace-relative path. DOCX/PPTX
  // are converted to PDF via LibreOffice; PDF/PNG/text preview through file-raw.
  app.get('/api/sessions/:id/file-preview', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: filePath } = req.query as { path?: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply, req);
    if (!workingDir) return;

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    const validated = validateSessionFilePath(workingDir, filePath);
    if (!validated) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
      return;
    }
    const { resolvedPath } = validated;
    const ext = filePath.split('.').pop()?.toLowerCase() || '';

    // Only Office formats need server-side conversion; PDF/PNG and text formats
    // (md/txt) preview directly from their raw bytes.
    if (ext !== 'docx' && ext !== 'pptx') {
      const previewQuery = ext === 'xlsx' ? '&preview=true' : '';
      reply.redirect(`/api/sessions/${id}/file-raw?path=${encodeURIComponent(filePath)}${previewQuery}`);
      return;
    }

    await serveConvertedPreview(reply, resolvedPath, filePath, ext);
  });

  // Serve a first-page thumbnail for a workspace-relative path.
  app.get('/api/sessions/:id/file-thumbnail', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: filePath } = req.query as { path?: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply, req);
    if (!workingDir) return;

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    const validated = validateSessionFilePath(workingDir, filePath);
    if (!validated) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
      return;
    }

    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    if (!isSupportedAttachmentExtension(ext)) {
      reply
        .code(400)
        .send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Thumbnail is not supported for this file type'));
      return;
    }

    await serveThumbnail(reply, validated.resolvedPath, ext);
  });

  // Stream file content via tail -f (SSE endpoint)
  app.get('/api/sessions/:id/tail-file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: filePath, lines } = req.query as { path?: string; lines?: string };
    const session = findSessionOrFail(ctx, id);

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    // Set up SSE headers
    reply.raw.writeHead(200, {
      ...inheritedHeaders(reply),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Track stream for cleanup
    const streamRef: { id?: string } = {};

    // Create the file stream
    const result = await fileStreamManager.createStream({
      sessionId: id,
      filePath,
      workingDir: session.workingDir,
      lines: lines ? parseInt(lines, 10) : undefined,
      onData: (data) => {
        // Send data as SSE event
        reply.raw.write(`data: ${JSON.stringify({ type: 'data', content: data })}\n\n`);
      },
      onEnd: () => {
        reply.raw.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
        reply.raw.end();
      },
      onError: (error) => {
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
      },
    });

    if (!result.success) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: result.error })}\n\n`);
      reply.raw.end();
      return;
    }

    streamRef.id = result.streamId;

    // Notify client of successful connection
    reply.raw.write(`data: ${JSON.stringify({ type: 'connected', streamId: result.streamId, filePath })}\n\n`);

    // Handle client disconnect
    req.raw.on('close', () => {
      if (streamRef.id) {
        fileStreamManager.closeStream(streamRef.id);
      }
    });
  });

  // Close a file stream. Returns { closed } rather than { success: closed } —
  // a top-level `success` key would collide with the envelope discriminator
  // (the preSerialization hook would pass `{success:false}` through as a
  // malformed error envelope instead of wrapping it).
  app.delete('/api/sessions/:id/tail-file/:streamId', async (req) => {
    const { id, streamId } = req.params as { id: string; streamId: string };
    findSessionOrFail(ctx, id); // Validates session exists
    const closed = fileStreamManager.closeStream(streamId);
    return { closed };
  });

  // Session-scoped file download.
  // Uses the same realpath-based workspace boundary as file preview/raw routes;
  // the sensitive-path blocklist (shared with attachment serving via
  // ../sensitive-path.js) remains defense-in-depth, not the primary boundary.
  app.get('/api/download', async (req, reply) => {
    const { path: filePath, sessionId } = req.query as { path?: string; sessionId?: string };

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    if (!sessionId) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing sessionId parameter'));
      return;
    }

    const session = findSessionOrFail(ctx, sessionId);
    const validated = validateSessionFilePath(session.workingDir, filePath);
    if (!validated) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
      return;
    }
    const { resolvedPath } = validated;

    // Check sensitive path blocklist. NOTE (COD-53): this deliberately uses the
    // base `isSensitivePath` blocklist, NOT the broadened attachment blocklist
    // (which adds the /root + /etc trees). /api/download is already confined to
    // the session workspace by validateSessionFilePath above, so the broadened
    // trees are unnecessary here and changing this would alter download
    // behavior. See cod-53-security-review.md "Configuration".
    if (isSensitivePath(resolvedPath)) {
      reply.code(403).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Access to this file is blocked'));
      return;
    }

    try {
      const stat = await fs.stat(resolvedPath);

      if (!stat.isFile()) {
        reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Path is not a file'));
        return;
      }

      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const mimeTypes: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',
        pdf: 'application/pdf',
        json: 'application/json',
        txt: 'text/plain',
        md: 'text/markdown',
        csv: 'text/csv',
        xml: 'application/xml',
        zip: 'application/zip',
        gz: 'application/gzip',
        tar: 'application/x-tar',
      };

      const filename = sanitizeDownloadName(pathBasename(resolvedPath));
      const content = createReadStream(resolvedPath);
      reply.header('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      reply.header('Content-Length', stat.size);
      reply.send(content);
      return;
    } catch (err) {
      reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`));
    }
  });
}
