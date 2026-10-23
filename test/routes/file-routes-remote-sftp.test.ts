/**
 * Route coverage for remote File Viewer access (COD-252).
 *
 * Directory LISTING stays on SFTP (`remote-sftp.ts`). File READS moved to the #415
 * path in `remote-files.ts` (COD-453): the realpath, workspace boundary and stat run on
 * the remote host, the size caps apply to the REMOTE size before a byte is read, and
 * bodies stream over ssh instead of being staged on this host. The read tests below
 * pin the COD-252/COD-280 behaviour (bounded reads, Office on the raw path, capped
 * XLSX previews) on that path; the #415 security cases live in file-routes-remote.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import type { SessionRemote } from '../../src/types/session.js';

const { listRemoteWorkspaceDirectory, remoteWorkspacePath, remoteProbePaths, remoteReadFile, remoteCreateReadStream } =
  vi.hoisted(() => ({
    listRemoteWorkspaceDirectory: vi.fn(),
    remoteWorkspacePath: vi.fn((remote: SessionRemote, relativePath = '') => {
      if (relativePath.startsWith('/') || relativePath.split('/').includes('..')) throw new Error('workspace-relative');
      return relativePath ? `${remote.remotePath}/${relativePath}` : remote.remotePath;
    }),
    remoteProbePaths: vi.fn(),
    remoteReadFile: vi.fn(),
    remoteCreateReadStream: vi.fn(),
  }));

vi.mock('../../src/remote-sftp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/remote-sftp.js')>()),
  listRemoteWorkspaceDirectory,
  remoteWorkspacePath,
}));

// Keep the pure builders + the error class real; replace only the IO.
vi.mock('../../src/remote-files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/remote-files.js')>()),
  remoteProbePaths,
  remoteReadFile,
  remoteCreateReadStream,
}));

const REMOTE: SessionRemote = {
  hostId: 'host-1',
  label: 'Remote host',
  host: 'remote.example',
  username: 'ann',
  remotePath: '/srv/project',
};

/** A remote probe pair for `relativePath`: the file, then the (canonical) workspace root. */
function probeFile(relativePath: string, size: number) {
  remoteProbePaths.mockResolvedValue([
    { realPath: `${REMOTE.remotePath}/${relativePath}`, kind: 'file', size, mtimeMs: 1 },
    { realPath: REMOTE.remotePath, kind: 'directory', size: 0, mtimeMs: 0 },
  ]);
}

/** Answer `remoteCreateReadStream` with `body`, and hand back the ssh reaper spy. */
function streamBody(body: string) {
  const close = vi.fn();
  remoteCreateReadStream.mockImplementation(() => ({ stream: Readable.from([Buffer.from(body)]), close }));
  return close;
}

