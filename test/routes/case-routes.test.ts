/**
 * @fileoverview Tests for case-routes route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 *
 * Responses follow the uniform envelope contract:
 *   SUCCESS -> HTTP 2xx, body = { success: true, data: <payload> }
 *   ERROR   -> HTTP 4xx/5xx, body = { success: false, error, errorCode }
 * Bare handler returns are wrapped into { success:true, data } and returned
 * error envelopes are mapped to their conventional HTTP status by the same
 * preSerialization hook the production server installs (mirrored below so test
 * behavior matches production exactly).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { registerCaseRoutes } from '../../src/web/routes/case-routes.js';

const { execMock, execPromisifyMock, execFileMock, execFilePromisifyMock } = vi.hoisted(() => {
  const promisifySymbol = Symbol.for('nodejs.util.promisify.custom');
  const execMock = vi.fn();
  const custom = vi.fn(async () => ({ stdout: '', stderr: '' }));
  (execMock as unknown as Record<symbol, unknown>)[promisifySymbol] = custom;
  const execFileMock = vi.fn();
  const fileCustom = vi.fn(async () => ({ stdout: '', stderr: '' }));
  (execFileMock as unknown as Record<symbol, unknown>)[promisifySymbol] = fileCustom;
  return { execMock, execPromisifyMock: custom, execFileMock, execFilePromisifyMock: fileCustom };
});

vi.mock('node:child_process', () => ({
  exec: execMock,
  execFile: execFileMock,
}));

// Mock filesystem modules
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  };
});

vi.mock('node:fs/promises', () => ({
  default: {
    readdir: vi.fn(async () => []),
    realpath: vi.fn(async (path: string) => path),
    stat: vi.fn(async () => ({ isDirectory: () => true })),
    readFile: vi.fn(async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }),
    writeFile: vi.fn(async () => {}),
  },
}));

vi.mock('../../src/templates/claude-md.js', () => ({
  generateClaudeMd: vi.fn(() => '# CLAUDE.md\nGenerated content'),
}));

vi.mock('../../src/skill-install-reader.js', () => ({
  readSources: vi.fn(async () => []),
  buildCatalog: vi.fn(async () => ({ entries: [], bundles: [] })),
}));

vi.mock('../../src/skill-install-classifier.js', () => ({
  classifyScope: vi.fn(async () => []),
  summarize: vi.fn(() => ({ installed: 0, missing: 0, drifted: 0 })),
}));

vi.mock('../../src/hooks-config.js', () => ({
  writeHooksConfig: vi.fn(async () => {}),
}));

// Stub the remote-tmux prereq probe so remote-link tests never shell out to ssh
// (readRemoteHosts/writeRemoteHosts stay real, backed by the mocked fs).
vi.mock('../../src/remote-hosts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/remote-hosts.js')>();
  return {
    ...actual,
    checkRemoteTmuxAvailable: vi.fn(async () => ({ ok: true, tmuxPath: '/usr/bin/tmux' })),
  };
});

// Import mocked modules for test control
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import * as skillReader from '../../src/skill-install-reader.js';
import * as skillClassifier from '../../src/skill-install-classifier.js';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadSources = vi.mocked(skillReader.readSources);
const mockedBuildCatalog = vi.mocked(skillReader.buildCatalog);
const mockedClassifyScope = vi.mocked(skillClassifier.classifyScope);
const mockedSummarize = vi.mocked(skillClassifier.summarize);
const mockedMkdirSync = vi.mocked(mkdirSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedReaddir = vi.mocked(fs.readdir);
const mockedRealpath = vi.mocked(fs.realpath);
const mockedStat = vi.mocked(fs.stat);
const mockedReadFile = vi.mocked(fs.readFile);
const mockedWriteFile = vi.mocked(fs.writeFile);

interface CaseRouteHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

/**
 * Build a route harness that mirrors production: cookie plugin, the shared
 * route error handler, AND the uniform-envelope preSerialization hook (copied
 * from src/web/server.ts) so bare handler returns become { success:true, data }
 * and returned error envelopes get mapped to a conventional HTTP status.
 */
async function createEnvelopeHarness(): Promise<CaseRouteHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);

  // Uniform response envelope (matches src/web/server.ts preSerialization hook).
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

  const ctx = createMockRouteContext();
  registerCaseRoutes(app, ctx as never);
  installRouteErrorHandler(app);
  await app.ready();

  return { app, ctx };
}

