/** Route coverage for secure Codex file-URI preview resolution (COD-273). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const { execFile } = vi.hoisted(() => ({
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      callback(null, { stdout: Buffer.from('remote-image-bytes'), stderr: Buffer.alloc(0) });
    }
    return {};
  }),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, execFile };
});

import { attachmentRegistry } from '../../src/attachment-registry.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { SseEvent } from '../../src/web/sse-events.js';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import type { SessionRemote } from '../../src/types/session.js';

describe('POST /api/sessions/:id/file-uri-preview', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let testRoot: string;
  let workspaceDir: string;
  let outsideDir: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    testRoot = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-file-uri-preview-')));
    workspaceDir = join(testRoot, 'workspace');
    outsideDir = join(testRoot, 'outside');
    await Promise.all([fs.mkdir(workspaceDir), fs.mkdir(outsideDir)]);
    previousDataDir = process.env.CODEMAN_DATA_DIR;
    process.env.CODEMAN_DATA_DIR = join(testRoot, 'data');

    app = Fastify({ logger: false });
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

  it('resolves remote artifacts with the saved remote configuration and no local fallback or path disclosure', async () => {
    const remote: SessionRemote = {
      hostId: 'mac-mini',
      label: 'Mac mini',
      host: 'remote.example',
      username: 'ann',
      port: 2222,
      remotePath: '/Users/ann/project',
      identityFile: '~/.ssh/remote_ed25519',
      jumpHost: 'jump.example.com',
      extraSshOptions: ['StrictHostKeyChecking=no'],
    };
    const remotePath = '/Users/ann/project/output/remote mockup.png';
    ctx._session.remote = remote;

    const response = await postUri(pathToFileURL(remotePath).href);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      success: true,
      data: { fileName: 'remote_mockup.png', attachmentId: expect.stringMatching(/^att_/) },
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    const [command, args] = execFile.mock.calls[0] as [string, string[]];
    expect(command).toBe('ssh');
    expect(args).toEqual(
      expect.arrayContaining([
        '-p',
        '2222',
        '-J',
        'jump.example.com',
        '-o',
        'StrictHostKeyChecking=no',
        'ann@remote.example',
      ])
    );
    expect(args.at(-1)).toContain(remotePath);
    expect(response.body).not.toContain(remotePath);
    expect(response.body).not.toContain(remote.remotePath);
    expect(response.body).not.toContain(process.env.CODEMAN_DATA_DIR!);
  });
});