describe('remote File Viewer SFTP routes (COD-252)', () => {
  let harness: RouteTestHarness;
  let stagingDir: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    harness = await createRouteTestHarness(registerFileRoutes);
    harness.ctx._session.remote = REMOTE;
    // A remote session's workingDir IS its remote path (Session.workingDir = RemoteCase.remotePath).
    harness.ctx._session.workingDir = REMOTE.remotePath;
    stagingDir = await fs.mkdtemp(join(tmpdir(), 'codeman-remote-file-route-'));
    remoteProbePaths.mockImplementation(async (_remote: SessionRemote, paths: string[]) =>
      paths.length === 1
        ? [{ realPath: REMOTE.remotePath, kind: 'directory', size: 0, mtimeMs: 1 }]
        : [
            { realPath: paths[0], kind: 'file', size: 1024, mtimeMs: 1 },
            { realPath: REMOTE.remotePath, kind: 'directory', size: 0, mtimeMs: 1 },
          ]
    );
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

  it('refuses a remote symlink that resolves outside the workspace before opening a stream', async () => {
    remoteProbePaths.mockResolvedValue([
      { realPath: '/etc/passwd', kind: 'file', size: 10, mtimeMs: 1 },
      { realPath: '/srv/project', kind: 'directory', size: 0, mtimeMs: 1 },
    ]);

    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=inside.txt`,
    });

    expect(res.statusCode).toBe(404);
    expect(remoteProbePaths).toHaveBeenCalledOnce();
    expect(remoteCreateReadStream).not.toHaveBeenCalled();
  });

  it('rejects remote server-side search rather than omitting nested matches', async () => {
    const readdir = vi.spyOn(fs, 'readdir');

    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files?q=match`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('limited to folders already loaded');
    expect(listRemoteWorkspaceDirectory).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
    readdir.mockRestore();
  });

  it('uses bounded remote content reads and preserves text and binary responses', async () => {
    probeFile('notes.txt', 14);
    remoteReadFile.mockResolvedValueOnce(Buffer.from('one\ntwo\nthree\n'));

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

    probeFile('unknown.data', 3);
    remoteReadFile.mockResolvedValueOnce(Buffer.from([1, 0, 2]));
    const binary = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=unknown.data`,
    });
    expect(binary.statusCode).toBe(200);
    expect(binary.json().data).toMatchObject({ type: 'binary', size: 3, url: expect.stringContaining('file-raw') });
    // Bounded, and against the path the REMOTE host resolved, never a local one.
    expect(remoteReadFile).toHaveBeenNthCalledWith(1, REMOTE, '/srv/project/notes.txt', 10 * 1024 * 1024);
  });

  it('returns known remote binary metadata from the probe without reading a >10MB body', async () => {
    probeFile('archive.zip', 11 * 1024 * 1024);

    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=archive.zip`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ type: 'binary', size: 11 * 1024 * 1024, extension: 'zip' });
    expect(remoteProbePaths).toHaveBeenCalledWith(REMOTE, ['/srv/project/archive.zip', '/srv/project']);
    expect(remoteReadFile).not.toHaveBeenCalled();
  });

  it('keeps remote Office files on the raw-download path', async () => {
    probeFile('proposal.docx', 1024);

    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=proposal.docx`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      type: 'binary',
      url: expect.stringContaining('file-raw'),
      previewUrl: expect.stringContaining('file-raw'),
    });
    expect(res.json().data.thumbnailUrl).toBeUndefined();
    expect(res.body).not.toContain('file-preview');
    expect(res.body).not.toContain('file-thumbnail');
  });

  it('classifies remote XLSX metadata for capped browser preview', async () => {
    probeFile('forecast.xlsx', 1024);

    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=forecast.xlsx`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      type: 'spreadsheet',
      previewUrl: expect.stringContaining('file-raw?path=forecast.xlsx&preview=true'),
    });
  });

  it('rejects an oversized remote XLSX preview before opening a stream', async () => {
    probeFile('forecast.xlsx', 10 * 1024 * 1024 + 1);

    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=forecast.xlsx&preview=true`,
    });

    expect(res.statusCode).toBe(413);
    expect(res.body).toContain('10MB limit');
    expect(remoteCreateReadStream).not.toHaveBeenCalled();
  });

  it('does not apply the XLSX preview cap to an explicit remote download', async () => {
    probeFile('forecast.xlsx', 10 * 1024 * 1024 + 1);
    const close = streamBody('remote xlsx bytes');

    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=forecast.xlsx&download=true`,
    });

    expect(res.statusCode).toBe(200);
    expect(remoteCreateReadStream).toHaveBeenCalledWith(REMOTE, '/srv/project/forecast.xlsx', undefined);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it('streams a remote download over ssh, stages nothing locally, and reaps the stream', async () => {
    probeFile('report.txt', 12);
    const close = streamBody('remote bytes');
    const writeFile = vi.spyOn(fs, 'writeFile');

    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=report.txt&download=true`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('remote bytes');
    expect(res.headers['content-disposition']).toBe('attachment; filename="report.txt"; filename*=UTF-8\'\'report.txt');
    expect(remoteCreateReadStream).toHaveBeenCalledWith(REMOTE, '/srv/project/report.txt', undefined);
    expect(writeFile).not.toHaveBeenCalled();
    writeFile.mockRestore();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
});
