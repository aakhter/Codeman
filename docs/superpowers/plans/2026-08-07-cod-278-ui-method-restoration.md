# COD-278 UI Method Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore every unique UI method accidentally deleted by `a8929ead` and prove shortcuts and adjacent browser surfaces work before pushing the deployed merge.

**Architecture:** Preserve the deduplicated module layout. Add a static composed-method contract, then restore only the fifteen missing session/file-preview methods in `panels-ui.js` from the known-good parent implementation.

**Tech Stack:** Plain browser JavaScript, TypeScript/Vitest static contract tests, Playwright/Chromium realistic smoke, esbuild production assets, systemd user service.

---

### Task 1: Add the COD-278 composed-method contract

**Files:**
- Create: `test/public-ui-method-contract.test.ts`

- [ ] **Step 1: Write a focused test that extracts method definitions from `app.js`, `settings-ui.js`, `terminal-ui.js`, and `panels-ui.js`, and asserts definitions for the fifteen COD-278 methods.**

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI_FILES = ['app.js', 'settings-ui.js', 'terminal-ui.js', 'panels-ui.js'];
const REQUIRED_METHODS = [
  '_onSessionListMaybeChanged',
  '_copyFilePreviewImage',
  'copyFilePreviewContent',
  '_countWords',
  '_formatReadingMeta',
  '_slugifyHeading',
  '_buildDocumentOutline',
  '_setupOutlineScrollSpy',
  '_teardownOutlineScrollSpy',
  '_readPreviewPref',
  '_writePreviewPref',
  'toggleDocumentOutline',
  'toggleReadingView',
  'getFileIcon',
  'formatFileSize',
];

function publicUiMethodNames(): Set<string> {
  const names = new Set<string>();
  const pattern = /^\s{2}(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\([^;]*\)\s*\{/gm;
  for (const file of UI_FILES) {
    const source = readFileSync(resolve('src/web/public', file), 'utf8');
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  return names;
}

describe('public UI method contract', () => {
  it.each(REQUIRED_METHODS)('defines %s after module composition', (method) => {
    expect(publicUiMethodNames().has(method)).toBe(true);
  });
});
```
- [ ] **Step 2: Run `npm test -- test/public-ui-method-contract.test.ts` and verify it fails because `_onSessionListMaybeChanged`, `formatFileSize`, and the other methods are undefined.**
- [ ] **Step 3: Commit the red regression test with `test(ui): COD-278 detect deleted public UI methods`.**

### Task 2: Restore only the unique methods

**Files:**
- Modify: `src/web/public/panels-ui.js`
- Test: `test/public-ui-method-contract.test.ts`

- [ ] **Step 1: Restore `_onSessionListMaybeChanged` beside the session-list UI helpers.**
- [ ] **Step 2: Restore the fourteen file-preview helpers beside the surviving file-preview implementation.**

Use the exact known-good implementations from `a8929ead^:src/web/public/panels-ui.js`: session refresh at line 1203 and
the contiguous file-preview helper region at lines 6260-6494. Copy only the fifteen named methods from Task 1; do not
copy their surrounding duplicate feature sections.
- [ ] **Step 3: Run `npm test -- test/public-ui-method-contract.test.ts` and verify it passes.**
- [ ] **Step 4: Run `node --check src/web/public/panels-ui.js` and inspect the diff to confirm no duplicate Away Digest or attachment block returned.**
- [ ] **Step 5: Commit with `fix(ui): COD-278 restore methods lost during deduplication`.**

### Task 3: Focused and static verification

**Files:**
- Verify only; no expected source changes.

- [ ] **Step 1: Run the method contract, shortcut registry, keyboard shortcut, document preview, attachment, and relevant route tests as explicitly scoped Vitest files.**
- [ ] **Step 2: Run `npm run typecheck`, `npm run lint`, `npm run format:check`, and `npm run check:lockfile`.**
- [ ] **Step 3: Run `npm run build` and confirm zero missing-method browser errors in the generated asset composition.**

### Task 4: Real-browser verification and review

**Files:**
- Verify only; artifacts under `/tmp`.

- [ ] **Step 1: Run the Codeman realistic smoke against a temporary dev server with Claude skipped.**
- [ ] **Step 2: Verify shortcut settings contain 18 rows, `Ctrl+/` opens 18 overlay rows, session refresh is callable, and attachment cards render without page errors.**
- [ ] **Step 3: Review the complete branch diff and verification evidence before integration.**

### Task 5: Integrate, deploy, verify, then push

**Files:**
- Merge the verified commits into root branch `local`.

- [ ] **Step 1: Fetch Bitbucket `origin/local`, merge it into the issue branch if needed, and rerun the focused regression.**
- [ ] **Step 2: Merge the issue branch into root `local` and rerun the focused merged-result tests.**
- [ ] **Step 3: Use the established sync/deploy workflow to build and restart `codeman-web` without pushing yet.**
- [ ] **Step 4: Require active systemd status, three HTTP 200 probes on port 3002, deployed asset markers, and the live Chromium shortcut/attachment/SSE checks.**
- [ ] **Step 5: Push verified `local` to Bitbucket `origin`, fetch, and prove local/origin equality.**
- [ ] **Step 6: Comment on COD-278 with commits and verification, transition it to Done, and clean only the merged issue worktree/branch.**
