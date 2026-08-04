# COD-273 Clickable File URI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make supported `file://` URIs in Codex terminal output open the referenced local or remote generated artifact in Codeman's in-app preview.

**Architecture:** Extend the existing xterm link provider with a file-URI link kind. Resolve clicks through a Codex-only session route that decodes the URI and delegates to the existing generated-artifact registration boundary, returning only sanitized attachment metadata. Reuse registry records by canonical local/cache path so the proactive `Saved to:` scanner and a click converge on one attachment. A remote cache hit skips byte retransmission only after a fresh canonical, descriptor-backed inspection; first-time inspection and bounded transfer share one framed remote operation and retain the 50 MiB limit.

**Tech Stack:** TypeScript ESM, Fastify `app.inject()`, browser JavaScript mixins, xterm.js link providers, Vitest, OpenSSH-backed generated-artifact materialization.

---

### Task 1: Deduplicate generated-artifact registration

**Files:**
- Modify: `test/generated-artifact-attachments.test.ts`
- Modify: `src/generated-artifact-attachments.ts`

- [ ] **Step 1: Write the failing local deduplication test**

Add a test that creates one supported workspace file, calls `registerGeneratedArtifactAttachment()` twice for the same session/path, and asserts both results have the same `attachmentId` and the registry contains that record.

```ts
it('reuses an existing registration for the same resolved local artifact', async () => {
  workspaceDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeman-genart-dedupe-')));
  const filePath = join(workspaceDir, 'mockup.png');
  await fs.writeFile(filePath, 'png-bytes');

  const first = await registerGeneratedArtifactAttachment({
    sessionId,
    filePath,
    sessionWorkingDir: workspaceDir,
  });
  const second = await registerGeneratedArtifactAttachment({
    sessionId,
    filePath,
    sessionWorkingDir: workspaceDir,
  });

  expect(second.attachmentId).toBe(first.attachmentId);
  expect(attachmentRegistry.get(sessionId, first.attachmentId)?.filePath).toBe(filePath);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- test/generated-artifact-attachments.test.ts`

Expected: FAIL because the second registration currently mints a different attachment ID.

- [ ] **Step 3: Implement canonical-path reuse**

Import `attachmentRecordToEvent` and `attachmentRegistry`. Before `registerExternalAttachment()`, resolve the final server-local path and return the existing event when `findByFilePath()` succeeds. For remote sessions, compute `buildRemoteGeneratedArtifactCachePath()` and check it for a candidate existing record, then perform a fresh canonical security inspection before reuse. A cache hit omits the byte payload but does not omit the remote inspection.

```ts
function registeredArtifact(sessionId: string, localPath: string): AttachmentRegistrationResult | undefined {
  const existing = attachmentRegistry.findByFilePath(sessionId, localPath);
  return existing ? attachmentRecordToEvent(existing) : undefined;
}

if (options.remote) {
  const localPath = buildRemoteGeneratedArtifactCachePath(options.sessionId, options.remote, options.filePath);
  const existing = registeredArtifact(options.sessionId, localPath);
  const inspection = await inspectRemoteGeneratedArtifact(options, { includeBytes: !existing });
  // canonical validation + 50 MiB admission check
  if (existing) return existing;
  // materialize the bytes returned by the same descriptor-backed operation, then register
}

const existing = registeredArtifact(options.sessionId, resolvedPath);
if (existing) return existing;
```

- [ ] **Step 4: Add and verify the remote-cache deduplication case**

Create the deterministic cache file, register it once with `registerExternalAttachment()`, call `registerGeneratedArtifactAttachment()` with a mocked canonical remote inspection, and assert the existing ID returns after inspection without a file-byte payload. Clean the generated cache directory in `afterEach`.

Run: `npm test -- test/generated-artifact-attachments.test.ts`

