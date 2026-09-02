# COD-390 Labeled Spaced Path Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve `Path:`, `File:`, and `Saved to:` terminal references containing absolute paths with spaces as one safe, complete preview link.

**Architecture:** Extend `findPreviewReferences()` before generic whitespace tokenization with a case-insensitive labeled absolute-path candidate. Reuse `isSingleAbsolutePath()`, `normalizePreviewPath()`, and the current local external-preview policy; suppress the complete candidate whenever it cannot be safely routed so later scanners cannot create a relative tail.

**Tech Stack:** Browser JavaScript, xterm link provider, Vitest.

---

## File structure

- Modify: `src/web/public/terminal-ui.js:2395-2555` — recognize and safely route an absolute path after the approved labels.
- Modify: `test/terminal-document-link-provider.test.ts:628-775` — regressions for complete labeled paths, safe routing, and rejected tails.

### Task 1: Prove the reported labeled-path regression

**Files:**

- Modify: `test/terminal-document-link-provider.test.ts:after COD-288 own-line spaced path tests`
- Test: `test/terminal-document-link-provider.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
const REPORTED =
  '/mnt/syncthing/brain/90 Sensitive/cisco/training/smart-switch-training-attendees.xlsx';

it.each(['Path:', 'File:', 'Saved to:'])('links the complete spaced path after %s', (label) => {
  const { provide, previewSpy, originalSessionId } = makeHarness(`${label} ${REPORTED}`, {
    workingDir: '/mnt/syncthing/brain',
  });

  const [link] = provide();
  expect(link.text).toBe(REPORTED);
  link.activate(null, link.text);
  expect(previewSpy).toHaveBeenCalledWith('90 Sensitive/cisco/training/smart-switch-training-attendees.xlsx', originalSessionId);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/terminal-document-link-provider.test.ts -t "links the complete spaced path"`

Expected: FAIL because the provider currently returns the whitespace-delimited tail instead of `REPORTED`.

- [ ] **Step 3: Add safe-routing regressions**

```ts
it('uses external preview for a complete local Path target outside the workspace', () => {
  const { provide, externalPreviewSpy, originalSessionId } = makeHarness(`Path: ${REPORTED}`, {
    workingDir: '/opt/projects/Codeman',
  });
  const [link] = provide();
  expect(link.text).toBe(REPORTED);
  link.activate(null, link.text);
  expect(externalPreviewSpy).toHaveBeenCalledWith(REPORTED, originalSessionId);
});

it('does not link a relative tail from an invalid labeled candidate', () => {
  const { provide } = makeHarness('File: /mnt/syncthing/brain/90 Sensitive/../private/report.xlsx', {
    workingDir: '/mnt/syncthing/brain',
  });
  expect(provide()).toEqual([]);
});
```

- [ ] **Step 4: Run the new test group to verify each assertion fails for the missing label rule**

Run: `npm test -- test/terminal-document-link-provider.test.ts -t "labeled"`

Expected: FAIL with the complete link absent or the partial tail present.

### Task 2: Add the narrow labeled-path pre-scan

**Files:**

- Modify: `src/web/public/terminal-ui.js:after the marker-prefixed-path loop in findPreviewReferences()`
- Test: `test/terminal-document-link-provider.test.ts`

- [ ] **Step 1: Add the case-insensitive labeled candidate before the own-line and token scans**

```js
const labeledPathMatch = /^\s*(?:path|file|saved to):[ \t]+(\/.*)$/i.exec(lineText);
if (labeledPathMatch) {
  const rawCandidate = labeledPathMatch[1];
  const candidate = trimTrailingPunctuation(rawCandidate);
  const startIndex = labeledPathMatch[0].length - rawCandidate.length;
  const endIndex = startIndex + candidate.length;

  if (!isSingleAbsolutePath(candidate)) {
    suppress(startIndex, lineText.length);
  } else {
    blockPreview(startIndex, lineText.length);
    const relativePath = normalizePreviewPath(candidate, workingDir);
    if (relativePath) references.push({ text: candidate, relativePath, startIndex, endIndex });
    else if (!session?.remote && !session?.docker && attachmentExtensions.has(extensionOf(candidate))) {
      references.push({ text: candidate, absolutePath: candidate, startIndex, endIndex });
    } else suppress(startIndex, lineText.length);
  }
}
```

Keep this block before the generic token scanner. Do not alter the accepted labels, extension allowlist, external-attachment route, or remote/Docker policy.

- [ ] **Step 2: Run the focused regression file to verify green**

Run: `npm test -- test/terminal-document-link-provider.test.ts`

Expected: PASS, including existing own-line, marker-prefixed, URL, and wrapped-link coverage.

- [ ] **Step 3: Commit the implementation**

```bash
git add src/web/public/terminal-ui.js test/terminal-document-link-provider.test.ts
git commit -m "fix(terminal): COD-390 link labeled paths with spaces"
```

### Task 3: Release verification and delivery

**Files:**

- Verify: `src/web/public/terminal-ui.js`
- Verify: `test/terminal-document-link-provider.test.ts`

- [ ] **Step 1: Run scoped repository gates**

Run: `npm run typecheck && npm run lint && npm run format:check && npm run check:lockfile && npm run build`

Expected: every command exits 0. Do not run the unscoped test suite from the managed tmux session.

- [ ] **Step 2: Inspect the release diff and commit ancestry**

Run: `git status --short && git diff local...HEAD --check && git log --oneline local..HEAD`

Expected: only the approved design, plan, parser, and terminal-link tests are present on the feature branch.

- [ ] **Step 3: Merge, push, deploy, and prove the active service**

Run: `git -C /opt/projects/Codeman merge --no-ff COD-390-labeled-spaced-path-links && git -C /opt/projects/Codeman push origin local && npm run build && systemctl --user restart codeman-web && curl --fail --silent --show-error http://127.0.0.1:3002/ >/dev/null`

Expected: the merge and push succeed, the production build completes, `codeman-web` restarts, and the loopback HTTP probe returns 2xx. Before the merge, confirm the production checkout still contains only its pre-existing unrelated untracked files.

- [ ] **Step 4: Update Jira with branch, commit, verification, deployment, and completion status**

Run: `JIRA_PROFILE=work JIRA_SITE=https://aakhter.atlassian.net jira comment COD-390 --body "Implemented on COD-390-labeled-spaced-path-links; include the resulting commit, focused test count, static/build gates, and live service probe in this comment." && JIRA_PROFILE=work JIRA_SITE=https://aakhter.atlassian.net jira transition COD-390 --to Done`

Expected: Jira records the exact branch, implementation commit, focused test result, static/build gates, active-service probe, and the issue is Done.
