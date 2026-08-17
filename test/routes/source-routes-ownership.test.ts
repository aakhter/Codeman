/**
 * @fileoverview Multi-user ownership regressions for the session source routes (COD-294).
 *
 * The COD-294 audit of "adjacent routes with the same unchecked lookup pattern"
 * found all four source endpoints calling findSessionOrFail() without the request.
 * Two of them WRITE (add a source, upload a file into the workspace) and one
 * DELETES, so a foreign non-admin could mutate another user's session.
 *
 * Mirrors test/routes/file-routes-ownership.test.ts: a regular user must receive
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
import { registerSourceRoutes, _resetSourceUploadRateBuckets } from '../../src/web/routes/source-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, type AuthUser } from '../../src/types.js';

const SESSION_OWNER = 'alice';
const FOREIGN_USER: AuthUser = { username: 'bob', role: 'user' };
const OWNER_USER: AuthUser = { username: SESSION_OWNER, role: 'user' };
const ADMIN_USER: AuthUser = { username: 'root', role: 'admin' };
const BOUNDARY = 'codeman-source-ownership-boundary';
const JSON_HEADERS = { host: 'codeman.test', origin: 'http://codeman.test' };
const MULTIPART_HEADERS = {
  ...JSON_HEADERS,
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
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
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
  let requestUser = FOREIGN_USER;
  app.addHook('onRequest', async (req) => {
    (req as unknown as { authUser: AuthUser }).authUser = requestUser;
  });

  const ctx = createMockRouteContext();
  const workdir = await fs.mkdtemp(join(tmpdir(), 'codeman-source-ownership-test-'));
  (ctx._session as unknown as { owner: string }).owner = SESSION_OWNER;
  ctx._session.workingDir = workdir;
  registerSourceRoutes(app, ctx as never);
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

describe('source route session ownership (COD-294)', () => {
  let harness: OwnershipHarness;
  let previousMultiUser: string | undefined;

  beforeEach(async () => {
    previousMultiUser = process.env.CODEMAN_MULTIUSER;
    process.env.CODEMAN_MULTIUSER = '1';
    _resetSourceUploadRateBuckets();
    harness = await createOwnershipHarness();
  });

  afterEach(async () => {
    await harness.app.close();
    await fs.rm(harness.workdir, { recursive: true, force: true });
    if (previousMultiUser === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = previousMultiUser;
  });

  it("GET /sources hides another user's session", async () => {
    harness.ctx._session.addSource({
      id: 'src-1',
      sessionId: harness.ctx._sessionId,
      type: 'url',
      title: 'alice only',
      url: 'https://example.com/private',
      addedAt: Date.now(),
    } as never);

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/sources`,
    });

    expectOwnershipNotFound(response, harness.ctx._sessionId);
    expect(response.body).not.toContain('alice only');
  });

  it("POST /sources hides another user's session and does not add the source", async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/sources`,
      headers: JSON_HEADERS,
      payload: { type: 'url', title: 'bob was here', url: 'https://example.com/injected' },
    });

    expectOwnershipNotFound(response, harness.ctx._sessionId);
    expect(harness.ctx._session.sources).toEqual([]);
  });

  it("DELETE /sources/:sourceId hides another user's session and does not remove the source", async () => {
    harness.ctx._session.addSource({
      id: 'src-1',
      sessionId: harness.ctx._sessionId,
      type: 'url',
      title: 'alice only',
      url: 'https://example.com/private',
      addedAt: Date.now(),
    } as never);

    const response = await harness.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${harness.ctx._sessionId}/sources/src-1`,
      headers: JSON_HEADERS,
    });

    expectOwnershipNotFound(response, harness.ctx._sessionId);
    expect(harness.ctx._session.sources).toHaveLength(1);
  });

  it("POST /sources/upload hides another user's session and does not write a file", async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/sources/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody('planted.pdf', PDF_BYTES),
    });

    expectOwnershipNotFound(response, harness.ctx._sessionId);
    await expect(fs.stat(join(harness.workdir, '.codeman-sources'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it("foreign upload attempts do not consume the owner's rate-limit quota", async () => {
    const foreignStatuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt++) {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/sources/upload`,
        headers: MULTIPART_HEADERS,
        payload: uploadBody(`foreign-${attempt}.pdf`, PDF_BYTES),
      });
      foreignStatuses.push(response.statusCode);
    }

    harness.setRequestUser(OWNER_USER);
    const ownerStatuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt++) {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/sources/upload`,
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

  it('the owner and an admin still reach every source route', async () => {
    const results: Array<{ user: string; get: number; post: number; del: number }> = [];
    for (const user of [OWNER_USER, ADMIN_USER]) {
      harness.setRequestUser(user);
      const post = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/sources`,
        headers: JSON_HEADERS,
        payload: { type: 'url', title: `${user.username} source`, url: 'https://example.com/ok' },
      });
      const added = (post.json() as { data: { source: { id: string } } }).data.source.id;
      const get = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/sources`,
      });
      const del = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/sources/${added}`,
        headers: JSON_HEADERS,
      });
      results.push({ user: user.username, get: get.statusCode, post: post.statusCode, del: del.statusCode });
    }

    expect(results).toEqual([
      { user: SESSION_OWNER, get: 200, post: 200, del: 200 },
      { user: 'root', get: 200, post: 200, del: 200 },
    ]);
  });
});