Expected: PASS with both local and remote deduplication cases.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/generated-artifact-attachments.ts test/generated-artifact-attachments.test.ts
git commit -m "fix(attachments): COD-273 dedupe generated artifacts"
```

### Task 2: Add the secure file-URI resolver route

**Files:**
- Create: `test/routes/file-uri-preview.test.ts`
- Modify: `src/web/routes/file-routes.ts`

- [ ] **Step 1: Write failing route tests**

Use a Fastify `app.inject()` harness with `registerFileRoutes()` and `createMockRouteContext()`. Set the mock session to `mode = 'codex'` and cover:

```ts
const response = await app.inject({
  method: 'POST',
  url: `/api/sessions/${sessionId}/file-uri-preview`,
  payload: { uri: pathToFileURL(filePath).href },
});
expect(response.statusCode).toBe(200);
expect(response.json().data).toMatchObject({ fileName: 'mockup one.png', attachmentId: expect.any(String) });
expect(JSON.stringify(response.json().data)).not.toContain(filePath);
```

Add separate assertions for percent-encoded spaces, missing `uri`, `https:` input, unsupported extension, a non-Codex session, a missing file, and an outside-boundary path. Add a mocked remote-session case asserting the registration call receives `session.remote` and the response contains no remote absolute path.

- [ ] **Step 2: Run the route test and verify RED**

Run: `npm test -- test/routes/file-uri-preview.test.ts`

Expected: FAIL with HTTP 404 because the route does not exist.

- [ ] **Step 3: Implement URI parsing and the route**

Import `fileURLToPath` from `node:url` and `registerGeneratedArtifactAttachment`. Add a small input parser that rejects non-string bodies, non-`file:` schemes, non-absolute decoded paths, and unsupported extensions.

```ts
function parsePreviewFileUri(uri: unknown): string {
  if (typeof uri !== 'string' || !uri) throw new AttachmentRegistrationError('Missing file URI', 400);
  let filePath: string;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') throw new Error('scheme');
    filePath = fileURLToPath(parsed);
  } catch {
    throw new AttachmentRegistrationError('Invalid file URI', 400);
  }
  const extension = extname(filePath).slice(1).toLowerCase();
  if (!isAbsolute(filePath) || !isSupportedAttachmentExtension(extension)) {
    throw new AttachmentRegistrationError('Unsupported file URI', 400);
  }
  return filePath;
}
```

Register `POST /api/sessions/:id/file-uri-preview`; find the owned session, require `session.mode === 'codex'`, resolve/register through `registerGeneratedArtifactAttachment()`, upsert the private attachment history from the registry record, persist it, broadcast `attachment:detected`, and return `{ success: true, data: event }`. Map `AttachmentRegistrationError` status codes directly and map other failures to a concise `File is unavailable` response without embedding SSH diagnostics.

- [ ] **Step 4: Run focused route and existing attachment tests**

Run separately:

```bash
npm test -- test/routes/file-uri-preview.test.ts
npm test -- test/routes/file-routes.test.ts
npm test -- test/routes/file-routes-remote-sftp.test.ts
```

Expected: all three files PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/web/routes/file-routes.ts test/routes/file-uri-preview.test.ts
git commit -m "feat(api): COD-273 resolve preview file URIs"
```

### Task 3: Link terminal file URIs to the in-app preview

**Files:**
- Modify: `test/terminal-document-link-provider.test.ts`
- Create: `test/file-uri-preview-ui.test.ts`
- Modify: `src/web/public/terminal-ui.js`
- Modify: `src/web/public/panels-ui.js`

- [ ] **Step 1: Write failing xterm-provider tests**

Extend the existing harness with `openFileUriPreview: vi.fn()`. Add cases for a macOS generated-image URI, encoded spaces/trailing punctuation, an unsupported extension, a wrapped URI, and originating-session capture.

```ts
const uri = 'file:///Users/saqeb/.codex-personal/generated_images/mockup%20one.png';
const { provide, fileUriSpy, originalSessionId } = makeHarness(`Saved to: ${uri}.`);
const [link] = provide();
expect(link.text).toBe(uri);
link.activate(null, link.text);
expect(fileUriSpy).toHaveBeenCalledWith(uri, originalSessionId);
```

- [ ] **Step 2: Run the provider test and verify RED**

Run: `npm test -- test/terminal-document-link-provider.test.ts`

Expected: FAIL because `file://` candidates are currently excluded by the path normalizer and ordinary URL matching does not include the file scheme.

- [ ] **Step 3: Implement the file-URI link kind**

Add a bounded linear `fileUriPattern` before the ordinary URL pattern. Trim sentence punctuation, verify the URI pathname against a `fileUriExtensions` set that mirrors the attachment registry allowlist, reserve the link range, and activate through the captured session without decoding the path client-side.

```js
const fileUriPattern = /file:\/\/[^\s"'<>|;&\x00-\x1f]+/g;
const fileUriExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'docx', 'pptx', 'xlsx', 'md', 'txt']);

const addFileUriLink = (uri, matchIndex) => {
  const cleaned = uri.replace(/[.,;:!?)\]]+$/, '');
  const pathname = cleaned.split(/[?#]/, 1)[0];
  const extension = pathname.slice(pathname.lastIndexOf('.') + 1).toLowerCase();
  if (!fileUriExtensions.has(extension)) return;
  // existing coordAt/range/decorations pattern
  links.push({
    text: cleaned,
    range: { start, end },
    decorations: { pointerCursor: true, underline: true },
    activate() {
      self.openFileUriPreview(cleaned, originatingSessionId);
    },
    hover() { self._linkHovered = true; },
    leave() { self._linkHovered = false; },
  });
};
```

