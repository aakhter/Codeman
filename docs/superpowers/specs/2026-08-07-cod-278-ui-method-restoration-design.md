# COD-278 UI Method Restoration Design

## Problem

Commit `a8929ead` removed duplicated UI feature blocks, but those blocks also contained fifteen method definitions that
have no surviving definition. Current callers still invoke methods such as `_onSessionListMaybeChanged()` and
`formatFileSize()`, producing uncaught browser errors. The affected long-lived page showed a blank Shortcuts settings
panel, and realistic smoke also lost attachment cards.

## Chosen approach

Keep the legitimate duplicate cleanup and selectively restore the fifteen unique methods from the pre-cleanup parent.
Restore them in `panels-ui.js` beside their owning session-list or file-preview behavior. Do not reintroduce either
duplicate Away Digest or duplicate attachment implementation.

The restored surface is:

- Session refresh: `_onSessionListMaybeChanged`.
- File preview utilities: `_copyFilePreviewImage`, `copyFilePreviewContent`, `_countWords`, `_formatReadingMeta`,
  `_slugifyHeading`, `_buildDocumentOutline`, `_setupOutlineScrollSpy`, `_teardownOutlineScrollSpy`, `_readPreviewPref`,
  `_writePreviewPref`, `toggleDocumentOutline`, `toggleReadingView`, `getFileIcon`, and `formatFileSize`.

## Safety and testing

Add a regression test that compares method definitions removed by `a8929ead` with the composed current public UI and
fails if a removed method has no surviving definition. Assert the known COD-278 methods explicitly so the contract
remains readable. Prove the test red on current `HEAD`, restore only the missing methods, and prove it green.

Run the focused shortcut and document/attachment tests, strict static gates, production build, and the realistic browser
smoke. After merging to `local`, rerun the focused merged-result tests. Deploy `codeman-web`, require an active unit and
three HTTP 200 probes on port 3002, then use Chromium against the deployed service to verify:

- App Settings -> Shortcuts renders all 18 rows.
- `Ctrl+/` opens the 18-row shortcut overlay from xterm.
- representative session refresh calls do not throw.
- file-size/icon/preview helpers exist and an attachment card renders.
- no page errors are observed.

Push `local` to Bitbucket only after deployed verification succeeds. Update COD-278 with branch, commits, tests, merge,
deployment, and live evidence before transitioning it to Done.

## Non-goals

No broad UI-module refactor, shortcut redesign, changeset/version bump, or unrelated cleanup is included.
