# COD-280 XLSX Attachment Viewer Implementation Plan

> **Execution:** Use TDD and run only the named Vitest files. Never invoke the unscoped full suite from a Codeman-managed session.

**Goal:** Add a local-only, read-only XLSX preview with worksheet tabs, virtualized cells, safe resource admission, and byte-identical original download for attachment, local-workspace, and remote-workspace files.

**Architecture:** Existing guarded raw routes remain the only file-serving surfaces. A `preview=true` mode enforces a current 10 MiB cap before local streaming or remote staging. A same-origin Worker first performs bounded streaming ZIP/XML admission with fflate, then parses the admitted workbook with ExcelJS and retains it worker-side. The main thread receives metadata and ordered viewport tiles only. A dedicated renderer integrates with the existing preview overlay and original-download identity contract.

**Tech stack:** TypeScript ESM, Fastify, plain browser JavaScript, classic Web Worker, ExcelJS 4.4.0, fflate 0.8.2, Vitest, Playwright.

---

## File map

- `package.json`, `package-lock.json`: pin ExcelJS and fflate.
- `scripts/postinstall.js`: prepare development vendor assets and strip source-map references.
- `scripts/build.mjs`: produce production vendor assets and cache-bust the spreadsheet entry script.
- `scripts/check-public-assets.mjs`: enforce bundle-size and content-hash/version contracts.
- `src/attachment-registry.ts`, `src/types/tools.ts`: add the `spreadsheet` attachment type.
- `src/web/routes/file-routes.ts`: classify XLSX metadata and enforce `preview=true` size limits before streaming/staging.
- `src/web/public/spreadsheet-xlsx-core.js`: pure ZIP admission, number formatting, sparse geometry, and protocol helpers.
- `src/web/public/spreadsheet-preview-worker.js`: fflate admission, ExcelJS parse, worker-owned workbook, metadata/tile protocol.
- `src/web/public/spreadsheet-preview.js`: fetch/worker lifecycle, sheet tabs, ordered tiles, virtual-grid DOM.
- `src/web/public/panels-ui.js`: shared overlay integration and disposal.
- `src/web/public/index.html`: load the small renderer entry script.
- `src/web/public/styles.css`, `src/web/public/mobile.css`: spreadsheet grid, tabs, notices, mobile behavior.
- `src/web/public/i18n.js`: English/Chinese viewer-owned strings.
- `test/routes/file-routes.test.ts`: attachment/local classification, preview caps, and download behavior.
- `test/routes/file-routes-remote-sftp.test.ts`: remote pre-staging cap and download exemption.
- `test/spreadsheet-xlsx-core.test.ts`: ZIP, format, geometry, merge, and protocol unit tests.
- `test/spreadsheet-preview-worker.test.ts`: real workbook parse and tile protocol tests.
- `test/spreadsheet-preview.test.ts`: renderer and overlay-lifecycle unit tests.
- `test/spreadsheet-preview.browser.test.ts`: actual Worker/CSP/network/mobile browser coverage.
- Existing viewer tests updated only where the new type changes an assertion.

### Task 1: Pin and deliver local parser assets

**Files:** `package.json`, `package-lock.json`, `scripts/postinstall.js`, `scripts/build.mjs`, `scripts/check-public-assets.mjs`, `test/public-assets.test.ts` or the closest existing asset test.

- [ ] Add RED tests/assertions for:
  - exact production versions `exceljs@4.4.0` and `fflate@0.8.2`;
  - local vendor output names;
  - stripped `sourceMappingURL` comments;
  - combined raw-size budget ≤1.1 MiB;
  - `SPREADSHEET_ASSET_VERSION` matching the truncated SHA-256 of the worker plus production vendor bundles.
- [ ] Run the focused public-asset test/check and confirm failure.
- [ ] Install exact dependencies with the lockfile.
- [ ] Extend postinstall and build asset preparation using the existing xterm vendor pattern. Keep generated `src/web/public/vendor/` ignored.
- [ ] Add the content-hash/version check and make worker/vendor URL versioning consume the checked constant.
- [ ] Run the focused test, `npm run check:public-assets`, and `npm run check:lockfile`.
- [ ] Commit: `build: COD-280 vendor local XLSX preview dependencies`.

### Task 2: Classify XLSX and enforce server preview caps

**Files:** `src/types/tools.ts`, `src/attachment-registry.ts`, `src/web/routes/file-routes.ts`, `test/routes/file-routes.test.ts`, `test/routes/file-routes-remote-sftp.test.ts`.

