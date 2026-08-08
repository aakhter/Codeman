/**
 * @fileoverview Remote-session upload coverage for COD-281 source uploads.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { PassThrough, Writable } from 'node:stream';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, spawn };
});

import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { registerSourceRoutes, _resetSourceUploadRateBuckets } from '../../src/web/routes/source-routes.js';
import type { SessionRemote } from '../../src/types/session.js';

interface Harness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

const REMOTE: SessionRemote = {
  hostId: 'remote-1',
  label: 'remote-1',
  host: '192.168.21.109',
  username: 'saqebakhter',
  remotePath: '/Users/saqebakhter/projects/demo',
};
const BOUNDARY = 'codeman-source-remote-boundary';
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n', 'latin1');

async function createHarness(): Promise<Harness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, { limits: { fileSize: 1024 * 1024, files: 1, fields: 4, parts: 6 } });
  const ctx = createMockRouteContext();
  ctx._session.remote = REMOTE;
  registerSourceRoutes(app, ctx as never);
  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api') || payload === null || typeof payload !== 'object') return done(null, payload);
    const response = payload as { success?: unknown; errorCode?: unknown };
    if (response.success === false && reply.statusCode === 200 && typeof response.errorCode === 'string') {
      reply.code(httpStatusForErrorCode(response.errorCode as ApiErrorCode));
    }
    return done(null, response.success === undefined ? { success: true, data: payload } : payload);
  });
  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx };
}

function uploadBody(filename: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`
    ),
    bytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

function mockSsh(exitCode: number, stderrText = ''): Buffer[] {
  const chunks: Buffer[] = [];
  spawn.mockImplementation(() => {
    const child = new PassThrough() as unknown as {
      stdin: Writable;
      stderr: PassThrough;
      on: (event: string, cb: (...args: unknown[]) => void) => unknown;
      emit: (event: string, ...args: unknown[]) => boolean;
      kill: () => void;
    };
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
      final(callback) {
        queueMicrotask(() => {
          if (stderrText) child.stderr.emit('data', Buffer.from(stderrText));
          child.emit('close', exitCode);
        });
        callback();
      },
    });
    return child;
  });
  return chunks;
}

describe('POST /api/sessions/:id/sources/upload - remote session (COD-281)', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.app.close();
    spawn.mockReset();
    _resetSourceUploadRateBuckets();
  });

  it('transfers valid bytes to .codeman-sources and then registers the source', async () => {
    harness = await createHarness();
    const stdin = mockSsh(0);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/sources/upload`,
      headers: {
        host: 'codeman.test',
        origin: 'http://codeman.test',
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: uploadBody('reference.pdf', PDF_BYTES),
    });

    expect(response.statusCode).toBe(200);
    const source = JSON.parse(response.body).data.source;
    expect(source.relativePath).toMatch(/^\.codeman-sources\/reference-\d+-[a-f0-9]{8}\.pdf$/);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(String((spawn.mock.calls[0] as [string, string[]])[1].at(-1))).toContain(
      '/Users/saqebakhter/projects/demo/.codeman-sources'
    );
    expect(Buffer.concat(stdin)).toEqual(PDF_BYTES);
    expect(harness.ctx._session.sources).toHaveLength(1);
    expect(harness.ctx.persistSessionState).toHaveBeenCalledTimes(1);
  });

  it('returns 502 and does not register a source when remote transfer fails', async () => {
    harness = await createHarness();
    mockSsh(73, '.codeman-sources is not a regular directory');

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/sources/upload`,
      headers: {
        host: 'codeman.test',
        origin: 'http://codeman.test',
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: uploadBody('reference.pdf', PDF_BYTES),
    });

    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body).error).toContain('Failed to transfer source to remote host');
    expect(harness.ctx._session.sources).toHaveLength(0);
    expect(harness.ctx.persistSessionState).not.toHaveBeenCalled();
  });
});