describe('case-routes', () => {
  let harness: CaseRouteHarness;

  beforeEach(async () => {
    harness = await createEnvelopeHarness();
    vi.clearAllMocks();

    // Default: existsSync returns false, readFile throws ENOENT
    mockedExistsSync.mockReturnValue(false);
    mockedRealpath.mockImplementation(async (path) => String(path));
    mockedStat.mockResolvedValue({ isDirectory: () => true } as never);
    mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    execPromisifyMock.mockResolvedValue({ stdout: '', stderr: '' });
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/cases ==========

  describe('GET /api/cases', () => {
    it('returns empty array when no cases exist', async () => {
      mockedReaddir.mockRejectedValue(new Error('ENOENT'));

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
    });

    it('returns cases from CASES_DIR', async () => {
      mockedReaddir.mockResolvedValue([
        { name: 'my-case', isDirectory: () => true },
        { name: 'other-case', isDirectory: () => true },
        { name: 'readme.txt', isDirectory: () => false },
      ] as never);
      // No CLAUDE.md exists
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].name).toBe('my-case');
      expect(body.data[1].name).toBe('other-case');
      expect(body.data[0].hasClaudeMd).toBe(false);
    });

    it('includes hasClaudeMd flag', async () => {
      mockedReaddir.mockResolvedValue([{ name: 'case-with-md', isDirectory: () => true }] as never);
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data[0].hasClaudeMd).toBe(true);
    });

    it('includes linked cases from linked-cases.json', async () => {
      // CASES_DIR readdir returns one case
      mockedReaddir.mockResolvedValue([{ name: 'regular-case', isDirectory: () => true }] as never);
      // linked-cases.json is read second (after CASES_DIR readdir)
      let readCallCount = 0;
      mockedReadFile.mockImplementation(async () => {
        readCallCount++;
        if (readCallCount === 1) {
          return JSON.stringify({ 'linked-project': '/home/user/projects/linked' });
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      // existsSync: path exists for linked case, CLAUDE.md check
      mockedExistsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('linked')) return true;
        return false;
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Should have both regular and linked cases
      expect(body.data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('remote host and remote case routes', () => {
    function setupRemoteConfigStore() {
      const store = new Map<string, string>();
      mockedReadFile.mockImplementation(async (path) => {
        const key = String(path);
        if (store.has(key)) return store.get(key) || '';
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockedWriteFile.mockImplementation(async (path, data) => {
        store.set(String(path), String(data));
      });
    }

    it('creates a remote host and lists it', async () => {
      setupRemoteConfigStore();

      const create = await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: {
          id: 'gpu-box',
          label: 'GPU Box',
          host: '10.0.0.42',
          username: 'ubuntu',
          commands: { codex: 'exec codx personal' },
        },
      });
      expect(create.statusCode).toBe(200);
      expect(JSON.parse(create.body)).toMatchObject({ success: true });

      const list = await harness.app.inject({ method: 'GET', url: '/api/remote-hosts' });
      expect(list.statusCode).toBe(200);
      expect(JSON.parse(list.body).data).toEqual([
        expect.objectContaining({ id: 'gpu-box', label: 'GPU Box', commands: { codex: 'exec codx personal' } }),
      ]);
    });

    // COD-107 — advanced SSH connection options (port, identity, SOCKS proxy,
    // jump host, escape-hatch -o options) round-trip through the host schema.
    it('persists advanced SSH options (port/identity/socks/jump/extra) on a remote host', async () => {
      setupRemoteConfigStore();

      const create = await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: {
          id: 'aa-desktop',
          label: 'aa-desktop',
          host: '192.168.55.170',
          username: 'aakht',
          port: 2222,
          identityFile: '~/.ssh/remote_ed25519',
          socksProxy: '127.0.0.1:1080',
          jumpHost: 'bastion@10.0.0.1:22',
          extraSshOptions: ['StrictHostKeyChecking=accept-new'],
        },
      });
      expect(create.statusCode).toBe(200);
      expect(JSON.parse(create.body)).toMatchObject({ success: true });

      const list = await harness.app.inject({ method: 'GET', url: '/api/remote-hosts' });
      expect(JSON.parse(list.body).data).toEqual([
        expect.objectContaining({
          id: 'aa-desktop',
          port: 2222,
          identityFile: '~/.ssh/remote_ed25519',
          socksProxy: '127.0.0.1:1080',
          jumpHost: 'bastion@10.0.0.1:22',
          extraSshOptions: ['StrictHostKeyChecking=accept-new'],
        }),
      ]);
    });

    it('rejects a malformed extraSshOptions entry (not KEY=VALUE) with INVALID_INPUT', async () => {
      setupRemoteConfigStore();

      const create = await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: {
          id: 'bad-host',
          label: 'bad',
          host: '10.0.0.9',
          username: 'ubuntu',
          extraSshOptions: ['not a valid option'],
        },
      });
      expect(create.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.INVALID_INPUT));
      expect(JSON.parse(create.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.INVALID_INPUT });
    });

    it('rejects a malformed socksProxy (missing port) with INVALID_INPUT', async () => {
      setupRemoteConfigStore();

      const create = await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: { id: 'bad2', label: 'bad2', host: '10.0.0.9', username: 'ubuntu', socksProxy: '127.0.0.1' },
      });
      expect(create.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.INVALID_INPUT));
      expect(JSON.parse(create.body)).toMatchObject({ success: false });
    });

    it('verifies SSH access for an unsaved remote host profile', async () => {
      execPromisifyMock.mockResolvedValueOnce({ stdout: 'codeman-ssh-ok', stderr: '' });

      const verify = await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts/verify',
        payload: { id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', port: 2222 },
      });

      expect(verify.statusCode).toBe(200);
      expect(JSON.parse(verify.body)).toEqual({ success: true, data: { ok: true } });
      expect(execPromisifyMock).toHaveBeenCalledWith(expect.stringContaining('printf codeman-ssh-ok'), {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
    });

    it('links a remote case and includes it in GET /api/cases', async () => {
      setupRemoteConfigStore();
      mockedReaddir.mockRejectedValue(new Error('ENOENT'));

      await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: { id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' },
      });

      const link = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/remote-link',
        payload: {
          name: 'gpu-work',
          hostId: 'gpu-box',
          remotePath: '/home/ubuntu/work',
          commands: { codex: 'exec case-codex' },
        },
      });
      expect(link.statusCode).toBe(200);
      expect(JSON.parse(link.body).data.case).toMatchObject({
        name: 'gpu-work',
        commands: { codex: 'exec case-codex' },
      });

      const cases = await harness.app.inject({ method: 'GET', url: '/api/cases' });
      expect(JSON.parse(cases.body).data).toContainEqual(
        expect.objectContaining({
          name: 'gpu-work',
          location: 'remote',
          path: 'ubuntu@10.0.0.42:/home/ubuntu/work',
          remote: expect.objectContaining({
            hostId: 'gpu-box',
            path: '/home/ubuntu/work',
            commands: { codex: 'exec case-codex' },
          }),
        })
      );
    });

    it('prefers remote case metadata over a same-name local managed case', async () => {
      setupRemoteConfigStore();
      mockedReaddir.mockResolvedValue([{ name: 'gpu-work', isDirectory: () => true }] as never);

      await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: { id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' },
      });
      await harness.app.inject({
        method: 'POST',
        url: '/api/cases/remote-link',
        payload: { name: 'gpu-work', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' },
      });
      mockedExistsSync.mockReturnValue(true);

      const cases = await harness.app.inject({ method: 'GET', url: '/api/cases' });
      expect(JSON.parse(cases.body).data).toContainEqual(
        expect.objectContaining({
          name: 'gpu-work',
          location: 'remote',
          path: 'ubuntu@10.0.0.42:/home/ubuntu/work',
        })
      );
    });

    it('deletes remote case metadata only', async () => {
      setupRemoteConfigStore();

      await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: { id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' },
      });
      await harness.app.inject({
        method: 'POST',
        url: '/api/cases/remote-link',
        payload: { name: 'gpu-work', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' },
      });

      const deleted = await harness.app.inject({ method: 'DELETE', url: '/api/cases/gpu-work' });
      expect(deleted.statusCode).toBe(200);
      expect(JSON.parse(deleted.body)).toEqual({ success: true, data: { name: 'gpu-work' } });
    });

    it('updates a linked case name and folder path', async () => {
      setupRemoteConfigStore();
      mockedReaddir.mockRejectedValue(new Error('ENOENT'));
      mockedExistsSync.mockImplementation((path) => {
        const value = String(path);
        return value === '/projects/old-app' || value === '/projects/new-app';
      });

      await harness.app.inject({
        method: 'POST',
        url: '/api/cases/link',
        payload: { name: 'old-app', path: '/projects/old-app' },
      });

      const update = await harness.app.inject({
        method: 'PUT',
        url: '/api/cases/old-app',
        payload: { name: 'new-app', path: '/projects/new-app' },
      });
      expect(update.statusCode).toBe(200);
      expect(JSON.parse(update.body)).toMatchObject({
        success: true,
        data: { case: { name: 'new-app', path: '/projects/new-app', linked: true, location: 'linked-local' } },
      });

      const cases = await harness.app.inject({ method: 'GET', url: '/api/cases' });
      expect(JSON.parse(cases.body).data).toContainEqual(
        expect.objectContaining({ name: 'new-app', path: '/projects/new-app', linked: true, location: 'linked-local' })
      );
    });

    it('updates a remote case name, host, and remote path', async () => {
      setupRemoteConfigStore();
      mockedReaddir.mockRejectedValue(new Error('ENOENT'));

      await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: { id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' },
      });
      await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: { id: 'build-box', label: 'Build Box', host: '10.0.0.43', username: 'builder' },
      });
      await harness.app.inject({
        method: 'POST',
        url: '/api/cases/remote-link',
        payload: { name: 'gpu-work', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' },
      });

      const update = await harness.app.inject({
        method: 'PUT',
        url: '/api/cases/gpu-work',
        payload: {
          name: 'build-work',
          hostId: 'build-box',
          remotePath: '/srv/build/work',
          commands: { codex: 'exec build-codex' },
        },
      });
      expect(update.statusCode).toBe(200);
      expect(JSON.parse(update.body)).toMatchObject({
        success: true,
        data: {
          case: {
            name: 'build-work',
            location: 'remote',
            path: 'builder@10.0.0.43:/srv/build/work',
            remote: {
              hostId: 'build-box',
              host: '10.0.0.43',
              username: 'builder',
              path: '/srv/build/work',
              commands: { codex: 'exec build-codex' },
            },
          },
        },
      });

      const cases = await harness.app.inject({ method: 'GET', url: '/api/cases' });
      expect(JSON.parse(cases.body).data).toContainEqual(
        expect.objectContaining({
          name: 'build-work',
          location: 'remote',
          path: 'builder@10.0.0.43:/srv/build/work',
        })
      );
    });

    it('lists only local directories for case path browsing', async () => {
      mockedStat.mockResolvedValueOnce({ isDirectory: () => true } as never);
      mockedReaddir.mockResolvedValueOnce([
        { name: 'app', isDirectory: () => true },
        { name: '.hidden', isDirectory: () => true },
        { name: 'README.md', isDirectory: () => false },
        { name: 'ops', isDirectory: () => true },
      ] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/browse-local?path=%2Fprojects',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        success: true,
        data: {
          path: '/projects',
          parentPath: '/',
          entries: [
            { name: 'app', path: '/projects/app' },
            { name: 'ops', path: '/projects/ops' },
          ],
        },
      });
    });

    it('lists remote directories through a saved remote host', async () => {
      setupRemoteConfigStore();
      execPromisifyMock.mockResolvedValueOnce({ stdout: '/srv/app\n/srv/ops\n', stderr: '' });

      await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: { id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' },
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/remote-hosts/gpu-box/directories?path=%2Fsrv',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        success: true,
        data: {
          path: '/srv',
          parentPath: '/',
          entries: [
            { name: 'app', path: '/srv/app' },
            { name: 'ops', path: '/srv/ops' },
          ],
        },
      });
      expect(execPromisifyMock).toHaveBeenCalledWith(expect.stringContaining('ubuntu@10.0.0.42'), {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
    });
  });

  // ========== POST /api/cases ==========

  describe('POST /api/cases', () => {
    it('rejects invalid case name', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: { name: 'invalid case name!!' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects missing name', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects path traversal in name', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: { name: '../etc' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects duplicate case name', async () => {
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: { name: 'existing-case' },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('already exists');
    });

    it('creates case directory with CLAUDE.md and hooks config', async () => {
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: { name: 'new-case', description: 'A new test case' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.case.name).toBe('new-case');
      expect(body.data.case.path).toContain('new-case');

      // Verify directory creation
      expect(mockedMkdirSync).toHaveBeenCalled();

      // Verify broadcast
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('case:created', expect.objectContaining({ name: 'new-case' }));
    });
  });

  // ========== POST /api/cases/link ==========

  describe('POST /api/cases/link', () => {
    it('rejects invalid request body', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/link',
        payload: { name: 'bad name!' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects missing fields', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/link',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns not found when folder does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/link',
        payload: { name: 'my-project', path: '/nonexistent/path' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    it('rejects when case name already exists in CASES_DIR', async () => {
      // First call (expandedPath check) returns true, second (casePath check) also returns true
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/link',
        payload: { name: 'existing-case', path: '/home/user/project' },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('already exists');
    });

    it('links folder successfully', async () => {
      // expandedPath exists (first call), casePath does not (second call)
      let callIdx = 0;
      mockedExistsSync.mockImplementation(() => {
        callIdx++;
        return callIdx === 1; // first: folder exists, second: case dir doesn't
      });
      // linked-cases.json doesn't exist yet
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/link',
        payload: { name: 'linked-project', path: '/home/user/project' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.case.name).toBe('linked-project');
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        'case:linked',
        expect.objectContaining({ name: 'linked-project' })
      );
    });
  });

  // ========== GET /api/cases/:name ==========

  describe('GET /api/cases/:name', () => {
    it('returns linked case info', async () => {
      mockedReadFile.mockResolvedValue(JSON.stringify({ 'my-case': '/home/user/my-case' }) as never);
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('my-case');
      expect(body.data.linked).toBe(true);
    });

    it('returns CASES_DIR case when no linked case found', async () => {
      // linked-cases.json read fails
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      // case dir exists
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/regular-case',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('regular-case');
    });

    it('returns error when case not found anywhere', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/nonexistent',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });
  });

  // ========== GET /api/cases/:name/fix-plan ==========

  describe('GET /api/cases/:name/fix-plan', () => {
    it('returns exists=false when no fix plan file', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/fix-plan',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.exists).toBe(false);
      expect(body.data.content).toBeNull();
      expect(body.data.todos).toEqual([]);
    });

    it('parses fix plan with todos and stats', async () => {
      const fixPlanContent = [
        '# Fix Plan',
        '## High Priority',
        '- [ ] Fix critical bug',
        '- [-] Working on auth',
        '- [x] Setup database',
        '## Standard',
        '- [ ] Add logging',
        '## Completed',
        '- [x] Initial setup',
      ].join('\n');

      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockedExistsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('fix_plan')) return true;
        return false;
      });

      // Override readFile for the fix plan read
      mockedReadFile.mockImplementation(async (p: string) => {
        if (typeof p === 'string' && p.includes('fix_plan')) {
          return fixPlanContent as never;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/fix-plan',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.exists).toBe(true);
      expect(body.data.todos.length).toBeGreaterThan(0);
      expect(body.data.stats.total).toBeGreaterThan(0);
    });
  });

  // ========== GET /api/cases/:caseName/ralph-wizard/files ==========

  describe('GET /api/cases/:caseName/ralph-wizard/files', () => {
    it('returns error when wizard directory not found', async () => {
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/ralph-wizard/files',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    it('rejects path traversal in case name', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/..%2F..%2Fetc/ralph-wizard/files',
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns wizard files when directory exists', async () => {
      mockedExistsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('ralph-wizard')) return true;
        if (typeof p === 'string' && p.includes('prompt.md')) return true;
        if (typeof p === 'string' && p.includes('result.json')) return true;
        return false;
      });
      mockedReaddirSync.mockReturnValue([
        { name: 'research', isDirectory: () => true },
        { name: 'planner', isDirectory: () => true },
      ] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/ralph-wizard/files',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.files).toHaveLength(2);
      expect(body.data.files[0].agentType).toBe('research');
    });
  });

  // ========== GET /api/cases/:caseName/ralph-wizard/file/:filePath ==========

  describe('GET /api/cases/:caseName/ralph-wizard/file/:filePath', () => {
    it('returns error for missing file', async () => {
      mockedExistsSync.mockReturnValue(false);
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/ralph-wizard/file/research%2Fprompt.md',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns markdown file content', async () => {
      mockedExistsSync.mockReturnValue(false);
      mockedReadFile.mockResolvedValue('# Research Prompt\nContent here' as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/ralph-wizard/file/research%2Fprompt.md',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.content).toContain('Research Prompt');
      expect(body.data.isJson).toBe(false);
    });

    it('parses JSON file content', async () => {
      mockedExistsSync.mockReturnValue(false);
      const jsonContent = JSON.stringify({ plan: 'test plan', steps: [1, 2, 3] });
      mockedReadFile.mockResolvedValue(jsonContent as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/ralph-wizard/file/planner%2Fresult.json',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.isJson).toBe(true);
      expect(body.data.parsed.plan).toBe('test plan');
    });

    it('sets no-cache headers', async () => {
      mockedExistsSync.mockReturnValue(false);
      mockedReadFile.mockResolvedValue('content' as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/ralph-wizard/file/research%2Fprompt.md',
      });
      expect(res.headers['cache-control']).toContain('no-store');
    });
  });

  // ========== GET /api/cases/:name/skill-detail ==========

  describe('GET /api/cases/:name/skill-detail', () => {
    it('returns hasManifest:false when no sources configured', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadSources.mockResolvedValue([]);

      const res = await harness.app.inject({ method: 'GET', url: '/api/cases/testcase/skill-detail' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.hasManifest).toBe(false);
      expect(body.data.projectEntries).toEqual([]);
      expect(body.data.userEntries).toEqual([]);
    });

    it('returns project and user entries when sources present', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadSources.mockResolvedValue([
        { name: 'my-skills', path: '/tmp/skills', description: '', available: true, artifacts: {}, bundles: {} },
      ]);
      mockedBuildCatalog.mockResolvedValue({
        entries: [{ kind: 'skill', source: 'my-skills', name: 'code-review', pack: null }],
        bundles: [],
      });
      const installedEntry = {
        kind: 'skill',
        name: 'code-review',
        source: 'my-skills',
        pack: null,
        klass: 'linked-managed',
        claudePath: '/home/u/.claude/skills/code-review',
        mirrorPath: null,
        target: '/tmp/skills/code-review.md',
      };
      mockedClassifyScope.mockResolvedValue([installedEntry] as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/cases/testcase/skill-detail' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.hasManifest).toBe(true);
      expect(body.data.projectEntries).toHaveLength(1);
      expect(body.data.projectEntries[0].name).toBe('code-review');
      expect(body.data.projectEntries[0].klass).toBe('linked-managed');
      expect(body.data.userEntries).toHaveLength(1);
    });

    it('returns 404 when case does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({ method: 'GET', url: '/api/cases/no-such-case/skill-detail' });
      expect(res.statusCode).toBe(404);
    });
  });

  // ========== POST /api/cases/:name/skill-sync ==========

  describe('POST /api/cases/:name/skill-sync', () => {
    it('calls exec with skill-install sync and returns fresh detail', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadSources.mockResolvedValue([]);

      const res = await harness.app.inject({ method: 'POST', url: '/api/cases/testcase/skill-sync' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(execPromisifyMock).toHaveBeenCalledWith(
        expect.stringContaining('skill-install'),
        expect.objectContaining({ cwd: expect.any(String) })
      );
    });

    it('returns 404 when case does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({ method: 'POST', url: '/api/cases/no-such-case/skill-sync' });
      expect(res.statusCode).toBe(404);
    });
  });

  // ========== POST /api/cases/:name/skill-remove ==========

  describe('POST /api/cases/:name/skill-remove', () => {
    it('rejects missing or unsafe skillId', async () => {
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/testcase/skill-remove',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('calls execFile with skill-install remove and returns fresh detail', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadSources.mockResolvedValue([]);
      execFilePromisifyMock.mockResolvedValueOnce({ stdout: '', stderr: '' });

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/testcase/skill-remove',
        payload: { skillId: 'my-skills/code-review' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(execFilePromisifyMock).toHaveBeenCalledWith(
        'skill-install',
        ['remove', 'my-skills/code-review'],
        expect.objectContaining({ cwd: expect.any(String) })
      );
    });
  });

  // ========== GET /api/cases/:name/skill-catalog ==========

  describe('GET /api/cases/:name/skill-catalog', () => {
    it('returns hasManifest:false when no sources configured', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadSources.mockResolvedValue([]);

      const res = await harness.app.inject({ method: 'GET', url: '/api/cases/testcase/skill-catalog' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.hasManifest).toBe(false);
      expect(body.data.packs).toEqual([]);
      expect(body.data.individuals).toEqual([]);
    });

    it('returns packs with install counts and individuals from catalog', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadSources.mockResolvedValue([
        { name: 'src1', path: '/some/path', description: '', available: true, artifacts: {}, bundles: {} },
      ] as never);
      mockedBuildCatalog.mockResolvedValue({
        entries: [
          { kind: 'skill', source: 'src1', name: 'code-review', pack: 'review-tools' },
          { kind: 'skill', source: 'src1', name: 'pr-check', pack: 'review-tools' },
          { kind: 'skill', source: 'src1', name: 'solo-skill', pack: null },
        ],
        bundles: [
          {
            source: 'src1',
            name: 'review-tools',
            description: 'Code review toolset',
            skills: ['code-review', 'pr-check'],
            agents: [],
            commands: [],
          },
        ],
      } as never);
      mockedClassifyScope.mockResolvedValue([
        {
          kind: 'skill',
          name: 'code-review',
          source: 'src1',
          pack: 'review-tools',
          klass: 'linked-managed',
          claudePath: '/p',
          mirrorPath: null,
          target: null,
        },
        {
          kind: 'skill',
          name: 'pr-check',
          source: 'src1',
          pack: 'review-tools',
          klass: 'available-managed',
          claudePath: '/p',
          mirrorPath: null,
          target: null,
        },
        {
          kind: 'skill',
          name: 'solo-skill',
          source: 'src1',
          pack: null,
          klass: 'available-managed',
          claudePath: '/p',
          mirrorPath: null,
          target: null,
        },
      ] as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/cases/testcase/skill-catalog' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.packs).toHaveLength(1);
      expect(body.data.packs[0].name).toBe('review-tools');
      expect(body.data.packs[0].description).toBe('Code review toolset');
      expect(body.data.packs[0].installedCount).toBe(1);
      expect(body.data.packs[0].totalCount).toBe(2);
      expect(body.data.individuals).toHaveLength(1);
      expect(body.data.individuals[0].name).toBe('solo-skill');
      expect(body.data.individuals[0].klass).toBe('available-managed');
    });

    it('returns 404 when case does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);
      const res = await harness.app.inject({ method: 'GET', url: '/api/cases/no-such-case/skill-catalog' });
      expect(res.statusCode).toBe(404);
    });
  });

  // ========== POST /api/cases/:name/skill-add ==========

  describe('POST /api/cases/:name/skill-add', () => {
    it('rejects missing or unsafe target', async () => {
      mockedExistsSync.mockReturnValue(true);

      const resMissing = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/testcase/skill-add',
        payload: {},
      });
      expect(resMissing.statusCode).toBe(400);

      const resDash = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/testcase/skill-add',
        payload: { target: '-dangerous' },
      });
      expect(resDash.statusCode).toBe(400);

      const resTraversal = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/testcase/skill-add',
        payload: { target: 'src/../etc/passwd' },
      });
      expect(resTraversal.statusCode).toBe(400);
    });

    it('calls execFile with skill-install add and returns fresh catalog', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadSources.mockResolvedValue([]);
      execFilePromisifyMock.mockResolvedValueOnce({ stdout: '', stderr: '' });

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/testcase/skill-add',
        payload: { target: 'my-source:review-tools' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(execFilePromisifyMock).toHaveBeenCalledWith(
        'skill-install',
        ['add', 'my-source:review-tools'],
        expect.objectContaining({ cwd: expect.any(String) })
      );
    });

    it('returns 404 when case does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/no-such-case/skill-add',
        payload: { target: 'src:pack' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ========== GET /api/cases/:name/skill-state ==========

  describe('GET /api/cases/:name/skill-state', () => {
    it('returns hasManifest:false when no sources configured', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadSources.mockResolvedValue([]);

      const res = await harness.app.inject({ method: 'GET', url: '/api/cases/testcase/skill-state' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.hasManifest).toBe(false);
    });

    it('returns summary when sources and catalog are present', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadSources.mockResolvedValue([
        { name: 'my-skills', path: '/tmp/skills', description: '', available: true, artifacts: {}, bundles: {} },
      ]);
      mockedBuildCatalog.mockResolvedValue({
        entries: [{ kind: 'skill', source: 'my-skills', name: 'code-review', pack: 'code-review' }],
        bundles: [],
      });
      mockedClassifyScope.mockResolvedValue([
        {
          kind: 'skill',
          name: 'code-review',
          source: 'my-skills',
          pack: 'code-review',
          klass: 'linked-managed',
          claudePath: '/home/u/.claude/skills/code-review',
          mirrorPath: null,
          target: '/tmp/skills/code-review.md',
        },
      ]);
      mockedSummarize.mockReturnValue({ installed: 1, missing: 0, drifted: 0 });

      const res = await harness.app.inject({ method: 'GET', url: '/api/cases/testcase/skill-state' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.hasManifest).toBe(true);
      expect(body.data.installed).toBe(1);
      expect(body.data.missing).toBe(0);
      expect(body.data.primaryPack).toBe('code-review');
    });

    it('returns 404 when case does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({ method: 'GET', url: '/api/cases/no-such-case/skill-state' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/skills/user', () => {
    it('returns hasManifest:false when no sources configured', async () => {
      mockedReadSources.mockResolvedValue([]);

      const res = await harness.app.inject({ method: 'GET', url: '/api/skills/user' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.hasManifest).toBe(false);
      expect(body.data.entries).toEqual([]);
    });

    it('returns user-scope entries from classifyScope at homedir', async () => {
      const fakeSource = { name: 'test-source', path: '/sources/test', kind: 'local' as const };
      mockedReadSources.mockResolvedValue([fakeSource]);
      mockedBuildCatalog.mockResolvedValue({ entries: [], bundles: [] });
      mockedClassifyScope.mockResolvedValue([
        { kind: 'skill', name: 'my-skill', source: 'test-source', pack: null, klass: 'real' },
        { kind: 'agent', name: 'my-agent', source: 'test-source', pack: 'mypak', klass: 'linked-managed' },
      ]);

      const res = await harness.app.inject({ method: 'GET', url: '/api/skills/user' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.hasManifest).toBe(true);
      expect(body.data.entries).toHaveLength(2);
      expect(body.data.entries[0]).toMatchObject({ kind: 'skill', name: 'my-skill', klass: 'real' });
    });
  });

  describe('POST /api/skills/user/add', () => {
    it('rejects missing or unsafe target', async () => {
      const cases = [{ target: '' }, { target: '-danger' }, { target: '../traversal' }, { target: 'a/../b' }];
      for (const payload of cases) {
        const res = await harness.app.inject({
          method: 'POST',
          url: '/api/skills/user/add',
          payload,
          headers: { 'content-type': 'application/json' },
        });
        expect(res.statusCode).toBe(400);
      }
    });

    it('calls execFile with --user --add and returns fresh user skills', async () => {
      const fakeSource = { name: 's', path: '/p', kind: 'local' as const };
      mockedReadSources.mockResolvedValue([fakeSource]);
      mockedBuildCatalog.mockResolvedValue({ entries: [], bundles: [] });
      mockedClassifyScope.mockResolvedValue([
        { kind: 'skill', name: 'added-skill', source: 's', pack: null, klass: 'real' },
      ]);
      execFilePromisifyMock.mockResolvedValue({ stdout: '', stderr: '' });

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/skills/user/add',
        payload: { target: 'test-source/my-skill' },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.hasManifest).toBe(true);
      expect(execFilePromisifyMock).toHaveBeenCalledWith(
        'skill-install',
        ['--user', '--add', 'test-source/my-skill'],
        expect.objectContaining({ timeout: expect.any(Number) })
      );
    });
  });

  describe('POST /api/skills/user/remove', () => {
    it('rejects missing or unsafe skillId', async () => {
      const cases = [{ skillId: '' }, { skillId: '-danger' }, { skillId: '../traversal' }];
      for (const payload of cases) {
        const res = await harness.app.inject({
          method: 'POST',
          url: '/api/skills/user/remove',
          payload,
          headers: { 'content-type': 'application/json' },
        });
        expect(res.statusCode).toBe(400);
      }
    });

    it('calls execFile with --user --remove and returns fresh user skills', async () => {
      const fakeSource = { name: 's', path: '/p', kind: 'local' as const };
      mockedReadSources.mockResolvedValue([fakeSource]);
      mockedBuildCatalog.mockResolvedValue({ entries: [], bundles: [] });
      mockedClassifyScope.mockResolvedValue([]);
      execFilePromisifyMock.mockResolvedValue({ stdout: '', stderr: '' });

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/skills/user/remove',
        payload: { skillId: 'my-skill' },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(execFilePromisifyMock).toHaveBeenCalledWith(
        'skill-install',
        ['--user', '--remove', 'my-skill'],
        expect.objectContaining({ timeout: expect.any(Number) })
      );
    });
  });
});
