# COD-414 Bullet Relative Path Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link only the relative file-path suffix when a bulleted terminal line has descriptive prose followed by `: <path>`.

**Architecture:** Keep the established terminal link provider and its strict relative-path validation. Add a regression test for the reported line, then split only the proven bullet-description form at its final colon-plus-whitespace boundary before applying that validation. Existing bare bullet paths continue through the current path-only branch.

**Tech Stack:** Browser JavaScript, xterm link provider, Vitest.

---

### Task 1: Pin the reported parser behavior

**Files:**
- Modify: `test/terminal-document-link-provider.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('links only the relative suffix after a bulleted description', () => {
  const relative = '.worktrees/jira-NZBDAV-1151-deferral-normalization/docs/superpowers/specs/2026-09-05-health-deferral-normalization-design.md';
  const { provide, previewSpy, originalSessionId } = makeHarness(
    `• Design committed in the isolated worktree: ${relative}`,
    { workingDir: '/opt/projects/nzbdav' }
  );

  const [link] = provide();
  expect(link.text).toBe(relative);
  link.activate(null, link.text);
  expect(previewSpy).toHaveBeenCalledWith(relative, originalSessionId);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- test/terminal-document-link-provider.test.ts -t "links only the relative suffix after a bulleted description"`

Expected: FAIL because the provider returns the whole post-bullet description as the link text.

### Task 2: Parse the tested suffix without widening candidate recognition

**Files:**
- Modify: `src/web/public/terminal-ui.js`
- Test: `test/terminal-document-link-provider.test.ts`

- [ ] **Step 1: Extract the final `: <relative path>` suffix only in the marker scanner**

```js
const descriptionPathMatch = /^.+:[ \t]+(.+)$/.exec(rawCandidate);
const candidate = trimTrailingPunctuation(descriptionPathMatch ? descriptionPathMatch[1] : rawCandidate);
const startIndex = markerOffset + markerMatch[1].length + (descriptionPathMatch ? descriptionPathMatch[0].length - descriptionPathMatch[1].length : 0);
```

- [ ] **Step 2: Reuse `isSingleRelativePath`, `resolveRelativeCandidate`, and existing suppression rules unchanged**

The new suffix remains subject to the same extension allowlist, traversal rejection, base-resolution, and external-preview policy as an existing bullet path.

- [ ] **Step 3: Run the focused test and verify it passes**

Run: `npm test -- test/terminal-document-link-provider.test.ts -t "links only the relative suffix after a bulleted description"`

Expected: PASS; the link text and preview target are precisely the `.worktrees/...md` suffix.

- [ ] **Step 4: Run the whole safe provider file**

Run: `npm test -- test/terminal-document-link-provider.test.ts`

Expected: PASS; existing marker and labeled path behavior remains covered.

### Task 3: Verify, commit, merge, and deploy

**Files:**
- Modify: `docs/superpowers/plans/2026-09-05-cod-414-bullet-relative-path-link.md`
- Modify: `src/web/public/terminal-ui.js`
- Modify: `test/terminal-document-link-provider.test.ts`

- [ ] **Step 1: Run release gates**

Run: `npm run typecheck && npm run lint && npm run format:check && npm run check:lockfile && npm run build`

Expected: every command exits zero.

- [ ] **Step 2: Commit the focused change**

```bash
git add docs/superpowers/plans/2026-09-05-cod-414-bullet-relative-path-link.md src/web/public/terminal-ui.js test/terminal-document-link-provider.test.ts
git commit -m "fix(terminal): COD-414 link bullet path suffixes"
```

- [ ] **Step 3: Push the branch, merge it into `local`, and push `origin/local`**

Run the configured Bitbucket branch/PR workflow, updating COD-414 with branch, commit, and verification evidence before marking it Done.

- [ ] **Step 4: Deploy the merged `local` checkout and verify health**

Run: `~/.codex/skills/sync-origin-local-deploy/scripts/sync_origin_local_deploy.sh`

Expected: build succeeds, `codeman-web` restarts, and local health probes succeed.
