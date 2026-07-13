# COD-231 Symlinked Workspace Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make session-scoped file preview and download routes accept files inside a symlinked workspace root while continuing to reject nested symlinks that escape the canonical workspace.

**Architecture:** Keep the correction in the shared `validateSessionFilePath()` boundary. Canonicalize both the configured workspace root and requested file before calculating containment; all existing callers inherit the corrected semantics without route-specific exceptions.

**Tech Stack:** TypeScript, Node.js `fs`/`path`, Fastify `app.inject()`, Vitest.

---

## File Structure

- Modify `src/web/route-helpers.ts`: canonicalize the session working directory before the existing relative-path containment check.
- Create `test/routes/file-routes-symlink-workspace.test.ts`: use a real temporary directory plus a workspace symlink to reproduce the production list/metadata/raw/preview split and verify nested-symlink escape rejection.

### Task 1: Add the production-shaped failing regression

**Files:**
- Create: `test/routes/file-routes-symlink-workspace.test.ts`
- Test: `test/routes/file-routes-symlink-workspace.test.ts`

- [ ] **Step 1: Write the failing route and validator tests**

Create `test/routes/file-routes-symlink-workspace.test.ts` with real filesystem fixtures. Mock only the Office conversion cache so the test exercises the real shared path validator without invoking LibreOffice:

```ts
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
    expect(files.json().data.tree).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'out', type: 'directory' }),
      ])
    );

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
```

- [ ] **Step 2: Run the new file and verify the production case fails**

Run:

```bash
npm test -- test/routes/file-routes-symlink-workspace.test.ts
```

Expected: the valid symlink-root assertions fail because the current validator returns `null`; the nested escape and missing-path assertions remain green.

- [ ] **Step 3: Commit the RED test**

```bash
git add -- test/routes/file-routes-symlink-workspace.test.ts
git commit -m "COD-231 test symlinked workspace file routes"
```

### Task 2: Canonicalize both sides of the containment check

**Files:**
- Modify: `src/web/route-helpers.ts:61-78`
- Test: `test/routes/file-routes-symlink-workspace.test.ts`

- [ ] **Step 1: Implement the minimal validator correction**

Replace the body of `validateSessionFilePath()` with:

```ts
export function validateSessionFilePath(
  sessionWorkingDir: string,
  filePath: string
): { resolvedPath: string; relativePath: string } | null {
  const fullPath = resolve(sessionWorkingDir, filePath);
  let resolvedWorkingDir: string;
  let resolvedPath: string;
  try {
    resolvedWorkingDir = realpathSync(sessionWorkingDir);
    resolvedPath = realpathSync(fullPath);
  } catch {
    return null;
  }
  const relativePath = relative(resolvedWorkingDir, resolvedPath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null;
  }
  return { resolvedPath, relativePath };
}
```

- [ ] **Step 2: Run the new test and verify GREEN**

Run:

```bash
npm test -- test/routes/file-routes-symlink-workspace.test.ts
```

Expected: 4 tests pass, including 200 responses for metadata, raw download, and converted preview.

- [ ] **Step 3: Commit the minimal implementation**

```bash
git add -- src/web/route-helpers.ts
git commit -m "COD-231 fix symlinked workspace validation"
```

### Task 3: Run focused regression and static gates

**Files:**
- Verify: `src/web/route-helpers.ts`
- Verify: `test/routes/file-routes-symlink-workspace.test.ts`

- [ ] **Step 1: Run each safe focused test file separately**

```bash
npm test -- test/routes/file-routes-symlink-workspace.test.ts
npm test -- test/routes/file-routes.test.ts
npm test -- test/routes/file-routes-preview-thumbnail.test.ts
npm test -- test/routes/file-routes-attachment-path-guard.test.ts
npm test -- test/file-browser-session-ownership.test.ts
npm test -- test/file-browser-download.test.ts
```

Expected: every file passes with zero failures. Never run bare `npm test` or raw unscoped Vitest in this managed session.

- [ ] **Step 2: Run type, format, lint, lockfile, and build gates**

```bash
npm run typecheck
npx prettier --check src/web/route-helpers.ts test/routes/file-routes-symlink-workspace.test.ts
npx eslint src/web/route-helpers.ts test/routes/file-routes-symlink-workspace.test.ts
npm run check:lockfile
npm run build
```

Expected: every command exits 0. Known build duplicate-member/key warnings may appear; no new error is acceptable.

- [ ] **Step 3: Verify the exact production alias without changing production**

Run from the issue worktree:

```bash
npx tsx -e "import { validateSessionFilePath } from './src/web/route-helpers.ts'; console.log(validateSessionFilePath('/home/aakhter/projects/kb', 'out/airdc-fy27-roadmap-mapping/deliverables/fy27-airdc-messaging-market-story.docx'))"
```

Expected: a non-null object whose canonical path is under the `/mnt/c/.../Source/kb` workspace and whose relative path is exactly `out/airdc-fy27-roadmap-mapping/deliverables/fy27-airdc-messaging-market-story.docx`.

- [ ] **Step 4: Review the final diff for scope and security**

```bash
git diff local...HEAD -- src/web/route-helpers.ts test/routes/file-routes-symlink-workspace.test.ts
git diff --check local...HEAD
```

Expected: only the canonical-base correction and focused tests; no arbitrary absolute-path allowance and no relaxation of nested-symlink rejection.

### Task 4: Land and record the fix

**Files:**
- Update: `/home/aakhter/.codeman/jira-autoloop-state.md`
- Jira: `COD-231`

- [ ] **Step 1: Independently review specification compliance and code quality**

Use a fresh reviewer to confirm the implementation matches the design, the RED/GREEN evidence is genuine, and canonicalizing the root does not permit nested symlink escape.

- [ ] **Step 2: Fast-forward the deploy branch and push only to Bitbucket**

From the primary checkout, after confirming its two pre-existing dirty files are unchanged:

```bash
git merge --ff-only cod-231-symlink-workspace-validation
git push origin local
```

Expected: `local == origin/local`; upstream remains read-only. Do not deploy production without a new explicit deploy authorization.

- [ ] **Step 3: Update Jira and the loop state**

Record the root cause, commits, RED/GREEN counts, exact-path proof, focused/static/build evidence, and Bitbucket commit link on COD-231. Transition it to Done only after the pushed branch and evidence are verified; mark the correction deploy-pending in the loop state.

