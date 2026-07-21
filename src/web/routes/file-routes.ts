/**
 * @fileoverview File browser and streaming routes.
 * Provides directory listing, file content preview, raw file serving, and tail streaming.
 */

import { FastifyInstance, type FastifyReply } from 'fastify';
import { join, extname, sep, basename as pathBasename, posix as pathPosix } from 'node:path';
import { createReadStream, realpathSync } from 'node:fs';
import type { ReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  ApiErrorCode,
  createErrorResponse,
  getErrorMessage,
  type SessionAttachmentHistoryItem,
  type SessionState,
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
import { findSessionOrFail, validateSessionFilePath } from '../route-helpers.js';
import { compileFileQuery } from '../../utils/file-query.js';
import { isSensitivePath } from '../sensitive-path.js';
import { isBlockedAttachmentPath, loadAttachmentGuardConfig } from '../../config/attachment-guard.js';
import { SseEvent } from '../sse-events.js';
import { writeRemoteFileBytes } from '../../remote-file-transfer.js';
import { dataPath } from '../../config/instance.js';
import type { ConfigPort, EventPort, SessionPort } from '../ports/index.js';

// Client-side hard timeout for the remote document-upload ssh transfer. Mirrors
// the paste-image timeout (session-routes.ts) so both remote writes behave the same.
const REMOTE_ATTACHMENT_SSH_TIMEOUT_MS = 15_000;

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
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
};

function sanitizeDownloadName(fileName: string): string {
  return fileName.replace(/["\\\r\n]/g, '_');
}

function sendRawStream(reply: FastifyReply, content: ReadStream): void {
  const headers = reply.getHeaders();
  reply.hijack();

  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      reply.raw.setHeader(name, value);
    }
  }

  content.on('error', (err) => {
    if (reply.raw.headersSent) {
      reply.raw.destroy(err);
      return;
    }

    reply.raw.statusCode = 500;
    reply.raw.end('Failed to read file');
  });
  content.pipe(reply.raw);
}

async function serveRawFile(
  reply: FastifyReply,
  resolvedPath: string,
  fileName: string,
  extension: string,
  download?: boolean,
  maxSizeBytes?: number
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
  const content = createReadStream(resolvedPath);
  const safeName = sanitizeDownloadName(fileName);
  if (download || extension === 'svg') {
    reply.header(
      'Content-Type',
      extension === 'svg' ? 'application/octet-stream' : MIME_TYPES[extension] || 'application/octet-stream'
    );
    reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
    reply.header('Content-Length', stat.size);
    reply.header('X-Content-Type-Options', 'nosniff');
    sendRawStream(reply, content);
    return;
  }

  reply.header('Content-Type', MIME_TYPES[extension] || 'application/octet-stream');
  reply.header('Content-Disposition', `inline; filename="${safeName}"`);
  reply.header('Content-Length', stat.size);
  reply.header('X-Content-Type-Options', 'nosniff');
  sendRawStream(reply, content);
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
    reply.header('Content-Disposition', `inline; filename="${getPreviewPdfDownloadName(fileName, extension)}"`);
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
    pathToCheck = realpathSync(record.filePath);
    resolved = true;
  } catch {
    // Fall back to the stored (already realpath-resolved at registration) path.
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

type AttachmentHistoryRouteItem = Omit<SessionAttachmentHistoryItem, 'externalPath'> & {
  missing: boolean;
  rawUrl?: string;
  url?: string;
  previewUrl?: string;
  thumbnailUrl?: string;
  downloadUrl?: string;
  attachmentId?: string;
};

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
  reply: FastifyReply
): string | undefined {
  const liveSession = ctx.sessions.get(sessionId);
  if (liveSession) return liveSession.workingDir;

  const stored = ctx.store.getSession(sessionId) as StoredSessionWithPrivateAttachmentHistory | undefined;
  if (stored) return stored.workingDir;

  reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, `Session ${sessionId} not found`));
  return undefined;
}

