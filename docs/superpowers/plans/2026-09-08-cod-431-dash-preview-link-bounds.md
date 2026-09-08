# COD-431 Dash-Led Preview Link Bounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep descriptive dash-led terminal bullets outside the clickable preview range while preserving the existing bounded-path behavior from COD-429.

**Architecture:** The xterm link provider in `src/web/public/terminal-ui.js` recognizes marker-led lines before the fallback token scanner. Extend only that marker grammar to include en/em dashes; the existing bounded-path extractor and validation continue to determine the link text and range. No preview route or backend behavior changes.

**Tech Stack:** Plain browser JavaScript, xterm link-provider API, Vitest with the existing terminal-provider harness.

---

### Task 1: Add the failing regression test

**Files:**
- Modify: `test/terminal-document-link-provider.test.ts` in the COD-232 marker-preview tests.

- [ ] **Step 1: Add the reported en-dash case**

Add this test beside the existing bounded-marker tests:

```ts
  it('links only the bounded path in an en-dash descriptive bullet', () => {
    const path = 'out/networking-ai-era-session/deliverables/ai-networking-vision-discussion-deck.pptx';
    const line = `– Editable PowerPoint (${path})`;
    const { provide, previewSpy, originalSessionId } = makeHarness(line);

    const [link] = provide();

    expect(link.text).toBe(path);
    expect(link.range.start).toEqual({ x: line.indexOf(path) + 1, y: 1 });
    expect(link.range.end).toEqual({ x: line.indexOf(path) + path.length, y: 1 });
    link.activate(null, link.text);
    expect(previewSpy).toHaveBeenCalledWith(path, originalSessionId);
  });
```

- [ ] **Step 2: Run only the new test and confirm the expected failure**

Run:

```bash
npm test -- --run test/terminal-document-link-provider.test.ts -t "en-dash descriptive bullet"
```

Expected: FAIL because the current marker regular expression does not classify `–` as a marker, so the returned link is not the bounded path with the expected range.

### Task 2: Implement the minimal marker-bound fix

**Files:**
- Modify: `src/web/public/terminal-ui.js` at the `markerMatch` expression in `findPreviewReferences`.

- [ ] **Step 1: Extend only the marker character class**

Change:

```js
const markerMatch = /^(\s*(?:\d+[.)]|[-*•])[ \t]+)(.+)$/.exec(lineText.slice(markerOffset));
```

to:

```js
const markerMatch = /^(\s*(?:\d+[.)]|[-*•–—])[ \t]+)(.+)$/.exec(lineText.slice(markerOffset));
```

Do not change `trailingBoundedRelativePath`, `isSingleRelativePath`, suppression, or fallback scanning. The prior COD-429 logic already extracts the parenthesized path and maps its exact offset.

- [ ] **Step 2: Run the focused provider suite**

Run:

```bash
npm test -- --run test/terminal-document-link-provider.test.ts
```

Expected: PASS for all tests, including the new en-dash regression and existing ASCII marker/source-locator cases.

- [ ] **Step 3: Commit the implementation**

```bash
git add src/web/public/terminal-ui.js test/terminal-document-link-provider.test.ts
git commit -m "fix(terminal): COD-431 bound dash preview links"
```

### Task 3: Run proportional repository verification

**Files:**
- Verify only; no additional source changes expected.

- [ ] **Step 1: Check changed files and branch identity**

Run:

```bash
git branch --show-current
git status --short
git diff cod-429-marker-preview-link...HEAD -- src/web/public/terminal-ui.js test/terminal-document-link-provider.test.ts
```

Expected: the branch is `cod-431-dash-preview-link`, the worktree is clean after the commit, and the diff contains only marker recognition plus the focused regression test.

- [ ] **Step 2: Run the frontend/static checks required for review**

Run:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run check:frontend-syntax
npm run check:public-assets
```

Expected: every command exits 0. The targeted test from Task 2 remains the behavioral evidence for the bug fix.
