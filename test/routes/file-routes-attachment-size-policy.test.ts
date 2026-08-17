/**
 * @fileoverview COD-297 — the cap that ADMITS attachment bytes must be the cap
 * that SERVES them.
 *
 * `CODEMAN_MAX_PASTE_IMAGE_BYTES` is what @fastify/multipart enforces on an
 * upload, so raising it lets a >50MiB document upload and register. The by-id
 * raw route, however, used a HARDCODED 50MiB for everything that was not a
 * trusted-symlink upload — and an ordinary workspace upload carries no
 * `trustedUploadBoundary`. Net effect: the file uploads fine and then 413s on
 * every read. Same for the remote-session upload, whose local cache copy also
 * registers as `source: 'upload'` with no boundary.
 *
 * These tests pin the source-specific policy in both directions: raising the
 * upload knob follows the bytes through to serving, and it must NOT widen the
 * caps for generated artifacts, ordinary external references, or the XLSX
 * browser-preview limit.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';

/**
 * Mutable stand-in for the env-derived upload cap. `MAX_PASTE_IMAGE_BYTES` is a
 * module-level const read from `process.env` at import time, so a per-test knob
 * has to be a getter on the mocked module rather than an env write.
 */
const limits = vi.hoisted(() => ({ pasteImage: 50 * 1024 * 1024 }));

vi.mock('../../src/config/buffer-limits.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/buffer-limits.js')>();
  return {
    ...actual,
    get MAX_PASTE_IMAGE_BYTES() {
      return limits.pasteImage;
    },
  };
});

vi.mock('node:fs/promises', () => ({
  default: {
    readdir: vi.fn(async () => []),
    readFile: vi.fn(async () => 'file content'),
    writeFile: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 100, isFile: () => true, mtimeMs: 1 })),
    mkdir: vi.fn(async () => undefined),
    mkdtemp: vi.fn(async () => '/tmp/codeman-size-policy-test'),
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
    realpath: vi.fn(async (p: string) => p),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: vi.fn((p: string) => p),
    createReadStream: vi.fn(() => Readable.from([Buffer.from('bytes')])),
  };
});

vi.mock('../../src/file-stream-manager.js', () => ({
  fileStreamManager: {
    createStream: vi.fn(async () => ({ success: true, streamId: 'stream-1' })),
    closeStream: vi.fn(() => true),
  },
}));

import fs from 'node:fs/promises';
import { createReadStream, realpathSync } from 'node:fs';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import { attachmentRegistry, type AttachmentRecord, type AttachmentSource } from '../../src/attachment-registry.js';

const mockedStat = vi.mocked(fs.stat);
const mockedRealpathSync = vi.mocked(realpathSync);
const mockedCreateReadStream = vi.mocked(createReadStream);

const MIB = 1024 * 1024;
const DEFAULT_PASTE_IMAGE_BYTES = 50 * MIB;
const WORKSPACE = '/tmp/test-workdir';

