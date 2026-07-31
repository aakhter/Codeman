/** Route coverage for remote File Viewer SFTP reads (COD-252). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import type { SessionRemote } from '../../src/types/session.js';

const { listRemoteWorkspaceDirectory, readRemoteWorkspaceFile, downloadRemoteWorkspaceFile, remoteWorkspacePath } =
  vi.hoisted(() => ({
    listRemoteWorkspaceDirectory: vi.fn(),
    readRemoteWorkspaceFile: vi.fn(),
    downloadRemoteWorkspaceFile: vi.fn(),
    remoteWorkspacePath: vi.fn((remote: SessionRemote, relativePath = '') => {
      if (relativePath.startsWith('/') || relativePath.split('/').includes('..')) throw new Error('workspace-relative');
      return relativePath ? `${remote.remotePath}/${relativePath}` : remote.remotePath;
    }),
  }));

vi.mock('../../src/remote-sftp.js', () => ({
  listRemoteWorkspaceDirectory,
  readRemoteWorkspaceFile,
  downloadRemoteWorkspaceFile,
  remoteWorkspacePath,
}));

const REMOTE: SessionRemote = {
  hostId: 'host-1',
  label: 'Remote host',
  host: 'remote.example',
  username: 'ann',
  remotePath: '/srv/project',
};

describe('remote File Viewer SFTP routes (COD-252)', () => {
  let harness: RouteTestHarness;
  let stagingDir: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    harness = await createRouteTestHarness(registerFileRoutes);
    harness.ctx._session.remote = REMOTE;
    stagingDir = await fs.mkdtemp(join(tmpdir(), 'codeman-remote-file-route-'));
  });

  afterEach(async () => {
    await harness.app.close();
    await fs.rm(stagingDir, { recursive: true, force: true });
  });

  it('lists only the requested remote directory lazily', async () => {
    listRemoteWorkspaceDirectory.mockResolvedValue([
      { name: 'lib', path: 'src/lib', type: 'directory' },
      { name: 'index.ts', path: 'src/index.ts', type: 'file', size: 42 },
    ]);

    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files?path=src`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      root: '/srv/project',
      tree: [
        { name: 'lib', path: 'src/lib', type: 'directory', children: [] },
        { name: 'index.ts', path: 'src/index.ts', type: 'file', size: 42, extension: 'ts' },
      ],
      totalFiles: 1,
      totalDirectories: 1,
      truncated: false,
      mode: 'tree',
      lazy: true,
    });
    expect(listRemoteWorkspaceDirectory).toHaveBeenCalledWith(REMOTE, 'src');
  });

  it('returns an empty remote directory and reports SFTP failures without local reads', async () => {
    listRemoteWorkspaceDirectory.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('Permission denied'));

    const empty = await harness.app.inject({ method: 'GET', url: `/api/sessions/${harness.ctx._sessionId}/files` });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().data.tree).toEqual([]);

    const failed = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files?path=private`,
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).toContain('Permission denied');
  });

  it('rejects unsafe remote paths before invoking SFTP', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files?path=../secret`,
    });

    expect(res.statusCode).toBe(400);
    expect(listRemoteWorkspaceDirectory).not.toHaveBeenCalled();
  });

  it('uses bounded remote content reads and preserves text and binary responses', async () => {
    readRemoteWorkspaceFile
      .mockResolvedValueOnce(Buffer.from('one\ntwo\nthree\n'))
      .mockResolvedValueOnce(Buffer.from([1, 0, 2]));

    const text = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=notes.txt&lines=2`,
    });
    expect(text.statusCode).toBe(200);
    expect(text.json().data).toMatchObject({
      content: 'one\ntwo',
      size: 14,
      totalLines: 4,
      truncated: true,
      type: 'text',
    });

    const binary = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=unknown.data`,
    });
    expect(binary.statusCode).toBe(200);
    expect(binary.json().data).toMatchObject({ type: 'binary', size: 3, url: expect.stringContaining('file-raw') });
    expect(readRemoteWorkspaceFile).toHaveBeenNthCalledWith(1, REMOTE, 'notes.txt', 10 * 1024 * 1024);
  });

  it('streams a staged remote download and removes it after the response closes', async () => {
    const stagedPath = join(stagingDir, 'download');
    await fs.writeFile(stagedPath, 'remote bytes');
    const cleanup = vi.fn(async () => undefined);
    downloadRemoteWorkspaceFile.mockResolvedValue({ path: stagedPath, cleanup });

    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=report.txt&download=true`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('remote bytes');
    expect(res.headers['content-disposition']).toBe('attachment; filename="report.txt"');
    expect(downloadRemoteWorkspaceFile).toHaveBeenCalledWith(REMOTE, 'report.txt');
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
  });
});
