/**
 * @fileoverview Regression tests for COD-296 — attachment directory resolution
 * must be NON-MUTATING on read and delete paths.
 *
 * `resolveLocalUploadDirectory` used to `mkdir` a missing `.codeman-attachments/`
 * while reconstructing attachment history, so a plain `GET /attachments` or a
 * `DELETE /attachments/uploaded` created a directory in the user's workspace —
 * a read-only request with a filesystem side effect. Remote sessions, whose
 * attachments live on the REMOTE host, got the pointless local directory too.
 *
 * These assert on the filesystem (does the directory exist afterwards?), not on
 * the status code alone: the status codes were already correct, which is exactly
 * why the side effect went unnoticed. The upload cases are the controls — they
 * must STILL create the directory, or the fix has simply broken uploads.
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
import type { SessionRemote } from '../../src/types/session.js';

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

const BOUNDARY = 'codeman-side-effect-boundary';
const MULTIPART_HEADERS = {
  host: 'codeman.test',
  origin: 'http://codeman.test',
  'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
};
const MUTATING_HEADERS = { host: 'codeman.test', origin: 'http://codeman.test' };

const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n', 'latin1');

const REMOTE: SessionRemote = {
  hostId: 'host-1',
  label: 'moneytrove',
  host: 'example.internal',
  username: 'saqebakhter',
  remotePath: '/Users/saqebakhter/repos/projects/moneytrove',
};

function uploadBody(filename: string): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
        `Content-Type: application/pdf\r\n\r\n`
    ),
    PDF_BYTES,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

describe('COD-296 — attachment directory resolution is non-mutating on read/delete', () => {
  let harness: LocalHarness;
  let workdir: string;
  let attachmentsDir: string;

  beforeEach(async () => {
    _resetUploadRateBuckets();
    harness = await createEnvelopeHarness();
    workdir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-side-effect-')));
    attachmentsDir = join(workdir, '.codeman-attachments');
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

  /** Upload a PDF (creating the dir), then delete the dir behind Codeman's back. */
  async function uploadThenRemoveDirectory(filename = 'Report.pdf'): Promise<string> {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(filename),
    });
    expect(res.statusCode).toBe(200);
    const agentPath = JSON.parse(res.body).data.agentPath as string;

    await fs.rm(attachmentsDir, { recursive: true, force: true });
    // Force the history-reconstruction path (the registry would otherwise short-circuit).
    attachmentRegistry.clearSession(harness.ctx._sessionId);
    return agentPath;
  }

  const dirExists = async (): Promise<boolean> =>
    fs
      .lstat(attachmentsDir)
      .then(() => true)
      .catch(() => false);

  it('GET /attachments does not recreate a missing upload directory', async () => {
    await uploadThenRemoveDirectory();

    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
    });

    expect(res.statusCode).toBe(200);
    // Fail-closed: the file is gone, so the entry reports missing rather than 500.
    expect(JSON.parse(res.body).data.items[0]).toMatchObject({ missing: true });
    expect(await dirExists()).toBe(false);
  });

  it('DELETE /attachments/uploaded does not recreate a missing upload directory', async () => {
    const agentPath = await uploadThenRemoveDirectory();

    const res = await harness.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/uploaded?path=${encodeURIComponent(agentPath)}`,
      headers: MUTATING_HEADERS,
    });

    // Not-found semantics preserved: the file genuinely is not there.
    expect(res.statusCode).toBe(404);
    expect(await dirExists()).toBe(false);
  });

  it('DELETE /attachments/uploaded creates nothing when the workspace has never had an upload', async () => {
    const res = await harness.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/uploaded?path=${encodeURIComponent(
        '.codeman-attachments/never-existed.pdf'
      )}`,
      headers: MUTATING_HEADERS,
    });

    expect(res.statusCode).toBe(404);
    expect(await dirExists()).toBe(false);
  });

  it('a remote session never creates a local upload directory on delete', async () => {
    harness.ctx._session.remote = REMOTE;

    const res = await harness.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/uploaded?path=${encodeURIComponent(
        '.codeman-attachments/remote.pdf'
      )}`,
      headers: MUTATING_HEADERS,
    });

    expect(res.statusCode).toBe(404);
    expect(await dirExists()).toBe(false);
  });

  it('a remote session never creates a local upload directory when listing history', async () => {
    const agentPath = await uploadThenRemoveDirectory('Remote.pdf');
    expect(agentPath).toContain('.codeman-attachments/');
    // The session became remote after the fact; history still carries the local
    // upload provenance, which is the entry that used to trigger the mkdir.
    harness.ctx._session.remote = REMOTE;

    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
    });

    expect(res.statusCode).toBe(200);
    expect(await dirExists()).toBe(false);
  });

  // ── Controls: the upload path MUST still create the directory ───────────────

  it('POST /attachments/upload still creates a missing upload directory', async () => {
    expect(await dirExists()).toBe(false);

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody('Fresh.pdf'),
    });

    expect(res.statusCode).toBe(200);
    expect((await fs.lstat(attachmentsDir)).isDirectory()).toBe(true);
  });

  it('an upload into an existing directory still round-trips through history and delete', async () => {
    await fs.mkdir(attachmentsDir);

    const upload = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody('Kept.pdf'),
    });
    expect(upload.statusCode).toBe(200);
    const agentPath = JSON.parse(upload.body).data.agentPath as string;
    attachmentRegistry.clearSession(harness.ctx._sessionId);

    const list = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
    });
    expect(JSON.parse(list.body).data.items[0]).toMatchObject({ missing: false });

    const remove = await harness.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/uploaded?path=${encodeURIComponent(agentPath)}`,
      headers: MUTATING_HEADERS,
    });
    expect(remove.statusCode).toBe(200);
    await expect(fs.stat(join(workdir, agentPath))).rejects.toMatchObject({ code: 'ENOENT' });
    // The directory itself survives a file removal.
    expect((await fs.lstat(attachmentsDir)).isDirectory()).toBe(true);
  });
});
