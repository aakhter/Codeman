# COD-431 Preview Link Bounds with Sentence Punctuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep descriptive marker-led terminal bullets outside the clickable preview range when sentence punctuation follows the bounded path, while preserving the existing bounded-path behavior from COD-429.

**Architecture:** The xterm link provider in `src/web/public/terminal-ui.js` recognizes marker-led lines before the fallback token scanner. Preserve closing delimiters while removing only sentence punctuation before bounded-path extraction; the existing extractor and validation continue to determine the link text and range. No preview route or backend behavior changes.

**Tech Stack:** Plain browser JavaScript, xterm link-provider API, Vitest with the existing terminal-provider harness.

---

### Task 1: Add the failing regression test

**Files:**
- Modify: `test/terminal-document-link-provider.test.ts` in the COD-232 marker-preview tests.

- [ ] **Step 1: Add the reported punctuation case**

Add this test beside the existing bounded-marker tests:

```ts
  it('links only the bounded path when sentence punctuation follows a descriptive bullet', () => {
    const path = 'out/networking-ai-era-session/deliverables/ai-networking-vision-discussion-deck.pptx';
    const line = `- Editable PowerPoint (${path}).`;
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
npm test -- --run test/terminal-document-link-provider.test.ts -t "sentence punctuation follows"
```

Expected: FAIL because trimming the trailing period also removes the closing `)`, so bounded extraction misses and the returned link includes the descriptive prose.

### Task 2: Implement the minimal bounded-path fix

**Files:**
- Modify: `src/web/public/terminal-ui.js` in the marker candidate preparation inside `findPreviewReferences`.

- [ ] **Step 1: Strip sentence punctuation without stripping the closing bound**

Add a sentence-punctuation-only intermediate before `trailingBoundedRelativePath`:

```js
const sentenceTrimmedRawCandidate = rawCandidate.replace(/[.,;:!?]+$/, '');
const trimmedRawCandidate = trimTrailingPunctuation(rawCandidate);
const boundedRelativePath = !descriptionPathMatch
  ? trailingBoundedRelativePath(rawCandidate) ||
    trailingBoundedRelativePath(sentenceTrimmedRawCandidate) ||
    trailingBoundedRelativePath(trimmedRawCandidate)
  : null;
```

Use `sentenceTrimmedRawCandidate` for bounded extraction while leaving the
existing `trimmedRawCandidate` behavior intact for unbounded candidates. Do not
change the fallback scanner or preview routes.

- [ ] **Step 2: Run the focused provider suite**

Run:

```bash
npm test -- --run test/terminal-document-link-provider.test.ts
```

Expected: PASS for all tests, including the new punctuation regression and existing ASCII marker/source-locator cases.

- [ ] **Step 3: Commit the implementation**

```bash
git add src/web/public/terminal-ui.js test/terminal-document-link-provider.test.ts
git commit -m "fix(terminal): COD-431 preserve bounded preview links"
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

Expected: the branch is `cod-431-dash-preview-link`, the worktree is clean after the implementation commit, and the diff contains only bounded-candidate preparation plus the focused regression test.

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
