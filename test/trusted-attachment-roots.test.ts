import fs from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureLocalUploadDirectory,
  getTrustedAttachmentRoots,
  resetTrustedAttachmentRootsForTests,
  resolveLocalUploadDirectory,
} from '../src/config/attachment-guard.js';
import { SettingsUpdateSchema } from '../src/web/schemas.js';

const admin = { username: 'admin', role: 'admin' as const };
const user = { username: 'alice', role: 'user' as const };

describe('trusted attachment roots', () => {
  let tempDir: string;
  let workspace: string;
  let trustedRoot: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'codeman-trusted-roots-')));
    workspace = join(tempDir, 'workspace');
    trustedRoot = join(tempDir, 'trusted');
    await fs.mkdir(workspace);
    await fs.mkdir(trustedRoot);
    delete process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS;
    resetTrustedAttachmentRootsForTests();
  });

  afterEach(async () => {
    delete process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS;
    resetTrustedAttachmentRootsForTests();
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('ignores unset, empty, relative, missing, non-directory, non-canonical, blocked, and duplicate entries', async () => {
    const file = join(tempDir, 'file.txt');
    const alias = join(tempDir, 'alias');
    await fs.writeFile(file, 'x');
    await fs.symlink(trustedRoot, alias);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS = [
      '',
      'relative',
      join(tempDir, 'missing'),
      file,
      alias,
      '/etc',
      trustedRoot,
      trustedRoot,
    ].join(',');

    await expect(getTrustedAttachmentRoots()).resolves.toEqual([trustedRoot]);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).not.toContain(tempDir);
  });

  it('does not accept trusted roots through browser-writable settings', () => {
    expect(SettingsUpdateSchema.safeParse({ trustedAttachmentRoots: [trustedRoot] }).success).toBe(false);
  });

  it('creates a missing workspace upload directory non-recursively', async () => {
    await expect(ensureLocalUploadDirectory(workspace, admin)).resolves.toEqual({
      kind: 'workspace',
      canonicalDir: join(workspace, '.codeman-attachments'),
    });
    expect((await fs.lstat(join(workspace, '.codeman-attachments'))).isDirectory()).toBe(true);
  });

  it('handles concurrent first-use directory creation', async () => {
    const results = await Promise.all([
      ensureLocalUploadDirectory(workspace, admin),
      ensureLocalUploadDirectory(workspace, admin),
    ]);
    expect(results).toEqual([
      { kind: 'workspace', canonicalDir: join(workspace, '.codeman-attachments') },
      { kind: 'workspace', canonicalDir: join(workspace, '.codeman-attachments') },
    ]);
  });

  // COD-296: resolve-only is the read/delete contract — null, and no mkdir.
  it('resolves a missing workspace upload directory to null without creating it', async () => {
    await expect(resolveLocalUploadDirectory(workspace, admin)).resolves.toBeNull();
    await expect(fs.lstat(join(workspace, '.codeman-attachments'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps rejecting an unapproved directory rather than returning null', async () => {
    // An entry that EXISTS but is not approved must still throw: null means
    // "absent", never "denied", or a caller could mistake one for the other.
    const other = join(tempDir, 'other');
    await fs.mkdir(other);
    await fs.symlink(other, join(workspace, '.codeman-attachments'));

    await expect(resolveLocalUploadDirectory(workspace, admin)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('returns an existing regular workspace directory', async () => {
    const dir = join(workspace, '.codeman-attachments');
    await fs.mkdir(dir);
    await expect(resolveLocalUploadDirectory(workspace, admin)).resolves.toEqual({
      kind: 'workspace',
      canonicalDir: dir,
    });
  });

  it('accepts only an exact configured symlink target for an admin', async () => {
    process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS = trustedRoot;
    resetTrustedAttachmentRootsForTests();
    await fs.symlink(trustedRoot, join(workspace, '.codeman-attachments'));

    await expect(resolveLocalUploadDirectory(workspace, admin)).resolves.toEqual({
      kind: 'trusted',
      canonicalDir: trustedRoot,
    });
  });

  it.each(['unapproved', 'child', 'broken'] as const)('rejects a %s symlink target', async (variant) => {
    const target =
      variant === 'unapproved'
        ? join(tempDir, 'other')
        : variant === 'child'
          ? join(trustedRoot, 'child')
          : join(tempDir, 'missing');
    if (variant !== 'broken') await fs.mkdir(target);
    process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS = trustedRoot;
    resetTrustedAttachmentRootsForTests();
    await fs.symlink(target, join(workspace, '.codeman-attachments'));

    await expect(resolveLocalUploadDirectory(workspace, admin)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects a trusted symlink for a non-admin', async () => {
    process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS = trustedRoot;
    resetTrustedAttachmentRootsForTests();
    await fs.symlink(trustedRoot, join(workspace, '.codeman-attachments'));

    await expect(resolveLocalUploadDirectory(workspace, user)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('fails closed after the workspace symlink is repointed', async () => {
    const link = join(workspace, '.codeman-attachments');
    const other = join(tempDir, 'other');
    await fs.mkdir(other);
    process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS = trustedRoot;
    resetTrustedAttachmentRootsForTests();
    await fs.symlink(trustedRoot, link);
    await expect(resolveLocalUploadDirectory(workspace, admin)).resolves.toMatchObject({ kind: 'trusted' });
    await fs.unlink(link);
    await fs.symlink(other, link);

    await expect(resolveLocalUploadDirectory(workspace, admin)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('fails closed when a configured root stops resolving to itself', async () => {
    const link = join(workspace, '.codeman-attachments');
    const moved = join(tempDir, 'trusted-moved');
    const other = join(tempDir, 'other');
    await fs.mkdir(other);
    process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS = trustedRoot;
    resetTrustedAttachmentRootsForTests();
    await getTrustedAttachmentRoots();
    await fs.symlink(trustedRoot, link);
    await fs.rename(trustedRoot, moved);
    await fs.symlink(other, trustedRoot);

    await expect(resolveLocalUploadDirectory(workspace, admin)).rejects.toMatchObject({ statusCode: 403 });
  });
});
