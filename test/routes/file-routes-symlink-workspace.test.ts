/**
 * @fileoverview COD-231 production regression: a session working directory may
 * itself be a symlink (for example ~/projects/kb -> a OneDrive path on /mnt/c).
 * Listing, metadata, raw download, and preview must agree on containment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';

const previewFixture = vi.hoisted(() => ({ path: '' }));

vi.mock('../../src/document-preview-cache.js', () => ({
  getOfficePreviewPdfPath: vi.fn(async () => previewFixture.path),
  getPreviewPdfDownloadName: vi.fn((name: string) => `${name.replace(/\.[^.]+$/, '')}.pdf`),
}));

import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import { validateSessionFilePath } from '../../src/web/route-helpers.js';

const SESSION_ID = 'cod231-symlink-session';
const RELATIVE_DOCX = 'out/airdc-fy27-roadmap-mapping/deliverables/fy27-airdc-messaging-market-story.docx';

describe('COD-231 symlinked workspace file routes', () => {
  let harness: RouteTestHarness;
  let fixtureRoot: string;
  let canonicalWorkspace: string;
  let workspaceAlias: string;
  let canonicalDocx: string;

  beforeEach(async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'cod231-symlink-workspace-'));
    canonicalWorkspace = join(fixtureRoot, 'canonical-workspace');
    workspaceAlias = join(fixtureRoot, 'workspace-alias');
    canonicalDocx = join(canonicalWorkspace, RELATIVE_DOCX);

    mkdirSync(join(canonicalWorkspace, 'out/airdc-fy27-roadmap-mapping/deliverables'), { recursive: true });
    writeFileSync(canonicalDocx, Buffer.from('PK fake docx bytes'));
    symlinkSync(canonicalWorkspace, workspaceAlias, 'dir');

    previewFixture.path = join(fixtureRoot, 'preview.pdf');
    writeFileSync(previewFixture.path, Buffer.from('%PDF-1.4\n%%EOF\n'));

    harness = await createRouteTestHarness(registerFileRoutes, { sessionId: SESSION_ID });
    harness.ctx._session.workingDir = workspaceAlias;
  });

  afterEach(async () => {
    await harness.app.close();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('accepts a file under a symlinked workspace root', () => {
    expect(validateSessionFilePath(workspaceAlias, RELATIVE_DOCX)).toEqual({
      resolvedPath: realpathSync(canonicalDocx),
      relativePath: RELATIVE_DOCX,
    });
  });

  it('lists, describes, downloads, and previews the same DOCX', async () => {
    const encodedPath = encodeURIComponent(RELATIVE_DOCX);

    const files = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${SESSION_ID}/files?depth=5&showHidden=false`,
    });
    expect(files.statusCode).toBe(200);
    expect(files.json().data.root).toBe(workspaceAlias);
    expect(files.json().data.tree).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'out', type: 'directory' })])
    );
    expect(JSON.stringify(files.json().data.tree)).toContain(RELATIVE_DOCX);

    const metadata = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${SESSION_ID}/file-content?path=${encodedPath}&lines=500`,
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          path: RELATIVE_DOCX,
          type: 'document',
          extension: 'docx',
          previewUrl: `/api/sessions/${SESSION_ID}/file-preview?path=${encodedPath}`,
        }),
      })
    );

    const raw = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${SESSION_ID}/file-raw?path=${encodedPath}&download=true`,
    });
    expect(raw.statusCode).toBe(200);
    expect(raw.headers['content-disposition']).toContain('attachment');
    expect(raw.rawPayload).toEqual(Buffer.from('PK fake docx bytes'));

    const preview = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${SESSION_ID}/file-preview?path=${encodedPath}`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toContain('application/pdf');
    expect(preview.rawPayload).toEqual(Buffer.from('%PDF-1.4\n%%EOF\n'));
  });

  it('still rejects a nested symlink that escapes the canonical workspace', () => {
    const outsideDir = join(fixtureRoot, 'outside');
    const outsideFile = join(outsideDir, 'secret.txt');
    mkdirSync(outsideDir);
    writeFileSync(outsideFile, 'secret');
    symlinkSync(outsideDir, join(canonicalWorkspace, 'escape'), 'dir');

    expect(validateSessionFilePath(workspaceAlias, 'escape/secret.txt')).toBeNull();
  });

  it('fails closed for missing workspace roots and missing files', () => {
    expect(validateSessionFilePath(join(fixtureRoot, 'missing-workspace'), RELATIVE_DOCX)).toBeNull();
    expect(validateSessionFilePath(workspaceAlias, 'out/missing.docx')).toBeNull();
  });
});