function getSessionAttachmentHistory(
  ctx: SessionPort & ConfigPort,
  sessionId: string
): { workingDir: string; history: SessionAttachmentHistoryItem[] } | undefined {
  const liveSession = ctx.sessions.get(sessionId);
  if (liveSession) {
    return {
      workingDir: liveSession.workingDir,
      history: liveSession.getAttachmentHistoryForPersist() ?? liveSession.attachmentHistory ?? [],
    };
  }

  const stored = ctx.store.getSession(sessionId) as StoredSessionWithPrivateAttachmentHistory | undefined;
  if (!stored) return undefined;

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
  sessionWorkingDir?: string
): Promise<AttachmentHistoryRouteItem> {
  const safe = sanitizeAttachmentHistoryItem(item);
  if (!item.externalPath) {
    return { ...safe, missing: true };
  }

  try {
    const event = await registerExternalAttachment(sessionId, item.externalPath, { sessionWorkingDir });
    // COD-241 unit 3: expose a workspace-relative path for Codeman-uploaded
    // copies (those inside .codeman-attachments/). The frontend gates its
    // "Remove" affordance on `relativePath` starting with `.codeman-attachments/`
    // and feeds that path to DELETE …/attachments/uploaded. externalPath itself
    // stays stripped (never leaves the server); only the confined relative path
    // is surfaced. Non-workspace published files resolve to null → no relativePath
    // → no Remove button.
    const validated = sessionWorkingDir ? validateSessionFilePath(sessionWorkingDir, item.externalPath) : null;
    const ownedRelativePath =
      validated &&
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
function resolveDocumentTarget(
  ctx: SessionPort & ConfigPort,
  reply: FastifyReply,
  sessionId: string,
  target: { attachmentId?: string; path?: string }
): DocumentTarget | undefined {
  if (target.attachmentId) {
    const record = attachmentRegistry.get(sessionId, target.attachmentId);
    if (!record) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Attachment not found'));
      return undefined;
    }
    return { filePath: record.filePath, extension: record.extension };
  }
  if (target.path) {
    const workingDir = getKnownSessionWorkingDir(ctx, sessionId, reply);
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

export function registerFileRoutes(app: FastifyInstance, ctx: SessionPort & EventPort & ConfigPort): void {
  // File tree listing (tree mode) + server-side search (search mode, COD-236).
  // A `q` query param prunes the walk to matching entries and returns a FLAT
  // `matches` list instead of the nested tree, so a large workspace never has to
  // serialize/render the whole tree just to filter it. Tree mode replaces the
  // old serial per-file stat with a bounded-concurrency stat pool so the panel
  // paints faster.
  app.get('/api/sessions/:id/files', async (req) => {
    const { id } = req.params as { id: string };
    const { depth, showHidden, q } = req.query as { depth?: string; showHidden?: string; q?: string };
    const session = findSessionOrFail(ctx, id);

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
    const { path: filePath, lines, raw } = req.query as { path?: string; lines?: string; raw?: string };
    const workingDir = getSessionAttachmentHistory(ctx, id)?.workingDir ?? findSessionOrFail(ctx, id).workingDir;

    if (!filePath) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter');
    }

    // Validate path is within working directory (security: resolve symlinks to prevent traversal)
    const validated = validateSessionFilePath(workingDir, filePath);
    if (!validated) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found');
    }
    const { resolvedPath } = validated;

    try {
      const stat = await fs.stat(resolvedPath);

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
        const officePreviewUrl = `/api/sessions/${id}/file-preview?path=${encodeURIComponent(filePath)}`;
        const type =
          mediaType ??
          (ext === 'pdf' ? 'pdf' : ext === 'docx' ? 'document' : ext === 'pptx' ? 'presentation' : 'binary');
        const previewUrl = ext === 'docx' || ext === 'pptx' ? officePreviewUrl : fileRawUrl;
        const thumbnailUrl = isSupportedAttachmentExtension(ext) ? buildFileThumbnailRoute(id, filePath) : undefined;
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
      const fileBuffer = await fs.readFile(resolvedPath);
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
        },
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`);
    }
  });

  // Register a live external file as an explicit attachment card.
  app.post('/api/sessions/:id/attachments', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);
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

    // Rate limit per (IP, sessionId): 20/min. Defends against disk-fill DoS.
    if (!consumeUploadToken(`${req.ip}:${id}`)) {
      reply.code(429);
      reply.header('Retry-After', '60');
      return createErrorResponse(ApiErrorCode.RATE_LIMITED, 'Rate limit exceeded (20 uploads/min per session)');
    }

    const session = findSessionOrFail(ctx, id);

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
        reply.code(502);
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          `Failed to transfer document to remote host: ${getErrorMessage(err)}`
        );
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
        reply.code(500);
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          `Uploaded to remote but failed to cache locally: ${getErrorMessage(err)}`
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
        reply.code(500);
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to register upload: ${getErrorMessage(err)}`);
      }

      const remoteRoutes = buildAttachmentRoutes(id, remoteAttachmentId);
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
    const attachmentsDir = join(session.workingDir, '.codeman-attachments');
    try {
      const dirStat = await fs.lstat(attachmentsDir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        reply.code(403);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, '.codeman-attachments is not a regular directory');
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      try {
        await fs.mkdir(attachmentsDir);
      } catch (mkErr: unknown) {
        // Concurrent uploads race to create the dir — losers get EEXIST. Treat an
        // already-present REAL directory as success, but re-verify it isn't a
        // symlink a racing actor planted.
        if ((mkErr as NodeJS.ErrnoException).code !== 'EEXIST') throw mkErr;
        const raceStat = await fs.lstat(attachmentsDir);
        if (raceStat.isSymbolicLink() || !raceStat.isDirectory()) {
          reply.code(403);
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, '.codeman-attachments is not a regular directory');
        }
      }
    }

    const dest = join(attachmentsDir, diskName);

    try {
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
      reply.code(500);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to write upload: ${getErrorMessage(err)}`);
    }

    // Register as an 'upload' attachment (workspace-confined), then surface it
    // in the session's attachment history and broadcast AttachmentDetected so
    // the paperclip drawer + attachment cards update live — mirroring the tail
    // of the external-path route above (COD-241 unit 2).
    let attachmentId: string;
    try {
      const event = await registerExternalAttachment(id, dest, {
        sessionWorkingDir: session.workingDir,
        forceWorkspaceConfinement: true,
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
      reply.code(500);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to register upload: ${getErrorMessage(err)}`);
    }

    const agentPath =
      validateSessionFilePath(session.workingDir, dest)?.relativePath ?? join('.codeman-attachments', diskName);
    const routes = buildAttachmentRoutes(id, attachmentId);
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

    const session = findSessionOrFail(ctx, id);

    if (!rawPath || typeof rawPath !== 'string') {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter');
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
      reply.code(500);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to remove file: ${getErrorMessage(err)}`);
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
    const sessionHistory = getSessionAttachmentHistory(ctx, id);
    if (!sessionHistory) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, `Session ${id} not found`));
      return;
    }

    const items = await Promise.all(
      sessionHistory.history.map((item) =>
        (item.source === 'external'
          ? buildExternalAttachmentRouteItem(id, item, sessionHistory.workingDir)
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
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply);
    if (!workingDir) return;
    const record = getAttachmentOr404(reply, id, attachmentId);
    if (!record) return;
    if (!(await resolveServableAttachmentPath(reply, record, workingDir))) return;
    const event = attachmentRecordToEvent(record);
    // Re-stat so the live preview poller sees current size/mtime as the agent
    // rewrites the underlying file (COD-58). Fall back to the cached record on error.
    let size = record.size;
    let mtimeMs = record.mtimeMs;
    try {
      const stat = await fs.stat(record.filePath);
      size = stat.size;
      mtimeMs = stat.mtimeMs ?? mtimeMs;
    } catch {
      // File temporarily unavailable mid-write — keep cached values.
    }
    // Snapshot revision history off the live-preview poll (COD-59).
    await captureDocumentVersion(id, record.filePath, record.extension);
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
    const { download } = req.query as { download?: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply);
    if (!workingDir) return;
    const record = getAttachmentOr404(reply, id, attachmentId);
    if (!record) return;
    // Stream the freshly-resolved path (TOCTOU): a path component swapped to a
    // symlink after registration would otherwise redirect the stream to a file
    // the guard never checked.
    const servePath = await resolveServableAttachmentPath(reply, record, workingDir);
    if (!servePath) return;

    try {
      // 50MB cap on the by-id attachment raw route (matches the attachment POST path).
      await serveRawFile(reply, servePath, record.fileName, record.extension, download === 'true', 50 * 1024 * 1024);
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
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply);
    if (!workingDir) return;
    const record = getAttachmentOr404(reply, id, attachmentId);
    if (!record) return;
    const servePath = await resolveServableAttachmentPath(reply, record, workingDir);
    if (!servePath) return;

    // Only Office formats need server-side conversion; PDF/PNG and text formats
    // (md/txt) preview directly from their raw bytes.
    if (record.extension !== 'docx' && record.extension !== 'pptx') {
      reply.redirect(`/api/sessions/${id}/attachments/${encodeURIComponent(attachmentId)}/raw`);
      return;
    }

    await serveConvertedPreview(reply, servePath, record.fileName, record.extension);
  });

  // Serve a first-page thumbnail of a registered attachment by id.
  app.get('/api/sessions/:id/attachments/:attachmentId/thumbnail', async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply);
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
    const target = resolveDocumentTarget(ctx, reply, id, req.query as { attachmentId?: string; path?: string });
    if (!target) return;
    await captureDocumentVersion(id, target.filePath, target.extension);
    return { success: true, data: { versions: documentVersionStore.list(id, target.filePath) } };
  });

  app.get('/api/sessions/:id/documents/diff', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { attachmentId?: string; path?: string; from?: string; to?: string };
    const target = resolveDocumentTarget(ctx, reply, id, query);
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
    const target = resolveDocumentTarget(ctx, reply, id, body);
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
    const target = resolveDocumentTarget(ctx, reply, id, req.query as { attachmentId?: string; path?: string });
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

    const target = resolveDocumentTarget(ctx, reply, id, query);
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
    const target = resolveDocumentTarget(ctx, reply, id, body);
    if (!target) return;
    const annotations = Array.isArray(body.annotations) ? body.annotations.filter((a) => a && a.note) : [];
    if (annotations.length === 0) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'No annotations provided'));
      return;
    }
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply);
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
    const { path: filePath, download } = req.query as { path?: string; download?: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply);
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
      await serveRawFile(reply, resolvedPath, rawBasename, ext, download === 'true');
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
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply);
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
      reply.redirect(`/api/sessions/${id}/file-raw?path=${encodeURIComponent(filePath)}`);
      return;
    }

    await serveConvertedPreview(reply, resolvedPath, filePath, ext);
  });

  // Serve a first-page thumbnail for a workspace-relative path.
  app.get('/api/sessions/:id/file-thumbnail', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: filePath } = req.query as { path?: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply);
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
