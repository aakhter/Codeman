# COD-260 Attachment Viewer Open-in-New-Tab Implementation Plan

## Scope

Implement the approved frontend-only design in `docs/superpowers/specs/2026-08-02-cod-260-open-preview-new-tab-design.md`. The work is one tightly coupled TDD task: header markup, preview-state URL derivation/activation, and focused behavior tests.

## Task 1: Add the safe state-owned open-in-new-tab action

### RED

Create `test/file-preview-open-new-tab.test.ts` using the existing `vm`-loaded `panels-ui.js` pattern. Exercise shipped markup and real prototype methods with small DOM doubles.

The initial failing assertions must cover:

- a disabled, accessible `filePreviewOpenNewTab` header button wired to `app.openFilePreviewInNewTab()`;
- reset/disabled state at the beginning of each `openFilePreview()` and after `closeFilePreview()`;
- current metadata preferring `previewUrl` over `url` and enabling the action;
- exact guarded attachment and workspace raw fallbacks when both metadata URLs are absent;
- same-origin URL normalization and rejection of cross-origin, malformed, and non-HTTP(S) candidates;
- activation using `_blank` plus `noopener`, defensively clearing a returned window's opener;
- no `window.open()` call without a current approved URL; and
- stale metadata from an older preview never enabling or replacing the current action.

Run `npm test -- test/file-preview-open-new-tab.test.ts` and capture the expected RED result before changing runtime files.

### GREEN

Update `src/web/public/index.html`:

- add the compact `Open in new tab` button beside Copy and Close;
- use `type="button"`, `id="filePreviewOpenNewTab"`, matching title/ARIA label, and an external-navigation glyph;
- ship it disabled by default.

Update `src/web/public/panels-ui.js` with focused helpers:

- `_resetFilePreviewExternalAction()` clears the current state's `externalPreviewUrl`, when present, and disables the header button;
- `_resolveFilePreviewExternalUrl(data, previewState)` evaluates `previewUrl`, `url`, then the identity-derived guarded raw fallback; accepts only HTTP(S) URLs on `window.location.origin`; and returns only the normalized same-origin path/query/fragment;
- `_setFilePreviewExternalUrl(previewState, data)` publishes and enables only if `previewState` remains current;
- `openFilePreviewInNewTab()` reads only the current state's approved URL, calls `window.open(url, '_blank', 'noopener')`, and defensively nulls a returned opener; and
- `openFilePreview()` resets before loading and publishes after current-state metadata succeeds, while `closeFilePreview()` disables the action after teardown.

Keep the existing metadata/render/navigation/polling lifecycle intact. Do not add backend routes, persistence, standalone viewer state, keyboard shortcuts, or COD-261 download behavior.

### Focused verification

Run:

```bash
npm test -- test/file-preview-open-new-tab.test.ts
npm test -- test/file-preview-navigation.test.ts
npm test -- test/document-preview-render-state.test.ts
```

Then commit the implementation with a `COD-260` Conventional Commit subject and report RED/GREEN evidence, files changed, and any concern.

## Independent review and landing gates

After the implementer commits:

1. Independent specification review compares the actual diff to the approved design and this plan.
2. Independent quality review checks URL safety, stale-state handling, popup isolation, accessibility, test realism, and scope discipline.
3. The orchestrator reruns focused tests plus `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run check:lockfile`, frontend syntax/public-asset checks, `git diff --check`, and `npm run build`.
4. Serve the exact branch on the isolated beta slot and use Chromium to verify desktop and phone header layout, a real same-origin new-tab target, unchanged overlay state, and zero page errors.
5. Fast-forward `local` only after all gates pass, push only Bitbucket `origin`, add Jira worklog/evidence/structured commit link, mark Done, and flag deploy-pending. Do not deploy production without a separate explicit `deploy` authorization.
