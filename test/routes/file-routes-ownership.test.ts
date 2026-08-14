/**
 * @fileoverview Multi-user ownership regressions for session-scoped file and attachment routes (COD-292).
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
import { ApiErrorCode } from '../../src/types.js';

const SESSION_OWNER = 'alice';
const REQUEST_USER = { username: 'bob', role: 'user' as const };
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
  app.addHook('onRequest', async (req) => {
    (req as unknown as { authUser: typeof REQUEST_USER }).authUser = REQUEST_USER;
  });

  const ctx = createMockRouteContext();
  const workdir = await fs.mkdtemp(join(tmpdir(), 'codeman-file-ownership-test-'));
  ctx._session.owner = SESSION_OWNER;
  ctx._session.workingDir = workdir;
  registerFileRoutes(app, ctx as never);
  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx, workdir };
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
});
