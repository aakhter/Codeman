/**
 * @fileoverview Tests for file-routes route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCompress from '@fastify/compress';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { createMockRouteContext } from '../mocks/index.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode } from '../../src/types.js';

// Mock fs/promises for file operations
vi.mock('node:fs/promises', () => ({
  default: {
    readdir: vi.fn(async () => []),
    readFile: vi.fn(async () => 'file content'),
    writeFile: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 100, isFile: () => true, isDirectory: () => true })),
    mkdir: vi.fn(async () => undefined),
    mkdtemp: vi.fn(async () => '/tmp/codeman-preview-test'),
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  },
}));

vi.mock('node:child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn((_cmd, _args, _options, callback) => {
    callback(null, { stdout: '', stderr: '' });
    return {};
  }),
}));

// Mock realpathSync for symlink resolution
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: vi.fn((p: string) => p),
    createReadStream: vi.fn(() => Readable.from([Buffer.from('file content')])),
  };
});

// Mock fileStreamManager
vi.mock('../../src/file-stream-manager.js', () => ({
  fileStreamManager: {
    createStream: vi.fn(async () => ({ success: true, streamId: 'stream-1' })),
    closeStream: vi.fn(() => true),
  },
}));

import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createReadStream, realpathSync } from 'node:fs';
import { fileStreamManager } from '../../src/file-stream-manager.js';
import { clearDocumentPreviewCache } from '../../src/document-preview-cache.js';
import { buildDetectedAttachmentHistoryItem } from '../../src/session-attachment-history.js';
import { documentVersionStore } from '../../src/document-version-store.js';

const mockedReaddir = vi.mocked(fs.readdir);
const mockedReadFile = vi.mocked(fs.readFile);
const mockedWriteFile = vi.mocked(fs.writeFile);
const mockedStat = vi.mocked(fs.stat);
const mockedMkdir = vi.mocked(fs.mkdir);
const mockedMkdtemp = vi.mocked(fs.mkdtemp);
const mockedRename = vi.mocked(fs.rename);
const mockedRm = vi.mocked(fs.rm);
const mockedExecFile = vi.mocked(execFile);
const mockedCreateReadStream = vi.mocked(createReadStream);
const mockedRealpathSync = vi.mocked(realpathSync);
const mockedFileStreamManager = vi.mocked(fileStreamManager);

describe('file-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes);
    vi.clearAllMocks();
    clearDocumentPreviewCache();
    documentVersionStore.clearSession(harness.ctx._sessionId);

    // Default: realpathSync returns the path unchanged
    mockedRealpathSync.mockImplementation((p: string) => p as never);
    mockedReaddir.mockResolvedValue([] as never);
    mockedReadFile.mockResolvedValue('file content' as never);
    // Default stat
    mockedStat.mockImplementation(async (path) => {
      const pathText = String(path);
      if (pathText.includes('codeman-document-preview-cache') && pathText.endsWith('.pdf')) {
        throw new Error('ENOENT');
      }

      return { size: 100, isFile: () => true, isDirectory: () => true, mtimeMs: 12345 } as never;
    });
    mockedReadFile.mockImplementation(async (path) =>
      String(path).endsWith('settings.json') ? ('{}' as never) : ('file content' as never)
    );
    mockedMkdir.mockResolvedValue(undefined as never);
    mockedMkdtemp.mockResolvedValue('/tmp/codeman-preview-test' as never);
    mockedRename.mockResolvedValue(undefined as never);
    mockedRm.mockResolvedValue(undefined as never);
    mockedExecFile.mockImplementation((_cmd, _args, _options, callback) => {
      callback(null, { stdout: '', stderr: '' });
      return {} as never;
    });
    mockedCreateReadStream.mockReturnValue(Readable.from([Buffer.from('file content')]) as never);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/filesystem/browse ==========

  describe('GET /api/filesystem/browse', () => {
    it('lists the active session folder lazily with directories first', async () => {
      mockedReaddir.mockResolvedValueOnce([
        {
          name: 'notes.txt',
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        },
        {
          name: 'src',
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        },
      ] as never);

      const path = harness.ctx._session.workingDir;
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/browse?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(path)}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.path).toBe(path);
      expect(body.data.roots[0]).toEqual({ label: 'Current Folder', path });
      expect(
        body.data.entries.map((entry: { name: string; type: string; previewKind?: string }) => [
          entry.name,
          entry.type,
          entry.previewKind,
        ])
      ).toEqual([
        ['src', 'directory', undefined],
        ['notes.txt', 'file', 'text'],
      ]);
    });

    it('rejects paths outside the configured roots', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/browse?path=${encodeURIComponent('/tmp/not-an-allowed-root')}`,
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.INVALID_INPUT });
    });

    it('does not expose hidden entries or symlinks that escape the allowed roots', async () => {
      const root = harness.ctx._session.workingDir;
      mockedReaddir.mockResolvedValueOnce([
        {
          name: '.secret',
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        },
        {
          name: 'outside-link',
          isDirectory: () => false,
          isFile: () => false,
          isSymbolicLink: () => true,
        },
      ] as never);
      mockedRealpathSync.mockImplementation((path: string) =>
        path === `${root}/outside-link` ? ('/etc/shadow' as never) : (path as never)
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/browse?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(root)}`,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.entries).toEqual([]);
    });

    it('returns 404 for an unknown session scope', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/filesystem/browse?sessionId=missing-session',
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.NOT_FOUND });
    });

    it('rejects direct navigation into a hidden descendant', async () => {
      const hidden = `${harness.ctx._session.workingDir}/.git`;
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/browse?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(hidden)}`,
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.INVALID_INPUT });
    });
  });

  // ========== Multi-user scoping for the filesystem picker ==========
  //
  // The picker is a SECOND file-serving surface and does not inherit the
  // attachment guard's ownership scoping, so both of its endpoints have to do
  // it themselves. Two distinct holes are covered here:
  //   1. `sessionId` was used without an owner check, so any user could pin
  //      another user's workingDir as a browse root.
  //   2. `Home` and `CASES_DIR` were unconditional roots, and per-user spaces
  //      live INSIDE homedir(), so Home alone exposed every other user's files.
  describe('filesystem picker multi-user scoping', () => {
    const SPACES = '/tmp/codeman-test-user-spaces';
    let prevMultiUser: string | undefined;
    let prevSpaces: string | undefined;

    beforeEach(() => {
      prevMultiUser = process.env.CODEMAN_MULTIUSER;
      prevSpaces = process.env.CODEMAN_USER_SPACES_DIR;
      process.env.CODEMAN_MULTIUSER = '1';
      process.env.CODEMAN_USER_SPACES_DIR = SPACES;
    });

    afterEach(() => {
      if (prevMultiUser === undefined) delete process.env.CODEMAN_MULTIUSER;
      else process.env.CODEMAN_MULTIUSER = prevMultiUser;
      if (prevSpaces === undefined) delete process.env.CODEMAN_USER_SPACES_DIR;
      else process.env.CODEMAN_USER_SPACES_DIR = prevSpaces;
    });

    const harnessAs = (role: 'admin' | 'user', username: string) =>
      createRouteTestHarness(registerFileRoutes, { authUser: { username, role } });

    it('404s a browse scoped to another user session instead of adopting its folder', async () => {
      const scoped = await harnessAs('user', 'bob');
      scoped.ctx._session.owner = 'alice';
      try {
        const res = await scoped.app.inject({
          method: 'GET',
          url: `/api/filesystem/browse?sessionId=${scoped.ctx._sessionId}`,
        });

        expect(res.statusCode).toBe(404);
        expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.NOT_FOUND });
        // The decisive part: alice's folder must not have leaked in as a root.
        expect(res.body).not.toContain(scoped.ctx._session.workingDir);
      } finally {
        await scoped.app.close();
      }
    });

    it('404s a preview scoped to another user session', async () => {
      const scoped = await harnessAs('user', 'bob');
      scoped.ctx._session.owner = 'alice';
      try {
        const res = await scoped.app.inject({
          method: 'GET',
          url: `/api/filesystem/preview?sessionId=${scoped.ctx._sessionId}&path=${encodeURIComponent(
            `${scoped.ctx._session.workingDir}/notes.md`
          )}`,
        });

        expect(res.statusCode).toBe(404);
      } finally {
        await scoped.app.close();
      }
    });

    it('confines a regular user to their own space, never Home or the shared cases dir', async () => {
      const scoped = await harnessAs('user', 'bob');
      try {
        mockedReaddir.mockResolvedValueOnce([] as never);
        const res = await scoped.app.inject({ method: 'GET', url: '/api/filesystem/browse' });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.data.roots).toEqual([{ label: 'My Space', path: `${SPACES}/bob` }]);
        expect(body.data.path).toBe(`${SPACES}/bob`);
      } finally {
        await scoped.app.close();
      }
    });

    it("refuses to browse another user's space by absolute path", async () => {
      const scoped = await harnessAs('user', 'bob');
      try {
        const res = await scoped.app.inject({
          method: 'GET',
          url: `/api/filesystem/browse?path=${encodeURIComponent(`${SPACES}/alice/cases`)}`,
        });

        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.INVALID_INPUT });
      } finally {
        await scoped.app.close();
      }
    });

    it('keeps the host-wide roots for a multi-user admin', async () => {
      const scoped = await harnessAs('admin', 'root');
      try {
        mockedReaddir.mockResolvedValueOnce([] as never);
        const res = await scoped.app.inject({ method: 'GET', url: '/api/filesystem/browse' });

        expect(res.statusCode).toBe(200);
        const labels = JSON.parse(res.body).data.roots.map((root: { label: string }) => root.label);
        expect(labels).toContain('Home');
        expect(labels).not.toContain('My Space');
      } finally {
        await scoped.app.close();
      }
    });
  });

  // ========== GET /api/filesystem/preview ==========

  describe('GET /api/filesystem/preview', () => {
    it('serves Markdown as inert plain text inside the active session root', async () => {
      const path = `${harness.ctx._session.workingDir}/notes.md`;
      mockedReadFile.mockImplementation(async (candidate) =>
        candidate === path ? ('# Safe heading\n<script>alert(1)</script>' as never) : ('{}' as never)
      );
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/preview?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(path)}`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.body).toContain('<script>alert(1)</script>');
    });

    it('rejects unsupported file types', async () => {
      const path = `${harness.ctx._session.workingDir}/archive.exe`;
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/preview?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(path)}`,
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.INVALID_INPUT });
    });

    it('rejects hidden files even when requested directly', async () => {
      const path = `${harness.ctx._session.workingDir}/.env`;
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/preview?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(path)}`,
      });

      expect(res.statusCode).toBe(403);
    });

    it('rejects a preview symlink whose real path escapes every allowed root', async () => {
      const path = `${harness.ctx._session.workingDir}/outside.png`;
      mockedRealpathSync.mockImplementation((candidate: string) =>
        candidate === path ? ('/etc/shadow' as never) : (candidate as never)
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/preview?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(path)}`,
      });

      expect(res.statusCode).toBe(403);
    });

    it('caps text previews at 2MB', async () => {
      const path = `${harness.ctx._session.workingDir}/large.txt`;
      mockedStat.mockImplementation(async (candidate) =>
        candidate === path
          ? ({ size: 2 * 1024 * 1024 + 1, isFile: () => true, isDirectory: () => false } as never)
          : ({ size: 100, isFile: () => true, isDirectory: () => true } as never)
      );
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/preview?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(path)}`,
      });

      expect(res.statusCode).toBe(413);
    });
  });

  // ========== GET /api/sessions/:id/files ==========

  describe('GET /api/sessions/:id/files', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/files',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns file tree for valid session', async () => {
      mockedReaddir.mockResolvedValue([
        { name: 'src', isDirectory: () => true },
        { name: 'package.json', isDirectory: () => false, name_: 'package.json' },
      ] as never);
      // Nested readdir for src/ returns empty
      mockedReaddir.mockResolvedValueOnce([
        { name: 'src', isDirectory: () => true },
        { name: 'package.json', isDirectory: () => false },
      ] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.root).toBe(harness.ctx._session.workingDir);
      expect(body.data.tree).toBeDefined();
    });

    it('respects depth parameter', async () => {
      mockedReaddir.mockResolvedValue([] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?depth=2`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('excludes hidden files by default', async () => {
      mockedReaddir.mockResolvedValue([
        { name: '.hidden', isDirectory: () => false },
        { name: 'visible.ts', isDirectory: () => false },
      ] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Hidden files should be excluded
      expect(body.data.totalFiles).toBe(1);
    });

    it('includes hidden files when showHidden=true', async () => {
      mockedReaddir.mockResolvedValue([
        { name: '.hidden', isDirectory: () => false },
        { name: 'visible.ts', isDirectory: () => false },
      ] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?showHidden=true`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.totalFiles).toBe(2);
    });

    it('excludes node_modules and .git directories', async () => {
      let callCount = 0;
      mockedReaddir.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return [
            { name: 'node_modules', isDirectory: () => true },
            { name: '.git', isDirectory: () => true },
            { name: 'src', isDirectory: () => true },
          ] as never;
        }
        return [] as never;
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?showHidden=true`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // node_modules and .git are in excludeDirs set — only src should be counted
      expect(body.data.totalDirectories).toBe(1); // only src
    });
  });

  // ========== GET /api/sessions/:id/file-content ==========

  describe('GET /api/sessions/:id/file-content', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/file-content?path=test.ts',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns error for missing path parameter', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Missing path');
    });

    it('returns text file content', async () => {
      const fileContent = 'const x = 1;\nconst y = 2;\n';
      mockedReadFile.mockResolvedValue(fileContent as never);
      mockedStat.mockResolvedValue({ size: fileContent.length } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=src/test.ts`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.content).toBe(fileContent);
      expect(body.data.extension).toBe('ts');
    });

    it('classifies markdown files as type "markdown" so the file panel renders rich prose (COD-234)', async () => {
      const fileContent = '# Title\n\nBody text';
      mockedReadFile.mockResolvedValue(fileContent as never);
      mockedStat.mockResolvedValue({ size: fileContent.length, mtimeMs: 1 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=notes.md`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.type).toBe('markdown');
    });

    it('classifies non-markdown text files as type "text" (not markdown, not document)', async () => {
      const fileContent = 'const x = 1;\n';
      mockedReadFile.mockResolvedValue(fileContent as never);
      mockedStat.mockResolvedValue({ size: fileContent.length, mtimeMs: 1 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=src/app.js`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.type).toBe('text');
      expect(body.data.content).toBe(fileContent);
    });

    it('includes mtimeMs in text file metadata (freshness signal for live preview)', async () => {
      const fileContent = 'draft v1';
      mockedReadFile.mockResolvedValue(fileContent as never);
      mockedStat.mockResolvedValue({ size: fileContent.length, mtimeMs: 555 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=draft.md`,
      });
      const body = JSON.parse(res.body);
      expect(body.data.mtimeMs).toBe(555);
    });

    it('includes mtimeMs in binary file metadata', async () => {
      mockedStat.mockResolvedValue({ size: 1024, mtimeMs: 777 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=logo.png`,
      });
      const body = JSON.parse(res.body);
      expect(body.data.mtimeMs).toBe(777);
    });

    it('returns binary metadata for image files', async () => {
      mockedStat.mockResolvedValue({ size: 1024 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=logo.png`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.type).toBe('image');
      expect(body.data.url).toContain('file-raw');
    });

    it('returns binary metadata for stored stopped sessions', async () => {
      harness.ctx.sessions.clear();
      harness.ctx.store.getSession.mockReturnValue({
        id: 'stopped-session',
        workingDir: '/tmp/test-workdir',
        status: 'stopped',
        pid: null,
        createdAt: 1,
        lastActivityAt: 2,
        currentTaskId: null,
        attachmentHistory: [],
      });
      mockedStat.mockResolvedValue({ size: 2048 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/stopped-session/file-content?path=out/report.pdf',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.type).toBe('pdf');
      expect(body.data.previewUrl).toBe('/api/sessions/stopped-session/file-raw?path=out%2Freport.pdf');
    });

    it('returns audio metadata for audio files', async () => {
      mockedStat.mockResolvedValue({ size: 2048 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=clip.mp3`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.type).toBe('audio');
      expect(body.data.url).toContain('file-raw');
    });

    it('returns PDF metadata with an inline preview URL', async () => {
      mockedStat.mockResolvedValue({ size: 4096 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=report.pdf`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.type).toBe('pdf');
      expect(body.data.previewUrl).toContain('file-raw');
      expect(body.data.url).toContain('file-raw');
    });

    it('returns DOCX metadata with a converted preview URL', async () => {
      mockedStat.mockResolvedValue({ size: 8192 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=brief.docx`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.type).toBe('document');
      expect(body.data.previewUrl).toContain('file-preview');
      expect(body.data.url).toContain('file-raw');
    });

    it('returns PPTX metadata with a converted preview URL', async () => {
      mockedStat.mockResolvedValue({ size: 16384 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=deck.pptx`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.type).toBe('presentation');
      expect(body.data.previewUrl).toContain('file-preview');
      expect(body.data.url).toContain('file-raw');
    });

    it('classifies XLSX for browser preview without reading its bytes as text', async () => {
      mockedStat.mockResolvedValue({ size: 4096 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=sheet.xlsx`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.type).toBe('spreadsheet');
      expect(body.data.previewUrl).toContain('file-raw?path=sheet.xlsx&preview=true');
      expect(body.data.content).toBeUndefined();
    });

    it('sniffs NUL bytes and flags binary content for unknown extensions', async () => {
      const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]);
      mockedReadFile.mockResolvedValue(binary as never);
      mockedStat.mockResolvedValue({ size: binary.length } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=mystery.dat`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.type).toBe('binary');
      expect(body.data.content).toBeUndefined();
    });

    it('rejects path traversal attempts', async () => {
      // realpathSync resolves the symlink to a path outside workingDir
      mockedRealpathSync.mockImplementation((path) =>
        String(path) === harness.ctx._session.workingDir ? (path as never) : ('/etc/passwd' as never)
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=../../etc/passwd`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects files that are too large', async () => {
      mockedStat.mockResolvedValue({ size: 20 * 1024 * 1024 } as never); // 20MB

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=large-file.txt`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('too large');
    });

    it('truncates content when exceeding line limit', async () => {
      const lines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join('\n');
      mockedReadFile.mockResolvedValue(lines as never);
      mockedStat.mockResolvedValue({ size: lines.length } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=big.txt&lines=100`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.truncated).toBe(true);
      expect(body.data.totalLines).toBe(600);
    });

    it('returns file not found when realpathSync throws', async () => {
      mockedRealpathSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=nonexistent.ts`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });
  });

  // ========== POST /api/sessions/:id/attachments ==========

  describe('POST /api/sessions/:id/attachments', () => {
    it('registers a live external attachment and broadcasts an attachment card event', async () => {
      mockedRealpathSync.mockImplementation((p: string) => p as never);
      mockedStat.mockResolvedValue({ size: 4096, isFile: () => true, mtimeMs: 12345 } as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: '/mnt/c/decks/board-update.pdf' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.attachmentId).toMatch(/^att_/);
      expect(body.data.fileName).toBe('board-update.pdf');
      expect(body.data.filePath).toBe('board-update.pdf');
      expect(body.data.attachmentType).toBe('pdf');
      expect(body.data.previewUrl).toBe(
        `/api/sessions/${harness.ctx._sessionId}/attachments/${body.data.attachmentId}/preview`
      );
      expect(body.data.thumbnailUrl).toBe(
        `/api/sessions/${harness.ctx._sessionId}/attachments/${body.data.attachmentId}/thumbnail`
      );
      expect(JSON.stringify(body.data)).not.toContain('/mnt/c/decks/board-update.pdf');
      expect(harness.ctx._session.upsertAttachmentHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          fileName: 'board-update.pdf',
          extension: 'pdf',
          externalPath: '/mnt/c/decks/board-update.pdf',
          source: 'external',
        })
      );
      expect(harness.ctx.persistSessionState).toHaveBeenCalledWith(harness.ctx._session);
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('attachment:detected', expect.objectContaining(body.data));
    });

    it('lists session attachment history with safe URLs and no external paths', async () => {
      mockedRealpathSync.mockImplementation((p: string) => p as never);
      mockedStat.mockResolvedValue({ size: 4096, isFile: () => true, mtimeMs: 12345 } as never);
      harness.ctx._session.upsertAttachmentHistory({
        id: 'external:/mnt/c/decks/board-update.pdf',
        sessionId: harness.ctx._sessionId,
        fileName: 'board-update.pdf',
        extension: 'pdf',
        attachmentType: 'pdf',
        size: 4096,
        mtimeMs: 12345,
        timestamp: 100,
        source: 'external',
        externalPath: '/mnt/c/decks/board-update.pdf',
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0]).toMatchObject({
        fileName: 'board-update.pdf',
        source: 'external',
        missing: false,
      });
      expect(body.data.items[0].previewUrl).toContain('/attachments/att_');
      expect(body.data.items[0].downloadUrl).toContain('download=true');
      expect(JSON.stringify(body.data)).not.toContain('/mnt/c/decks/board-update.pdf');
      expect(body.data.count).toBe(1);
    });

    it('marks missing external history items without returning action URLs', async () => {
      mockedRealpathSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      harness.ctx._session.upsertAttachmentHistory({
        id: 'external:/mnt/c/decks/missing.pdf',
        sessionId: harness.ctx._sessionId,
        fileName: 'missing.pdf',
        extension: 'pdf',
        attachmentType: 'pdf',
        size: 4096,
        mtimeMs: 12345,
        timestamp: 100,
        source: 'external',
        externalPath: '/mnt/c/decks/missing.pdf',
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.items[0]).toMatchObject({ fileName: 'missing.pdf', missing: true });
      expect(body.data.items[0].previewUrl).toBeUndefined();
      expect(JSON.stringify(body.data)).not.toContain('/mnt/c/decks/missing.pdf');
    });

    it('restores generated provenance privately and rejects a history path swapped outside its boundary', async () => {
      const externalPath = '/tmp/test-workdir/output/mockup.png';
      const boundary = '/tmp/test-workdir';
      const swappedPath = '/srv/public/mockup.png';
      mockedRealpathSync.mockImplementation((path: string) => {
        if (path === externalPath) return swappedPath as never;
        return path as never;
      });
      harness.ctx._session.upsertAttachmentHistory({
        id: 'external:generated:mockup.png',
        sessionId: harness.ctx._sessionId,
        fileName: 'mockup.png',
        extension: 'png',
        attachmentType: 'image',
        size: 100,
        mtimeMs: 1,
        timestamp: 100,
        source: 'external',
        externalPath,
        generatedArtifactBoundary: boundary,
      });

      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.items[0]).toMatchObject({ fileName: 'mockup.png', missing: true });
      expect(JSON.stringify(response.json().data)).not.toContain('generatedArtifactBoundary');
      expect(JSON.stringify(response.json().data)).not.toContain(boundary);
      expect(JSON.stringify(response.json().data)).not.toContain(swappedPath);
    });

    it('lists stopped session workspace attachment history from stored state', async () => {
      harness.ctx.sessions.clear();
      const historyItem = buildDetectedAttachmentHistoryItem({
        sessionId: 'stopped-session',
        filePath: 'report.pdf',
        relativePath: 'out/report.pdf',
        fileName: 'report.pdf',
        extension: 'pdf',
        attachmentType: 'pdf',
        size: 2048,
        timestamp: 100,
      });
      harness.ctx.store.getSession.mockReturnValue({
        id: 'stopped-session',
        workingDir: '/tmp/test-workdir',
        status: 'stopped',
        pid: null,
        createdAt: 1,
        lastActivityAt: 2,
        currentTaskId: null,
        attachmentHistory: [historyItem],
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/stopped-session/attachments',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.items[0]).toMatchObject({
        fileName: 'report.pdf',
        source: 'detected',
        missing: false,
      });
      expect(body.data.items[0].previewUrl).toBe('/api/sessions/stopped-session/file-raw?path=out%2Freport.pdf');
    });

    it('rejects unsupported external attachment types', async () => {
      mockedStat.mockResolvedValue({ size: 1024, isFile: () => true, mtimeMs: 12345 } as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: '/mnt/c/archive.zip' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Unsupported attachment type');
    });

    it('serves registered live external attachments by attachment id', async () => {
      const content = Buffer.from('%PDF-1.7');
      mockedCreateReadStream.mockReturnValue(Readable.from([content]) as never);
      mockedStat.mockResolvedValue({ size: content.length, isFile: () => true, mtimeMs: 12345 } as never);

      const registerRes = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: '/mnt/c/decks/board-update.pdf' },
      });
      const attachmentId = JSON.parse(registerRes.body).data.attachmentId;

      const rawRes = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/${attachmentId}/raw`,
      });

      expect(rawRes.statusCode).toBe(200);
      expect(rawRes.headers['content-type']).toBe('application/pdf');
      expect(mockedCreateReadStream).toHaveBeenCalledWith('/mnt/c/decks/board-update.pdf');
    });

    it.each([
      [
        'docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '/mnt/c/docs/strategy brief.docx',
        'strategy brief.docx',
      ],
      [
        'pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '/mnt/c/decks/board update.pptx',
        'board update.pptx',
      ],
      [
        'xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '/mnt/c/sheets/forecast.xlsx',
        'forecast.xlsx',
      ],
    ])('serves %s raw attachments with an inline filename for Open', async (_extension, mimeType, path, fileName) => {
      const content = Buffer.from('office bytes');
      mockedCreateReadStream.mockReturnValue(Readable.from([content]) as never);
      mockedStat.mockResolvedValue({ size: content.length, isFile: () => true, mtimeMs: 12345 } as never);

      const registerRes = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path },
      });
      const attachmentId = JSON.parse(registerRes.body).data.attachmentId;

      const rawRes = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/${attachmentId}/raw`,
      });

      expect(rawRes.statusCode).toBe(200);
      expect(rawRes.headers['content-type']).toBe(mimeType);
      expect(rawRes.headers['content-disposition']).toBe(
        `inline; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
      );
    });

    it('classifies XLSX attachment metadata for capped browser preview', async () => {
      mockedStat.mockResolvedValue({ size: 4096, isFile: () => true, mtimeMs: 12345 } as never);

      const registerRes = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: '/mnt/c/sheets/forecast.xlsx' },
      });

      expect(registerRes.statusCode).toBe(200);
      const registerBody = JSON.parse(registerRes.body);
      expect(registerBody.data.attachmentType).toBe('spreadsheet');
      expect(registerBody.data.previewUrl).toContain('/raw?preview=true');
      const attachmentId = registerBody.data.attachmentId;

      const metadataRes = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/${attachmentId}`,
      });
      expect(metadataRes.statusCode).toBe(200);
      expect(JSON.parse(metadataRes.body).data.type).toBe('spreadsheet');
      expect(JSON.parse(metadataRes.body).data.previewUrl).toContain('/raw?preview=true');

      const previewRes = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/${attachmentId}/preview`,
      });
      expect(previewRes.statusCode).toBe(302);
      expect(previewRes.headers.location).toContain(`/attachments/${attachmentId}/raw?preview=true`);
    });

    it('serves registered PNG attachment bytes with production compression enabled', async () => {
      const app = Fastify({ logger: false });
      await app.register(fastifyCompress, { threshold: 1024 });
      await app.register(fastifyCookie);
      const ctx = createMockRouteContext();
      registerFileRoutes(app, ctx);
      installRouteErrorHandler(app);
      await app.ready();

      const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(4096, 1)]);
      mockedReadFile.mockResolvedValue(png as never);
      mockedCreateReadStream.mockReturnValue(Readable.from([png]) as never);
      mockedStat.mockResolvedValue({ size: png.length, isFile: () => true, mtimeMs: 12345 } as never);

      try {
        const registerRes = await app.inject({
          method: 'POST',
          url: `/api/sessions/${ctx._sessionId}/attachments`,
          payload: { path: '/mnt/c/images/diagram.png' },
        });
        const attachmentId = JSON.parse(registerRes.body).data.attachmentId;

        const rawRes = await app.inject({
          method: 'GET',
          url: `/api/sessions/${ctx._sessionId}/attachments/${attachmentId}/raw`,
          headers: { 'accept-encoding': 'gzip, deflate, br' },
        });

        expect(rawRes.statusCode).toBe(200);
        expect(rawRes.headers['content-type']).toBe('image/png');
        expect(rawRes.rawPayload).toEqual(png);
      } finally {
        await app.close();
      }
    });

    it.each([
      ['/mnt/c/notes/readme.md', 'readme.md', 'markdown', 'md'],
      ['/mnt/c/notes/run.txt', 'run.txt', 'text', 'txt'],
    ])('registers %s as a previewable text attachment', async (path, fileName, attachmentType, extension) => {
      mockedStat.mockResolvedValue({ size: 512, isFile: () => true, mtimeMs: 12345 } as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.fileName).toBe(fileName);
      expect(body.data.extension).toBe(extension);
      expect(body.data.attachmentType).toBe(attachmentType);
    });

    it.each([
      ['/mnt/c/notes/readme.md', 'readme.md', 'text/markdown'],
      ['/mnt/c/notes/run.txt', 'run.txt', 'text/plain'],
    ])('serves %s raw with a text content type and inline disposition', async (path, fileName, mimeType) => {
      const content = Buffer.from('# hello');
      mockedCreateReadStream.mockReturnValue(Readable.from([content]) as never);
      mockedStat.mockResolvedValue({ size: content.length, isFile: () => true, mtimeMs: 12345 } as never);

      const registerRes = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path },
      });
      const attachmentId = JSON.parse(registerRes.body).data.attachmentId;

      const rawRes = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/${attachmentId}/raw`,
      });

      expect(rawRes.statusCode).toBe(200);
      expect(rawRes.headers['content-type']).toBe(mimeType);
      expect(rawRes.headers['content-disposition']).toBe(
        `inline; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
      );
    });

    it.each([['/mnt/c/notes/readme.md'], ['/mnt/c/notes/run.txt']])(
      'redirects %s preview to the raw text endpoint',
      async (path) => {
        mockedStat.mockResolvedValue({ size: 64, isFile: () => true, mtimeMs: 12345 } as never);

        const registerRes = await harness.app.inject({
          method: 'POST',
          url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
          payload: { path },
        });
        const attachmentId = JSON.parse(registerRes.body).data.attachmentId;

        const previewRes = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/attachments/${attachmentId}/preview`,
        });

        expect(previewRes.statusCode).toBe(302);
        expect(previewRes.headers['location']).toContain(`/attachments/${attachmentId}/raw`);
      }
    );

    it.each([['/mnt/c/notes/readme.md'], ['/mnt/c/notes/run.txt']])(
      'returns a 204 fallback-badge thumbnail for %s',
      async (path) => {
        mockedStat.mockResolvedValue({ size: 64, isFile: () => true, mtimeMs: 12345 } as never);

        const registerRes = await harness.app.inject({
          method: 'POST',
          url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
          payload: { path },
        });
        const attachmentId = JSON.parse(registerRes.body).data.attachmentId;

        const thumbRes = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/attachments/${attachmentId}/thumbnail`,
        });

        expect(thumbRes.statusCode).toBe(204);
      }
    );

    it('returns a fresh mtimeMs/size for a registered attachment (freshness signal for live preview)', async () => {
      mockedStat.mockResolvedValue({ size: 4096, isFile: () => true, mtimeMs: 999 } as never);
      const registerRes = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: '/mnt/c/notes/readme.md' },
      });
      const attachmentId = JSON.parse(registerRes.body).data.attachmentId;

      // The file changes on disk after registration — the metadata endpoint must re-stat.
      mockedStat.mockResolvedValue({ size: 5000, isFile: () => true, mtimeMs: 1234 } as never);
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/${attachmentId}`,
      });

      const body = JSON.parse(res.body);
      expect(body.data.mtimeMs).toBe(1234);
      expect(body.data.size).toBe(5000);
    });

    it('rejects unknown attachment ids instead of accepting arbitrary browser paths', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/att_missing/raw`,
      });

      expect(res.statusCode).toBe(404);
    });

    it('serves PNG thumbnails directly for registered external image attachments', async () => {
      const png = Buffer.from('fake png');
      mockedReadFile.mockResolvedValue(png as never);
      mockedStat.mockResolvedValue({ size: png.length, isFile: () => true, mtimeMs: 12345 } as never);

      const registerRes = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: '/mnt/c/images/diagram.png' },
      });
      const attachmentId = JSON.parse(registerRes.body).data.attachmentId;

      const thumbRes = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments/${attachmentId}/thumbnail`,
      });

      expect(thumbRes.statusCode).toBe(200);
      expect(thumbRes.headers['content-type']).toBe('image/png');
      expect(thumbRes.body).toBe(png.toString());
    });
  });

  // ========== Document revision history (COD-59) ==========

  describe('GET/POST /api/sessions/:id/documents', () => {
    async function registerMdAttachment(path = '/mnt/c/notes/doc.md') {
      const reg = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path },
      });
      return JSON.parse(reg.body).data.attachmentId as string;
    }
    const hitMetadata = (aid: string) =>
      harness.app.inject({ method: 'GET', url: `/api/sessions/${harness.ctx._sessionId}/attachments/${aid}` });

    it('captures versions off the attachment metadata poll and lists them (no content leaked)', async () => {
      mockedStat.mockResolvedValue({ size: 9, isFile: () => true, mtimeMs: 100 } as never);
      mockedReadFile.mockResolvedValue('# draft v1' as never);
      const aid = await registerMdAttachment();
      await hitMetadata(aid); // captures v1

      mockedStat.mockResolvedValue({ size: 20, isFile: () => true, mtimeMs: 200 } as never);
      mockedReadFile.mockResolvedValue('# draft v2 rewritten' as never);
      await hitMetadata(aid); // captures v2

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/documents/versions?attachmentId=${aid}`,
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.versions).toHaveLength(2);
      expect(body.data.versions[0]).not.toHaveProperty('content');
    });

    it('diffs the latest change at word level', async () => {
      mockedStat.mockResolvedValue({ size: 19, isFile: () => true, mtimeMs: 100 } as never);
      mockedReadFile.mockResolvedValue('the quick brown fox' as never);
      const aid = await registerMdAttachment();
      await hitMetadata(aid);

      mockedStat.mockResolvedValue({ size: 17, isFile: () => true, mtimeMs: 200 } as never);
      mockedReadFile.mockResolvedValue('the quick red fox' as never);
      await hitMetadata(aid);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/documents/diff?attachmentId=${aid}`,
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(
        body.data.ops.some((o: { type: string; value: string }) => o.type === 'delete' && o.value.includes('brown'))
      ).toBe(true);
      expect(
        body.data.ops.some((o: { type: string; value: string }) => o.type === 'insert' && o.value.includes('red'))
      ).toBe(true);
    });

    it('returns 404 diff when no versions have been recorded', async () => {
      mockedStat.mockResolvedValue({ size: 9, isFile: () => true, mtimeMs: 100 } as never);
      // .pdf is not a text doc — capture is skipped, so no versions exist
      const reg = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: '/mnt/c/notes/slides.pdf' },
      });
      const aid = JSON.parse(reg.body).data.attachmentId;
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/documents/diff?attachmentId=${aid}`,
      });
      expect(res.statusCode).toBe(404);
    });

    it('rolls a document back to a prior version, writing the file', async () => {
      mockedStat.mockResolvedValue({ size: 4, isFile: () => true, mtimeMs: 100 } as never);
      mockedReadFile.mockResolvedValue('orig' as never);
      const aid = await registerMdAttachment();
      await hitMetadata(aid); // v1 = 'orig'

      mockedStat.mockResolvedValue({ size: 7, isFile: () => true, mtimeMs: 200 } as never);
      mockedReadFile.mockResolvedValue('changed' as never);
      await hitMetadata(aid); // v2 = 'changed'

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/documents/rollback`,
        payload: { attachmentId: aid, versionId: 'v1' },
      });
      expect(res.statusCode).toBe(200);
      expect(mockedWriteFile).toHaveBeenCalledWith('/mnt/c/notes/doc.md', 'orig', 'utf-8');
    });

    it('versions a .docx via raw bytes + pandoc text, diffs the prose, and rolls back losslessly (COD-66)', async () => {
      const pandocStdout = (text: string) =>
        mockedExecFile.mockImplementation((cmd, _args, _opts, cb) => {
          (cb as (e: unknown, r: unknown) => void)(null, {
            stdout: String(cmd).includes('pandoc') ? text : '',
            stderr: '',
          });
          return {} as never;
        });

      // v1: bytes + extracted prose
      mockedStat.mockResolvedValue({ size: 100, isFile: () => true, mtimeMs: 100 } as never);
      mockedReadFile.mockResolvedValue(Buffer.from('DOCXBYTES-1') as never);
      pandocStdout('# Brief\n\nThe plan is good.');
      const reg = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: '/mnt/c/docs/brief.docx' },
      });
      const aid = JSON.parse(reg.body).data.attachmentId;
      await hitMetadata(aid); // capture v1

      // v2: new bytes + revised prose
      mockedStat.mockResolvedValue({ size: 130, isFile: () => true, mtimeMs: 200 } as never);
      mockedReadFile.mockResolvedValue(Buffer.from('DOCXBYTES-2-longer') as never);
      pandocStdout('# Brief\n\nThe plan is excellent and ready.');
      await hitMetadata(aid); // capture v2

      const vres = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/documents/versions?attachmentId=${aid}`,
      });
      expect(JSON.parse(vres.body).data.versions).toHaveLength(2);

      // Prose diff comes from the pandoc-extracted text, not the bytes.
      const dres = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/documents/diff?attachmentId=${aid}`,
      });
      const ops = JSON.parse(dres.body).data.ops as { type: string; value: string }[];
      expect(ops.some((o) => o.type === 'delete' && o.value.includes('good'))).toBe(true);
      expect(ops.some((o) => o.type === 'insert' && o.value.includes('excellent'))).toBe(true);

      // Rollback writes the RAW bytes of v1 (byte-perfect), not text.
      const rb = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/documents/rollback`,
        payload: { attachmentId: aid, versionId: 'v1' },
      });
      expect(rb.statusCode).toBe(200);
      expect(mockedWriteFile).toHaveBeenCalledWith('/mnt/c/docs/brief.docx', Buffer.from('DOCXBYTES-1'));
    });

    it('renders a .docx as HTML via pandoc, and rejects HTML view for non-docx (COD-68)', async () => {
      mockedStat.mockResolvedValue({ size: 100, isFile: () => true, mtimeMs: 100 } as never);
      mockedExecFile.mockImplementation((cmd, _args, _opts, cb) => {
        (cb as (e: unknown, r: unknown) => void)(null, {
          stdout: String(cmd).includes('pandoc') ? '<h1>Brief</h1><p>Body text.</p>' : '',
          stderr: '',
        });
        return {} as never;
      });
      const reg = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path: '/mnt/c/docs/brief.docx' },
      });
      const aid = JSON.parse(reg.body).data.attachmentId;
      const ok = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/documents/html?attachmentId=${aid}`,
      });
      expect(ok.statusCode).toBe(200);
      expect(JSON.parse(ok.body).data.html).toContain('<h1>Brief</h1>');

      const mdAid = await registerMdAttachment('/mnt/c/notes/note.md');
      const bad = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/documents/html?attachmentId=${mdAid}`,
      });
      expect(bad.statusCode).toBe(400);
    });

    it('writes collected annotations to a workspace review file, and rejects empty reviews (COD-69)', async () => {
      mockedStat.mockResolvedValue({ size: 5, isFile: () => true, mtimeMs: 1 } as never);
      const aid = await registerMdAttachment('/mnt/c/notes/doc.md');

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/documents/review`,
        payload: { attachmentId: aid, annotations: [{ passage: 'the intro paragraph', note: 'tighten it' }] },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.path).toContain('codeman-review-');
      const reviewCall = mockedWriteFile.mock.calls.find((c) => String(c[0]).includes('codeman-review-'));
      expect(reviewCall).toBeDefined();
      expect(String(reviewCall?.[1])).toContain('tighten it');

      const empty = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/documents/review`,
        payload: { attachmentId: aid, annotations: [] },
      });
      expect(empty.statusCode).toBe(400);
    });

    it('returns 400 when neither attachmentId nor path is provided', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/documents/versions`,
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ========== GET /api/sessions/:id/documents/export (COD-61) ==========

  describe('GET /api/sessions/:id/documents/export', () => {
    it('rejects an unsupported export format with 400', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/documents/export?path=notes.md&format=docx`,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain('PDF');
    });

    it('rejects PDF export for an unsupported document type with 400', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/documents/export?path=image.png&format=pdf`,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain('not supported for this file type');
    });

    it('403s a sensitive path (resolved via realpath) before converting', async () => {
      mockedRealpathSync.mockReturnValue('/tmp/test-workdir/.env' as never);
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/documents/export?path=.env&format=pdf`,
      });
      // .env is sensitive, but it's also not a supported export type — the
      // sensitive guard runs first, so we expect 403 not 400.
      expect(res.statusCode).toBe(403);
    });

    it('exports a docx by reusing the LibreOffice preview-PDF cache as an attachment download', async () => {
      const pdf = Buffer.from('%PDF docx export');
      mockedStat.mockImplementation(async (path) => {
        const pathText = String(path);
        if (pathText.includes('codeman-document-preview-cache') && pathText.endsWith('.pdf')) {
          throw new Error('ENOENT');
        }
        return { size: 8192, mtimeMs: 12345, isFile: () => true } as never;
      });
      mockedReaddir.mockResolvedValue(['brief.pdf'] as never);
      mockedReadFile.mockResolvedValue(pdf as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/documents/export?path=brief.docx&format=pdf`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe('attachment; filename="brief.pdf"');
      expect(res.body).toBe(pdf.toString());
    });

    it('exports markdown by rendering HTML then converting HTML→PDF via soffice', async () => {
      const pdf = Buffer.from('%PDF md export');
      // First readFile = the markdown source; reads of the produced PDF return bytes.
      mockedReadFile.mockResolvedValue(pdf as never);
      mockedReaddir.mockResolvedValue(['document.pdf'] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/documents/export?path=draft.md&format=pdf`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe('attachment; filename="draft.pdf"');
      // The HTML→PDF conversion goes through the shared soffice invocation.
      expect(mockedExecFile).toHaveBeenCalledWith(
        'soffice',
        expect.arrayContaining(['--convert-to', 'pdf']),
        expect.any(Object),
        expect.any(Function)
      );
    });
  });

  // ========== GET /api/sessions/:id/file-raw ==========

  describe('GET /api/sessions/:id/file-raw', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/file-raw?path=test.png',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for missing path parameter', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('serves raw file with correct content type', async () => {
      const content = Buffer.from('fake png data');
      mockedCreateReadStream.mockReturnValue(Readable.from([content]) as never);
      mockedStat.mockResolvedValue({ size: content.length } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=image.png`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
    });

    it.each([
      [
        'docx',
        'deliverables/Market Story Final.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
      [
        'pptx',
        'deliverables/Executive Brief Final.pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ],
    ])(
      'downloads the exact workspace %s source with its original spaced name and official media type',
      async (_extension, filePath, mediaType) => {
        const content = Buffer.from('PK\u0003\u0004 exact original office bytes');
        mockedCreateReadStream.mockReturnValue(Readable.from([content]) as never);
        mockedStat.mockResolvedValue({ size: content.length } as never);

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=${encodeURIComponent(filePath)}&download=true`,
        });

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe(mediaType);
        const downloadName = filePath.split('/').at(-1) as string;
        expect(res.headers['content-disposition']).toBe(
          `attachment; filename="${downloadName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
        );
        expect(res.rawPayload).toEqual(content);
        expect(mockedCreateReadStream).toHaveBeenCalledWith(`${harness.ctx._session.workingDir}/${filePath}`);
      }
    );

    it('serves workspace SVG as an untrusted attachment instead of inline image/svg+xml', async () => {
      const content = Buffer.from('<svg><script>alert("xss")</script></svg>');
      mockedCreateReadStream.mockReturnValue(Readable.from([content]) as never);
      mockedStat.mockResolvedValue({ size: content.length } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=malicious.svg`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-disposition']).toContain('attachment; filename="malicious.svg"');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('rejects path traversal in raw file serving', async () => {
      mockedRealpathSync.mockImplementation((path) =>
        String(path) === harness.ctx._session.workingDir ? (path as never) : ('/etc/shadow' as never)
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=../../etc/shadow`,
      });
      // Path traversal returns 404 ("File not found") to avoid revealing the target exists.
      expect(res.statusCode).toBe(404);
    });

    it('streams large raw files without an app-level size cap', async () => {
      const content = Buffer.from('large file chunk');
      mockedStat.mockResolvedValue({ size: 100 * 1024 * 1024 } as never); // 100MB
      mockedCreateReadStream.mockReturnValue(Readable.from([content]) as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=huge.bin`,
      });
      expect(res.statusCode).toBe(200);
      expect(mockedCreateReadStream).toHaveBeenCalledWith('/tmp/test-workdir/huge.bin');
    });

    it('rejects an oversized XLSX browser preview before opening a stream', async () => {
      mockedStat.mockResolvedValue({ size: 10 * 1024 * 1024 + 1 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=forecast.xlsx&preview=true`,
      });

      expect(res.statusCode).toBe(413);
      expect(res.body).toContain('10MB limit');
      expect(mockedCreateReadStream).not.toHaveBeenCalled();
    });
  });

  // ========== GET /api/sessions/:id/file-preview ==========

  describe('GET /api/sessions/:id/file-preview', () => {
    it('converts large office documents without an app-level source-size cap', async () => {
      const pdf = Buffer.from('%PDF converted');
      mockedStat.mockImplementation(async (path) => {
        const pathText = String(path);
        if (pathText.includes('codeman-document-preview-cache') && pathText.endsWith('.pdf')) {
          throw new Error('ENOENT');
        }

        return { size: 150 * 1024 * 1024, mtimeMs: 12345, isFile: () => true } as never;
      });
      mockedReaddir.mockResolvedValue(['large-deck.pdf'] as never);
      mockedReadFile.mockResolvedValue(pdf as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-preview?path=large-deck.pptx`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.body).toBe(pdf.toString());
      expect(mockedExecFile).toHaveBeenCalledWith(
        'soffice',
        expect.arrayContaining(['--convert-to', 'pdf']),
        expect.any(Object),
        expect.any(Function)
      );
    });
  });

  // ========== DELETE /api/sessions/:id/tail-file/:streamId ==========

  describe('DELETE /api/sessions/:id/tail-file/:streamId', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/sessions/nonexistent/tail-file/stream-1',
      });
      expect(res.statusCode).toBe(404);
    });

    it('closes an existing stream', async () => {
      mockedFileStreamManager.closeStream.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/tail-file/stream-1`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.closed).toBe(true);
      expect(mockedFileStreamManager.closeStream).toHaveBeenCalledWith('stream-1');
    });

    it('returns closed: false for unknown stream', async () => {
      mockedFileStreamManager.closeStream.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/tail-file/nonexistent`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.closed).toBe(false);
    });
  });

  // ========== GET /api/download ==========

  describe('GET /api/download', () => {
    it('requires a sessionId to scope downloads', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/download?path=${encodeURIComponent('/tmp/test-workdir/report.txt')}`,
      });

      expect(res.statusCode).toBe(400);
    });

    it('downloads files scoped to the session working directory', async () => {
      const content = Buffer.from('download content');
      mockedReadFile.mockResolvedValue(content as never);
      mockedStat.mockResolvedValue({ size: content.length, isFile: () => true } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/download?sessionId=${harness.ctx._sessionId}&path=report.txt`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toContain('filename="report.txt"');
      expect(mockedCreateReadStream).toHaveBeenCalledWith('/tmp/test-workdir/report.txt');
    });

    it('rejects absolute paths outside the session working directory', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/download?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent('/var/log/app.log')}`,
      });

      expect(res.statusCode).toBe(404);
    });

    it('rejects symlink targets that escape the session working directory', async () => {
      mockedRealpathSync.mockImplementation((path) =>
        String(path) === harness.ctx._session.workingDir ? (path as never) : ('/tmp/outside-workdir/link.log' as never)
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/download?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(
          '/tmp/test-workdir/link.log'
        )}`,
      });

      expect(res.statusCode).toBe(404);
    });

    it('blocks sensitive files even when they are inside the session working directory', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/download?sessionId=${harness.ctx._sessionId}&path=.env`,
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
