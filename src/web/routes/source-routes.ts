/**
 * @fileoverview Source routes for COD-65 Reference / source manager.
 *
 * Endpoints:
 *   GET    /api/sessions/:id/sources                — list sources for a session
 *   POST   /api/sessions/:id/sources                — add a source to a session
 *   DELETE /api/sessions/:id/sources/:sourceId      — remove a source
 *   POST   /api/sessions/:id/sources/upload         — upload a file source (COD-281)
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { extname, join, posix as pathPosix } from 'node:path';
import fs from 'node:fs/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { SessionPort } from '../ports/session-port.js';
import { findSessionOrFail, parseBody } from '../route-helpers.js';
import { ApiErrorCode, createErrorResponse, getErrorMessage } from '../../types.js';
import { SessionSourceAddSchema } from '../schemas.js';
import { documentMagicMatchesExt, isAllowedUploadExtension, sanitizeUploadFilename } from '../document-upload.js';
import { writeRemoteFileBytes } from '../../remote-file-transfer.js';

// Per-(IP, sessionId) token bucket for source uploads. Distinct from the
// document-upload and paste-image buckets so the disk-fill surfaces are
// rate-limited independently. Entries are pruned when they drift > 1h stale to
// bound memory against a flood of unique IP keys.
const SOURCE_UPLOAD_RATE_TOKENS = 20;
const SOURCE_UPLOAD_RATE_REFILL_PER_MS = SOURCE_UPLOAD_RATE_TOKENS / 60_000;
const SOURCE_UPLOAD_BUCKET_TTL_MS = 60 * 60 * 1000;
const SOURCE_UPLOAD_BUCKET_GC_THRESHOLD = 1000;
const sourceUploadRateBuckets = new Map<string, { tokens: number; lastRefill: number }>();

function consumeSourceUploadToken(key: string, now: number = Date.now()): boolean {
  if (sourceUploadRateBuckets.size > SOURCE_UPLOAD_BUCKET_GC_THRESHOLD) {
    for (const [k, b] of sourceUploadRateBuckets) {
      if (now - b.lastRefill > SOURCE_UPLOAD_BUCKET_TTL_MS) sourceUploadRateBuckets.delete(k);
    }
  }
  let b = sourceUploadRateBuckets.get(key);
  if (!b) {
    b = { tokens: SOURCE_UPLOAD_RATE_TOKENS, lastRefill: now };
    sourceUploadRateBuckets.set(key, b);
  }
  const delta = (now - b.lastRefill) * SOURCE_UPLOAD_RATE_REFILL_PER_MS;
  b.tokens = Math.min(SOURCE_UPLOAD_RATE_TOKENS, b.tokens + delta);
  b.lastRefill = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** Test hook: reset the source-upload rate buckets between runs. */
export function _resetSourceUploadRateBuckets(): void {
  sourceUploadRateBuckets.clear();
}

// Subdirectory inside a session workspace where uploaded file sources land.
// Distinct from .codeman-attachments/ so source uploads never collide with the
// attachment-history relationship, and from .claude-images/ (paste-image).
const SOURCES_DIR = '.codeman-sources';
const REMOTE_SOURCE_UPLOAD_SSH_TIMEOUT_MS = 15_000;

/**
 * CSRF defense for the source-upload endpoint. Multipart/form-data is a
 * "simple" CORS request (no preflight), so a cross-origin <form> submit would
 * attach the session cookie. Reject unless Origin/Referer host matches
 * req.host; non-browser clients (no Origin AND no Referer) must supply
 * X-Codeman-CSRF (a header browsers cannot add cross-origin without a preflight
 * our CORS config disallows).
 */
function isCsrfAllowed(headers: {
  host?: string;
  origin?: string;
  referer?: string;
  'x-codeman-csrf'?: string;
}): boolean {
  const reqHost = headers.host;
  const origin = headers.origin;
  const referer = headers.referer;
  if (origin) {
    try {
      return new URL(origin).host === reqHost;
    } catch {
      return false;
    }
  }
  if (referer) {
    try {
      return new URL(referer).host === reqHost;
    } catch {
      return false;
    }
  }
  return !!headers['x-codeman-csrf'];
}

