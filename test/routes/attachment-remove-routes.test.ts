/**
 * @fileoverview Route tests for DELETE /api/sessions/:id/attachments/uploaded (COD-241 unit 3).
 *
 * Exercises the restart-safe ownership gate against a REAL temp workspace (via
 * fs.mkdtemp) so the symlink-safe realpath confinement runs on actual files:
 *  - upload → delete a file under .codeman-attachments/ → 200, file gone, history cleared
 *  - a normal workspace file OUTSIDE .codeman-attachments/ → 403, still present
 *  - a traversal path → 404
 *  - a missing ?path → 400
 *  - an already-deleted path → 404 (idempotent-not; the path no longer resolves)
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

async function createEnvelopeHarness(sessionId?: string): Promise<LocalHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4, parts: 5 },
  });

  const ctx = createMockRouteContext({ sessionId });
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

const BOUNDARY = 'codeman-remove-boundary';
const MULTIPART_HEADERS = {
  host: 'codeman.test',
  origin: 'http://codeman.test',
  'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
};

const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n', 'latin1');

/** Upload a PDF and return its workspace-relative agentPath (.codeman-attachments/…). */
async function uploadPdf(harness: LocalHarness, filename = 'Report.pdf'): Promise<string> {
  const res = await harness.app.inject({
    method: 'POST',
    url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
    headers: MULTIPART_HEADERS,
    payload: uploadBody(BOUNDARY, filename, 'application/pdf', PDF_BYTES),
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body).data.agentPath as string;
}

describe('DELETE /api/sessions/:id/attachments/uploaded (COD-241 unit 3)', () => {
  let harness: LocalHarness;
  let workdir: string;

  beforeEach(async () => {
    _resetUploadRateBuckets();
    harness = await createEnvelopeHarness();
    workdir = await fs.mkdtemp(join(tmpdir(), 'codeman-remove-test-'));
    harness.ctx._session.workingDir = workdir;
    attachmentRegistry.clearSession(harness.ctx._sessionId);
  });

  afterEach(async () => {
    delete process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS;
    resetTrustedAttachmentRootsForTests();
    attachmentRegistry.clearSession(harness.ctx._sessionId);
    await harness.app.close();
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('removes a proven trusted-root upload after registry reconstruction', async () => {
    const trusted = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-remove-trusted-')));
    process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS = trusted;
    resetTrustedAttachmentRootsForTests();
    await fs.symlink(trusted, join(workdir, '.codeman-attachments'));
    try {
      const agentPath = await uploadPdf(harness, 'Trusted.pdf');
      const leaf = agentPath.split('/').at(-1)!;
      attachmentRegistry.clearSession(harness.ctx._sessionId);
      const history = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      });
      expect(JSON.parse(history.body).data.items[0].relativePath).toBe(agentPath);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/uploaded?path=${encodeURIComponent(agentPath)}`,
      });
      expect(res.statusCode).toBe(200);
      await expect(fs.stat(join(trusted, leaf))).rejects.toBeTruthy();
      expect(harness.ctx._session.attachmentHistory).toHaveLength(0);
    } finally {
      await fs.rm(trusted, { recursive: true, force: true });
    }
  });

  it.each([
    '.codeman-attachments/',
    '.codeman-attachments/.',
    '.codeman-attachments/..',
    '.codeman-attachments/nested/file.pdf',
    '.codeman-attachments\\file.pdf',
    '.codeman-attachments/../file.pdf',
  ])('rejects an invalid trusted logical path: %s', async (candidate) => {
    const trusted = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-remove-trusted-')));
    process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS = trusted;
    resetTrustedAttachmentRootsForTests();
    await fs.symlink(trusted, join(workdir, '.codeman-attachments'));
    try {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/uploaded?path=${encodeURIComponent(candidate)}`,
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await fs.rm(trusted, { recursive: true, force: true });
    }
  });

  it('refuses a trusted sibling without provenance and a symlink leaf', async () => {
    const trusted = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-remove-trusted-')));
    process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS = trusted;
    resetTrustedAttachmentRootsForTests();
    await fs.symlink(trusted, join(workdir, '.codeman-attachments'));
    const sibling = join(trusted, 'sibling.pdf');
    const leafLink = join(trusted, 'link.pdf');
    await fs.writeFile(sibling, PDF_BYTES);
    await fs.symlink(sibling, leafLink);
    try {
      for (const name of ['sibling.pdf', 'link.pdf']) {
        const res = await harness.app.inject({
          method: 'DELETE',
          url: `/api/sessions/${harness.ctx._sessionId}/attachments/uploaded?path=${encodeURIComponent(
            `.codeman-attachments/${name}`
          )}`,
        });
        expect(res.statusCode).toBe(403);
      }
      await expect(fs.stat(sibling)).resolves.toBeDefined();
      await expect(fs.lstat(leafLink)).resolves.toMatchObject({});
    } finally {
      await fs.rm(trusted, { recursive: true, force: true });
    }
  });

  it('keeps old history without upload provenance readable but not removable', async () => {
    const trusted = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-remove-trusted-')));
    process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS = trusted;
    resetTrustedAttachmentRootsForTests();
    await fs.symlink(trusted, join(workdir, '.codeman-attachments'));
    try {
      const agentPath = await uploadPdf(harness, 'Legacy.pdf');
      const persisted = harness.ctx._session.getAttachmentHistoryForPersist()![0];
      harness.ctx._session.upsertAttachmentHistory({ ...persisted, uploadProvenance: undefined });
      attachmentRegistry.clearSession(harness.ctx._sessionId);

      const list = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      });
      expect(list.statusCode).toBe(200);
      expect(JSON.parse(list.body).data.items[0]).toMatchObject({ missing: false });
      expect(JSON.parse(list.body).data.items[0].relativePath).toBeUndefined();

      const remove = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/uploaded?path=${encodeURIComponent(agentPath)}`,
      });
      expect(remove.statusCode).toBe(403);
      await expect(fs.stat(join(trusted, agentPath.split('/').at(-1)!))).resolves.toBeDefined();
    } finally {
      await fs.rm(trusted, { recursive: true, force: true });
    }
  });

  it('fails closed when trusted-root configuration is removed', async () => {
    const trusted = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-remove-trusted-')));
    process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS = trusted;
    resetTrustedAttachmentRootsForTests();
    await fs.symlink(trusted, join(workdir, '.codeman-attachments'));
    try {
      const agentPath = await uploadPdf(harness, 'Config.pdf');
      delete process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS;
      resetTrustedAttachmentRootsForTests();
      const remove = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/uploaded?path=${encodeURIComponent(agentPath)}`,
      });
      expect(remove.statusCode).toBe(403);
      await expect(fs.stat(join(trusted, agentPath.split('/').at(-1)!))).resolves.toBeDefined();
    } finally {
      await fs.rm(trusted, { recursive: true, force: true });
    }
  });

  it('does not let another session using the same trusted root delete the upload', async () => {
    const trusted = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-remove-trusted-')));
    process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS = trusted;
    resetTrustedAttachmentRootsForTests();
    await fs.symlink(trusted, join(workdir, '.codeman-attachments'));
    const otherHarness = await createEnvelopeHarness('other-session');
    const otherWorkspace = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-remove-other-')));
    otherHarness.ctx._session.workingDir = otherWorkspace;
    await fs.symlink(trusted, join(otherWorkspace, '.codeman-attachments'));
    try {
      const agentPath = await uploadPdf(harness, 'Owned.pdf');
      const filePath = join(trusted, agentPath.split('/').at(-1)!);
      const ownerRecord = attachmentRegistry.findByFilePath(harness.ctx._sessionId, filePath)!;
      attachmentRegistry.register({
        ...ownerRecord,
        attachmentId: 'att_registry-is-not-authority',
        sessionId: otherHarness.ctx._sessionId,
      });
      const remove = await otherHarness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${otherHarness.ctx._sessionId}/attachments/uploaded?path=${encodeURIComponent(agentPath)}`,
      });
      expect(remove.statusCode).toBe(403);
      await expect(fs.stat(filePath)).resolves.toBeDefined();
    } finally {
      attachmentRegistry.clearSession(otherHarness.ctx._sessionId);
      await otherHarness.app.close();
      await fs.rm(otherWorkspace, { recursive: true, force: true });
      await fs.rm(trusted, { recursive: true, force: true });
    }
  });

  it('fails closed when the workspace symlink is repointed to another approved root', async () => {
    const trusted = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-remove-trusted-')));
    const other = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-remove-repointed-')));
    process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS = `${trusted},${other}`;
    resetTrustedAttachmentRootsForTests();
    const link = join(workdir, '.codeman-attachments');
    await fs.symlink(trusted, link);
    try {
      const agentPath = await uploadPdf(harness, 'Repointed.pdf');
      await fs.unlink(link);
      await fs.symlink(other, link);
      const remove = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/uploaded?path=${encodeURIComponent(agentPath)}`,
      });
      expect(remove.statusCode).not.toBe(200);
      await expect(fs.stat(join(trusted, agentPath.split('/').at(-1)!))).resolves.toBeDefined();
    } finally {
      await fs.rm(trusted, { recursive: true, force: true });
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it('(a) 200: removes an uploaded file, deletes it from disk, and drops it from history', async () => {
    const agentPath = await uploadPdf(harness);
    // Precondition: file present + one history entry.
    expect((await fs.stat(join(workdir, agentPath))).isFile()).toBe(true);
    expect(harness.ctx._session.attachmentHistory.length).toBe(1);

    const res = await harness.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/uploaded?path=${encodeURIComponent(agentPath)}`,
      headers: { host: 'codeman.test', origin: 'http://codeman.test' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.removed).toBe(true);
    expect(body.data.path).toBe(agentPath);

    // File is gone from disk and history no longer references it.
    await expect(fs.stat(join(workdir, agentPath))).rejects.toBeTruthy();
    expect(harness.ctx._session.attachmentHistory.length).toBe(0);
    expect(harness.ctx.persistSessionState).toHaveBeenCalled();
  });

  it('(b) 403: refuses a normal workspace file outside .codeman-attachments/ (file stays)', async () => {
    const outside = join(workdir, 'user-notes.txt');
    await fs.writeFile(outside, 'my own file, not a Codeman upload\n');

    const res = await harness.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/uploaded?path=${encodeURIComponent('user-notes.txt')}`,
      headers: { host: 'codeman.test', origin: 'http://codeman.test' },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).success).toBe(false);
    // The user's own file is untouched.
    expect((await fs.stat(outside)).isFile()).toBe(true);
  });

  it('(c) 404: rejects a traversal path', async () => {
    const res = await harness.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/uploaded?path=${encodeURIComponent('../../etc/passwd')}`,
      headers: { host: 'codeman.test', origin: 'http://codeman.test' },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).success).toBe(false);
  });

  it('(d) 400: rejects a missing ?path parameter', async () => {
    const res = await harness.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/uploaded`,
      headers: { host: 'codeman.test', origin: 'http://codeman.test' },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).success).toBe(false);
  });

  it('(e) 404: an already-deleted path no longer resolves (idempotent-not, consistent 404)', async () => {
    const agentPath = await uploadPdf(harness);
    const url = `/api/sessions/${harness.ctx._sessionId}/attachments/uploaded?path=${encodeURIComponent(agentPath)}`;

    const first = await harness.app.inject({
      method: 'DELETE',
      url,
      headers: { host: 'codeman.test', origin: 'http://codeman.test' },
    });
    expect(first.statusCode).toBe(200);

    const second = await harness.app.inject({
      method: 'DELETE',
      url,
      headers: { host: 'codeman.test', origin: 'http://codeman.test' },
    });
    expect(second.statusCode).toBe(404);
    expect(JSON.parse(second.body).success).toBe(false);
  });

  it('404: unknown session', async () => {
    const res = await harness.app.inject({
      method: 'DELETE',
      url: `/api/sessions/does-not-exist/attachments/uploaded?path=${encodeURIComponent('.codeman-attachments/x.pdf')}`,
      headers: { host: 'codeman.test', origin: 'http://codeman.test' },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).success).toBe(false);
  });
});
