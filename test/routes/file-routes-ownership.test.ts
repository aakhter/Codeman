/**
 * @fileoverview Multi-user ownership regressions for session-scoped file and attachment routes
 * (COD-292, extended by COD-294 for the tail-file and download routes).
 *
 * Uses app.inject() with a real temporary workspace. A regular user must receive
 * the same not-found response for another user's session as for an unknown id.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { registerFileRoutes, _resetUploadRateBuckets } from '../../src/web/routes/file-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, type AuthUser } from '../../src/types.js';

const SESSION_OWNER = 'alice';
const REQUEST_USER: AuthUser = { username: 'bob', role: 'user' };
const OWNER_USER: AuthUser = { username: SESSION_OWNER, role: 'user' };
const ADMIN_USER: AuthUser = { username: 'root', role: 'admin' };
const BOUNDARY = 'codeman-ownership-boundary';
const MULTIPART_HEADERS = {
  host: 'codeman.test',
  origin: 'http://codeman.test',
  'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
};
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n', 'latin1');

interface OwnershipHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
  workdir: string;
  setRequestUser(user: AuthUser): void;
}

function uploadBody(filename: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
        'Content-Type: application/pdf\r\n\r\n'
    ),
    bytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

function expectOwnershipNotFound(response: { statusCode: number; json(): unknown }, sessionId: string): void {
  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({
    success: false,
    error: `Session ${sessionId} not found`,
    errorCode: ApiErrorCode.NOT_FOUND,
  });
}

async function createOwnershipHarness(): Promise<OwnershipHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4, parts: 5 },
  });
  let requestUser = REQUEST_USER;
  app.addHook('onRequest', async (req) => {
    (req as unknown as { authUser: AuthUser }).authUser = requestUser;
  });

  const ctx = createMockRouteContext();
  const workdir = await fs.mkdtemp(join(tmpdir(), 'codeman-file-ownership-test-'));
  ctx._session.owner = SESSION_OWNER;
  ctx._session.workingDir = workdir;
  registerFileRoutes(app, ctx as never);
  installRouteErrorHandler(app);
  await app.ready();
  return {
    app,
    ctx,
    workdir,
    setRequestUser(user) {
      requestUser = user;
    },
  };
}

describe('file and attachment route session ownership (COD-292)', () => {
  let harness: OwnershipHarness;
  let previousMultiUser: string | undefined;

  beforeEach(async () => {
    previousMultiUser = process.env.CODEMAN_MULTIUSER;
    process.env.CODEMAN_MULTIUSER = '1';
    _resetUploadRateBuckets();
    harness = await createOwnershipHarness();
  });

  afterEach(async () => {
    await harness.app.close();
    await fs.rm(harness.workdir, { recursive: true, force: true });
    if (previousMultiUser === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = previousMultiUser;
  });

  it("GET /file-content hides another user's session", async () => {
    await fs.writeFile(join(harness.workdir, 'secret.txt'), 'alice only');

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=secret.txt`,
    });

    expectOwnershipNotFound(response, harness.ctx._sessionId);
  });

  it("POST /attachments/upload hides another user's session and does not write a file", async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody('secret.pdf', PDF_BYTES),
    });

    expectOwnershipNotFound(response, harness.ctx._sessionId);
    await expect(fs.stat(join(harness.workdir, '.codeman-attachments'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it("foreign upload attempts stay 404 and do not consume the owner's rate-limit quota", async () => {
    const foreignStatuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt++) {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
        headers: MULTIPART_HEADERS,
        payload: uploadBody(`foreign-${attempt}.pdf`, PDF_BYTES),
      });
      foreignStatuses.push(response.statusCode);
    }

    harness.setRequestUser({ username: SESSION_OWNER, role: 'user' });
    const ownerStatuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt++) {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
        headers: MULTIPART_HEADERS,
        payload: uploadBody(`owner-${attempt}.pdf`, PDF_BYTES),
      });
      ownerStatuses.push(response.statusCode);
    }

    expect({ foreignStatuses, ownerStatuses }).toEqual({
      foreignStatuses: Array.from({ length: 21 }, () => 404),
      ownerStatuses: [...Array.from({ length: 20 }, () => 200), 429],
    });
  });

  it("GET /attachments hides another user's session", async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
    });

    expectOwnershipNotFound(response, harness.ctx._sessionId);
  });

  it("DELETE /attachments/uploaded hides another user's session and does not remove its file", async () => {
    const attachmentsDir = join(harness.workdir, '.codeman-attachments');
    const uploadedPath = join(attachmentsDir, 'secret.pdf');
    await fs.mkdir(attachmentsDir);
    await fs.writeFile(uploadedPath, PDF_BYTES);

    const response = await harness.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/uploaded?path=${encodeURIComponent(
        '.codeman-attachments/secret.pdf'
      )}`,
      headers: { host: 'codeman.test', origin: 'http://codeman.test' },
    });

    expectOwnershipNotFound(response, harness.ctx._sessionId);
    expect((await fs.stat(uploadedPath)).isFile()).toBe(true);
  });

  // COD-294: tail-file and /api/download looked the session up WITHOUT the request,
  // so a foreign non-admin could tail or download another user's workspace files.
  // The owner/admin cases stop at the first post-lookup guard (missing `path`, unknown
  // stream id), which is what proves the ownership check runs BEFORE any filesystem
  // work or stream allocation rather than after it.
  describe('tail-file and download (COD-294)', () => {
    it("GET /tail-file hides another user's session", async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/tail-file?path=secret.txt`,
      });

      expectOwnershipNotFound(response, harness.ctx._sessionId);
    });

    it('GET /tail-file reaches the owner and an admin', async () => {
      const statuses: number[] = [];
      for (const user of [OWNER_USER, ADMIN_USER]) {
        harness.setRequestUser(user);
        const response = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/tail-file`,
        });
        statuses.push(response.statusCode);
      }

      // 400 = "Missing path parameter", the guard immediately after the lookup.
      expect(statuses).toEqual([400, 400]);
    });

    it("DELETE /tail-file/:streamId hides another user's session", async () => {
      const response = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/tail-file/stream-1`,
        headers: { host: 'codeman.test', origin: 'http://codeman.test' },
      });

      expectOwnershipNotFound(response, harness.ctx._sessionId);
    });

    it('DELETE /tail-file/:streamId reaches the owner and an admin', async () => {
      const bodies: unknown[] = [];
      for (const user of [OWNER_USER, ADMIN_USER]) {
        harness.setRequestUser(user);
        const response = await harness.app.inject({
          method: 'DELETE',
          url: `/api/sessions/${harness.ctx._sessionId}/tail-file/stream-1`,
          headers: { host: 'codeman.test', origin: 'http://codeman.test' },
        });
        bodies.push({ statusCode: response.statusCode, body: response.json() });
      }

      // The harness registers routes without the envelope hook, so the handler's
      // raw `{ closed }` shape is what lands here.
      expect(bodies).toEqual([
        { statusCode: 200, body: { closed: false } },
        { statusCode: 200, body: { closed: false } },
      ]);
    });

    it("GET /api/download hides another user's session and does not serve the file", async () => {
      await fs.writeFile(join(harness.workdir, 'secret.txt'), 'alice only');

      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/download?sessionId=${harness.ctx._sessionId}&path=secret.txt`,
      });

      expectOwnershipNotFound(response, harness.ctx._sessionId);
      expect(response.body).not.toContain('alice only');
    });

    it('GET /api/download serves the file to the owner and an admin', async () => {
      await fs.writeFile(join(harness.workdir, 'secret.txt'), 'alice only');

      // Asserted on status + the download headers rather than the body: the handler
      // answers with a read stream, which app.inject() does not buffer back here.
      const results: unknown[] = [];
      for (const user of [OWNER_USER, ADMIN_USER]) {
        harness.setRequestUser(user);
        const response = await harness.app.inject({
          method: 'GET',
          url: `/api/download?sessionId=${harness.ctx._sessionId}&path=secret.txt`,
        });
        results.push({
          statusCode: response.statusCode,
          disposition: response.headers['content-disposition'],
        });
      }

      expect(results).toEqual([
        {
          statusCode: 200, // 1.27.0 merge: the download route moved onto upstream's buildContentDisposition(),
          // which adds the RFC 5987 filename* parameter alongside the quoted filename.
          disposition: 'attachment; filename="secret.txt"; filename*=UTF-8\'\'secret.txt',
        },
        {
          statusCode: 200, // 1.27.0 merge: the download route moved onto upstream's buildContentDisposition(),
          // which adds the RFC 5987 filename* parameter alongside the quoted filename.
          disposition: 'attachment; filename="secret.txt"; filename*=UTF-8\'\'secret.txt',
        },
      ]);
    });
  });
});
