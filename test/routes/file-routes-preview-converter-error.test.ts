/**
 * @fileoverview COD-426 acceptance criterion 1: when the office converter is
 * present-but-unusable, the preview endpoint must return the probe's ACTIONABLE
 * reason instead of the generic "Document preview conversion failed" (which is
 * all the user got after ~5 minutes of "Rendering document…").
 *
 * Everything that spawns is mocked, so this needs no real LibreOffice.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => Buffer.from('%PDF-1.4 fake pdf bytes')),
    stat: vi.fn(async () => ({ size: 100, isFile: () => true, mtimeMs: 1 })),
    readdir: vi.fn(async () => []),
    mkdir: vi.fn(async () => undefined),
    mkdtemp: vi.fn(async () => '/tmp/codeman-preview-test'),
    writeFile: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
    access: vi.fn(async () => undefined),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, realpathSync: vi.fn((p: string) => p) };
});

vi.mock('../../src/document-preview-cache.js', () => ({
  getOfficePreviewPdfPath: vi.fn(async () => null),
  getPreviewPdfDownloadName: vi.fn((name: string) => `${name.replace(/\.[^.]+$/, '')}.pdf`),
}));

const verdict: { usable: boolean; bin: string | null; reason?: string } = { usable: true, bin: '/usr/bin/soffice' };
vi.mock('../../src/office-converter-runtime.js', () => ({
  probeOfficeConverter: vi.fn(async () => verdict),
}));

const REASON =
  'LibreOffice at /usr/bin/libreoffice could not convert a test document. Run `codeman doctor` to check it, ' +
  'or point CODEMAN_SOFFICE_BIN at a working LibreOffice binary.';

const SID = 'test-session-1';

describe('file-preview converter diagnostics (COD-426)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes, { sessionId: SID });
    verdict.usable = true;
    verdict.bin = '/usr/bin/soffice';
    delete verdict.reason;
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('surfaces the actionable probe reason when the converter is unusable', async () => {
    verdict.usable = false;
    verdict.bin = '/usr/bin/libreoffice';
    verdict.reason = REASON;

    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${SID}/file-preview?path=deck.docx` });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('codeman doctor');
    expect(body.error).toContain('CODEMAN_SOFFICE_BIN');
    expect(body.error).not.toBe('Document preview conversion failed');
  });

  it('keeps the generic message when the converter itself is fine (the document is at fault)', async () => {
    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${SID}/file-preview?path=deck.docx` });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: string };
    expect(body.error).toBe('Document preview conversion failed');
  });
});
