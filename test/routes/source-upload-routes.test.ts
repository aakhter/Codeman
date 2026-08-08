/**
 * TDD route tests for POST /api/sessions/:id/sources/upload (COD-281).
 *
 * Uses a multipart-capable Fastify harness with the production uniform-envelope
 * preSerialization hook (mirrors attachment-upload-routes.test.ts) and writes
 * to a REAL temp workspace so the symlink-safe write runs against actual files
 * on disk (no fs mock).
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
import { _resetSourceUploadRateBuckets, registerSourceRoutes } from '../../src/web/routes/source-routes.js';

interface LocalHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

async function createEnvelopeHarness(): Promise<LocalHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4, parts: 6 },
  });

  const ctx = createMockRouteContext();
  registerSourceRoutes(app, ctx as never);

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

function uploadBody(boundary: string, filename: string, mimetype: string, bytes: Buffer, title?: string): Buffer {
  const titlePart = title
    ? Buffer.from(`--${boundary}\r\n` + `Content-Disposition: form-data; name="title"\r\n` + `\r\n${title}\r\n`)
    : Buffer.alloc(0);
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${mimetype}\r\n\r\n`
    ),
    bytes,
    Buffer.from(`\r\n`),
    titlePart,
    Buffer.from(`--${boundary}--\r\n`),
  ]);
}

const BOUNDARY = 'codeman-source-boundary';
const MULTIPART_HEADERS = {
  host: 'codeman.test',
  origin: 'http://codeman.test',
  'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
};

const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n', 'latin1');
const TXT_BYTES = Buffer.from('just some notes\nsecond line\n');

describe('POST /api/sessions/:id/sources/upload (COD-281)', () => {
  let harness: LocalHarness;
  let workdir: string;
  const SESSION_ID = 'test-session-1';

  beforeEach(async () => {
    harness = await createEnvelopeHarness();
    workdir = await fs.mkdtemp(join(tmpdir(), 'codeman-source-upload-test-'));
    harness.ctx._session.workingDir = workdir;
    harness.ctx._sessionId = SESSION_ID;
  });

  afterEach(async () => {
    await harness.app.close();
    await fs.rm(workdir, { recursive: true, force: true });
    _resetSourceUploadRateBuckets();
  });

  it('200: uploads a valid PDF as a file source, writes it under .codeman-sources/', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/sources/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(BOUNDARY, 'Quarterly Report.pdf', 'application/pdf', PDF_BYTES, 'Quarterly Report'),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.source.type).toBe('file');
    expect(body.data.source.title).toBe('Quarterly Report');
    expect(body.data.source.relativePath).toMatch(/^\.codeman-sources\/Quarterly Report-.*\.pdf$/);
    expect(body.data.source.id).toBeTruthy();
    expect(body.data.source.sessionId).toBe(SESSION_ID);
    expect(typeof body.data.source.addedAt).toBe('number');

    // File exists on disk under the workspace .codeman-sources dir.
    const onDisk = join(workdir, body.data.source.relativePath);
    const stat = await fs.stat(onDisk);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBe(PDF_BYTES.length);
    expect(stat.mode & 0o777).toBe(0o600);

    // The source is registered on the session and persisted.
    expect(harness.ctx._session.sources).toHaveLength(1);
    expect(harness.ctx.persistSessionState).toHaveBeenCalled();
  });

  it('200: defaults the title to the sanitized filename when no title part is sent', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/sources/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(BOUNDARY, 'notes.txt', 'text/plain', TXT_BYTES),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.source.type).toBe('file');
    expect(body.data.source.title).toBe('notes.txt');
  });

  it('200: uploaded source is reflected in GET and can be deleted', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/sources/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(BOUNDARY, 'notes.txt', 'text/plain', TXT_BYTES),
    });
    const sourceId = JSON.parse(res.body).data.source.id;

    const get = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${SESSION_ID}/sources`,
    });
    expect(JSON.parse(get.body).data.sources).toHaveLength(1);

    const del = await harness.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${SESSION_ID}/sources/${sourceId}`,
    });
    expect(del.statusCode).toBe(200);
    expect(JSON.parse(del.body).success).toBe(true);
  });

  it('415: rejects an unsupported extension (.exe)', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/sources/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(BOUNDARY, 'malware.exe', 'application/octet-stream', PDF_BYTES),
    });
    expect(res.statusCode).toBe(415);
    expect(JSON.parse(res.body).success).toBe(false);
  });

  it('415: rejects a content/type mismatch (txt bytes declared as .pdf)', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/sources/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(BOUNDARY, 'fake.pdf', 'application/pdf', TXT_BYTES),
    });
    expect(res.statusCode).toBe(415);
    expect(JSON.parse(res.body).success).toBe(false);
  });

  it('400: rejects a title longer than the standard source title limit', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/sources/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(BOUNDARY, 'notes.txt', 'text/plain', TXT_BYTES, 'x'.repeat(501)),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).success).toBe(false);
    expect(harness.ctx._session.sources).toHaveLength(0);
  });

  it('400: rejects a non-multipart body', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/sources/upload`,
      headers: { host: 'codeman.test', origin: 'http://codeman.test', 'content-type': 'application/json' },
      payload: JSON.stringify({ nope: true }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).success).toBe(false);
  });

  it('400: rejects a missing "file" field (wrong field name)', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/sources/upload`,
      headers: MULTIPART_HEADERS,
      payload: Buffer.concat([
        Buffer.from(
          `--${BOUNDARY}\r\n` +
            `Content-Disposition: form-data; name="document"; filename="x.pdf"\r\n` +
            `Content-Type: application/pdf\r\n\r\n`
        ),
        PDF_BYTES,
        Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
      ]),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).success).toBe(false);
  });

  it('400: rejects unexpected multipart fields', async () => {
    const payload = Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="unexpected"\r\n\r\nvalue\r\n`),
      uploadBody(BOUNDARY, 'notes.txt', 'text/plain', TXT_BYTES).subarray(0, -(`${BOUNDARY}--\r\n`.length + 2)),
      Buffer.from(`--${BOUNDARY}--\r\n`),
    ]);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/sources/upload`,
      headers: MULTIPART_HEADERS,
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).success).toBe(false);
    expect(harness.ctx._session.sources).toHaveLength(0);
  });

  it('403: rejects a cross-origin (CSRF) request', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/sources/upload`,
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

  it('sanitizes a traversal filename: writes safely inside .codeman-sources/, preserves display title', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_ID}/sources/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(BOUNDARY, '../../evil.pdf', 'application/pdf', PDF_BYTES),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.source.relativePath).toMatch(/^\.codeman-sources\/evil-.*\.pdf$/);
    expect(body.data.source.relativePath).not.toContain('..');
    const onDisk = join(workdir, body.data.source.relativePath);
    await expect(fs.stat(onDisk)).resolves.toBeTruthy();
  });

  it('404: rejects an unknown session', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions/no-such-session/sources/upload',
      headers: MULTIPART_HEADERS,
      payload: uploadBody(BOUNDARY, 'x.pdf', 'application/pdf', PDF_BYTES),
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).success).toBe(false);
  });
});
