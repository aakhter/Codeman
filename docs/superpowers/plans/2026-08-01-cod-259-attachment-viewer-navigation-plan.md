# COD-259 Attachment Viewer Navigation Implementation Plan

## Task 1: Add a focused navigation regression harness

Create `test/file-preview-navigation.test.ts` using the existing pattern that evaluates the shipped `panels-ui.js` object literal against a jsdom preview header/body/footer. Exercise real `openFilePreview()` and navigation methods with mocked `fetch` responses.

Witness RED before production edits for: a three-item server history showing navigation; endpoint ordering and boundaries; clicking Next/Previous re-entering the canonical open path; missing-item filtering; attachment-ID-first/path-fallback matching; hidden controls for unmatched, singleton, failed, malformed, closed, and stale history responses.

## Task 2: Implement the minimal frontend behavior

Add a hidden, accessible Previous / `N of M` / Next group to the static file-preview header in `src/web/public/index.html`, with compact responsive styling in `src/web/public/styles.css`.

In every runtime-effective duplicate of the relevant `panels-ui.js` methods, reset the controls for every open, start a non-blocking attachment-history read tied to the new `filePreviewState` identity, derive filtered navigation state from the existing `/api/sessions/:id/attachments` response, and update controls only while that identity remains current. Add bounded navigation methods that resolve the neighbor from the state snapshot and call `openFilePreview()` with its exact path/session/attachment ID. Keep preview rendering independent of history failures and preserve all existing polling/conversion teardown behavior.

Run the new focused test GREEN, then the closest existing preview/attachment regression files.

## Task 3: Review and independent verification

Commit the implementation with a COD-259 Conventional Commit subject. Run separate specification and quality reviews; remediate and re-review any findings.

The orchestrator independently runs the new regression, relevant neighboring tests, typecheck, lint, format check, lockfile check, frontend syntax/public assets, `git diff --check`, and production build. Serve only the issue worktree on isolated beta `:5000`; use real Chromium to assert visible controls, exact order, boundary states, document switching, responsive header layout, and zero page errors. Stop the exact beta PID.

Fast-forward the verified branch into `local`, re-run the focused merged-result regression, push only Bitbucket `origin/local`, remove the issue worktree/branch, and complete the Jira comments/worklog/link/Done readback. Do not deploy production.
