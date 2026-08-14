import fs from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('trusted upload boundary byte cap', () => {
  afterEach(() => {
    delete process.env.CODEMAN_MAX_PASTE_IMAGE_BYTES;
    vi.resetModules();
  });

  it('uses the configured paste-image cap instead of the generated-artifact cap', async () => {
    process.env.CODEMAN_MAX_PASTE_IMAGE_BYTES = String(60 * 1024 * 1024);
    vi.resetModules();
    const { registerExternalAttachment, resolveGeneratedArtifactReadPath, attachmentRegistry } =
      await import('../src/attachment-registry.js');
    const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'codeman-trusted-cap-')));
    const file = join(root, 'large.pdf');
    await fs.writeFile(file, '%PDF-1.4\n');
    await fs.truncate(file, 55 * 1024 * 1024);
    try {
      const event = await registerExternalAttachment('trusted-cap', file, {
        source: 'upload',
        trustedUploadBoundary: root,
      });
      const record = attachmentRegistry.get('trusted-cap', event.attachmentId)!;
      await expect(resolveGeneratedArtifactReadPath(record)).resolves.toBe(file);
    } finally {
      attachmentRegistry.clearSession('trusted-cap');
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('never merges generated-artifact and trusted-upload authority on record reuse', async () => {
    const { registerExternalAttachment, attachmentRegistry } = await import('../src/attachment-registry.js');
    const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'codeman-trusted-conflict-')));
    const file = join(root, 'file.pdf');
    await fs.writeFile(file, '%PDF-1.4\n');
    try {
      await registerExternalAttachment('generated-first', file, { generatedArtifactBoundary: root });
      await expect(
        registerExternalAttachment('generated-first', file, { trustedUploadBoundary: root })
      ).rejects.toMatchObject({ statusCode: 403 });

      await registerExternalAttachment('trusted-first', file, { trustedUploadBoundary: root });
      await expect(
        registerExternalAttachment('trusted-first', file, { generatedArtifactBoundary: root })
      ).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      attachmentRegistry.clearSession('generated-first');
      attachmentRegistry.clearSession('trusted-first');
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
