# COD-261 attachment-viewer original-file download — implementation plan

> **Execution:** use TDD. Run each named Vitest file individually; never invoke the full suite.

## 1. Add the shared viewer control

**Files:** `src/web/public/index.html`, `src/web/public/panels-ui.js`, `src/web/public/styles.css`, `src/web/public/mobile.css`

1. Add a disabled header Download control beside the existing viewer actions, with a stable element ID, `type="button"`, visible desktop label, tooltip, and `aria-label="Download original file"`.
2. Introduce viewer-specific state reset/enable helpers. Reset before a new preview, then enable from the assigned `filePreviewState` identity after assignment—never after metadata resolves.
3. Add a single frontend helper that creates the encoded original raw route from `sessionId` plus either `attachmentId` or `filePath`, adds `download=true`, and optionally adds `_t` from the active state’s `mtimeMs`. It must never inspect metadata `previewUrl` or `url`.
4. Add a viewer download handler that rechecks state identity before fetching the raw route, uses the existing fetch→Blob/browser-download behavior, and shows an error toast only on failure. It must retain the shared helper’s silent-success behavior.
5. Capture `mtimeMs` onto the current state after every metadata result and every metadata/signature refresh path, including normal polling, document-diff exit, and DOCX-view switching.
6. Remove the workspace-only Office footer source-download control. Retain Export PDF.
7. Apply `#toolbar=0` to converted Office preview iframes for both workspace and attachment previews, while native PDF behavior remains unchanged.
8. Add only scoped viewer-header responsive CSS: at ≤430px the control becomes icon-only while keeping its accessible label; the title can shrink and action group cannot overlap navigation/actions.

## 2. Write RED tests, then implement GREEN behavior

**New focused test:** `test/file-preview-original-download.test.ts`

1. Establish a minimal `panels-ui.js` VM harness modeled on existing viewer tests.
2. Add failing cases for attachment and workspace raw-route construction, `download=true`, encoded identities, optional `_t`, and metadata URL non-use.
3. Add failing cases for immediate enabled state, close/replacement reset, stale activation rejection, Blob download, silent success, and error toast behavior.
4. Add failing cases for Office source-vs-rendered behavior, attachment/converted-preview toolbar suppression, image Copy coexistence, and narrow header markup/CSS contract.
5. Implement the smallest matching runtime changes, rerunning this one test file after each behavior group.

## 3. Update affected regression suites

**Files:** `test/file-preview-source-download.test.ts`, `test/file-preview-source-download.browser.test.ts`, `test/file-preview-open-new-tab.test.ts`, `test/document-preview-render-state.test.ts`

1. Replace assertions for the removed workspace Office footer source-download button with the shared header action behavior.
2. Require `#toolbar=0` for attachment Office conversions; retain no fragment for native PDFs.
3. Reuse existing Open in New Tab tests rather than duplicating them; add only direct regression coverage needed for coexistence.
4. Keep browser-test coverage limited to existing files—do not create another `.browser.test.ts` file.

## 4. Verify

Run, in order:

```bash
npm test -- test/file-preview-original-download.test.ts
npm test -- test/file-preview-source-download.test.ts
npm test -- test/file-preview-source-download.browser.test.ts
npm test -- test/file-preview-open-new-tab.test.ts
npm test -- test/document-preview-render-state.test.ts
npm run typecheck
npx eslint --config config/eslint.config.js src/web/public/panels-ui.js
npm run check:frontend-syntax
npm run check:public-assets
npm run check:lockfile
npm run build
```

Then run the candidate in its isolated beta target and use Chromium to verify original bytes/name, converted Office source download with hidden PDF toolbar, attachment and workspace cases, failure toast, no success toast, desktop layout, and ≤430px layout. Do not deploy production.
