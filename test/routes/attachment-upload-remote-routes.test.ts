/**
 * @fileoverview Route tests for the REMOTE branch of POST
 * /api/sessions/:id/attachments/upload (COD-241 final unit).
 *
 * The `ssh` child process is mocked (vi.mock('node:child_process')) — there is no
 * sshd on the box — so these assert the ROUTE behavior: a valid remote upload
 * transfers the exact bytes over ssh, caches a local copy, registers it as
 * source:'upload', appends history + broadcasts attachment:detected, and returns
 * the REMOTE agent path; an ssh failure returns a specific 502; and validation
 * failures still short-circuit (415/400) BEFORE any ssh spawn.
 *
 * CODEMAN_DATA_DIR is redirected to a temp dir so the local preview cache never
 * touches the real ~/.codeman. Uses app.inject() — no real HTTP ports.
 * Port: N/A.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, spawn };
});

import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { registerFileRoutes, _resetUploadRateBuckets } from '../../src/web/routes/file-routes.js';
import { attachmentRegistry } from '../../src/attachment-registry.js';
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

const BOUNDARY = 'codeman-remote-upload-boundary';
const MULTIPART_HEADERS = {
  host: 'codeman.test',
  origin: 'http://codeman.test',
  'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
};
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n', 'latin1');

const REMOTE: SessionRemote = {
  hostId: 'mac-mini',
  label: 'mac-mini',
  host: '192.168.21.109',
  username: 'saqebakhter',
  remotePath: '/Users/saqebakhter/repos/projects/moneytrove',
};

/** ssh mock: streams stdin, then close(exitCode); optional stderr on failure. */
function mockSsh(exitCode: number, stderrText = ''): Buffer[] {
  const stdinChunks: Buffer[] = [];
  spawn.mockImplementation(() => {
    const child = new PassThrough() as unknown as {
      stdin: Writable;
      stdout: PassThrough;
      stderr: PassThrough;
      on: (event: string, cb: (...args: unknown[]) => void) => unknown;
      emit: (event: string, ...args: unknown[]) => boolean;
      kill: (sig?: string) => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin = new Writable({
      write(chunk, _enc, cb) {
        stdinChunks.push(Buffer.from(chunk));
        cb();
      },
      final(cb) {
        queueMicrotask(() => {
          if (stderrText) child.stderr.emit('data', Buffer.from(stderrText));
          child.emit('close', exitCode);
        });
        cb();
      },
    });
    return child;
  });
  return stdinChunks;
}

describe('POST /api/sessions/:id/attachments/upload — remote branch (COD-241)', () => {
  let harness: LocalHarness;
  let dataDir: string;
  let prevDataDir: string | undefined;

  beforeEach(async () => {
    _resetUploadRateBuckets();
    spawn.mockReset();
    dataDir = await fs.mkdtemp(join(tmpdir(), 'codeman-remote-upload-data-'));
    prevDataDir = process.env.CODEMAN_DATA_DIR;
    process.env.CODEMAN_DATA_DIR = dataDir;
    harness = await createEnvelopeHarness();
    harness.ctx._session.remote = REMOTE;
    attachmentRegistry.clearSession(harness.ctx._sessionId);
  });

  afterEach(async () => {
    attachmentRegistry.clearSession(harness.ctx._sessionId);
    await harness.app.close();
    if (prevDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
    else process.env.CODEMAN_DATA_DIR = prevDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('200: transfers bytes over ssh, returns the REMOTE agent path, registers source:upload + history + SSE', async () => {
    const stdin = mockSsh(0);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(BOUNDARY, 'Quarterly Report.pdf', 'application/pdf', PDF_BYTES),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.fileName).toBe('Quarterly Report.pdf');
    // Agent-visible path is the REMOTE workspace-relative path (posix, confined).
    expect(body.data.agentPath).toMatch(/^\.codeman-attachments\/Quarterly Report-\d+-[a-f0-9]{8}\.pdf$/);
    expect(body.data.agentPath).not.toContain('..');
    expect(body.data.extension).toBe('pdf');
    expect(body.data.attachmentType).toBe('pdf');
    expect(body.data.size).toBe(PDF_BYTES.length);
    expect(body.data.rawUrl).toContain('/raw');
    expect(body.data.previewUrl).toContain('/preview');

    // Exactly the uploaded bytes were streamed to ssh stdin.
    expect(spawn).toHaveBeenCalledTimes(1);
    const [bin, argv] = spawn.mock.calls[0] as [string, string[]];
    expect(bin).toBe('ssh');
    expect(argv).toContain('saqebakhter@192.168.21.109');
    // Remote script targets the remote .codeman-attachments dir + atomic mv.
    expect(String(argv.at(-1))).toContain('/Users/saqebakhter/repos/projects/moneytrove/.codeman-attachments');
    expect(String(argv.at(-1))).toContain('mv -n "$tmp" "$file"');
    expect(Buffer.concat(stdin)).toEqual(PDF_BYTES);

    // Registered as source:'upload' with a local cache copy that actually exists.
    const record = attachmentRegistry.get(harness.ctx._sessionId, body.data.attachmentId);
    expect(record?.source).toBe('upload');
    expect((await fs.stat(record!.filePath)).size).toBe(PDF_BYTES.length);

    // History appended + persisted + attachment:detected broadcast.
    expect(harness.ctx._session.upsertAttachmentHistory).toHaveBeenCalledTimes(1);
    expect(harness.ctx.persistSessionState).toHaveBeenCalled();
    expect(harness.ctx._session.getAttachmentHistoryForPersist()?.[0].uploadProvenance).toBeUndefined();
    const detected = harness.ctx.broadcast.mock.calls.filter((c) => c[0] === 'attachment:detected');
    expect(detected.length).toBe(1);
    expect(detected[0][1].attachmentId).toBe(body.data.attachmentId);

    attachmentRegistry.clearSession(harness.ctx._sessionId);
    const history = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
    });
    expect(history.statusCode).toBe(200);
    expect(JSON.parse(history.body).data.items[0]).toMatchObject({ missing: false });
  });

  // COD-296 control: the remote branch returns before the local upload-directory
  // resolve, so a remote upload must leave no `.codeman-attachments/` behind in
  // the local case dir. This passed before COD-296 too — it pins the upload half
  // of "remote sessions never attempt local attachment-directory creation"; the
  // half that was actually broken (DELETE / history) is covered in
  // attachment-directory-side-effects.test.ts.
  it('creates no local attachment directory for a remote upload', async () => {
    const localWorkdir = await fs.mkdtemp(join(tmpdir(), 'codeman-remote-upload-ws-'));
    harness.ctx._session.workingDir = localWorkdir;
    mockSsh(0);
    try {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
        headers: MULTIPART_HEADERS,
        payload: uploadBody(BOUNDARY, 'Remote.pdf', 'application/pdf', PDF_BYTES),
      });

      expect(res.statusCode).toBe(200);
      await expect(fs.lstat(join(localWorkdir, '.codeman-attachments'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(localWorkdir, { recursive: true, force: true });
    }
  });

  it('502: ssh transfer failure returns a specific remote-transfer error and does NOT register', async () => {
    mockSsh(73, '.codeman-attachments is not a regular directory');
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(BOUNDARY, 'brief.pdf', 'application/pdf', PDF_BYTES),
    });

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('Failed to transfer document to remote host');
    // No registration / history / SSE on transfer failure.
    expect(harness.ctx._session.upsertAttachmentHistory).not.toHaveBeenCalled();
    const detected = harness.ctx.broadcast.mock.calls.filter((c) => c[0] === 'attachment:detected');
    expect(detected.length).toBe(0);
  });

  it('415: an unsupported type is rejected BEFORE any ssh spawn (host-independent validation)', async () => {
    mockSsh(0);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(BOUNDARY, 'malware.exe', 'application/octet-stream', PDF_BYTES),
    });
    expect(res.statusCode).toBe(415);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('415: a content/type mismatch is rejected BEFORE any ssh spawn', async () => {
    mockSsh(0);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: MULTIPART_HEADERS,
      payload: uploadBody(BOUNDARY, 'fake.pdf', 'application/pdf', Buffer.from('not a pdf at all')),
    });
    expect(res.statusCode).toBe(415);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('403: a cross-origin (CSRF) request is rejected before any ssh spawn', async () => {
    mockSsh(0);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/upload`,
      headers: { ...MULTIPART_HEADERS, origin: 'http://evil.example' },
      payload: uploadBody(BOUNDARY, 'x.pdf', 'application/pdf', PDF_BYTES),
    });
    expect(res.statusCode).toBe(403);
    expect(spawn).not.toHaveBeenCalled();
  });
});