Run: `npm test -- test/terminal-document-link-provider.test.ts`

Expected: PASS, including existing URL/path/wrap tests.

- [ ] **Step 4: Write failing browser-method tests**

Load `panels-ui.js` in the existing VM style. Test that `openFileUriPreview()`:

- opens the overlay in Loading state;
- POSTs `{ uri }` to the encoded originating-session route;
- calls `openFilePreview(fileName, sessionId, attachmentId)` on a successful response;
- renders a safe server error in the overlay;
- ignores a response after `closeFilePreview()` or a newer URI request owns `filePreviewState`.

Run: `npm test -- test/file-uri-preview-ui.test.ts`

Expected: FAIL because `openFileUriPreview()` is absent.

- [ ] **Step 5: Implement the preview resolver method**

Add `openFileUriPreview(fileUri, sessionId)` next to `openFilePreview()`. Create an identity object in `filePreviewState`, render Loading, POST JSON, parse the standard response, recheck identity after every await, and call canonical `openFilePreview()` only for the current request. On failure, retain the URI title and render `Error: ${escapeHtml(message)}` only when the request still owns state.

- [ ] **Step 6: Run focused frontend regression tests**

Run separately:

```bash
npm test -- test/file-uri-preview-ui.test.ts
npm test -- test/terminal-document-link-provider.test.ts
npm test -- test/terminal-touch-tap.test.ts
npm test -- test/terminal-document-link.browser.test.ts
```

Expected: all files PASS with no terminal-input or swipe regression.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/web/public/terminal-ui.js src/web/public/panels-ui.js test/terminal-document-link-provider.test.ts test/file-uri-preview-ui.test.ts
git commit -m "feat(ui): COD-273 preview clickable file URIs"
```

### Task 4: Document, review, verify, integrate, and deploy

**Files:**
- Modify: `docs/architecture-invariants.md`

- [ ] **Step 1: Update the architecture invariant**

Extend the Codex generated-artifacts paragraph to state that terminal `file://` clicks use the Codex-only `file-uri-preview` resolver, return opaque attachment IDs, open the shared in-app preview, and retain the same local/remote path boundaries.

- [ ] **Step 2: Run documentation checks and commit**

Run: `git diff --check`

```bash
git add docs/architecture-invariants.md
git commit -m "docs: COD-273 document file URI previews"
```

- [ ] **Step 3: Request code review and resolve findings**

Review the full diff from `38a9be71` through feature HEAD against the approved design. Fix every Critical or Important finding with a failing regression test first, rerun its focused file, and commit the correction.

- [ ] **Step 4: Run pre-merge verification**

Run every changed focused test file separately, followed by:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
node --check src/web/public/terminal-ui.js
node --check src/web/public/panels-ui.js
npm run build
git diff --check origin/local...HEAD
```

- [ ] **Step 5: Run realistic browser smoke**

Start a temporary isolated Codeman web instance according to the `codeman-prod-realistic-smoke` skill, create a representative Codex session/output fixture, click a `Saved to: file:///...png` terminal link, and verify the in-app image preview, POST resolver request, correct originating session, and zero browser console errors. Capture the required artifacts and clean up the temporary instance.

- [ ] **Step 6: Merge current Bitbucket local safely**

Fetch `origin/local`, merge it into `COD-273-file-uri-links`, resolve conflicts without touching unrelated root changes, and rerun focused tests/build. Then merge the feature branch into root `local`, preserving the root `opencode.json` modification with the repository deployment workflow.

- [ ] **Step 7: Push, deploy, and verify production**

Push `local` to Bitbucket, build the merged root checkout, restart `codeman-web`, and verify:

```bash
systemctl --user is-active codeman-web
curl --fail --silent --show-error http://127.0.0.1:3002/ >/dev/null
```

Repeat the HTTP probe three times, confirm the deployed hashed frontend asset contains the file-URI resolver/link marker, and verify the root checkout equals freshly fetched `origin/local` apart from the preserved `opencode.json` change.

- [ ] **Step 8: Close Jira with evidence**

Comment on COD-273 with the branch, commits, targeted test counts, static gates, build, push equality, service status, repeated HTTP probes, deployed-asset evidence, and any preserved dirty files. Transition COD-273 to Done only after every required verification succeeds.