- [ ] Add RED route tests proving:
  - attachment metadata returns `type: spreadsheet` and a raw `preview=true` URL;
  - local workspace metadata returns `type: spreadsheet` and a raw `preview=true` URL;
  - remote workspace metadata returns the same type and URL shape;
  - local XLSX above 10 MiB is rejected before `createReadStream` when `preview=true`;
  - remote XLSX above 10 MiB is rejected before `downloadRemoteWorkspaceFile` when `preview=true`;
  - a file that grows after metadata is rechecked and rejected;
  - `download=true` is not subject to the 10 MiB preview cap;
  - XLSX download retains official MIME, RFC 5987 filename handling, and exact bytes.
- [ ] Run the two route files and confirm the new assertions fail.
- [ ] Add `spreadsheet` to the shared attachment/API type unions and classify only XLSX as that type.
- [ ] Add exported `MAX_XLSX_BROWSER_PREVIEW_BYTES = 10 * 1024 * 1024` and apply it only when `preview=true`, with `download=true` remaining on the established path.
- [ ] For remote workspaces, call the existing metadata function and enforce the cap before staging.
- [ ] Preserve generic-binary fallback for unknown types and keep XLSX out of edit allowlists.
- [ ] Run the two route files and typecheck.
- [ ] Commit: `feat(attachments): COD-280 expose guarded XLSX previews`.

### Task 3: Build streaming XLSX admission and pure helpers

**Files:** `src/web/public/spreadsheet-xlsx-core.js`, `test/spreadsheet-xlsx-core.test.ts`.

- [ ] Create RED tests for:
  - CFB/OLE encrypted signature;
  - malformed EOCD/central directory;
  - ZIP64 sentinel refusal;
  - declared-size early rejection that never admits by declaration alone;
  - fflate streaming actual-byte, per-entry, entry-count, and compression-ratio limits;
  - chunk-boundary-safe counting of worksheets, cells, merges, and `cellXfs` definitions;
  - feature detection from OOXML entry names;
  - Excel coordinate bounds and populated-cell/merge-derived extents;
  - sparse dimension overrides, including hidden zero-size rows/columns;
  - common number-format matrix, 1900/1904 dates, formula fallback marker, and safe unknown-format warning;
  - merge interval intersection when the anchor is outside the viewport;
  - viewport math that does not allocate by declared row count and clamps physical scroll extent.
- [ ] Run this test file and confirm failure.
- [ ] Implement a dependency-free core IIFE with explicitly exported constants and pure helpers. Inject fflate into admission so Node tests can use the real package without a browser.
- [ ] Stream decompressed chunks through a counting sink; retain only bounded overlap needed for XML token counting. Abort immediately when any limit is exceeded.
- [ ] Implement the enumerated formatter and sparse geometry helpers without `innerHTML`, formula evaluation, or external links.
- [ ] Run the test file and frontend syntax check.
- [ ] Commit: `feat(preview): COD-280 validate XLSX browser workloads`.

### Task 4: Implement the worker-owned workbook and tile protocol

**Files:** `src/web/public/spreadsheet-preview-worker.js`, `test/spreadsheet-preview-worker.test.ts`, focused asset checks.

- [ ] Create a small XLSX fixture at test runtime with ExcelJS: multiple visible sheets, a hidden sheet, cached formula result, merge, dimensions, styles, and a common date format.
- [ ] Add RED worker-harness tests for:
  - ready → transferred bytes → admitted parse → metadata ordering;
  - no ExcelJS parse call before streaming admission succeeds;
  - metadata includes visible sheets, sparse geometry, zero-size hidden overrides, bounded style table, and feature warnings;
  - hidden/`veryHidden` sheets are not normalized;
  - no-visible-sheets and empty-sheet states;
  - tile requests echo monotonically increasing request ID and sheet ID;
  - tiles contain only intersecting cells/styles/merges and remain bounded;
  - stale/out-of-order requests can be identified without a full-model clone;
  - timeout/error/messageerror/OOM-like termination maps to deterministic errors;
  - number-format warnings discovered during tile formatting are returned with the tile.
- [ ] Run the worker test and confirm failure.
- [ ] Implement the classic worker with versioned, same-origin `importScripts` for fflate, core, and ExcelJS.
- [ ] Keep the ExcelJS workbook exclusively inside the worker after successful parse; service metadata and tile messages until explicit dispose/termination.
- [ ] Run worker/core tests and frontend syntax/public-asset checks.
- [ ] Commit: `feat(preview): COD-280 parse XLSX in a bounded worker`.

### Task 5: Implement the virtualized spreadsheet renderer

**Files:** `src/web/public/spreadsheet-preview.js`, `src/web/public/index.html`, `src/web/public/styles.css`, `src/web/public/mobile.css`, `test/spreadsheet-preview.test.ts`.

