# COD-436 Remote Generated-Artifact Path Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make plain absolute generated-image paths in remote Codex terminal output open in Codeman's existing in-app preview.

**Architecture:** Preserve `openExternalPathPreview()` for local and non-Codex sessions. For remote Codex sessions, encode the clicked absolute path as a `file:` URI and delegate to `openFileUriPreview()`, which already calls the authenticated generated-artifact resolver and returns an opaque attachment ID.

**Tech Stack:** Browser JavaScript, Vitest, existing Fastify file-URI route.

---

### Task 1: Lock remote Codex path routing with a UI test

**Files:**
- Modify: `test/file-uri-preview-ui.test.ts`

- [x] **Step 1: Write the failing test**

Add a test that marks `host.sessions.get('session-1')` as `{ mode: 'codex', remote: {} }`, calls:

```ts
await proto.openExternalPathPreview.call(host, '/Users/saqebakhter/.codex-personal/generated_images/a chart.png', 'session-1');
```

and expects one request to:

```ts
'/api/sessions/session-1/file-uri-preview'
```

with `body: JSON.stringify({ uri: 'file:///Users/saqebakhter/.codex-personal/generated_images/a%20chart.png' })`.

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- test/file-uri-preview-ui.test.ts`

Expected: the new assertion fails because the current browser code requests `/attachments`.

### Task 2: Delegate only remote Codex paths to the existing resolver

**Files:**
- Modify: `src/web/public/panels-ui.js:openExternalPathPreview`
- Test: `test/file-uri-preview-ui.test.ts`

- [x] **Step 1: Implement the minimal guard**

At the start of `openExternalPathPreview()`, inspect the session stored under `sessionId`. If it is both `mode === 'codex'` and has `remote`, call:

```js
const fileUri = `file://${absolutePath.split('/').map(encodeURIComponent).join('/')}`;
return this.openFileUriPreview(fileUri, sessionId);
```

before creating an external-path request. Do not send remote Claude/OpenCode sessions, local Codex sessions, or resolver failures to the `/attachments` path.

- [x] **Step 2: Run the focused test**

Run: `npm test -- test/file-uri-preview-ui.test.ts`

Expected: PASS with the new remote Codex test and all existing UI resolver tests.

### Task 3: Verify and prepare the promotion

**Files:**
- Modify: `docs/superpowers/plans/2026-09-13-cod-436-remote-generated-path-preview.md`

- [x] **Step 1: Run static and build gates**

Run: `npm run typecheck && npm run lint && npm run format:check && npm run check:lockfile && npm run build`

Expected: all commands exit zero.

- [ ] **Step 2: Commit the fix**

Run:

```bash
git add src/web/public/panels-ui.js test/file-uri-preview-ui.test.ts docs/superpowers/plans/2026-09-13-cod-436-remote-generated-path-preview.md
git commit -m 'fix: COD-436 preview remote Codex generated paths'
```

- [ ] **Step 3: Update Jira**

Add the branch, commit, root cause, and verification result to COD-436 before transitioning it to Done after deployment acceptance.
