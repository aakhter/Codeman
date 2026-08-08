/**
 * @fileoverview Route tests for POST /api/sessions/:id/attachments/upload (COD-241 unit 1).
 *
 * Uses a multipart-capable Fastify harness (mirrors session-routes.test.ts) with
 * the production uniform-envelope preSerialization hook, and writes to a REAL
 * temp workspace via fs.mkdtemp so the symlink-safe write + registry realpath
 * checks run against actual files on disk (no fs mock).
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { registerFileRoutes, _resetUploadRateBuckets } from '../../src/web/routes/file-routes.js';
import { attachmentRegistry } from '../../src/attachment-registry.js';

interface LocalHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

async function createEnvelopeHarness(): Promise<LocalHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4, parts: 5 },
  });

  const ctx = createMockRouteContext();
  registerFileRoutes(app, ctx as never);

  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    if (Buffer.isBuffer(payload) || typeof (payload as { pipe?: unknown }).pipe === 'function') {
      return done(null, payload);
    }
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });

  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx };
}

function uploadBody(boundary: string, filename: string, mimetype: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
        `Content-Type: ${mimetype}\r\n\r\n`
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

/** Body with a wrong field name (not "document"). */
function wrongFieldBody(boundary: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="x.pdf"\r\n` +
        `Content-Type: application/pdf\r\n\r\n`
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

const BOUNDARY = 'codeman-upload-boundary';
const MULTIPART_HEADERS = {
  host: 'codeman.test',
  origin: 'http://codeman.test',
  'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
};

const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n', 'latin1');
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

describe('POST /api/sessions/:id/attachments/upload (COD-241)', () => {
  let harness: LocalHarness;
  let workdir: string;

  beforeEach(async () => {
    _resetUploadRateBuckets();
    harness = await createEnvelopeHarness();
    workdir = await fs.mkdtemp(join(tmpdir(), 'codeman-upload-test-'));
    // Point the mock session at a real temp workspace so real fs writes land there.
    harness.ctx._session.workingDir = workdir;
    attachmentRegistry.clearSession(harness.ctx._sessionId);
  });

  afterEach(async () => {
    attachmentRegistry.clearSession(harness.ctx._sessionId);
    await harness.app.close();
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('200: uploads a valid PDF, registers it as source:upload, writes it under .codeman-attachments/', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(BOUNDARY, 'Quarterly Report.pdf', 'application/pdf', PDF_BYTES),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(typeof body.data.attachmentId).toBe('string');
    expect(body.data.attachmentId.length).toBeGreaterThan(0);
    expect(body.data.fileName).toBe('Quarterly Report.pdf');
    expect(body.data.agentPath.startsWith('.codeman-attachments/')).toBe(true);
    expect(body.data.extension).toBe('pdf');
    expect(body.data.attachmentType).toBe('pdf');
    expect(body.data.size).toBe(PDF_BYTES.length);
    expect(body.data.rawUrl).toContain(`/attachments/${encodeURIComponent(body.data.attachmentId)}/raw`);
    expect(body.data.previewUrl).toContain('/preview');
    expect(body.data.thumbnailUrl).toContain('/thumbnail');

    // File exists on disk under the workspace's .codeman-attachments dir.
    const onDisk = join(workdir, body.data.agentPath);
    const stat = await fs.stat(onDisk);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBe(PDF_BYTES.length);

    // Registry has a record stamped source:'upload'.
    const record = attachmentRegistry.get(harness.ctx._sessionId, body.data.attachmentId);
    expect(record).toBeDefined();
    expect(record?.source).toBe('upload');
    expect(record?.extension).toBe('pdf');
  });

  it('surfaces the upload in attachment history and broadcasts attachment:detected', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(BOUNDARY, 'Brief.pdf', 'application/pdf', PDF_BYTES),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    // (a) The session's attachment history now contains the uploaded file. The
    // stored fileName is the uniquified on-disk basename (Brief-<ts>-<hex>.pdf),
    // matching how the registry/GET path resolves upload attachments.
    expect(harness.ctx._session.upsertAttachmentHistory).toHaveBeenCalledTimes(1);
    const history = harness.ctx._session.attachmentHistory;
    expect(history.length).toBe(1);
    expect(history[0].fileName).toMatch(/^Brief-.*\.pdf$/);
    expect(history[0].extension).toBe('pdf');
    // State was persisted so the history survives beyond the live session.
    expect(harness.ctx.persistSessionState).toHaveBeenCalled();

    // (b) An attachment:detected event was broadcast with the registration result.
    const detected = harness.ctx.broadcast.mock.calls.filter((c) => c[0] === 'attachment:detected');
    expect(detected.length).toBe(1);
    expect(detected[0][1].attachmentId).toBe(body.data.attachmentId);
  });

  it('200: uploads a plain-text .txt', async () => {
    const txt = Buffer.from('just some notes\nsecond line\n');
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(BOUNDARY, 'notes.txt', 'text/plain', txt),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.extension).toBe('txt');
    expect(body.data.attachmentType).toBe('text');
    expect(body.data.fileName).toBe('notes.txt');
  });

  it('200: uploads a .docx with a ZIP (PK\\x03\\x04) prefix', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(
        BOUNDARY,
        'deck.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ZIP_BYTES
      ),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.extension).toBe('docx');
    expect(body.data.attachmentType).toBe('document');
  });

  it('200: uploads a .pptx with a ZIP prefix', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(BOUNDARY, 'slides.pptx', 'application/octet-stream', ZIP_BYTES),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.extension).toBe('pptx');
    expect(body.data.attachmentType).toBe('presentation');
  });

  it('200: uploads an .xlsx with a ZIP prefix as a spreadsheet attachment', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(
        BOUNDARY,
        'forecast.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ZIP_BYTES
      ),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.extension).toBe('xlsx');
    expect(body.data.attachmentType).toBe('spreadsheet');
    expect(body.data.agentPath).toMatch(/^\.codeman-attachments\/forecast-.*\.xlsx$/);
    expect(attachmentRegistry.get(harness.ctx._sessionId, body.data.attachmentId)?.source).toBe('upload');
  });

  it('415: rejects an unsupported extension (.exe)', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(BOUNDARY, 'malware.exe', 'application/octet-stream', PDF_BYTES),
    });

    expect(res.statusCode).toBe(415);
    expect(JSON.parse(res.body).success).toBe(false);
  });

  it('415: rejects a content/type mismatch (txt bytes declared as .pdf)', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(BOUNDARY, 'fake.pdf', 'application/pdf', Buffer.from('this is not a pdf')),
    });

    expect(res.statusCode).toBe(415);
    expect(JSON.parse(res.body).success).toBe(false);
  });

  it('400: rejects a non-multipart body', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: { host: 'codeman.test', origin: 'http://codeman.test', 'content-type': 'application/json' },
      payload: JSON.stringify({ nope: true }),
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).success).toBe(false);
  });

  it('400: rejects a missing "document" field (wrong field name)', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: MULTIPART_HEADERS,
      payload: wrongFieldBody(BOUNDARY, PDF_BYTES),
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).success).toBe(false);
  });

  it('403: rejects a cross-origin (CSRF) request', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: {
        host: 'codeman.test',
        origin: 'http://evil.example',
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: uploadBody(BOUNDARY, 'x.pdf', 'application/pdf', PDF_BYTES),
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).success).toBe(false);
  });

  it('sanitizes a traversal filename: writes safely inside .codeman-attachments/, preserves display name', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(BOUNDARY, '../../evil.pdf', 'application/pdf', PDF_BYTES),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Display name is the sanitized basename.
    expect(body.data.fileName).toBe('evil.pdf');
    // agentPath stays confined to .codeman-attachments/ (no traversal).
    expect(body.data.agentPath.startsWith('.codeman-attachments/')).toBe(true);
    expect(body.data.agentPath).not.toContain('..');
    // The on-disk file is inside the workspace dir; no file escaped to a parent.
    const onDisk = join(workdir, body.data.agentPath);
    expect((await fs.stat(onDisk)).isFile()).toBe(true);
    const parentEscape = join(workdir, '..', 'evil.pdf');
    await expect(fs.stat(parentEscape)).rejects.toBeTruthy();
  });

  it('429: rate-limits after the per-session token budget is exhausted', async () => {
    // Bucket is 20 tokens; exhaust then expect a 429.
    let last = 200;
    for (let i = 0; i < 21; i++) {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
        headers: MULTIPART_HEADERS,
        payload: uploadBody(BOUNDARY, `f${i}.pdf`, 'application/pdf', PDF_BYTES),
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });
});
