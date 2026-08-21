# Filesystem-backed Session Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `.codeman-sources/` the live source of truth for file cards while retaining persisted URL and highlight sources.

**Architecture:** `source-routes.ts` derives safe filesystem-backed records from the local directory or remote SFTP listing. GET merges those with non-file metadata. DELETE removes only the corresponding direct child from `.codeman-sources/`, or preserves its metadata-only delete behavior. The file form becomes upload-only.

**Tech Stack:** TypeScript ESM, Fastify, Node `fs/promises`, existing remote SFTP helpers, Vitest.

---

### Task 1: Specify and implement the filesystem route contract

**Files:**

- Modify: `test/routes/source-routes.test.ts`
- Modify: `test/routes/source-upload-remote-routes.test.ts`
- Modify: `src/web/routes/source-routes.ts`

- [ ] **Step 1: Write failing local route tests**

Create direct children in the harness `.codeman-sources` directory. Assert GET includes an unregistered file, filters persisted `type: 'file'` metadata to avoid duplicates, and retains URL/highlight records. Assert DELETE removes the discovered file, preserves an unrelated sibling, and remains successful for a missing target.

```ts
expect(body.data.sources).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ type: 'file', relativePath: '.codeman-sources/unregistered.pdf' }),
    expect.objectContaining({ type: 'url', title: 'MDN Docs' }),
    expect.objectContaining({ type: 'highlight', title: 'Key excerpt' }),
  ])
);
```

- [ ] **Step 2: Run the local test red**

Run: `npm test -- test/routes/source-routes.test.ts`

Expected: FAIL because GET returns only `session.sources` and DELETE never unlinks a source file.

- [ ] **Step 3: Write failing remote route tests**

Mock `listRemoteWorkspaceDirectory` and `deleteRemoteWorkspacePath` in the existing remote source suite. Assert GET lists direct remote `.codeman-sources` files without local `fs`, and DELETE calls the remote helper only for the matching direct child.

```ts
expect(listRemoteWorkspaceDirectory).toHaveBeenCalledWith(harness.ctx.session.remote, '.codeman-sources');
expect(deleteRemoteWorkspacePath).toHaveBeenCalledWith(harness.ctx.session.remote, '.codeman-sources/reference.pdf');
```

- [ ] **Step 4: Run the remote test red**

Run: `npm test -- test/routes/source-upload-remote-routes.test.ts`

Expected: FAIL because source routes do not list or delete through remote SFTP.

- [ ] **Step 5: Implement narrow route helpers**

Import `createHash`, `listRemoteWorkspaceDirectory`, and `deleteRemoteWorkspacePath`. Enumerate only direct regular local/remote children, give each a safe deterministic hash ID based on its `.codeman-sources/<name>` path, sort by filename, and match a deletion ID only against a fresh listing. GET merges filesystem records with `session.sources.filter((source) => source.type !== 'file')`. DELETE uses `fs.unlink` or remote SFTP; it ignores ENOENT and removes matching legacy file metadata.

```ts
const metadataSources = session.sources.filter((source) => source.type !== 'file');
return { success: true, data: { sources: [...metadataSources, ...(await listFilesystemSources(session))] } };
```

- [ ] **Step 6: Run focused route tests green**

Run: `npm test -- test/routes/source-routes.test.ts test/routes/source-upload-routes.test.ts test/routes/source-upload-remote-routes.test.ts`

Expected: PASS, including upload behavior and new local/remote filesystem cases.

- [ ] **Step 7: Commit the route contract**

```bash
git add src/web/routes/source-routes.ts test/routes/source-routes.test.ts test/routes/source-upload-remote-routes.test.ts
git commit -m "fix(sources): COD-353 render file sources from filesystem"
```

### Task 2: Make the file form match the route contract

**Files:**

- Modify: `src/web/public/index.html:3436-3454`
- Modify: `src/web/public/panels-ui.js:400-545`
- Modify: `test/source-upload-ui-wiring.test.ts`

- [ ] **Step 1: Write the failing UI wiring test**

Assert File mode retains the upload picker and button but no longer has the manual relative-path field or sends a generic `POST /sources` file record.

```ts
expect(indexHtml).not.toContain('id="sourcesPathRow"');
expect(panelsUi).toContain("if (type === 'file') return;");
```

- [ ] **Step 2: Run the UI test red**

Run: `npm test -- test/source-upload-ui-wiring.test.ts`

Expected: FAIL because file mode still includes `sourcesPathRow` and generic add behavior.

- [ ] **Step 3: Implement the minimal form change**

Remove `sourcesPathRow` from `index.html`; remove the path-row toggle from `panels-ui.js`; and make `handleAddSource` return before generic posting for `type === 'file'`.

- [ ] **Step 4: Run the UI test green**

Run: `npm test -- test/source-upload-ui-wiring.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the UI contract**

```bash
git add src/web/public/index.html src/web/public/panels-ui.js test/source-upload-ui-wiring.test.ts
git commit -m "fix(ui): COD-353 make session file sources upload-only"
```

### Task 3: Verify, integrate, deploy, and record delivery

**Files:**

- Modify: Jira issue `COD-353`

- [ ] **Step 1: Run static checks and targeted tests**

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
git diff --check
npm test -- test/routes/source-routes.test.ts test/routes/source-upload-routes.test.ts test/routes/source-upload-remote-routes.test.ts test/source-upload-ui-wiring.test.ts
```

Expected: every command exits 0.

- [ ] **Step 2: Build production output**

Run: `npm run build`

Expected: production bundle completes successfully.

- [ ] **Step 3: Merge and push only COD-353**

Merge into `local` without disturbing the dirty primary checkout, then push `local` to Bitbucket `origin`.

- [ ] **Step 4: Deploy and live-verify**

Use the COM deployment flow to update the deployed checkout, build, and restart `codeman-web`. In production, use a disposable session to confirm live GET discovers an unregistered file, and use a browser to confirm its card renders and × removes both card and file. Confirm URL/highlight remain metadata-backed.

- [ ] **Step 5: Update COD-353**

Record branch, commits, merge revision, checks, and live API/browser evidence before setting the Jira issue Done.