describe('attachment raw-serving size policy (COD-297)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes);
    vi.clearAllMocks();
    limits.pasteImage = DEFAULT_PASTE_IMAGE_BYTES;
    attachmentRegistry.clearSession(harness.ctx._sessionId);
    mockedRealpathSync.mockImplementation((p) => p as string);
    mockedCreateReadStream.mockReturnValue(Readable.from([Buffer.from('bytes')]) as never);
  });

  afterEach(async () => {
    await harness.app.close();
    attachmentRegistry.clearSession(harness.ctx._sessionId);
    limits.pasteImage = DEFAULT_PASTE_IMAGE_BYTES;
  });

  /** Register a record straight into the registry and stat it at `size`. */
  function registerRecord(
    attachmentId: string,
    opts: {
      size: number;
      source: AttachmentSource;
      filePath?: string;
      extension?: string;
      generatedArtifactBoundary?: string;
    }
  ): void {
    const extension = opts.extension ?? 'pdf';
    const filePath = opts.filePath ?? `${WORKSPACE}/.codeman-attachments/doc-1.${extension}`;
    mockedStat.mockResolvedValue({ size: opts.size, isFile: () => true, mtimeMs: 1 } as never);
    const record: AttachmentRecord = {
      attachmentId,
      sessionId: harness.ctx._sessionId,
      filePath,
      fileName: `doc-1.${extension}`,
      extension,
      attachmentType: extension === 'pdf' ? 'pdf' : 'document',
      size: opts.size,
      mtimeMs: 1,
      timestamp: Date.now(),
      source: opts.source,
      ...(opts.generatedArtifactBoundary ? { generatedArtifactBoundary: opts.generatedArtifactBoundary } : {}),
    };
    attachmentRegistry.register(record);
  }

  const raw = (attachmentId: string, query = '') =>
    harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/${attachmentId}/raw${query}`,
    });

  // ===== THE BUG: an upload admitted at the raised cap must also be servable =====

  it('serves a 55MiB workspace upload when the upload cap is configured at 60MiB', async () => {
    limits.pasteImage = 60 * MIB;
    registerRecord('att_workspace_upload', { size: 55 * MIB, source: 'upload' });

    const res = await raw('att_workspace_upload');

    expect(res.statusCode).toBe(200);
  });

  it('serves a 55MiB remote-session upload cache copy at the same raised cap', async () => {
    // The remote upload path caches the bytes under the instance data dir and
    // registers THAT path as `source: 'upload'` with no boundary — outside the
    // workspace, so it exercises a different branch of the same policy.
    limits.pasteImage = 60 * MIB;
    registerRecord('att_remote_upload', {
      size: 55 * MIB,
      source: 'upload',
      filePath: '/tmp/codeman-data/remote-attachment-uploads/s1/doc-1.pdf',
    });

    const res = await raw('att_remote_upload');

    expect(res.statusCode).toBe(200);
  });

  // ===== NOT WIDENED: everything the upload knob must not touch =====

  it('still caps an ordinary external reference at 50MiB when the upload cap is 60MiB', async () => {
    limits.pasteImage = 60 * MIB;
    registerRecord('att_external', { size: 55 * MIB, source: 'external', filePath: '/mnt/c/decks/doc-1.pdf' });

    const res = await raw('att_external');

    expect(res.statusCode).toBe(413);
  });

  it('still caps a generated artifact at 50MiB when the upload cap is 60MiB', async () => {
    limits.pasteImage = 60 * MIB;
    registerRecord('att_generated', {
      size: 55 * MIB,
      source: 'detected',
      filePath: '/tmp/codeman-data/generated/s1/doc-1.pdf',
      generatedArtifactBoundary: '/tmp/codeman-data/generated/s1',
    });

    const res = await raw('att_generated');

    expect(res.statusCode).toBe(413);
  });

  it('preserves the 10MiB XLSX browser-preview limit at a raised upload cap', async () => {
    limits.pasteImage = 60 * MIB;
    registerRecord('att_xlsx_preview', { size: 11 * MIB, source: 'upload', extension: 'xlsx' });

    const res = await raw('att_xlsx_preview', '?preview=true');

    expect(res.statusCode).toBe(413);
  });

  it('applies the upload cap, not the preview cap, to an explicit XLSX download', async () => {
    limits.pasteImage = 60 * MIB;
    registerRecord('att_xlsx_download', { size: 11 * MIB, source: 'upload', extension: 'xlsx' });

    const res = await raw('att_xlsx_download', '?preview=true&download=true');

    expect(res.statusCode).toBe(200);
  });

  // ===== DEFAULTS UNCHANGED =====

  it('caps a 55MiB upload at the unchanged 50MiB default', async () => {
    registerRecord('att_default_upload', { size: 55 * MIB, source: 'upload' });

    const res = await raw('att_default_upload');

    expect(res.statusCode).toBe(413);
  });

  it('serves a 49MiB upload at the unchanged 50MiB default', async () => {
    registerRecord('att_default_ok', { size: 49 * MIB, source: 'upload' });

    const res = await raw('att_default_ok');

    expect(res.statusCode).toBe(200);
  });
});
