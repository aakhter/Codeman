/**
 * @fileoverview Tests for File Manager operations (COD-317/COD-318).
 *
 * Covers POST /api/sessions/:id/files/upload (multipart, CSRF, rate, sanitize),
 * POST /api/sessions/:id/files/mkdir, POST /api/sessions/:id/files/rename,
 * DELETE /api/sessions/:id/files?path= .
 *
 * Uses real temp workspace (fs.mkdtemp) so symlink/realpath guards run on actual FS.
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
import { registerFileRoutes, _resetFileManagerUploadRateBuckets } from '../../src/web/routes/file-routes.js';

interface Harness {
  app: FastifyInstance;
  ctx: MockRouteContext;
  workdir: string;
}

async function createHarness(workdir: string): Promise<Harness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4, parts: 5 },
  });
  const ctx = createMockRouteContext();
  ctx._session.workingDir = workdir;
  registerFileRoutes(app, ctx as never);
  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    if (Buffer.isBuffer(payload) || typeof (payload as { pipe?: unknown }).pipe === 'function')
      return done(null, payload);
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string')
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });
  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx, workdir };
}

const BOUNDARY = 'codeman-fm-boundary';
const MULTIPART_HEADERS = {
  host: 'codeman.test',
  origin: 'http://codeman.test',
  'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
};

function fmUploadBody(filename: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    ),
    bytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

describe('File Manager ops (COD-317/COD-318)', () => {
  let harness: Harness;
  let workdir: string;
  let sessionId: string;

  beforeEach(async () => {
    _resetFileManagerUploadRateBuckets();
    workdir = await fs.mkdtemp(join(tmpdir(), 'codeman-fm-ops-test-'));
    harness = await createHarness(workdir);
    sessionId = harness.ctx._sessionId;
  });

  afterEach(async () => {
    await harness.app.close();
    await fs.rm(workdir, { recursive: true, force: true });
  });

  // ── upload ──
  describe('POST /api/sessions/:id/files/upload', () => {
    it('200: uploads to root and writes file', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/files/upload`,
        headers: MULTIPART_HEADERS,
        payload: fmUploadBody('hello.txt', Buffer.from('hello world')),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.path).toBe('hello.txt');
      expect((await fs.stat(join(workdir, 'hello.txt'))).isFile()).toBe(true);
    });

    it('200: uploads to subdir via ?path', async () => {
      await fs.mkdir(join(workdir, 'subdir'));
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/files/upload?path=subdir`,
        headers: MULTIPART_HEADERS,
        payload: fmUploadBody('nested.txt', Buffer.from('x')),
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.path).toBe('subdir/nested.txt');
      expect((await fs.stat(join(workdir, 'subdir/nested.txt'))).isFile()).toBe(true);
    });

    it('409: duplicate file', async () => {
      const payload = fmUploadBody('dup.txt', Buffer.from('a'));
      expect(
        (
          await harness.app.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/files/upload`,
            headers: MULTIPART_HEADERS,
            payload,
          })
        ).statusCode
      ).toBe(200);
      const res2 = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/files/upload`,
        headers: MULTIPART_HEADERS,
        payload,
      });
      expect(res2.statusCode).toBe(409);
    });

    it('403: CSRF', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/files/upload`,
        headers: {
          host: 'codeman.test',
          origin: 'http://evil.example',
          'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        },
        payload: fmUploadBody('evil.txt', Buffer.from('x')),
      });
      expect(res.statusCode).toBe(403);
    });

    it('sanitizes traversal filename', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/files/upload`,
        headers: MULTIPART_HEADERS,
        payload: fmUploadBody('../../evil2.txt', Buffer.from('x')),
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.path).toBe('evil2.txt');
      expect((await fs.stat(join(workdir, 'evil2.txt'))).isFile()).toBe(true);
    });

    it('400: empty file', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/files/upload`,
        headers: MULTIPART_HEADERS,
        payload: fmUploadBody('empty.txt', Buffer.from('')),
      });
      expect(res.statusCode).toBe(400);
    });

    it('400: wrong field', async () => {
      const bad = Buffer.concat([
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="document"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--${BOUNDARY}--\r\n`
        ),
      ]);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/files/upload`,
        headers: MULTIPART_HEADERS,
        payload: bad,
      });
      expect(res.statusCode).toBe(400);
    });

    it('429: rate limit', async () => {
      for (let i = 0; i < 20; i++) {
        await harness.app.inject({
          method: 'POST',
          url: `/api/sessions/${sessionId}/files/upload`,
          headers: MULTIPART_HEADERS,
          payload: fmUploadBody(`f${i}.txt`, Buffer.from('x')),
        });
      }
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/files/upload`,
        headers: MULTIPART_HEADERS,
        payload: fmUploadBody('f21.txt', Buffer.from('x')),
      });
      expect(res.statusCode).toBe(429);
    });
  });

  // ── mkdir ──
  describe('POST /api/sessions/:id/files/mkdir', () => {
    it('200: creates dir', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/files/mkdir`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ path: 'foo' }),
      });
      expect(res.statusCode).toBe(200);
      expect((await fs.stat(join(workdir, 'foo'))).isDirectory()).toBe(true);
    });

    it('200: creates nested', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/files/mkdir`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ path: 'foo/bar/baz' }),
      });
      expect(res.statusCode).toBe(200);
      expect((await fs.stat(join(workdir, 'foo/bar/baz'))).isDirectory()).toBe(true);
    });

    it('409: already exists', async () => {
      await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/files/mkdir`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ path: 'dup' }),
      });
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/files/mkdir`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ path: 'dup' }),
      });
      expect(res.statusCode).toBe(409);
    });

    it('403: .git blocked', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/files/mkdir`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ path: '.git/evil' }),
      });
      expect(res.statusCode).toBe(403);
    });

    it('400: missing path', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/files/mkdir`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── rename ──
  describe('POST /api/sessions/:id/files/rename', () => {
    it('200: rename file', async () => {
      await fs.writeFile(join(workdir, 'a.txt'), 'hi');
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/files/rename`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ from: 'a.txt', to: 'b.txt' }),
      });
      expect(res.statusCode).toBe(200);
      expect((await fs.stat(join(workdir, 'b.txt'))).isFile()).toBe(true);
      await expect(fs.stat(join(workdir, 'a.txt'))).rejects.toBeTruthy();
    });

    it('200: rename dir', async () => {
      await fs.mkdir(join(workdir, 'd'));
      await fs.writeFile(join(workdir, 'd/x.txt'), 'x');
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/files/rename`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ from: 'd', to: 'd2' }),
      });
      expect(res.statusCode).toBe(200);
      expect((await fs.stat(join(workdir, 'd2/x.txt'))).isFile()).toBe(true);
    });

    it('404: source missing', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/files/rename`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ from: 'nope.txt', to: 'y.txt' }),
      });
      expect(res.statusCode).toBe(404);
    });

    it('409: dest exists', async () => {
      await fs.writeFile(join(workdir, 'a.txt'), 'a');
      await fs.writeFile(join(workdir, 'b.txt'), 'b');
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/files/rename`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ from: 'a.txt', to: 'b.txt' }),
      });
      expect(res.statusCode).toBe(409);
    });
  });

  // ── delete ──
  describe('DELETE /api/sessions/:id/files', () => {
    it('200: delete file', async () => {
      await fs.writeFile(join(workdir, 'del.txt'), 'x');
      const res = await harness.app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}/files?path=del.txt` });
      expect(res.statusCode).toBe(200);
      await expect(fs.stat(join(workdir, 'del.txt'))).rejects.toBeTruthy();
    });

    it('200: delete dir recursive', async () => {
      await fs.mkdir(join(workdir, 'rmdir/sub'), { recursive: true });
      await fs.writeFile(join(workdir, 'rmdir/sub/f.txt'), 'x');
      const res = await harness.app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}/files?path=rmdir` });
      expect(res.statusCode).toBe(200);
      await expect(fs.stat(join(workdir, 'rmdir'))).rejects.toBeTruthy();
    });

    it('404: missing', async () => {
      const res = await harness.app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}/files?path=nope.txt` });
      expect(res.statusCode).toBe(404);
    });

    it('403: .git blocked', async () => {
      const res = await harness.app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}/files?path=.git` });
      expect(res.statusCode).toBe(403);
    });
  });
});
