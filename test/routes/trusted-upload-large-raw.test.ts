import fs from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SIXTY_MIB = 60 * 1024 * 1024;
const FIFTY_FIVE_MIB = 55 * 1024 * 1024;

function uploadBody(boundary: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="document"; filename="Large.pdf"\r\n' +
        'Content-Type: application/pdf\r\n\r\n'
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

describe('trusted upload raw serving above the generated-artifact cap', () => {
  afterEach(() => {
    delete process.env.CODEMAN_MAX_PASTE_IMAGE_BYTES;
    delete process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS;
    vi.resetModules();
  });

  it('uploads and downloads a 55 MiB trusted PDF when the paste cap is 60 MiB', async () => {
    const temp = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'codeman-large-trusted-')));
    const workspace = join(temp, 'workspace');
    const trusted = join(temp, 'trusted');
    await fs.mkdir(workspace);
    await fs.mkdir(trusted);
    await fs.symlink(trusted, join(workspace, '.codeman-attachments'));
    process.env.CODEMAN_MAX_PASTE_IMAGE_BYTES = String(SIXTY_MIB);
    process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS = trusted;
    vi.resetModules();

    const [{ registerFileRoutes }, { createMockRouteContext }, { installRouteErrorHandler }] = await Promise.all([
      import('../../src/web/routes/file-routes.js'),
      import('../mocks/index.js'),
      import('../../src/web/route-error-handler.js'),
    ]);
    const app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await app.register(fastifyMultipart, { limits: { fileSize: SIXTY_MIB, files: 1, fields: 4, parts: 5 } });
    const ctx = createMockRouteContext();
    ctx._session.workingDir = workspace;
    registerFileRoutes(app, ctx as never);
    installRouteErrorHandler(app);
    await app.ready();

    const bytes = Buffer.alloc(FIFTY_FIVE_MIB);
    bytes.write('%PDF-1.4\n', 0, 'latin1');
    const boundary = 'codeman-large-trusted-boundary';
    try {
      const upload = await app.inject({
        method: 'POST',
        url: `/api/sessions/${ctx._sessionId}/attachments/upload`,
        headers: {
          host: 'codeman.test',
          origin: 'http://codeman.test',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: uploadBody(boundary, bytes),
      });
      expect(upload.statusCode).toBe(200);
      const rawUrl = `${JSON.parse(upload.body).data.rawUrl}?download=true`;

      const raw = await app.inject({ method: 'GET', url: rawUrl });
      expect(raw.statusCode).toBe(200);
      expect(raw.rawPayload.length).toBe(FIFTY_FIVE_MIB);
      expect(raw.rawPayload.subarray(0, 9).toString('latin1')).toBe('%PDF-1.4\n');

      const externalPath = join(temp, 'ordinary-external.pdf');
      await fs.writeFile(externalPath, bytes);
      const external = await app.inject({
        method: 'POST',
        url: `/api/sessions/${ctx._sessionId}/attachments`,
        payload: { path: externalPath },
      });
      expect(external.statusCode).toBe(200);
      const externalRaw = await app.inject({
        method: 'GET',
        url: `${JSON.parse(external.body).data.rawUrl}?download=true`,
      });
      expect(externalRaw.statusCode).toBe(413);
    } finally {
      await app.close();
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
});
