/**
 * @fileoverview Tests for session route handlers.
 *
 * Uses app.inject() (Fastify's built-in test helper) — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 *
 * These tests assert the UNIFORM response envelope (stable HTTP contract):
 *   success -> 2xx, { success: true, data: <payload> }
 *   error   -> 4xx/5xx, { success: false, error, errorCode }
 * The production server applies this via a preSerialization hook (server.ts).
 * The shared route harness doesn't install it, so we build a local harness here
 * that mirrors production: the same preSerialization envelope hook + the shared
 * route error handler, so assertions match the real wire format.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { Session } from '../../src/session.js';

// Mock execFile so the send-key route's `tmux` invocation is observable (not run for real).
const { execFile, spawn } = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
const heicConvert = vi.hoisted(() => vi.fn(async () => Buffer.from('ffd8ffe000104a4649460001', 'hex')));
const remoteStore = vi.hoisted(() => ({
  hosts: [] as Array<{
    id: string;
    label: string;
    host: string;
    username: string;
    commands?: Record<string, string>;
  }>,
  cases: [] as Array<{
    name: string;
    type: 'remote';
    hostId: string;
    remotePath: string;
    commands?: Record<string, string>;
  }>,
  tmuxCheck: { ok: true, tmuxPath: '/usr/bin/tmux' } as { ok: boolean; tmuxPath?: string; error?: string },
}));
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, execFile, spawn };
});
vi.mock('heic-convert', () => ({ default: heicConvert }));
vi.mock('../../src/remote-hosts.js', async (orig) => {
  const actual = await orig<typeof import('../../src/remote-hosts.js')>();
  return {
    ...actual,
    readRemoteHosts: vi.fn(async () => remoteStore.hosts),
    readRemoteCases: vi.fn(async () => remoteStore.cases),
    checkRemoteTmuxAvailable: vi.fn(async () => remoteStore.tmuxCheck),
  };
});
vi.mock('../../src/web/heic-jpeg-converter.js', () => ({ convertHeicToJpeg: heicConvert }));

import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';

interface LocalHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

/**
 * Build a Fastify instance that mirrors production's uniform-envelope behavior
 * (server.ts preSerialization hook) so the test wire format matches the contract:
 * bare payloads become { success: true, data }, and { success:false } error
 * envelopes get the conventional HTTP status from their errorCode.
 */
async function createEnvelopeHarness(
  registerFn: (app: FastifyInstance, ctx: MockRouteContext) => void
): Promise<LocalHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 10 * 1024 * 1024,
      files: 1,
      fields: 4,
      parts: 5,
    },
  });

  const ctx = createMockRouteContext();
  registerFn(app, ctx);

  // Mirror production uniform response envelope (server.ts).
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

