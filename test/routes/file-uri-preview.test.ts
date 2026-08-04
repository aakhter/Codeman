/** Route coverage for secure Codex file-URI preview resolution (COD-273). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, execFile };
});

import { attachmentRegistry } from '../../src/attachment-registry.js';
import { buildRemoteGeneratedArtifactCachePath } from '../../src/generated-artifact-attachments.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { SseEvent } from '../../src/web/sse-events.js';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import type { SessionRemote } from '../../src/types/session.js';

const MAX_GENERATED_ARTIFACT_BYTES = 50 * 1024 * 1024;

function mockRemoteSsh(options: {
  filePath: string;
  size: number;
  workspace?: string;
  homes?: string[];
  fetchBytes?: Buffer;
}): void {
  execFile.mockImplementation((...args: unknown[]) => {
    const execOptions = args.at(-2) as { encoding?: string };
    const callback = args.at(-1);
    if (typeof callback !== 'function') return {};
    if (execOptions.encoding === 'utf8') {
      const lines = [
        `FILE\t${options.filePath}`,
        `SIZE\t${options.size}`,
        ...(options.workspace ? [`WORKSPACE\t${options.workspace}`] : []),
        ...(options.homes ?? []).map((home) => `HOME\t${home}`),
      ];
      callback(null, { stdout: `${lines.join('\n')}\n`, stderr: '' });
    } else {
      callback(null, { stdout: options.fetchBytes ?? Buffer.from('remote-image-bytes'), stderr: Buffer.alloc(0) });
    }
    return {};
  });
}

describe('POST /api/sessions/:id/file-uri-preview', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let testRoot: string;
  let workspaceDir: string;
  let outsideDir: string;
  let previousDataDir: string | undefined;
  let previousMultiUser: string | undefined;
  let requestUser: { username: string; role: 'admin' | 'user' } | undefined;
  let logLines: string[];

  beforeEach(async () => {
    vi.clearAllMocks();
    execFile.mockReset();
    execFile.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === 'function') callback(new Error('unexpected SSH invocation'));
      return {};
    });
    requestUser = undefined;
    testRoot = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-file-uri-preview-')));
    workspaceDir = join(testRoot, 'workspace');
    outsideDir = join(testRoot, 'outside');
    await Promise.all([fs.mkdir(workspaceDir), fs.mkdir(outsideDir)]);
    previousDataDir = process.env.CODEMAN_DATA_DIR;
    process.env.CODEMAN_DATA_DIR = join(testRoot, 'data');
    previousMultiUser = process.env.CODEMAN_MULTIUSER;
    delete process.env.CODEMAN_MULTIUSER;

    logLines = [];
    app = Fastify({
      logger: {
        level: 'warn',
        stream: { write: (line: string) => logLines.push(line) },
      },
    });
    app.addHook('onRequest', async (req) => {
      if (requestUser) (req as unknown as { authUser: typeof requestUser }).authUser = requestUser;
    });
    ctx = createMockRouteContext();
    ctx._session.mode = 'codex';
    ctx._session.workingDir = workspaceDir;
    registerFileRoutes(app, ctx);
    installRouteErrorHandler(app);
    await app.ready();
  });

  afterEach(async () => {
    attachmentRegistry.clearSession(ctx._sessionId);
    await app.close();
    if (previousDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
    else process.env.CODEMAN_DATA_DIR = previousDataDir;
    if (previousMultiUser === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = previousMultiUser;
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  async function postUri(uri?: string) {
    return app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/file-uri-preview`,
      payload: uri === undefined ? {} : { uri },
    });
  }

  it('resolves a percent-encoded local artifact to sanitized opaque attachment metadata', async () => {
    const filePath = join(workspaceDir, 'mockup one.png');
    await fs.writeFile(filePath, 'image-bytes');
    const uri = pathToFileURL(filePath).href;
    expect(uri).toContain('mockup%20one.png');

    const response = await postUri(uri);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      success: true,
      data: {
        fileName: 'mockup one.png',
        filePath: 'mockup one.png',
        attachmentId: expect.stringMatching(/^att_/),
      },
    });
    expect(JSON.stringify(body.data)).not.toContain(filePath);
    expect(JSON.stringify(body.data)).not.toContain(workspaceDir);
    expect(ctx._session.upsertAttachmentHistory).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'mockup one.png', externalPath: filePath })
    );
    expect(ctx.persistSessionState).toHaveBeenCalledWith(ctx._session);
    expect(ctx.broadcast).toHaveBeenCalledWith(SseEvent.AttachmentDetected, body.data);
  });

  it('rejects a missing URI', async () => {
    const response = await postUri();

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ success: false, error: 'Missing file URI' });
  });

  it('rejects non-file URI schemes', async () => {
    const response = await postUri('https://example.com/mockup.png');

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ success: false, error: 'Invalid file URI' });
  });

  it.each(['file:tmp/mockup.png', 'file:/tmp/mockup.png'])('rejects non-authority file URI form %s', async (uri) => {
    const response = await postUri(uri);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ success: false, error: 'Invalid file URI' });
  });

  it.each(['remote.example', 'localhost'])('rejects file URI network authority %s', async (host) => {
    const response = await postUri(`file://${host}/tmp/mockup.png`);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ success: false, error: 'Invalid file URI' });
  });

  it('rejects unsupported attachment extensions', async () => {
    const response = await postUri(pathToFileURL(join(workspaceDir, 'mockup.svg')).href);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ success: false, error: 'Unsupported file URI' });
  });

  it('rejects non-Codex sessions', async () => {
    ctx._session.mode = 'claude';

    const response = await postUri(pathToFileURL(join(workspaceDir, 'mockup.png')).href);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      success: false,
      error: 'File URI preview is only available for Codex sessions',
    });
  });

  it('returns a safe not-found response for a missing file', async () => {
    const filePath = join(workspaceDir, 'missing.png');

    const response = await postUri(pathToFileURL(filePath).href);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ success: false, error: 'Attachment file not found' });
    expect(response.body).not.toContain(filePath);
  });

  it('rejects local paths outside the generated-artifact boundary', async () => {
    const filePath = join(outsideDir, 'private.png');
    await fs.writeFile(filePath, 'private-image-bytes');

    const response = await postUri(pathToFileURL(filePath).href);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ success: false, error: 'Access to this file is blocked' });
    expect(response.body).not.toContain(filePath);
  });

  it('returns not found without registration side effects for a wrong-owner request', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    requestUser = { username: 'bob', role: 'user' };
    (ctx._session as unknown as { owner?: string }).owner = 'alice';
    const filePath = join(workspaceDir, 'owned.png');
    await fs.writeFile(filePath, 'image-bytes');

    const response = await postUri(pathToFileURL(filePath).href);

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(filePath);
    expect(ctx._session.upsertAttachmentHistory).not.toHaveBeenCalled();
    expect(ctx.persistSessionState).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalled();
    expect(attachmentRegistry.findByFilePath(ctx._sessionId, filePath)).toBeUndefined();
  });

  it('rejects an oversized local artifact before registry, history, or broadcast side effects', async () => {
    const filePath = join(workspaceDir, 'oversize.png');
    await fs.writeFile(filePath, '');
    await fs.truncate(filePath, MAX_GENERATED_ARTIFACT_BYTES + 1);

    const response = await postUri(pathToFileURL(filePath).href);

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ success: false, error: 'Attachment file is too large' });
    expect(response.body).not.toContain(filePath);
    expect(ctx._session.upsertAttachmentHistory).not.toHaveBeenCalled();
    expect(ctx.persistSessionState).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalled();
    expect(attachmentRegistry.findByFilePath(ctx._sessionId, filePath)).toBeUndefined();
  });

  it('rejects a lexical remote outside-root path with a safe 403 before SSH', async () => {
    const remote: SessionRemote = {
      hostId: 'mac-mini',
      label: 'Mac mini',
      host: 'remote.example',
      username: 'ann',
      remotePath: '/Users/ann/project',
    };
    const remotePath = '/Users/ann/private/mockup.png';
    ctx._session.remote = remote;

    const response = await postUri(pathToFileURL(remotePath).href);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ success: false, error: 'Access to this file is blocked' });
    expect(response.body).not.toContain(remotePath);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('rejects a remote canonical symlink escape without fetching bytes or disclosing paths', async () => {
    const remote: SessionRemote = {
      hostId: 'mac-mini',
      label: 'Mac mini',
      host: 'remote.example',
      username: 'ann',
      remotePath: '/Users/ann/project',
    };
    const remotePath = '/Users/ann/project/output/mockup.png';
    const escapedPath = '/Users/ann/private/mockup.png';
    ctx._session.remote = remote;
    mockRemoteSsh({ filePath: escapedPath, size: 12, workspace: remote.remotePath, homes: ['/Users/ann'] });

    const response = await postUri(pathToFileURL(remotePath).href);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ success: false, error: 'Access to this file is blocked' });
    expect(response.body).not.toContain(remotePath);
    expect(response.body).not.toContain(escapedPath);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls.some((call) => String(call[1]).includes('cat --'))).toBe(false);
    expect(ctx._session.upsertAttachmentHistory).not.toHaveBeenCalled();
    expect(ctx.persistSessionState).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalled();
  });

  it('rejects an oversized remote artifact after inspection and before fetch or route side effects', async () => {
    const remote: SessionRemote = {
      hostId: 'mac-mini',
      label: 'Mac mini',
      host: 'remote.example',
      username: 'ann',
      remotePath: '/Users/ann/project',
    };
    const remotePath = '/Users/ann/project/output/oversize.png';
    const cachePath = buildRemoteGeneratedArtifactCachePath(ctx._sessionId, remote, remotePath);
    ctx._session.remote = remote;
    mockRemoteSsh({
      filePath: remotePath,
      size: MAX_GENERATED_ARTIFACT_BYTES + 1,
      workspace: remote.remotePath,
    });

    const response = await postUri(pathToFileURL(remotePath).href);

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ success: false, error: 'Attachment file is too large' });
    expect(response.body).not.toContain(remotePath);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls.some((call) => String(call[1]).includes('cat --'))).toBe(false);
    expect(ctx._session.upsertAttachmentHistory).not.toHaveBeenCalled();
    expect(ctx.persistSessionState).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalled();
    expect(attachmentRegistry.findByFilePath(ctx._sessionId, cachePath)).toBeUndefined();
  });

  it('returns a generic remote failure and logs only a bounded safe category and code', async () => {
    const remote: SessionRemote = {
      hostId: 'mac-mini',
      label: 'Secret remote label',
      host: 'secret.remote.example',
      username: 'ann',
      remotePath: '/Users/ann/project',
    };
    const remotePath = '/Users/ann/project/output/private.png';
    ctx._session.remote = remote;
    execFile.mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === 'function') callback(new Error(`SSH failed for ${remotePath} on ${remote.host}`));
    });

    const response = await postUri(pathToFileURL(remotePath).href);

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ success: false, error: 'File is unavailable' });
    expect(response.body).not.toContain(remotePath);
    expect(response.body).not.toContain(remote.host);
    const routeLog = logLines
      .map((line) => JSON.parse(line))
      .find((entry) => entry.msg === 'File URI preview registration failed');
    expect(routeLog).toMatchObject({
      category: 'file-uri-preview',
      code: 'remote-unavailable',
      sessionId: ctx._sessionId,
    });
    expect(JSON.stringify(routeLog)).not.toContain(remotePath);
    expect(JSON.stringify(routeLog)).not.toContain(remote.host);
  });

  it('resolves remote artifacts with the saved remote configuration and no local fallback or path disclosure', async () => {
    const remote: SessionRemote = {
      hostId: 'mac-mini',
      label: 'Mac mini',
      host: 'remote.example',
      username: 'ann',
      port: 2222,
      remotePath: '/Users/ann/project',
      identityFile: '~/.ssh/remote_ed25519',
      socksProxy: '127.0.0.1:1080',
      jumpHost: 'jump.example.com',
      extraSshOptions: ['StrictHostKeyChecking=no'],
    };
    const remotePath = '/Users/ann/project/output/remote mockup.png';
    ctx._session.remote = remote;
    mockRemoteSsh({ filePath: remotePath, size: 18, workspace: remote.remotePath });

    const response = await postUri(pathToFileURL(remotePath).href);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      success: true,
      data: { fileName: 'remote_mockup.png', attachmentId: expect.stringMatching(/^att_/) },
    });
    expect(execFile).toHaveBeenCalledTimes(2);
    for (const [command, args] of execFile.mock.calls as [string, string[]][]) {
      expect(command).toBe('ssh');
      expect(args).toEqual(
        expect.arrayContaining([
          '-p',
          '2222',
          '-i',
          expect.stringMatching(/remote_ed25519$/),
          '-J',
          'jump.example.com',
          '-o',
          'ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p',
          '-o',
          'StrictHostKeyChecking=no',
          'ann@remote.example',
        ])
      );
      expect(args.at(-1)).toContain(remotePath);
    }
    expect(response.body).not.toContain(remotePath);
    expect(response.body).not.toContain(remote.remotePath);
    expect(response.body).not.toContain(process.env.CODEMAN_DATA_DIR!);
  });
});
