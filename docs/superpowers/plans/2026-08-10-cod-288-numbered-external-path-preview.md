# COD-288 Numbered External Path Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a complete, numbered-list external path open in Codeman's attachment viewer without reviving partial-path links or crossing local/remote security boundaries.

**Architecture:** Extend the terminal link provider with a conservative marker-path scanner that returns typed references and suppressed ranges. Local external targets resolve only after a deliberate click through the guarded attachment registration route; the shared preview overlay owns and deduplicates the asynchronous request. Harden the existing registration route with session ownership enforcement.

**Tech Stack:** Browser JavaScript, xterm.js link-provider API, Fastify, TypeScript, Vitest, Node `vm` browser-unit harnesses.

---

### Task 1: Lock the registration ownership boundary

**Files:**
- Modify: `src/web/routes/file-routes.ts:1821`
- Test: `test/routes/file-routes-attachment-path-guard.test.ts`

- [ ] **Step 1: Write the failing foreign-session route test**

Add a focused test that creates a user-scoped route harness, marks its session as owned by another user, and posts a supported PDF path to that session:

```ts
const scoped = await createRouteTestHarness(registerFileRoutes, {
  authUser: { username: 'bob', role: 'user' },
});
scoped.ctx._session.owner = 'alice';
const path = '/mnt/c/decks/board-update.pdf';
try {
  const response = await scoped.app.inject({
    method: 'POST',
    url: `/api/sessions/${scoped.ctx._sessionId}/attachments`,
    payload: { path },
  });
  expect(response.statusCode).toBe(404);
  expect(scoped.ctx._session.upsertAttachmentHistory).not.toHaveBeenCalled();
  expect(scoped.ctx.persistSessionState).not.toHaveBeenCalled();
  expect(scoped.ctx.broadcast).not.toHaveBeenCalled();
  expect(attachmentRegistry.findByFilePath(scoped.ctx._sessionId, path)).toBeUndefined();
} finally {
  await scoped.app.close();
}
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- test/routes/file-routes-attachment-path-guard.test.ts -t "foreign session"`

Expected: FAIL because the current route calls `findSessionOrFail(ctx, id)` without the request and registers the attachment.

- [ ] **Step 3: Enforce request ownership**

Change the route lookup to:

```ts
const session = findSessionOrFail(ctx, id, req);
```

- [ ] **Step 4: Run the focused route file**

Run: `npm test -- test/routes/file-routes-attachment-path-guard.test.ts`

Expected: PASS with the new foreign-session regression and all existing path-guard cases.

- [ ] **Step 5: Commit**

```bash
git add -- src/web/routes/file-routes.ts test/routes/file-routes-attachment-path-guard.test.ts
git commit -m "fix(attachments): COD-288 enforce registration ownership"
```

### Task 2: Detect and suppress complete marker-prefixed paths

**Files:**
- Modify: `src/web/public/terminal-ui.js:1623-2130`
- Test: `test/terminal-document-link-provider.test.ts`

- [ ] **Step 1: Add failing parser, range, and activation tests**

Add a `COD-288 marker-prefixed absolute paths` describe block using the reported Webex PDF:

```ts
const REPORTED =
  '/mnt/c/kb-data/webex-archive/Isovalent and Cisco Unified Edge_265668a5/attachments/cilium-pnet-whitepaper-draft9-5.pdf';

it('links the complete numbered external path and excludes the marker', () => {
  const { provide, externalPreviewSpy, originalSessionId } = makeHarness(`1. ${REPORTED}`, {
    workingDir: '/home/aakhter/projects/kb',
  });
  const [link] = provide();
  expect(link.text).toBe(REPORTED);
  expect(link.range.start.x).toBe(4);
  link.activate(null, link.text);
  expect(externalPreviewSpy).toHaveBeenCalledWith(REPORTED, originalSessionId);
});
```

Add table cases for `12)`, `-`, `*`, `•`, tabs/multiple spaces; in-workspace activation; remote and Docker suppression; unsupported external source/data extensions; traversal; a second absolute path; prose boundaries; an earlier preview-extension token; wide-character and wrapped ranges; and legacy `/home`, `/tmp`, `/var`, `/etc`, `/opt` fallback suppression. Assert an in-workspace marker path calls `openFilePreview` and does not call the external helper. Add a marker-prefixed long-line timing case.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npm test -- test/terminal-document-link-provider.test.ts -t "marker-prefixed"`

Expected: FAIL because the provider exposes neither a complete marker candidate nor `openExternalPathPreview` activation.

- [ ] **Step 3: Implement the scanner result contract**

Inside `registerFilePathLinkProvider()`:

```js
const attachmentExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'docx', 'pptx', 'xlsx', 'md', 'txt']);