- [ ] Add RED VM/DOM tests for:
  - metadata-size refusal before fetch;
  - fetch uses same-origin guarded `preview=true` URL and transfers the `ArrayBuffer`;
  - `AbortController` cancels fetch on dispose;
  - worker timeout starts only after ready byte transfer and is injectable;
  - tab switching reuses one fetch/worker parse;
  - request ID + sheet ID reject late tiles within the same preview;
  - virtual DOM node count stays bounded for a large sparse range;
  - offscreen-anchor merges render when intersecting the viewport;
  - style IDs resolve through allowlisted generated classes;
  - all cells use `textContent`, not workbook-derived HTML;
  - grid/tab containers carry ancestor `data-i18n-skip`;
  - errors/limits preserve the download action.
- [ ] Run the renderer test and confirm failure.
- [ ] Implement renderer lifecycle: open, select sheet, request viewport, resize, dispose.
- [ ] Use a clamped physical spacer mapped to logical sparse geometry; render visible cells/headings plus overscan only.
- [ ] Add accessible tabs, loading/empty/error/fidelity states, and responsive touch scrolling.
- [ ] Load only the small renderer entry from `index.html`; parser bundles remain lazy through the worker.
- [ ] Run renderer test, frontend syntax, formatting, and public-asset checks.
- [ ] Commit: `feat(ui): COD-280 render virtualized XLSX worksheets`.

### Task 6: Integrate with the shared preview overlay and i18n

**Files:** `src/web/public/panels-ui.js`, `src/web/public/i18n.js`, `src/web/public/styles.css`, `src/web/public/mobile.css`, `test/spreadsheet-preview.test.ts`, affected existing viewer tests.

- [ ] Add RED integration tests for:
  - `_renderFilePreviewBody` delegates `type: spreadsheet` to the renderer;
  - exact `filePreviewState` identity guards fetches, worker messages, tiles, polling refresh, close, and replacement;
  - renderer disposal occurs before another preview branch renders;
  - attachment navigation and live refresh reparse only after signature changes;
  - existing original-download URL remains identity-derived, includes `download=true`, and returns XLSX bytes/name;
  - preview failure does not disable Download;
  - viewer-owned English/Chinese strings exist while workbook content inherits the ancestor translation skip.
- [ ] Run the new renderer test plus existing original-download, source-download, navigation, and document-render-state files; confirm RED only for new behavior.
- [ ] Add the spreadsheet branch and disposal hooks without changing established download success/error behavior for other file types.
- [ ] Add i18n strings and scoped desktop/mobile CSS.
- [ ] Run the focused integration set, frontend syntax, and format check.
- [ ] Commit: `feat(ui): COD-280 integrate XLSX attachment previews`.

### Task 7: Add actual browser/CSP/mobile coverage

**Files:** `test/spreadsheet-preview.browser.test.ts`.

- [ ] Add a Playwright test that serves Codeman CSP, opens a real XLSX, and records every request.
- [ ] Assert Worker and both vendor bundles are same-origin/versioned; no workbook data or asset request leaves the origin.
- [ ] Assert multiple sheet tabs, cell text, merge geometry, and download behavior.
- [ ] Assert a narrow mobile viewport supports two-axis scrolling and horizontal tab scrolling without translating workbook content.
- [ ] Assert stale tile response handling under rapid scroll/tab changes.
- [ ] Run only this browser test and capture a screenshot for Jira/PR evidence.
- [ ] Commit: `test(ui): COD-280 exercise XLSX preview in Chromium`.

### Task 8: Final verification and traceability

- [ ] Run each focused file or safe group:

```bash
npm test -- test/spreadsheet-xlsx-core.test.ts
npm test -- test/spreadsheet-preview-worker.test.ts
npm test -- test/spreadsheet-preview.test.ts
npm test -- test/routes/file-routes.test.ts
npm test -- test/routes/file-routes-remote-sftp.test.ts
npm test -- test/file-preview-original-download.test.ts
npm test -- test/file-preview-source-download.test.ts
npm test -- test/file-preview-navigation.test.ts
npm test -- test/document-preview-render-state.test.ts
npm test -- test/spreadsheet-preview.browser.test.ts
```

- [ ] Run quality gates separately:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:frontend-syntax
npm run check:public-assets
npm run check:lockfile
npm run build
git diff --check
```

- [ ] Inspect branch scope with `git status --short --branch`, `git diff --stat origin/local...HEAD`, and recent log.
- [ ] Use the verification-before-completion and requesting-code-review workflows.
- [ ] Update COD-280 with branch, commits, exact test counts, quality gates, screenshot, fidelity limits, and the documented non-CI Playwright gap. Do not mark Done until the branch is pushed and landed.