describe('session-routes', () => {
  let harness: LocalHarness;

  beforeEach(async () => {
    remoteStore.hosts = [];
    remoteStore.cases = [];
    harness = await createEnvelopeHarness(registerSessionRoutes);
    // Reset remote store so tests start with empty hosts/cases and a passing tmux probe
    remoteStore.hosts = [];
    remoteStore.cases = [];
    remoteStore.tmuxCheck = { ok: true, tmuxPath: '/usr/bin/tmux' };
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== POST /api/sessions/:id/send-key ==========

  describe('POST /api/sessions/:id/send-key', () => {
    it('routes tmux send-keys through the dedicated Codeman socket (-L)', async () => {
      // Regression guard: bare `tmux` would hit the user's default server and never
      // find a session that lives only on the Codeman socket (#80 regression class).
      execFile.mockReset();
      execFile.mockImplementation((_bin: string, _argv: string[], _opts: unknown, cb: (e: Error | null) => void) =>
        cb(null)
      );

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/send-key',
        payload: { key: 'S-Enter' },
      });

      expect(res.statusCode).toBe(200);
      expect(execFile).toHaveBeenCalledTimes(1);
      const [bin, argv] = execFile.mock.calls[0];
      expect(bin).toBe('tmux');
      expect((argv as string[]).slice(0, 2)).toEqual(['-L', 'codeman']);
      expect(argv).toContain('send-keys');
      expect(argv).toContain('-H');
    });

    it('rejects keys outside the hex allowlist without invoking tmux', async () => {
      execFile.mockReset();
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/send-key',
        payload: { key: 'rm -rf' },
      });
      expect(JSON.parse(res.body).success).toBe(false);
      expect(execFile).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/sessions/:id/last-response', () => {
    it('returns the parsed last COD response from canonical terminal history', async () => {
      harness.ctx._session.mode = 'codex';
      harness.ctx._session.terminalBuffer = 'stale local byte history';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() =>
        `
╭──────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.143.0)                           │
╰──────────────────────────────────────────────────────╯

› say again

Final polished answer
With two lines

› Improve documentation in @filename

gpt-5.4 medium · kb · main · Ready · Context 92% left
`.trim()
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/test-session-1/last-response',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.text).toBe('Final polished answer\nWith two lines');
      expect(body.data.hasContext).toBe(true);
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(harness.ctx._session.muxName, {
        fullHistory: true,
      });
    });

    it('returns labeled COD transcript blocks for full context', async () => {
      harness.ctx._session.mode = 'codex';
      harness.ctx._session.terminalBuffer = '';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() =>
        `
› i need to create a naming recommendation for project helix

gpt-5.4 medium · kb · main · Ready · Context 100% left

• Explored
  └ Read SKILL.md

Subject: Naming Recommendation for Project Helix

The product helps customers move virtual machine workloads between hypervisors while keeping operations
stable. It improves visibility into application dependencies and reduces
the risk
and effort involved in moving workloads.
`.trim()
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/test-session-1/last-response?context=full',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.messages).toEqual([
        { kind: 'prompt', label: 'Prompt', text: 'i need to create a naming recommendation for project helix' },
        { kind: 'status', label: 'Status', text: 'gpt-5.4 medium · kb · main · Ready · Context 100% left' },
        { kind: 'tool', label: 'Tool', text: '• Explored\n  └ Read SKILL.md' },
        {
          kind: 'response',
          label: 'Response',
          text: 'Subject: Naming Recommendation for Project Helix\n\nThe product helps customers move virtual machine workloads between hypervisors while keeping operations stable. It improves visibility into application dependencies and reduces the risk and effort involved in moving workloads.',
        },
      ]);
    });
  });

  // ========== POST /api/sessions/:id/paste-image ==========

  describe('POST /api/sessions/:id/paste-image', () => {
    function imageUploadBody(boundary: string, filename: string, mimetype: string, imageBytes: Buffer): Buffer {
      return Buffer.concat([
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
            `Content-Type: ${mimetype}\r\n\r\n`
        ),
        imageBytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
    }

    function pngUploadBody(boundary: string, imageBytes: Buffer): Buffer {
      return imageUploadBody(boundary, 'issue.png', 'image/png', imageBytes);
    }

    function makeSessionRemote(remotePath = '/Users/saqebakhter/repos/projects/moneytrove'): void {
      harness.ctx._session.workingDir = remotePath;
      vi.spyOn(harness.ctx._session, 'toState').mockReturnValue({
        ...harness.ctx._session.toState(),
        workingDir: remotePath,
        remote: {
          hostId: 'mac-mini',
          label: 'mac-mini',
          host: '192.168.21.109',
          username: 'saqebakhter',
          remotePath,
        },
      });
    }

    function mockSuccessfulSshUpload(): Buffer[] {
      const stdinChunks: Buffer[] = [];
      spawn.mockImplementation(() => {
        const child = new PassThrough() as unknown as {
          stdin: Writable;
          stdout: PassThrough;
          stderr: PassThrough;
          on: (event: string, cb: (...args: unknown[]) => void) => unknown;
          emit: (event: string, ...args: unknown[]) => boolean;
        };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new Writable({
          write(chunk, _encoding, callback) {
            stdinChunks.push(Buffer.from(chunk));
            callback();
          },
          final(callback) {
            queueMicrotask(() => child.emit('close', 0));
            callback();
          },
        });
        return child;
      });
      return stdinChunks;
    }

    it('converts HEIC paste images to JPEG attachments when browser-side normalization falls back', async () => {
      makeSessionRemote();
      heicConvert.mockClear();
      const stdinChunks = mockSuccessfulSshUpload();

      const boundary = 'codeman-test-boundary';
      const heic = Buffer.from('00000034667479706865696300000000', 'hex');
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/paste-image`,
        headers: {
          host: 'codeman.test',
          origin: 'http://codeman.test',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: imageUploadBody(boundary, 'IMG_4996.HEIC', 'image/heic', heic),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.path).toMatch(
        /^\/Users\/saqebakhter\/repos\/projects\/moneytrove\/\.claude-images\/paste-\d+-[a-f0-9]{8}\.jpg$/
      );
      const written = Buffer.concat(stdinChunks);
      expect(written.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect(heicConvert).toHaveBeenCalledWith(heic);
    });

    it('uploads paste images for remote sessions to the remote workspace over ssh', async () => {
      makeSessionRemote();
      const stdinChunks = mockSuccessfulSshUpload();

      const boundary = 'codeman-test-boundary';
      const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/paste-image`,
        headers: {
          host: 'codeman.test',
          origin: 'http://codeman.test',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: pngUploadBody(boundary, png),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.path).toMatch(
        /^\/Users\/saqebakhter\/repos\/projects\/moneytrove\/\.claude-images\/paste-\d+-[a-f0-9]{8}\.png$/
      );
      expect(spawn).toHaveBeenCalledTimes(1);
      const [bin, argv] = spawn.mock.calls[0];
      expect(bin).toBe('ssh');
      expect(argv).toContain('BatchMode=yes');
      expect(argv).toContain('ConnectTimeout=10');
      expect(argv).toContain('saqebakhter@192.168.21.109');
      expect(String(argv.at(-1))).toContain('mkdir "$dir"');
      expect(Buffer.concat(stdinChunks)).toEqual(png);
    });
  });

  // ========== GET /api/sessions ==========

  describe('GET /api/sessions', () => {
    it('returns session list when sessions exist', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/sessions' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(1);
    });

    it('returns empty array when no sessions', async () => {
      harness.ctx.sessions.clear();
      const res = await harness.app.inject({ method: 'GET', url: '/api/sessions' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data).toEqual([]);
    });
  });

  // ========== GET /api/sessions/:id ==========

  describe('GET /api/sessions/:id', () => {
    it('returns session state for existing session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.id).toBe(harness.ctx._sessionId);
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });
  });

  // ========== PUT /api/sessions/:id/name ==========

  describe('PUT /api/sessions/:id/name', () => {
    it('persists the renamed session immediately so restart restore keeps the custom name', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/name`,
        payload: { name: 'Custom restart-safe name' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ success: true, data: { name: 'Custom restart-safe name' } });
      expect(harness.ctx._session.name).toBe('Custom restart-safe name');
      expect(harness.ctx.mux.updateSessionName).toHaveBeenCalledWith(
        harness.ctx._sessionId,
        'Custom restart-safe name'
      );
      expect(harness.ctx.persistSessionStateNow).toHaveBeenCalledWith(harness.ctx._session);
      expect(harness.ctx.persistSessionState).not.toHaveBeenCalled();
    });
  });

  // ========== DELETE /api/sessions/:id ==========

  describe('DELETE /api/sessions/:id', () => {
    it('deletes existing session', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx.cleanupSession).toHaveBeenCalledWith(harness.ctx._sessionId, true, 'user_delete');
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/sessions/nonexistent',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== DELETE /api/sessions (delete all) ==========

  describe('DELETE /api/sessions', () => {
    it('deletes all sessions', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/sessions',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.killed).toBe(1);
      expect(harness.ctx.cleanupSession).toHaveBeenCalled();
    });
  });

  // ========== PUT /api/sessions/:id/name ==========

  describe('PUT /api/sessions/:id/name', () => {
    it('renames session', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/name`,
        payload: { name: 'new-name' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('new-name');
      expect(harness.ctx.persistSessionStateNow).toHaveBeenCalled();
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:updated', expect.anything());
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/sessions/nonexistent/name',
        payload: { name: 'test' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== PUT /api/sessions/:id/color ==========

  describe('PUT /api/sessions/:id/color', () => {
    it('sets session color', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/color`,
        payload: { color: 'blue' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.color).toBe('blue');
    });

    it('rejects invalid color', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/color`,
        payload: { color: 'neon-rainbow' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/auto-resume ==========

  describe('POST /api/sessions/:id/auto-resume', () => {
    it('enables auto-resume on usage limit', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/auto-resume`,
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.autoResume.enabled).toBe(true);
      const session = harness.ctx.sessions.get(harness.ctx._sessionId)!;
      expect(session.setAutoResume).toHaveBeenCalledWith(true);
      expect(harness.ctx.persistSessionState).toHaveBeenCalled();
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:updated', expect.anything());
    });

    it('disables auto-resume', async () => {
      const session = harness.ctx.sessions.get(harness.ctx._sessionId)!;
      session.autoResumeEnabled = true;
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/auto-resume`,
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.autoResume.enabled).toBe(false);
      expect(session.setAutoResume).toHaveBeenCalledWith(false);
    });

    it('rejects invalid body', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/auto-resume`,
        payload: { enabled: 'yes' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe(ApiErrorCode.INVALID_INPUT);
    });

    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/auto-resume',
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/input ==========

  describe('POST /api/sessions/:id/input', () => {
    it('sends input to session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/input`,
        payload: { input: 'hello' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/input',
        payload: { input: 'hello' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects empty payload', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/input`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('applies a tagged (clientId, seq) input exactly once on redelivery', async () => {
      const url = `/api/sessions/${harness.ctx._sessionId}/input`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = harness.ctx.sessions.get(harness.ctx._sessionId) as any;
      session.writeBuffer.length = 0;

      const post = (payload: unknown) => harness.app.inject({ method: 'POST', url, payload });

      // First delivery of seq 1 — applied (200, written once).
      const first = await post({ input: 'prompt', seq: 1, clientId: 'cid-1' });
      expect(first.statusCode).toBe(200);

      // Redelivery of the SAME seq (client never saw the ACK) — still 200, but
      // must NOT write again.
      const dup = await post({ input: 'prompt', seq: 1, clientId: 'cid-1' });
      expect(dup.statusCode).toBe(200);

      // A genuinely new seq — applied.
      const next = await post({ input: '\r', seq: 2, clientId: 'cid-1' });
      expect(next.statusCode).toBe(200);

      expect(session.writeBuffer).toEqual(['prompt', '\r']);
    });

    it('always applies untagged input (curl/legacy, no dedup)', async () => {
      const url = `/api/sessions/${harness.ctx._sessionId}/input`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = harness.ctx.sessions.get(harness.ctx._sessionId) as any;
      session.writeBuffer.length = 0;

      const post = () => harness.app.inject({ method: 'POST', url, payload: { input: 'x' } });
      await post();
      await post();
      // No seq/clientId ⇒ no dedup ⇒ both writes land.
      expect(session.writeBuffer).toEqual(['x', 'x']);
    });
  });

  // ========== POST /api/sessions/:id/resize ==========

  describe('POST /api/sessions/:id/resize', () => {
    it('resizes session terminal', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 120, rows: 40 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.resize).toHaveBeenCalledWith(120, 40, { viewportType: undefined, force: undefined });
    });

    it('passes viewport type through for resize arbitration', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 48, rows: 28, viewportType: 'mobile' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.resize).toHaveBeenCalledWith(48, 28, { viewportType: 'mobile', force: undefined });
    });

    it('passes force resize through for redraw requests', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 120, rows: 40, force: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.resize).toHaveBeenCalledWith(120, 40, { viewportType: undefined, force: true });
    });

    it('rejects cols exceeding max (500)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 501, rows: 24 },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects rows exceeding max (200)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 80, rows: 201 },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects zero dimensions', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 0, rows: 24 },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/sessions/:id/terminal ==========

  describe('GET /api/sessions/:id/terminal', () => {
    it('returns terminal buffer', async () => {
      harness.ctx._session.terminalBuffer = 'hello world';
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toBeDefined();
    });

    it('does not strip VPA-like shell scrollback as Ink redraw bloat', async () => {
      const shellHistory = Array.from(
        { length: 3000 },
        (_, index) => `SHELL_SCROLLBACK_${String(index + 1).padStart(6, '0')} payload payload payload \x1b[1d`
      ).join('\n');
      harness.ctx._session.terminalBuffer = shellHistory;
      harness.ctx._session.mode = 'shell';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() => null);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('SHELL_SCROLLBACK_000001');
      expect(body.data.terminalBuffer).toContain('SHELL_SCROLLBACK_003000');
    });

    it('does not duplicate the latest Codex prompt tail when full tmux history already contains it', async () => {
      const duplicateTail =
        '› Find and fix a bug in @filename\n' + 'gpt-5.5 medium · ~/syncthing/contexts/openshift-base-install';
      harness.ctx._session.terminalBuffer = `hello world\nlater accumulated history\n${duplicateTail}`;
      harness.ctx._session.mode = 'codex';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => `tmux full history\n${duplicateTail}`
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toBe(`tmux full history\n${duplicateTail}`);
      expect(body.data.terminalBuffer).not.toContain('hello world');
      expect(body.data.terminalBuffer).not.toContain('\x1b[H\x1b[2J');
      expect(body.data.terminalBuffer.match(/Find and fix a bug in @filename/g)).toHaveLength(1);
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(harness.ctx._session.muxName, {
        fullHistory: true,
      });
    });

    it('preserves accumulated history before the visible mux pane snapshot on tab switch (claude)', async () => {
      harness.ctx._session.terminalBuffer = 'hello world\nlater accumulated history';
      harness.ctx._session.mode = 'claude';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'visible tmux pane only\n❯ current prompt'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?tail=65536`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('hello world');
      expect(body.data.terminalBuffer).toContain('later accumulated history');
      expect(body.data.terminalBuffer).toContain('\x1b[H\x1b[2Jvisible tmux pane only');
      expect(body.data.terminalBuffer.indexOf('hello world')).toBeLessThan(
        body.data.terminalBuffer.indexOf('visible tmux pane only')
      );
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(harness.ctx._session.muxName, undefined);
    });

    // ── COD-178: TUI modes replay the tmux capture ONLY — raw byte history is
    // full-screen redraw frames painted at historical window sizes; replaying
    // them at the browser's current row count scrolls each frame into
    // scrollback, stacking stale banner boxes. ──
    it('COD-178: codex full reload drops raw byte history even when the prompt-tail heuristic misses', async () => {
      // Prompt rendered via erase-char + cursor-forward (\x1b[1X\x1b[C) instead of a
      // literal space — the real prod byte stream that defeated the old
      // hasDuplicateCodexPromptTail text comparison.
      harness.ctx._session.terminalBuffer =
        '\x1b[H\x1b[1;40rstale banner frame one\n\x1b[Hstale banner frame two\n' +
        '›\x1b[1X\x1b[2m\x1b[CUse /skills to list available skills\x1b[0m\n' +
        'gpt-5.5 medium · ~/case';
      harness.ctx._session.mode = 'codex';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'clean full capture\n› Use /skills to list available skills\ngpt-5.5 medium · ~/case'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('clean full capture');
      expect(body.data.terminalBuffer).not.toContain('stale banner frame');
      expect(body.data.terminalBuffer).not.toContain('\x1b[H\x1b[2J');
      expect(body.data.source).toBe('mux-full-history');
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(harness.ctx._session.muxName, {
        fullHistory: true,
      });
    });

    it('COD-178: codex tab switch (tail) replays the full tmux capture instead of raw byte history', async () => {
      harness.ctx._session.terminalBuffer = 'stale redraw history';
      harness.ctx._session.mode = 'codex';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        (_name: string, opts?: { fullHistory?: boolean }) =>
          opts?.fullHistory ? 'full capture scrollback\n› current prompt' : 'visible frame only'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?tail=65536`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('full capture scrollback');
      expect(body.data.terminalBuffer).not.toContain('stale redraw history');
      expect(body.data.terminalBuffer).not.toContain('visible frame only');
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(harness.ctx._session.muxName, {
        fullHistory: true,
      });
    });

    it('COD-178: gemini full reload replays the tmux capture only', async () => {
      harness.ctx._session.terminalBuffer = 'stale gemini redraw frames';
      harness.ctx._session.mode = 'gemini';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'gemini clean capture'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('gemini clean capture');
      expect(body.data.terminalBuffer).not.toContain('stale gemini redraw frames');
    });

    it('COD-207: opencode lines=N capture request is capture-only and returns full-history source', async () => {
      harness.ctx._session.terminalBuffer = 'opencode byte history';
      harness.ctx._session.mode = 'opencode';
      const linesCaptureSpy = vi.fn((_name: string, opts?: { fullHistory?: boolean; lastLines?: number }) =>
        opts?.fullHistory ? 'opencode full capture' : 'visible'
      );
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = linesCaptureSpy;

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?lines=2000`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toBe('opencode full capture');
      expect(body.data.terminalBuffer).not.toContain('opencode byte history');
      expect(body.data.source).toBe('mux-full-history');
      expect(linesCaptureSpy).toHaveBeenCalledWith(harness.ctx._session.muxName, {
        fullHistory: true,
        lastLines: 2000,
      });
    });

    it('COD-207: opencode capture=1 request is capture-only and returns full-history source', async () => {
      harness.ctx._session.terminalBuffer = 'opencode byte history';
      harness.ctx._session.mode = 'opencode';
      const captureSpy = vi.fn((_name: string, opts?: { fullHistory?: boolean }) =>
        opts?.fullHistory ? 'opencode capture expansion' : 'visible'
      );
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = captureSpy;

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?capture=1`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toBe('opencode capture expansion');
      expect(body.data.terminalBuffer).not.toContain('opencode byte history');
      expect(body.data.source).toBe('mux-full-history');
    });

    it('COD-207: opencode full reload replays the tmux capture only', async () => {
      harness.ctx._session.terminalBuffer = 'stale opencode byte history';
      harness.ctx._session.mode = 'opencode';
      const fullReloadSpy = vi.fn(() => 'opencode canonical full capture');
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = fullReloadSpy;

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toBe('opencode canonical full capture');
      expect(body.data.terminalBuffer).not.toContain('stale opencode byte history');
      expect(body.data.source).toBe('mux-full-history');
      expect(fullReloadSpy).toHaveBeenCalledWith(harness.ctx._session.muxName, {
        fullHistory: true,
      });
    });

    // ── COD-180: remote sessions capture from the REMOTE tmux server — the
    // local wrapper accumulates no history (nested tmux repaints in place). ──
    it('COD-180: remote codex session replays the remote tmux capture only', async () => {
      harness.ctx._session.terminalBuffer = 'stale local byte history';
      harness.ctx._session.mode = 'codex';
      (harness.ctx._session as { remote?: unknown }).remote = {
        hostId: 'mac-mini',
        host: '192.168.21.109',
        username: 'saqebakhter',
        remotePath: '/tmp/case',
      };
      const remoteSpy = vi.fn(async () => 'remote canonical scrollback\n› prompt');
      const localSpy = vi.fn(() => 'local wrapper single screen');
      (harness.ctx.mux as { captureRemotePaneBuffer?: unknown }).captureRemotePaneBuffer = remoteSpy;
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = localSpy;

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('remote canonical scrollback');
      expect(body.data.terminalBuffer).not.toContain('stale local byte history');
      expect(body.data.terminalBuffer).not.toContain('local wrapper single screen');
      expect(body.data.source).toBe('mux-full-history');
      expect(remoteSpy).toHaveBeenCalledWith(
        (harness.ctx._session as { remote?: unknown }).remote,
        harness.ctx._session.muxName,
        { fullHistory: true }
      );
      expect(localSpy).not.toHaveBeenCalled();
    });

    it('COD-180: remote codex keeps byte history when the remote capture fails (never one local screen)', async () => {
      harness.ctx._session.terminalBuffer = 'accumulated byte history scrollback';
      harness.ctx._session.mode = 'codex';
      (harness.ctx._session as { remote?: unknown }).remote = {
        hostId: 'mac-mini',
        host: '192.168.21.109',
        username: 'saqebakhter',
        remotePath: '/tmp/case',
      };
      (harness.ctx.mux as { captureRemotePaneBuffer?: unknown }).captureRemotePaneBuffer = vi.fn(async () => null);
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'local wrapper single screen'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Degraded mode: byte history + separator + local screen — NOT capture-only,
      // so the session's whole scrollback is never replaced by ~30 local lines.
      expect(body.data.terminalBuffer).toContain('accumulated byte history scrollback');
      expect(body.data.terminalBuffer).toContain('\x1b[H\x1b[2Jlocal wrapper single screen');
      // A degraded response must not advertise itself as a canonical rewrite source.
      expect(body.data.source).toBe('mux-visible');
    });

    it('COD-180: local sessions never attempt a remote capture', async () => {
      harness.ctx._session.terminalBuffer = 'local history';
      harness.ctx._session.mode = 'codex';
      const remoteSpy = vi.fn(async () => 'should not be called');
      (harness.ctx.mux as { captureRemotePaneBuffer?: unknown }).captureRemotePaneBuffer = remoteSpy;
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'local full capture'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      expect(remoteSpy).not.toHaveBeenCalled();
      expect(JSON.parse(res.body).data.terminalBuffer).toContain('local full capture');
    });

    // ── COD-187 claude expansion: history-view requests are capture-only for
    // any mode; claude's legacy no-param reload keeps its concat. ──
    it('claude lines= request is capture-only (history view first page)', async () => {
      harness.ctx._session.terminalBuffer = 'claude byte history';
      harness.ctx._session.mode = 'claude';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        (_n: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? 'claude pane history' : 'v')
      );
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?lines=2000`,
      });
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('claude pane history');
      expect(body.data.terminalBuffer).not.toContain('claude byte history');
      expect(body.data.source).toBe('mux-full-history');
    });

    it('claude capture=1 request is capture-only (history view full expansion)', async () => {
      harness.ctx._session.terminalBuffer = 'claude byte history';
      harness.ctx._session.mode = 'claude';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        (_n: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? 'claude full capture' : 'v')
      );
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?capture=1`,
      });
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('claude full capture');
      expect(body.data.terminalBuffer).not.toContain('claude byte history');
    });

    it('claude legacy full reload keeps byte history + capture concat (unchanged)', async () => {
      harness.ctx._session.terminalBuffer = 'claude byte history';
      harness.ctx._session.mode = 'claude';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        (_n: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? 'claude full capture' : 'v')
      );
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('claude byte history');
      expect(body.data.terminalBuffer).toContain('claude full capture');
    });

    // ── COD-189: shell FULL reloads are capture-canonical (byte history is
    // sparse after fast bursts — tmux jump-scroll); tail path unchanged. ──
    it('COD-189: shell full reload replays the capture only (no sparse byte history)', async () => {
      harness.ctx._session.terminalBuffer = 'sparse burst history with holes';
      harness.ctx._session.mode = 'shell';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        (_n: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? 'contiguous pane history' : 'visible')
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('contiguous pane history');
      expect(body.data.terminalBuffer).not.toContain('sparse burst history');
      expect(body.data.source).toBe('mux-full-history');
    });

    it('COD-189: shell tail/tab-switch path still serves byte history (fast path unchanged)', async () => {
      harness.ctx._session.terminalBuffer = 'recent shell history';
      harness.ctx._session.mode = 'shell';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() => 'visible frame');

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?tail=65536`,
      });

      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('recent shell history');
    });

    // ── COD-187: live mirror — ?frame=1 returns ONLY the current visible frame ──
    describe('COD-187 ?frame=1', () => {
      it('local session: returns the visible-frame capture with source mux-frame, no history/tail processing', async () => {
        harness.ctx._session.terminalBuffer = 'byte history that must NOT appear';
        harness.ctx._session.mode = 'codex';
        const localSpy = vi.fn((_name: string, opts?: { fullHistory?: boolean }) =>
          opts?.fullHistory ? 'FULL_HISTORY' : 'VISIBLE_FRAME_SNAPSHOT'
        );
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = localSpy;

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?frame=1`,
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.data.source).toBe('mux-frame');
        expect(body.data.terminalBuffer).toBe('VISIBLE_FRAME_SNAPSHOT');
        expect(body.data.truncated).toBe(false);
        expect(localSpy).toHaveBeenCalledWith(harness.ctx._session.muxName);
      });

      it('remote session: uses the remote visibleFrame capture', async () => {
        harness.ctx._session.mode = 'codex';
        (harness.ctx._session as { remote?: unknown }).remote = {
          hostId: 'mac-mini',
          host: '192.168.21.109',
          username: 'saqebakhter',
          remotePath: '/tmp/case',
        };
        const remoteSpy = vi.fn(async () => 'REMOTE_FRAME');
        (harness.ctx.mux as { captureRemotePaneBuffer?: unknown }).captureRemotePaneBuffer = remoteSpy;
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
          () => 'LOCAL_WRAPPER_FRAME'
        );

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?frame=1`,
        });

        const body = JSON.parse(res.body);
        expect(body.data.source).toBe('mux-frame');
        expect(body.data.terminalBuffer).toBe('REMOTE_FRAME');
        expect(remoteSpy).toHaveBeenCalledWith(
          (harness.ctx._session as { remote?: unknown }).remote,
          harness.ctx._session.muxName,
          { visibleFrame: true }
        );
      });

      it('COD-207: opencode frame request also uses the visible-frame capture path', async () => {
        harness.ctx._session.mode = 'opencode';
        (harness.ctx._session as { remote?: unknown }).remote = {
          hostId: 'mac-mini',
          host: '192.168.21.109',
          username: 'saqebakhter',
          remotePath: '/tmp/case',
        };
        const remoteSpy = vi.fn(async () => 'REMOTE_FRAME');
        (harness.ctx.mux as { captureRemotePaneBuffer?: unknown }).captureRemotePaneBuffer = remoteSpy;
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
          () => 'LOCAL_WRAPPER_FRAME'
        );

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?frame=1`,
        });

        const body = JSON.parse(res.body);
        expect(body.data.source).toBe('mux-frame');
        expect(body.data.terminalBuffer).toBe('REMOTE_FRAME');
      });

      it('COD-207: opencode frame fallback remains frame-only with no canonical rewrite source', async () => {
        harness.ctx._session.mode = 'opencode';
        const localFrameSpy = vi.fn(() => 'OPENCODE_VISIBLE_FRAME');
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = localFrameSpy;

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?frame=1`,
        });

        const body = JSON.parse(res.body);
        expect(body.data.source).toBe('mux-frame');
        expect(body.data.terminalBuffer).toBe('OPENCODE_VISIBLE_FRAME');
        expect(localFrameSpy).toHaveBeenCalledWith(harness.ctx._session.muxName);
      });

      it('remote session: falls back to the local wrapper frame (still mux-frame — the wrapper shows the same screen)', async () => {
        harness.ctx._session.mode = 'codex';
        (harness.ctx._session as { remote?: unknown }).remote = {
          hostId: 'mac-mini',
          host: '192.168.21.109',
          username: 'saqebakhter',
          remotePath: '/tmp/case',
        };
        (harness.ctx.mux as { captureRemotePaneBuffer?: unknown }).captureRemotePaneBuffer = vi.fn(async () => null);
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
          () => 'LOCAL_WRAPPER_FRAME'
        );

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?frame=1`,
        });

        const body = JSON.parse(res.body);
        expect(body.data.source).toBe('mux-frame');
        expect(body.data.terminalBuffer).toBe('LOCAL_WRAPPER_FRAME');
      });

      it('no capture available: source history, empty buffer (frontend leaves screen to live repaint)', async () => {
        harness.ctx._session.terminalBuffer = 'byte history that must NOT appear';
        harness.ctx._session.mode = 'codex';
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() => null);

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?frame=1`,
        });

        const body = JSON.parse(res.body);
        expect(body.data.source).toBe('history');
        expect(body.data.terminalBuffer).toBe('');
      });

      it('COD-187 lazy history: lines=N bounds the capture and flags partial history', async () => {
        harness.ctx._session.mode = 'codex';
        const manyLines = Array.from({ length: 2000 }, (_, i) => `H${i}`).join('\n');
        const localSpy = vi.fn((_n: string, opts?: { fullHistory?: boolean; lastLines?: number }) =>
          opts?.fullHistory ? manyLines : 'visible'
        );
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = localSpy;

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?lines=2000`,
        });

        const body = JSON.parse(res.body);
        expect(localSpy).toHaveBeenCalledWith(harness.ctx._session.muxName, { fullHistory: true, lastLines: 2000 });
        expect(body.data.source).toBe('mux-full-history');
        expect(body.data.historyPartial).toBe(true);
      });

      it('COD-187 lazy history: short capture (fewer lines than requested) is NOT partial', async () => {
        harness.ctx._session.mode = 'codex';
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
          (_n: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? 'only\nfour\nshort\nlines' : 'v')
        );

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?lines=2000`,
        });

        const body = JSON.parse(res.body);
        expect(body.data.historyPartial).toBe(false);
      });

      it('COD-187 lazy history: unbounded request never sets historyPartial', async () => {
        harness.ctx._session.mode = 'codex';
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
          (_n: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? 'a\nb\nc' : 'v')
        );
        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
        });
        expect(JSON.parse(res.body).data.historyPartial).toBe(false);
      });

      it('frame wins over tail', async () => {
        harness.ctx._session.terminalBuffer = 'byte history';
        harness.ctx._session.mode = 'codex';
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
          (_n: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? 'FULL' : 'FRAME_ONLY')
        );

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?frame=1&tail=65536`,
        });

        const body = JSON.parse(res.body);
        expect(body.data.source).toBe('mux-frame');
        expect(body.data.terminalBuffer).toBe('FRAME_ONLY');
      });
    });

    it('COD-178: codex falls back to raw byte history when capture is unavailable', async () => {
      harness.ctx._session.terminalBuffer = 'accumulated byte history fallback';
      harness.ctx._session.mode = 'codex';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() => null);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('accumulated byte history fallback');
      expect(body.data.source).toBe('history');
    });

    // ── COD-47: full tmux scrollback replay on full page reload ──
    it('full reload (no tail) requests full tmux history and replays boundary markers', async () => {
      // A realistic scrollback-length capture: ~5000 lines, well past one screen.
      const firstLine = 'SCROLLBACK_FIRST_LINE_0001';
      const lastLine = 'SCROLLBACK_LAST_LINE_5000';
      const lines: string[] = [firstLine];
      for (let i = 2; i <= 4999; i++) {
        lines.push(`scrollback line ${String(i).padStart(4, '0')} lorem ipsum payload`);
      }
      lines.push(lastLine);
      const fullHistoryCapture = lines.join('\n');

      harness.ctx._session.mode = 'shell';
      harness.ctx._session.terminalBuffer = '';
      const captureSpy = vi.fn((_name: string, opts?: { fullHistory?: boolean }) =>
        opts?.fullHistory ? fullHistoryCapture : 'only the visible frame'
      );
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = captureSpy;

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Full reload asked tmux for the entire scrollback.
      expect(captureSpy).toHaveBeenCalledWith(harness.ctx._session.muxName, { fullHistory: true });
      // Both boundary markers survived the capture → route pipeline.
      expect(body.data.terminalBuffer).toContain(firstLine);
      expect(body.data.terminalBuffer).toContain(lastLine);
      expect(body.data.source).toBe('mux-full-history');
      expect(typeof body.data.fullSize).toBe('number');
    });

    it('tab switch (with tail) uses the visible frame, not full history', async () => {
      // COD-178 moved codex/gemini to full-capture-only replay; the cheap
      // visible-frame tail capture still applies to shell (and claude) modes.
      harness.ctx._session.mode = 'shell';
      harness.ctx._session.terminalBuffer = 'accumulated history';
      const captureSpy = vi.fn((_name: string, opts?: { fullHistory?: boolean }) =>
        opts?.fullHistory ? 'FULL_HISTORY_SHOULD_NOT_APPEAR' : 'visible frame only\n› prompt'
      );
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = captureSpy;

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?tail=65536`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Tail/tab-switch must NOT request fullHistory (undefined opts).
      expect(captureSpy).toHaveBeenCalledWith(harness.ctx._session.muxName, undefined);
      expect(body.data.terminalBuffer).toContain('visible frame only');
      expect(body.data.terminalBuffer).not.toContain('FULL_HISTORY_SHOULD_NOT_APPEAR');
      expect(body.data.source).toBe('mux-visible');
    });

    it('caps huge full-history at the configured terminal buffer limit and marks truncated', async () => {
      // Shrink the cap so the test can exceed it without allocating 32MB.
      harness.ctx.getTerminalHistoryConfig = vi.fn(async () => ({
        terminalScrollbackLines: 100_000,
        tmuxHistoryLimit: 100_000,
        terminalBufferMaxBytes: 4096,
        terminalBufferTrimBytes: 4096,
      }));
      harness.ctx._session.mode = 'shell';
      harness.ctx._session.terminalBuffer = '';
      const oldestMarker = 'OLDEST_EVICTED_MARKER';
      const newestMarker = 'NEWEST_KEPT_MARKER';
      const filler = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
      const huge = `${oldestMarker}\n${filler}\n${newestMarker}`;
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        (_name: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? huge : 'visible')
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.truncated).toBe(true);
      expect(body.data.fullSize).toBeGreaterThan(4096);
      expect(body.data.terminalBuffer.length).toBeLessThanOrEqual(4096);
      // Cap keeps the most RECENT bytes: newest marker survives, oldest is dropped.
      expect(body.data.terminalBuffer).toContain(newestMarker);
      expect(body.data.terminalBuffer).not.toContain(oldestMarker);
    });

    it('treats stale Codex scrollback config as TUI replay', async () => {
      // A stale renderMode:'scrollback' in codexConfig must NOT switch codex
      // back to append-style history replay — capture-only (COD-178) applies.
      harness.ctx._session.terminalBuffer = 'hello world\nlater accumulated history';
      harness.ctx._session.mode = 'codex';
      harness.ctx._session.codexConfig = { renderMode: 'scrollback' } as any;
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'full capture scrollback\n› current prompt'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('full capture scrollback');
      expect(body.data.terminalBuffer).not.toContain('hello world');
      expect(body.data.terminalBuffer).not.toContain('\x1b[H\x1b[2J');
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(harness.ctx._session.muxName, {
        fullHistory: true,
      });
    });

    it('preserves one-time OAuth authorization URLs in Codex TUI replay history', async () => {
      // Everything codex prints lands in the tmux scrollback, so the full
      // capture (the only thing codex replay ships since COD-178) carries the
      // one-time OAuth URL the user still needs to click.
      const authUrl =
        'https://auth.atlassian.com/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A35547%2Fcallback%2Fxyz';
      harness.ctx._session.terminalBuffer = 'stale codex redraw frames';
      harness.ctx._session.mode = 'codex';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () =>
          'Authorize `atlassian` by opening this URL in your browser:\n' +
          authUrl +
          '\n(Browser launch failed; please copy the URL above manually.)\n' +
          '› current prompt'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain(authUrl);
      expect(body.data.terminalBuffer).toContain('› current prompt');
      expect(body.data.terminalBuffer).not.toContain('stale codex redraw frames');
    });

    it('preserves incidental OAuth URL mentions as ordinary Codex TUI history', async () => {
      const authUrl =
        'https://auth.atlassian.com/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A35547%2Fcallback%2Fxyz';
      harness.ctx._session.terminalBuffer = 'stale codex redraw frames';
      harness.ctx._session.mode = 'codex';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () =>
          'Root cause: URLs like ' +
          authUrl +
          ' could be present in history but missing from browser-rendered terminal replay.\n' +
          '› current prompt'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain(authUrl);
      expect(body.data.terminalBuffer).toContain('› current prompt');
    });

    it('preserves accumulated history before a live mux pane snapshot for non-Codex sessions', async () => {
      harness.ctx._session.terminalBuffer = 'hello world\nlater accumulated history';
      harness.ctx._session.mode = 'claude';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'visible tmux pane only\n› current prompt'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('hello world');
      expect(body.data.terminalBuffer).toContain('later accumulated history');
      expect(body.data.terminalBuffer).toContain('visible tmux pane only');
      expect(body.data.terminalBuffer).toContain('\x1b[H\x1b[2Jvisible tmux pane only');
      expect(body.data.terminalBuffer.indexOf('hello world')).toBeLessThan(
        body.data.terminalBuffer.indexOf('visible tmux pane only')
      );
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(harness.ctx._session.muxName, {
        fullHistory: true,
      });
    });

    it('uses live mux pane capture only when the accumulated buffer is empty', async () => {
      harness.ctx._session.terminalBuffer = '';
      harness.ctx._session.mode = 'codex';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'visible restored tmux pane\n› current prompt'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('visible restored tmux pane');
      expect(body.data.terminalBuffer).toContain('› current prompt');
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(harness.ctx._session.muxName, {
        fullHistory: true,
      });
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/terminal',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('prepends the live tmux pane buffer (cleared) before the byte history', async () => {
      harness.ctx._session.terminalBuffer = 'history-bytes';
      harness.ctx.mux.captureActivePaneBuffer = vi.fn(() => 'LIVE-PANE-FRAME');

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });
      expect(res.statusCode).toBe(200);
      const buf = JSON.parse(res.body).data.terminalBuffer as string;
      // history, then a viewport clear, then the live pane frame
      expect(buf).toContain('history-bytes');
      expect(buf).toContain('\x1b[H\x1b[2J');
      expect(buf).toContain('LIVE-PANE-FRAME');
      expect(buf.indexOf('history-bytes')).toBeLessThan(buf.indexOf('LIVE-PANE-FRAME'));
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(harness.ctx._session.muxName, {
        fullHistory: true,
      });
    });

    it('falls back to the byte history when no live pane buffer is available', async () => {
      harness.ctx._session.terminalBuffer = 'history-only';
      // Empty string (the test-mode return) and null both mean "no live frame".
      harness.ctx.mux.captureActivePaneBuffer = vi.fn(() => '');

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });
      expect(res.statusCode).toBe(200);
      const buf = JSON.parse(res.body).data.terminalBuffer as string;
      expect(buf).toContain('history-only');
      expect(buf).not.toContain('\x1b[H\x1b[2J');
    });
  });

  // ========== POST /api/sessions/:id/run ==========

  describe('POST /api/sessions/:id/run', () => {
    it('runs prompt on session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/run`,
        payload: { prompt: 'do something' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('rejects empty prompt', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/run`,
        payload: { prompt: '' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/run',
        payload: { prompt: 'test' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns error if session is busy', async () => {
      harness.ctx._session.isBusy.mockReturnValue(true);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/run`,
        payload: { prompt: 'test' },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/interactive ==========

  describe('POST /api/sessions/:id/interactive', () => {
    it('starts interactive mode', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.startInteractive).toHaveBeenCalled();
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/interactive',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns error if session is busy', async () => {
      harness.ctx._session.isBusy.mockReturnValue(true);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    // COD-118: this endpoint is ALSO the frontend's automatic re-attach path, so it
    // must never clear a tripped PTY-exit breaker unless the request explicitly asks.
    it('does NOT clear the PTY-exit breaker on an automatic re-attach (no body)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx._session.resetRespawnBreaker).not.toHaveBeenCalled();
      expect(harness.ctx._session.startInteractive).toHaveBeenCalled();
    });

    it('clears the PTY-exit breaker when the explicit restart flag is sent (COD-118)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
        payload: { clearBreaker: true },
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx._session.resetRespawnBreaker).toHaveBeenCalledTimes(1);
      expect(harness.ctx._session.startInteractive).toHaveBeenCalled();
    });

    it('rejects a non-boolean clearBreaker flag', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
        payload: { clearBreaker: 'yes' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe(ApiErrorCode.INVALID_INPUT);
      expect(harness.ctx._session.resetRespawnBreaker).not.toHaveBeenCalled();
      expect(harness.ctx._session.startInteractive).not.toHaveBeenCalled();
    });

    // COD-118: the wiring exit handler detaches ALL session listeners on PTY exit;
    // re-attach must restore them or later trips/output go unobserved.
    it('re-runs session listener wiring before starting', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx.setupSessionListeners).toHaveBeenCalledWith(harness.ctx._session);
    });
  });

  // ========== POST /api/sessions/:id/shell ==========

  describe('POST /api/sessions/:id/shell', () => {
    it('starts shell mode', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/shell`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.startShell).toHaveBeenCalled();
      // COD-118: re-attach restores listener wiring detached by a prior PTY exit.
      expect(harness.ctx.setupSessionListeners).toHaveBeenCalledWith(harness.ctx._session);
    });

    it('returns error if session is busy', async () => {
      harness.ctx._session.isBusy.mockReturnValue(true);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/shell`,
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/park (COD-124) ==========

  describe('POST /api/sessions/:id/park', () => {
    it('parks an active session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/park`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.park).toHaveBeenCalled();
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:parked', expect.anything());
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:updated', expect.anything());
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/park',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('is idempotent when the session is already parked', async () => {
      harness.ctx._session.status = 'parked';
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/park`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      // Already parked — park() should NOT be invoked again.
      expect(harness.ctx._session.park).not.toHaveBeenCalled();
    });
  });

  // ========== POST /api/sessions/:id/resume (COD-124) ==========

  describe('POST /api/sessions/:id/resume', () => {
    it('resumes a parked session', async () => {
      harness.ctx._session.status = 'parked';
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resume`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      // COD-118-style requirement: listener wiring must be re-attached before
      // startInteractive() is called, since park() detaches listeners via PTY exit.
      expect(harness.ctx.setupSessionListeners).toHaveBeenCalledWith(harness.ctx._session);
      expect(harness.ctx._session.startInteractive).toHaveBeenCalled();
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:resumed', expect.anything());
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:updated', expect.anything());
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/resume',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects resume when the session is not parked', async () => {
      // Default mock status is 'idle', not 'parked'.
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resume`,
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe(ApiErrorCode.CONFLICT);
      expect(harness.ctx._session.startInteractive).not.toHaveBeenCalled();
    });

    // Non-Claude CLIs (codex/opencode/gemini/shell) get a best-effort relaunch
    // in the same workingDir with NO conversation restore — startInteractive()
    // is still called (it's the same relaunch path), but no --resume semantics
    // are claimed or asserted for these modes.
    it('best-effort relaunches a parked non-claude-mode session (no conversation restore claimed)', async () => {
      harness.ctx._session.status = 'parked';
      harness.ctx._session.mode = 'codex';
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resume`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.startInteractive).toHaveBeenCalled();
    });
  });

  // ========== GET /api/sessions/:id/output ==========

  describe('GET /api/sessions/:id/output', () => {
    it('returns session output data', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/output`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty('textOutput');
      expect(body.data).toHaveProperty('messages');
      expect(body.data).toHaveProperty('errorBuffer');
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/output',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/sessions/:id/ralph-state ==========

  describe('GET /api/sessions/:id/ralph-state', () => {
    it('returns ralph state data', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-state`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty('loop');
      expect(body.data).toHaveProperty('todos');
      expect(body.data).toHaveProperty('todoStats');
    });
  });

  // ========== GET /api/sessions/:id/active-tools ==========

  describe('GET /api/sessions/:id/active-tools', () => {
    it('returns active tools', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/active-tools`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty('tools');
    });
  });

  // ========== POST /api/logout ==========

  describe('POST /api/logout', () => {
    it('returns success', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/logout',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });
  });

  // ========== GET /api/history/sessions ==========

  describe('GET /api/history/sessions', () => {
    it('returns sessions array', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveProperty('sessions');
      expect(Array.isArray(body.data.sessions)).toBe(true);
    });

    it('does not expose local Claude history while running in test mode', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual({ sessions: [], total: 0 });
    });

    it('sessions have required fields', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions',
      });
      const body = JSON.parse(res.body);
      for (const session of body.data.sessions) {
        expect(session).toHaveProperty('sessionId');
        expect(session).toHaveProperty('workingDir');
        expect(session).toHaveProperty('projectKey');
        expect(session).toHaveProperty('sizeBytes');
        expect(session).toHaveProperty('lastModified');
        // sessionId must be a valid UUID
        expect(session.sessionId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
      }
    });

    it('sessions are sorted by lastModified descending', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions',
      });
      const body = JSON.parse(res.body);
      const dates = body.data.sessions.map((s: { lastModified: string }) => new Date(s.lastModified).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
      }
    });

    it('returns at most 50 sessions', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions',
      });
      const body = JSON.parse(res.body);
      expect(body.data.sessions.length).toBeLessThanOrEqual(50);
    });
  });

  // ========== POST /api/sessions (with resumeSessionId) ==========

  describe('POST /api/sessions with resumeSessionId', () => {
    it('creates session from a remote case without local stat validation', async () => {
      remoteStore.hosts = [
        {
          id: 'gpu-box',
          label: 'GPU Box',
          host: '10.0.0.42',
          username: 'ubuntu',
          commands: { codex: 'exec codx personal' },
        },
      ];
      remoteStore.cases = [
        {
          name: 'gpu-work',
          type: 'remote',
          hostId: 'gpu-box',
          remotePath: '/home/ubuntu/work',
          commands: { codex: 'exec case-codex' },
        },
      ];

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { caseName: 'gpu-work', mode: 'shell', name: 'Remote Shell' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.session.workingDir).toBe('/home/ubuntu/work');
      expect(body.data.session.remote).toMatchObject({
        hostId: 'gpu-box',
        host: '10.0.0.42',
        username: 'ubuntu',
        remotePath: '/home/ubuntu/work',
        commands: { codex: 'exec case-codex' },
      });
    });

    it('COD-179: passes the creating browser dims through to Session initialDims', async () => {
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', commands: {} }];
      remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { caseName: 'gpu-work', mode: 'shell', name: 'Sized', cols: 178, rows: 33 },
      });

      expect(res.statusCode).toBe(200);
      const added = (harness.ctx.addSession as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
      expect(added).toBeDefined();
      expect((added as unknown as { _initialDims?: { cols: number; rows: number } })._initialDims).toEqual({
        cols: 178,
        rows: 33,
      });
    });

    it('COD-179: rejects out-of-bounds create dims', async () => {
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', commands: {} }];
      remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { caseName: 'gpu-work', mode: 'shell', cols: 10_000, rows: 33 },
      });

      expect(JSON.parse(res.body).success).toBe(false);
    });

    it('quick-start creates remote case sessions through ssh metadata', async () => {
      const startShell = vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
      try {
        remoteStore.hosts = [
          {
            id: 'gpu-box',
            label: 'GPU Box',
            host: '10.0.0.42',
            username: 'ubuntu',
            commands: { codex: 'exec codx personal' },
          },
        ];
        remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];

        const res = await harness.app.inject({
          method: 'POST',
          url: '/api/quick-start',
          payload: { caseName: 'gpu-work', mode: 'shell' },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
        expect(body.data.casePath).toBe('/home/ubuntu/work');
        const session = [...harness.ctx.sessions.values()].find((item) => item.id === body.data.sessionId);
        expect(session?.toState()).toMatchObject({
          workingDir: '/home/ubuntu/work',
          remote: expect.objectContaining({
            hostId: 'gpu-box',
            host: '10.0.0.42',
            username: 'ubuntu',
            remotePath: '/home/ubuntu/work',
          }),
        });
      } finally {
        startShell.mockRestore();
      }
    });

    it('creates session with valid resumeSessionId', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          name: 'resume-test',
          mode: 'claude',
          workingDir: process.env.HOME || '/tmp',
          resumeSessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.session).toBeDefined();
    });

    it('rejects invalid resumeSessionId format', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          name: 'bad-resume',
          mode: 'claude',
          workingDir: process.env.HOME || '/tmp',
          resumeSessionId: 'not-a-uuid',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('creates session without resumeSessionId (optional field)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          name: 'no-resume',
          mode: 'claude',
          workingDir: process.env.HOME || '/tmp',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });
  });
});
