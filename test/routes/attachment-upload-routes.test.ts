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
import { resetTrustedAttachmentRootsForTests } from '../../src/config/attachment-guard.js';

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
    delete process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS;
    delete process.env.CODEMAN_ATTACHMENT_WORKSPACE_ROOTS;
    delete process.env.CODEMAN_ATTACHMENT_CONFINE;
    resetTrustedAttachmentRootsForTests();
    attachmentRegistry.clearSession(harness.ctx._sessionId);
    await harness.app.close();
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it.each(['removed', 'regular replacement'] as const)(
    'fails closed during trusted restart reconstruction when the workspace link is %s',
    async (replacement) => {
      const trusted = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-upload-trusted-')));
      process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS = trusted;
      resetTrustedAttachmentRootsForTests();
      const link = join(workdir, '.codeman-attachments');
      await fs.symlink(trusted, link);
      try {
        const upload = await harness.app.inject({
          method: 'POST',
          url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
          headers: MULTIPART_HEADERS,
          payload: uploadBody(BOUNDARY, 'Restart.pdf', 'application/pdf', PDF_BYTES),
        });
        expect(upload.statusCode).toBe(200);
        attachmentRegistry.clearSession(harness.ctx._sessionId);
        await fs.unlink(link);
        if (replacement === 'regular replacement') await fs.mkdir(link);

        const history = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        });
        expect(history.statusCode).toBe(200);
        expect(JSON.parse(history.body).data.items[0]).toMatchObject({ missing: true });
        expect(JSON.parse(history.body).data.items[0].attachmentId).toBeUndefined();
      } finally {
        await fs.rm(trusted, { recursive: true, force: true });
      }
    }
  );

  it('reconstructs a normal workspace upload only inside the current regular upload directory', async () => {
    const upload = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(BOUNDARY, 'Workspace.pdf', 'application/pdf', PDF_BYTES),
    });
    expect(upload.statusCode).toBe(200);
    const agentPath = JSON.parse(upload.body).data.agentPath;
    attachmentRegistry.clearSession(harness.ctx._sessionId);

    const history = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
    });
    const item = JSON.parse(history.body).data.items[0];
    expect(item).toMatchObject({ missing: false, relativePath: agentPath });
    expect(attachmentRegistry.get(harness.ctx._sessionId, item.attachmentId)?.trustedUploadBoundary).toBeUndefined();
  });

  it('lets a freshly validated trusted boundary bypass global confinement for upload and every by-id read', async () => {
    const trusted = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-upload-trusted-')));
    const unrelated = join(workdir, '..', `unrelated-${Date.now()}.pdf`);
    process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS = trusted;
    process.env.CODEMAN_ATTACHMENT_CONFINE = 'true';
    resetTrustedAttachmentRootsForTests();
    await fs.symlink(trusted, join(workdir, '.codeman-attachments'));
    await fs.writeFile(unrelated, PDF_BYTES);
    try {
      const upload = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
        headers: MULTIPART_HEADERS,
        payload: uploadBody(BOUNDARY, 'Confined.pdf', 'application/pdf', PDF_BYTES),
      });
      expect(upload.statusCode).toBe(200);
      const data = JSON.parse(upload.body).data;
      const raw = await harness.app.inject({ method: 'GET', url: data.rawUrl });
      const preview = await harness.app.inject({ method: 'GET', url: data.previewUrl });
      const thumbnail = await harness.app.inject({ method: 'GET', url: data.thumbnailUrl });
      expect(raw.statusCode).toBe(200);
      expect(preview.statusCode).toBe(302);
      expect([200, 204]).toContain(thumbnail.statusCode);

      const external = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: unrelated },
      });
      expect(external.statusCode).toBe(403);
    } finally {
      await fs.rm(unrelated, { force: true });
      await fs.rm(trusted, { recursive: true, force: true });
    }
  });

  it('uploads, reconstructs history, reads and deletes from a mapped enclave with no workspace symlink', async () => {
    const trusted = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-upload-mapped-')));
    process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS = trusted;
    process.env.CODEMAN_ATTACHMENT_WORKSPACE_ROOTS = JSON.stringify({ [await fs.realpath(workdir)]: trusted });
    resetTrustedAttachmentRootsForTests();
    try {
      const upload = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
        headers: MULTIPART_HEADERS,
        payload: uploadBody(BOUNDARY, 'Mapped.pdf', 'application/pdf', PDF_BYTES),
      });
      expect(upload.statusCode).toBe(200);
      const data = JSON.parse(upload.body).data;
      expect(data.agentPath.startsWith(`${trusted}/`)).toBe(true);
      expect(await fs.readFile(data.agentPath)).toEqual(PDF_BYTES);
      attachmentRegistry.clearSession(harness.ctx._sessionId);
      const history = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      });
      const item = JSON.parse(history.body).data.items[0];
      expect(item.missing).toBe(false);
      expect(item.relativePath).toMatch(/^\.codeman-attachments\/Mapped-/);
      const raw = await harness.app.inject({ method: 'GET', url: item.rawUrl });
      expect(raw.rawPayload).toEqual(PDF_BYTES);
      const removed = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/uploaded?path=${encodeURIComponent(item.relativePath)}`,
        headers: { host: 'codeman.test', origin: 'http://codeman.test' },
      });
      expect(removed.statusCode).toBe(200);
      await expect(fs.stat(data.agentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.lstat(join(workdir, '.codeman-attachments'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(trusted, { recursive: true, force: true });
    }
  });

  it('uploads through an exact approved symlink with a trusted read boundary and provenance', async () => {
    const trusted = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-upload-trusted-')));
    process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS = trusted;
    resetTrustedAttachmentRootsForTests();
    await fs.symlink(trusted, join(workdir, '.codeman-attachments'));

    try {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
        headers: MULTIPART_HEADERS,
        payload: uploadBody(BOUNDARY, 'Trusted.pdf', 'application/pdf', PDF_BYTES),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.agentPath).toMatch(/^\.codeman-attachments\/Trusted-.*\.pdf$/);
      const record = attachmentRegistry.get(harness.ctx._sessionId, body.data.attachmentId);
      expect(record?.filePath).toBe(join(trusted, body.data.agentPath.split('/').at(-1)));
      expect(record?.trustedUploadBoundary).toBe(trusted);
      expect(record?.generatedArtifactBoundary).toBeUndefined();
      expect(harness.ctx._session.attachmentHistory[0].source).toBe('external');
      expect(harness.ctx._session.attachmentHistory[0].uploadProvenance).toBe('codeman-upload');
      expect(JSON.stringify(harness.ctx._session.getAttachmentHistoryForPersist())).not.toContain(
        'trustedUploadBoundary'
      );
      await expect(fs.readFile(record!.filePath)).resolves.toEqual(PDF_BYTES);

      const raw = await harness.app.inject({ method: 'GET', url: body.data.rawUrl });
      expect(raw.statusCode).toBe(200);
      expect(raw.rawPayload).toEqual(PDF_BYTES);

      const persisted = harness.ctx._session.getAttachmentHistoryForPersist()![0];
      harness.ctx._session.upsertAttachmentHistory({ ...persisted, generatedArtifactBoundary: '/forged/wide/root' });
      attachmentRegistry.clearSession(harness.ctx._sessionId);
      const history = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      });
      expect(history.statusCode).toBe(200);
      const reconstructedId = JSON.parse(history.body).data.items[0].attachmentId;
      const reconstructed = attachmentRegistry.get(harness.ctx._sessionId, reconstructedId);
      expect(reconstructed?.trustedUploadBoundary).toBe(trusted);
      expect(reconstructed?.generatedArtifactBoundary).toBeUndefined();

      const outside = join(workdir, 'outside.pdf');
      await fs.writeFile(outside, PDF_BYTES);
      await fs.unlink(reconstructed!.filePath);
      await fs.symlink(outside, reconstructed!.filePath);
      for (const suffix of ['raw', 'preview', 'thumbnail']) {
        const blocked = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/attachments/${reconstructedId}/${suffix}`,
        });
        expect(blocked.statusCode).toBe(403);
      }
    } finally {
      await fs.rm(trusted, { recursive: true, force: true });
    }
  });

  it('keeps trusted upload names unique under concurrency', async () => {
    const trusted = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-upload-trusted-')));
    process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS = trusted;
    resetTrustedAttachmentRootsForTests();
    await fs.symlink(trusted, join(workdir, '.codeman-attachments'));
    try {
      const responses = await Promise.all(
        Array.from({ length: 4 }, () =>
          harness.app.inject({
            method: 'POST',
            url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
            headers: MULTIPART_HEADERS,
            payload: uploadBody(BOUNDARY, 'Same.pdf', 'application/pdf', PDF_BYTES),
          })
        )
      );
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      expect(new Set(responses.map((response) => JSON.parse(response.body).data.agentPath)).size).toBe(4);
    } finally {
      await fs.rm(trusted, { recursive: true, force: true });
    }
  });

  it('rejects an unapproved symlink without exposing its target', async () => {
    const target = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-upload-secret-')));
    const configured = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-upload-configured-')));
    process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS = configured;
    resetTrustedAttachmentRootsForTests();
    await fs.symlink(target, join(workdir, '.codeman-attachments'));
    try {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
        headers: MULTIPART_HEADERS,
        payload: uploadBody(BOUNDARY, 'Nope.pdf', 'application/pdf', PDF_BYTES),
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain(target);
      expect(res.body).not.toContain(configured);
    } finally {
      await fs.rm(target, { recursive: true, force: true });
      await fs.rm(configured, { recursive: true, force: true });
    }
  });

  it('explains that an external attachment symlink needs trusted-root configuration', async () => {
    const target = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-upload-unconfigured-')));
    await fs.symlink(target, join(workdir, '.codeman-attachments'));
    try {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
        headers: MULTIPART_HEADERS,
        payload: uploadBody(BOUNDARY, 'Needs-config.pdf', 'application/pdf', PDF_BYTES),
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain('External .codeman-attachments requires an approved trusted attachment root');
      expect(res.body).not.toContain(target);
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
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
