/**
 * @fileoverview File browser and streaming routes.
 * Provides directory listing, file content preview, raw file serving, and tail streaming.
 */

import { FastifyInstance, type FastifyReply } from 'fastify';
import { join, basename as pathBasename } from 'node:path';
import { homedir } from 'node:os';
import { createReadStream } from 'node:fs';
import type { ReadStream } from 'node:fs';
import fs from 'node:fs/promises';
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
  buildFileThumbnailRoute,
  isSupportedAttachmentExtension,
  registerExternalAttachment,
  type AttachmentRecord,
} from '../../attachment-registry.js';
import { buildExternalAttachmentHistoryItem, sanitizeAttachmentHistoryItem } from '../../session-attachment-history.js';
import { generateFirstPageThumbnail } from '../../document-thumbnailer.js';
import { getOfficePreviewPdfPath, getPreviewPdfDownloadName } from '../../document-preview-cache.js';
import { findSessionOrFail, validateSessionFilePath } from '../route-helpers.js';
import { SseEvent } from '../sse-events.js';
import type { ConfigPort, EventPort, SessionPort } from '../ports/index.js';

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
  download?: boolean
): Promise<void> {
  const stat = await fs.stat(resolvedPath);
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

async function buildExternalAttachmentRouteItem(
  sessionId: string,
  item: SessionAttachmentHistoryItem
): Promise<AttachmentHistoryRouteItem> {
  const safe = sanitizeAttachmentHistoryItem(item);
  if (!item.externalPath) {
    return { ...safe, missing: true };
  }

  try {
    const event = await registerExternalAttachment(sessionId, item.externalPath);
    return {
      ...safe,
      fileName: event.fileName,
      extension: event.extension,
      attachmentType: event.attachmentType,
      size: event.size,
      missing: false,
      attachmentId: event.attachmentId,
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

export function registerFileRoutes(app: FastifyInstance, ctx: SessionPort & EventPort & ConfigPort): void {
  // File tree listing
  app.get('/api/sessions/:id/files', async (req) => {
    const { id } = req.params as { id: string };
    const { depth, showHidden } = req.query as { depth?: string; showHidden?: string };
    const session = findSessionOrFail(ctx, id);

    const maxDepth = Math.min(parseInt(depth || '5', 10), 10);
    const includeHidden = showHidden === 'true';
    const workingDir = session.workingDir;

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

    const scanDirectory = async (dirPath: string, currentDepth: number): Promise<FileTreeNode[]> => {
      if (currentDepth > maxDepth || totalFiles + totalDirectories > maxFiles) {
        truncated = true;
        return [];
      }

      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const nodes: FileTreeNode[] = [];

        // Sort: directories first, then alphabetically
        entries.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

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
          const relativePath = fullPath.slice(workingDir.length + 1);

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
            const ext = entry.name.includes('.') ? entry.name.split('.').pop()?.toLowerCase() : undefined;
            let size: number | undefined;
            try {
              const stat = await fs.stat(fullPath);
              size = stat.size;
            } catch {
              // Skip if can't stat
            }
            nodes.push({
              name: entry.name,
              path: relativePath,
              type: 'file',
              size,
              extension: ext,
            });
          }
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

      // Check if it's a binary/media file
      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const binaryExts = new Set([
        'png',
        'jpg',
        'jpeg',
        'gif',
        'webp',
        'ico',
        'svg',
        'bmp',
        'mp4',
        'webm',
        'mov',
        'avi',
        'mp3',
        'wav',
        'ogg',
        'pdf',
        'zip',
        'tar',
        'gz',
        'exe',
        'dll',
        'so',
        'woff',
        'woff2',
        'ttf',
        'eot',
        'docx',
        'pptx',
      ]);
      const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
      const videoExts = new Set(['mp4', 'webm', 'mov', 'avi']);

      if (raw === 'true' || binaryExts.has(ext)) {
        // Return metadata for binary files
        const rawUrl = `/api/sessions/${id}/file-raw?path=${encodeURIComponent(filePath)}`;
        const officePreviewUrl = `/api/sessions/${id}/file-preview?path=${encodeURIComponent(filePath)}`;
        const type = imageExts.has(ext)
          ? 'image'
          : videoExts.has(ext)
            ? 'video'
            : ext === 'pdf'
              ? 'pdf'
              : ext === 'docx'
                ? 'document'
                : ext === 'pptx'
                  ? 'presentation'
                  : 'binary';
        const previewUrl = ext === 'docx' || ext === 'pptx' ? officePreviewUrl : rawUrl;
        const thumbnailUrl = isSupportedAttachmentExtension(ext) ? buildFileThumbnailRoute(id, filePath) : undefined;
        return {
          success: true,
          data: {
            path: filePath,
            size: stat.size,
            type,
            extension: ext,
            url: rawUrl,
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

      // Read text file with line limit (bounded to prevent DoS)
      const MAX_LINES_LIMIT = 10000;
      const maxLines = Math.min(parseInt(lines || '500', 10) || 500, MAX_LINES_LIMIT);
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const allLines = content.split('\n');
      const truncatedContent = allLines.length > maxLines;
      const displayContent = truncatedContent ? allLines.slice(0, maxLines).join('\n') : content;

      return {
        success: true,
        data: {
          path: filePath,
          content: displayContent,
          size: stat.size,
          totalLines: allLines.length,
          truncated: truncatedContent,
          extension: ext,
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
      const event = await registerExternalAttachment(id, body.path);
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

  app.get('/api/sessions/:id/attachments', async (req, reply) => {
    const { id } = req.params as { id: string };
    const sessionHistory = getSessionAttachmentHistory(ctx, id);
    if (!sessionHistory) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, `Session ${id} not found`));
      return;
    }

    const items = await Promise.all(
      sessionHistory.history.map((item) =>
        item.source === 'external'
          ? buildExternalAttachmentRouteItem(id, item)
          : buildDetectedAttachmentRouteItem(id, sessionHistory.workingDir, item)
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

  app.get('/api/sessions/:id/attachments/:attachmentId', async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply);
    if (!workingDir) return;
    const record = getAttachmentOr404(reply, id, attachmentId);
    if (!record) return;
    const event = attachmentRecordToEvent(record);
    return {
      success: true,
      data: {
        path: record.fileName,
        size: record.size,
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

  app.get('/api/sessions/:id/attachments/:attachmentId/raw', async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    const { download } = req.query as { download?: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply);
    if (!workingDir) return;
    const record = getAttachmentOr404(reply, id, attachmentId);
    if (!record) return;

    try {
      await serveRawFile(reply, record.filePath, record.fileName, record.extension, download === 'true');
    } catch (err) {
      reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`));
    }
  });

  app.get('/api/sessions/:id/attachments/:attachmentId/preview', async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply);
    if (!workingDir) return;
    const record = getAttachmentOr404(reply, id, attachmentId);
    if (!record) return;

    if (record.extension === 'pdf' || record.extension === 'png') {
      reply.redirect(`/api/sessions/${id}/attachments/${encodeURIComponent(attachmentId)}/raw`);
      return;
    }

    await serveConvertedPreview(reply, record.filePath, record.fileName, record.extension);
  });

  app.get('/api/sessions/:id/attachments/:attachmentId/thumbnail', async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply);
    if (!workingDir) return;
    const record = getAttachmentOr404(reply, id, attachmentId);
    if (!record) return;
    await serveThumbnail(reply, record.filePath, record.extension);
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

  // Serve converted document previews. DOCX/PPTX are converted to PDF using
  // LibreOffice when available; PDF/PNG preview directly through file-raw.
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

    if (ext === 'pdf' || ext === 'png') {
      reply.redirect(`/api/sessions/${id}/file-raw?path=${encodeURIComponent(filePath)}`);
      return;
    }

    await serveConvertedPreview(reply, resolvedPath, filePath, ext);
  });

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

  // Close a file stream
  app.delete('/api/sessions/:id/tail-file/:streamId', async (req) => {
    const { id, streamId } = req.params as { id: string; streamId: string };
    findSessionOrFail(ctx, id); // Validates session exists
    const closed = fileStreamManager.closeStream(streamId);
    return { success: closed };
  });

  // Session-scoped file download.
  // Uses the same realpath-based workspace boundary as file preview/raw routes;
  // the sensitive-path blocklist remains defense-in-depth, not the primary boundary.
  const SENSITIVE_PATTERNS: RegExp[] = [
    /^\/etc\/shadow$/,
    /^\/etc\/gshadow$/,
    /^\/etc\/master\.passwd$/,
    new RegExp(`^${homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/\\.ssh\\/`),
    /\/\.env$/,
    /\/\.env\./,
    /\/credentials(\.json|\.yml|\.yaml|\.xml)?$/i,
    /\/\.aws\/credentials$/,
    /\/\.gcloud\/credentials\.db$/,
    /\/\.docker\/config\.json$/,
  ];

  function isSensitivePath(absPath: string): boolean {
    return SENSITIVE_PATTERNS.some((pattern) => pattern.test(absPath));
  }

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

    // Check sensitive path blocklist
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
