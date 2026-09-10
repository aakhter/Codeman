# COD-434 descriptive marker preview-path bounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a descriptive marker line link only its final valid relative document path, excluding the prose prefix and trailing sentence punctuation.

**Architecture:** Keep the behavior inside the existing terminal link provider. Add one conservative extraction helper beside the current bounded-marker helper, run it only after absolute/label/wrapper recognition, and feed the extracted candidate through the existing path validation and resolution gates. No preview routes or activation APIs change.

**Tech Stack:** TypeScript/Vitest test harness, shipped browser JavaScript in `src/web/public/terminal-ui.js`, xterm-style terminal range mapping.

---

### Task 1: Add the failing descriptive-marker regression test

**Files:**
- Modify: `test/terminal-document-link-provider.test.ts` near the existing COD-390 descriptive marker tests.

- [ ] **Step 1: Add one test for the reported unwrapped marker form.**

Add this test beside the existing bounded descriptive-marker tests:

```ts
  it('links only the final relative path in descriptive marker prose', () => {
    const path = 'out/cisco-my-agent-learning-lab-2026-09/deliverables/cisco-my-agent-learning-lab-overall-plan.docx';
    const line = `• Updated ${path}.`;
    const { provide, previewSpy, originalSessionId } = makeHarness(line);

    const [link] = provide();

    expect(link.text).toBe(path);
    expect(link.range.start).toEqual({ x: line.indexOf(path) + 1, y: 1 });
    expect(link.range.end).toEqual({ x: line.indexOf(path) + path.length, y: 1 });
    link.activate(null, link.text);
    expect(previewSpy).toHaveBeenCalledWith(path, originalSessionId);
  });
```

- [ ] **Step 2: Add the ambiguity guard test.**

Add a second test immediately after it:

```ts
  it('does not select a final suffix when marker prose contains an earlier path-like segment', () => {
    const line = '• Compared out/previous/report.docx with out/current/report.docx.';
    const { provide } = makeHarness(line);

    expect(provide()).toEqual([]);
  });
```

- [ ] **Step 3: Run the focused test file and verify RED.**

Run:

```bash
npm test -- test/terminal-document-link-provider.test.ts
```

Expected result: the existing suite fails on the two new tests because the
current marker branch treats the whole descriptive remainder as one candidate
and does not extract the final path. Existing tests should remain passing.

- [ ] **Step 4: Commit the test-only change.**

Run:

```bash
git add test/terminal-document-link-provider.test.ts
git commit -m "test(terminal): COD-434 cover descriptive preview path bounds"
```

### Task 2: Implement conservative final-token extraction

**Files:**
- Modify: `src/web/public/terminal-ui.js` in `registerFilePathLinkProvider()`, beside `trailingBoundedRelativePath()` and the marker scanner.

- [ ] **Step 1: Add the helper for an unwrapped descriptive suffix.**

After `trailingBoundedRelativePath`, add:

```js
      const trailingDescriptiveRelativePath = (value) => {
        const trimmed = trimTrailingPunctuation(value);
        const match = /^(.*?)\s+(\S+)$/.exec(trimmed);
        if (!match) return null;
        const prefix = match[1].trim();
        const path = match[2];
        const prefixTokens = prefix.split(/\s+/);
        if (
          prefixTokens.length !== 1 ||
          prefix.includes('/') ||
          /\.[a-z0-9]{1,10}$/i.test(prefix) ||
          !path.includes('/')
        )
          return null;
        return {
          path,
          offset: match[0].length - path.length,
        };
      };
```

The helper must only return a final non-space token when the prefix is exactly
one non-space token with no slash or filename-like extension. That makes the
branch work for `Updated out/report.docx` while rejecting a marker whose prose
already contains another path, URL, or bare filename. It must not shorten
unwrapped spaced paths; those remain on the existing complete-marker behavior,
while explicitly wrapped and labeled spaced paths retain their current branch.

- [ ] **Step 2: Prefer the new extraction after existing explicit bounds.**

In the marker loop, compute the helper only when the existing description-label
and wrapper matches did not succeed:

```js
        const trailingDescriptivePath = !descriptionPathMatch && !boundedRelativePath
          ? trailingDescriptiveRelativePath(rawCandidate)
          : null;
```

Update candidate selection to prefer the new extracted path before falling
back to the complete trimmed marker remainder:

```js
              : boundedRelativePath?.path || trailingDescriptivePath?.path || trimmedRawCandidate)
```

Update the start-index calculation with the matching source offset:

```js
                : boundedRelativePath
                  ? boundedRelativePath.offset
                  : trailingDescriptivePath
                    ? trailingDescriptivePath.offset
                    : 0);
```

Pass the new branch through the same unspaced-relative-path allowance used by
explicitly bounded paths:

```js
        if (!candidate || !isSingleRelativePath(candidate, Boolean(descriptionPathMatch || boundedRelativePath || trailingDescriptivePath))) {
```

Keep the existing `suppress`, `blockPreview`, `resolveRelativeCandidate`, and
activation logic unchanged. This preserves all current workspace, pane-cwd,
remote, Docker, and external-preview behavior.

- [ ] **Step 3: Run the focused test file and verify GREEN.**

Run:

```bash
npm test -- test/terminal-document-link-provider.test.ts
```

Expected result: all tests pass, including the two COD-434 regressions. The
new link text must be exactly the document path, and the range end must stop on
the final path character before the period.

- [ ] **Step 4: Run the frontend syntax check.**

Run:

```bash
npm run check:frontend-syntax
```

Expected result: exit 0 with no JavaScript syntax errors.

- [ ] **Step 5: Commit the implementation.**

Run:

```bash
git add src/web/public/terminal-ui.js
git commit -m "fix(terminal): COD-434 bound descriptive preview paths"
```

### Task 3: Verify the complete change

**Files:**
- Verify: `src/web/public/terminal-ui.js`
- Verify: `test/terminal-document-link-provider.test.ts`
- Verify: `docs/superpowers/specs/2026-09-10-cod-434-descriptive-preview-path-design.md`

- [ ] **Step 1: Run the focused regression suite again.**

Run:

```bash
npm test -- test/terminal-document-link-provider.test.ts
```

Expected result: 117 tests pass with 0 failures, including the two new COD-434
tests.

- [ ] **Step 2: Run repository static checks.**

Run each command from the COD-434 worktree:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run check:frontend-syntax
npm run check:public-assets
npm run check:browser-excludes
```

Expected result: every command exits 0. These checks cover TypeScript, shipped
public-asset syntax/formatting, lockfile consistency, and test-suite exclusion
rules without running the unsafe bare full suite.

- [ ] **Step 3: Inspect the final diff and worktree.**

Run:

```bash
git diff HEAD~2..HEAD --check
git status --short --branch
git log -3 --oneline
```

Expected result: only the COD-434 spec, focused regression tests, and the
terminal provider implementation are present; the branch is
`COD-434-descriptive-preview-path` and the worktree is clean.