async function writeLocalSourceFile(sourcesDir: string, diskName: string, bytes: Buffer): Promise<void> {
  try {
    const dirStat = await fs.lstat(sourcesDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new Error(`${SOURCES_DIR} is not a regular directory`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    try {
      await fs.mkdir(sourcesDir, { mode: 0o700 });
    } catch (mkErr: unknown) {
      if ((mkErr as NodeJS.ErrnoException).code !== 'EEXIST') throw mkErr;
      const raceStat = await fs.lstat(sourcesDir);
      if (raceStat.isSymbolicLink() || !raceStat.isDirectory()) {
        throw new Error(`${SOURCES_DIR} is not a regular directory`);
      }
    }
  }

  // Use an already-open directory descriptor for the final lookup. On Linux and
  // macOS, the fd filesystem resolves children relative to that descriptor, so a
  // workspace process cannot swap .codeman-sources for a symlink between the
  // validation above and the file creation below.
  const dir = await fs.open(sourcesDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const fdRoot = process.platform === 'linux' ? `/proc/self/fd/${dir.fd}` : `/dev/fd/${dir.fd}`;
    const file = await fs.open(
      join(fdRoot, diskName),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600
    );
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
  } finally {
    await dir.close();
  }
}

export function registerSourceRoutes(app: FastifyInstance, ctx: SessionPort): void {
  app.get('/api/sessions/:id/sources', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);
    return { success: true, data: { sources: session.sources } };
  });

  app.post('/api/sessions/:id/sources', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);
    const body = parseBody(SessionSourceAddSchema, req.body);

    const source = {
      id: randomUUID(),
      sessionId: id,
      addedAt: Date.now(),
      ...body,
    };

    session.addSource(source);
    ctx.persistSessionState(session);

    return { success: true, data: { source } };
  });

  app.post('/api/sessions/:id/sources/upload', async (req, reply: FastifyReply) => {
    // CSRF defense: reject unless Origin/Referer host matches req.host;
    // non-browser clients must supply X-Codeman-CSRF.
    if (!isCsrfAllowed(req.headers as Record<string, string | undefined>)) {
      reply.code(403);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'CSRF check failed');
    }

    const { id } = req.params as { id: string };

    // Rate limit per (IP, sessionId): 20/min. Defends against disk-fill DoS.
    if (!consumeSourceUploadToken(`${req.ip}:${id}`)) {
      reply.code(429);
      reply.header('Retry-After', '60');
      return createErrorResponse(ApiErrorCode.RATE_LIMITED, 'Rate limit exceeded (20 uploads/min per session)');
    }

    const session = findSessionOrFail(ctx, id);

    if (!req.isMultipart()) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Expected multipart/form-data');
    }

    // Read the parts in a single pass so we can capture both the file bytes and
    // an optional `title` field. @fastify/multipart enforces the per-file size
    // cap and the 1-file/field count limits (server.ts).
    let filePart: import('@fastify/multipart').MultipartFile | undefined;
    let bytes: Buffer | undefined;
    let title = '';
    let unexpectedField = '';
    try {
      for await (const p of req.parts()) {
        if (p.type === 'file') {
          filePart = p;
          bytes = await p.toBuffer();
        } else if (p.type === 'field' && p.fieldname === 'title' && typeof p.value === 'string') {
          title = p.value.trim();
        } else {
          unexpectedField = p.fieldname;
        }
      }
    } catch (err: unknown) {
      reply.code(413);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err) || 'Invalid multipart payload');
    }
    if (!filePart) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'No file uploaded');
    }
    if (unexpectedField) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Unexpected field "${unexpectedField}"`);
    }
    if (filePart.fieldname !== 'file') {
      reply.code(400);
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        `Unexpected field "${filePart.fieldname}", expected "file"`
      );
    }
    if (!bytes) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Empty file');
    }

    if (bytes.length === 0) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Empty file');
    }

    // Extension from the (attacker-controlled) filename — lowercased, no dot.
    const rawName = filePart.filename || '';
    const ext = extname(rawName).toLowerCase().replace(/^\./, '');
    if (!isAllowedUploadExtension(ext)) {
      reply.code(415);
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        `Unsupported file type: ${ext || '(none)'}. Allowed: pdf, docx, pptx, xlsx, md, markdown, txt`
      );
    }

    // Byte-signature check — filename/Content-Type are attacker-supplied, bytes
    // are not (mirrors paste-image / document-upload).
    if (!documentMagicMatchesExt(bytes, ext)) {
      reply.code(415);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'File content does not match its type');
    }

    // Display title: explicit `title` field, else the sanitized display filename.
    const sanitized = sanitizeUploadFilename(rawName);
    const diskBase = sanitizeUploadFilename(rawName.replace(/\.[^.]*$/, ''));
    const diskName = `${diskBase}-${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`;
    const titleResult = SessionSourceAddSchema.pick({ title: true }).safeParse({ title: title || sanitized });
    if (!titleResult.success) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, titleResult.error.issues[0]?.message ?? 'Invalid title');
    }
    const displayTitle = titleResult.data.title;

    const remote = session.remote;
    if (remote) {
      const remoteSourcesDir = pathPosix.join(remote.remotePath, SOURCES_DIR);
      try {
        await writeRemoteFileBytes(remote, {
          dir: remoteSourcesDir,
          filePath: pathPosix.join(remoteSourcesDir, diskName),
          bytes,
          timeoutMs: REMOTE_SOURCE_UPLOAD_SSH_TIMEOUT_MS,
          transferLabel: 'remote source upload',
          notADirectoryMessage: `${SOURCES_DIR} is not a regular directory`,
        });
      } catch (err) {
        reply.code(502);
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          `Failed to transfer source to remote host: ${getErrorMessage(err)}`
        );
      }
    } else {
      const sourcesDir = join(session.workingDir, SOURCES_DIR);
      try {
        await writeLocalSourceFile(sourcesDir, diskName, bytes);
      } catch (err: unknown) {
        if (getErrorMessage(err) === `${SOURCES_DIR} is not a regular directory`) {
          reply.code(403);
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err));
        }
        reply.code(500);
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to write upload: ${getErrorMessage(err)}`);
      }
    }

    const source = {
      id: randomUUID(),
      sessionId: id,
      type: 'file' as const,
      title: displayTitle,
      relativePath: `${SOURCES_DIR}/${diskName}`,
      addedAt: Date.now(),
    };

    session.addSource(source);
    ctx.persistSessionState(session);

    return { success: true, data: { source } };
  });

  app.delete('/api/sessions/:id/sources/:sourceId', async (req) => {
    const { id, sourceId } = req.params as { id: string; sourceId: string };
    const session = findSessionOrFail(ctx, id);
    session.removeSource(sourceId);
    ctx.persistSessionState(session);
    return { success: true };
  });
}