// Returned by findPreviewReferences().
// { references: [{ text, relativePath?, absolutePath?, startIndex, endIndex }],
//   suppressedRanges: [{ startIndex, endIndex }] }
```

Implement a linear marker-prefix scan and single-path predicate from the design. Normalize the post-marker remainder, classify in-workspace targets against the existing 20-extension set, classify external targets against the 11-extension set, and retain a suppression range for rejected, remote, or Docker candidates.

- [ ] **Step 4: Reserve document and suppression ranges before legacy scanners**

Compute the document scan once per logical line. After ordinary URLs, reserve rejected ranges and add document links before command/Bash/legacy patterns. Activate typed references as follows:

```js
if (reference.absolutePath) {
  self.openExternalPathPreview(reference.absolutePath, originatingSessionId);
} else {
  self.openFilePreview(reference.relativePath, originatingSessionId);
}
```

- [ ] **Step 5: Run the complete terminal link-provider test file**

Run: `npm test -- test/terminal-document-link-provider.test.ts`

Expected: PASS, including the existing URL, file URI, command/log, COD-232, COD-237, COD-285, and COD-288 cases.

- [ ] **Step 6: Commit**

```bash
git add -- src/web/public/terminal-ui.js test/terminal-document-link-provider.test.ts
git commit -m "fix(terminal): COD-288 link complete numbered external paths"
```

### Task 3: Resolve external paths into owned attachment previews

**Files:**
- Modify: `src/web/public/panels-ui.js:3790-3895`
- Test: `test/file-uri-preview-ui.test.ts`

- [ ] **Step 1: Add failing helper contract tests**

Extend the existing VM harness with `openExternalPathPreview` tests:

```ts
const opening = proto.openExternalPathPreview.call(host, absolutePath, 'session / one');
expect(fetch).toHaveBeenCalledWith('/api/sessions/session%20%2F%20one/attachments', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: absolutePath }),
});
```

Assert success calls:

```ts
expect(openFilePreview).toHaveBeenCalledWith('report.pdf', 'session / one', 'att_1', {
  displayPath: absolutePath,
});
```

Add malformed-envelope, escaped/bounded server error, network error, close-before-response, newer-preview-wins, and identical-double-activation cases.

- [ ] **Step 2: Run the helper tests and verify they fail**

Run: `npm test -- test/file-uri-preview-ui.test.ts -t "external path"`

Expected: FAIL because `openExternalPathPreview` and the display-path option do not exist.

- [ ] **Step 3: Implement the external resolver**

Mirror `openFileUriPreview()` for overlay setup, request ownership, response parsing, escaped 300-character errors, and safe handoff. Keep an in-flight promise map keyed by `sessionId + NUL + absolutePath`; remove the entry in `finally` only when it still owns that promise.

- [ ] **Step 4: Add the optional viewer display path**

Change the preview signature without affecting existing callers:

```js
async openFilePreview(filePath, sessionId = this.activeSessionId, attachmentId = null, options = {}) {
  // ...
  if (titleEl) titleEl.textContent = options.displayPath || filePath;
}
```

Store the display path in the preview state so polling and navigation retain the owned title.

- [ ] **Step 5: Run the complete preview-helper test file**

Run: `npm test -- test/file-uri-preview-ui.test.ts`

Expected: PASS for both existing file-URI behavior and the new external-path flow.

- [ ] **Step 6: Commit**

```bash
git add -- src/web/public/panels-ui.js test/file-uri-preview-ui.test.ts
git commit -m "feat(preview): COD-288 resolve external terminal paths"
```

### Task 4: Verify the complete change

**Files:**
- Modify only if verification exposes a defect.

- [ ] **Step 1: Run focused regression files**

```bash
npm test -- test/terminal-document-link-provider.test.ts
npm test -- test/file-uri-preview-ui.test.ts
npm test -- test/routes/file-routes-attachment-path-guard.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run repository quality gates**

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run check:public-assets
npm run build
```

Expected: every command exits 0.

- [ ] **Step 3: Review the final diff**

Run: `git diff origin/local...HEAD --check && git status --short --branch`

Expected: no whitespace errors; only COD-288 spec, plan, source, and focused tests are changed; worktree is clean.

- [ ] **Step 4: Update Jira COD-288**

Add a comment through the repository-required local Jira CLI containing the branch, commits, root cause, security behavior, Opus approval, and exact verification results.

- [ ] **Step 5: Push the working branch**

Run: `git push -u origin COD-288-numbered-external-path-preview`

Expected: Bitbucket accepts the branch and sets upstream tracking.
