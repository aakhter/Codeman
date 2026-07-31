# COD-252 Remote SFTP File Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing File Viewer list, preview, and download files for SSH-backed sessions through OpenSSH SFTP while reusing every saved SSH connection option.

**Architecture:** Add a `remote-sftp` transport that starts the system `sftp` client with a batch file on stdin. Its argv is derived from `buildSshConnectionArgv`, converting only SSH's `-p` port flag to SFTP's `-P`; identity, jump host, SOCKS `ProxyCommand`, and extra `-o` options pass through unchanged. File routes select SFTP only when `session.remote` exists; local filesystem behavior is unchanged.

**Tech Stack:** TypeScript ESM, Node child processes and streams, OpenSSH `sftp`, Fastify, Vitest.

---

### Task 1: Create a tested OpenSSH SFTP transport

**Files:**
- Create: `src/remote-sftp.ts`
- Create: `test/remote-sftp.test.ts`

- [ ] **Step 1: Write failing argv and path-validation tests**

```ts
expect(buildSftpConnectionArgv(REMOTE)).toEqual([
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-P', '2222',
  '-i', '/home/ann/.ssh/id remote', '-J', 'jump.example',
  '-o', 'ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p',
  '-o', 'StrictHostKeyChecking=yes', 'ann@10.0.0.9',
]);
expect(() => remoteWorkspacePath(REMOTE, '../secret')).toThrow('workspace-relative');
```

- [ ] **Step 2: Verify the test is red**

Run: `npm test -- test/remote-sftp.test.ts`

Expected: FAIL because `remote-sftp` is not yet present.

- [ ] **Step 3: Implement the pure argv and path API**

```ts
export function buildSftpConnectionArgv(remote: SessionRemote): string[] {
  const args = buildSshConnectionArgv(remote);
  return [...args.map((arg, i) => (arg === '-p' && i + 1 < args.length ? '-P' : arg)), remoteSshTarget(remote)];
}

export function remoteWorkspacePath(remote: SessionRemote, relativePath = ''): string {
  if (/^(?:\/|.*(?:^|\/)\.\.(?:\/|$)|.*[\0\r\n].*)/.test(relativePath)) {
    throw new Error('Remote file path must be workspace-relative');
  }
  return relativePath ? pathPosix.join(remote.remotePath, relativePath) : remote.remotePath;
}
```

- [ ] **Step 4: Add red tests for batch operations**

```ts
await expect(listRemoteWorkspaceDirectory(REMOTE, '')).resolves.toEqual([]);
await expect(listRemoteWorkspaceDirectory(REMOTE, '')).rejects.toThrow('Permission denied');
```

Mock `spawn('sftp', ['-b', '-', ...argv])` and assert that its stdin receives a quoted `ls -l` batch command.

- [ ] **Step 5: Implement and verify batch operations**

Implement `runSftpBatch`, `listRemoteWorkspaceDirectory`, `readRemoteWorkspaceFile`, and `downloadRemoteWorkspaceFile`. Capture stderr, enforce a 15-second timeout, reject non-zero exits with a labelled error, parse immediate `ls -l` entries, and use a private `mkdtemp` staging directory for `get` downloads.

Run: `npm test -- test/remote-sftp.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/remote-sftp.ts test/remote-sftp.test.ts
git commit -m "feat: COD-252 add remote SFTP transport"
```

### Task 2: Route remote File Viewer reads through SFTP

**Files:**
- Modify: `src/web/routes/file-routes.ts:555-780`
- Modify: `src/web/routes/file-routes.ts:705-900`
- Modify: `src/web/routes/file-routes.ts:1705-1734`
- Create: `test/routes/file-routes-remote-sftp.test.ts`

- [ ] **Step 1: Write a failing remote-list route test**

```ts
harness.ctx._session.remote = REMOTE;
mockedList.mockResolvedValue([{ name: 'src', path: 'src', type: 'directory' }]);
const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${SID}/files?path=src` });
expect(res.json().data.tree).toEqual([{ name: 'src', path: 'src', type: 'directory', children: [] }]);
expect(mockedList).toHaveBeenCalledWith(REMOTE, 'src');
```

- [ ] **Step 2: Verify the test is red**

Run: `npm test -- test/routes/file-routes-remote-sftp.test.ts`

Expected: FAIL because the current route reads the local workspace.

- [ ] **Step 3: Add the SFTP listing branch**

When `session.remote` exists and `q` is absent, call `listRemoteWorkspaceDirectory(session.remote, path ?? '')` and return the standard tree envelope with immediate children, computed immediate file/directory counts, and `lazy: true`. Keep the current recursive local scanner in the non-remote branch. Reject an unsafe path before invoking SFTP.

- [ ] **Step 4: Add remote content and raw-download branches**

For `file-content`, read at most the existing 10MB text limit with `readRemoteWorkspaceFile` and reuse the current binary, line-limit, and response-shape classification. For `file-raw`, stage the SFTP `get` result, set the existing MIME and disposition headers, stream it with `sendRawStream`, and clean the staging path on stream close/error.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- test/routes/file-routes-remote-sftp.test.ts test/routes/file-routes.test.ts test/file-browser-download.test.ts`

Expected: PASS.

```bash
git add src/web/routes/file-routes.ts test/routes/file-routes-remote-sftp.test.ts
git commit -m "fix: COD-252 browse remote session files over SFTP"
```

### Task 3: Lazy-load remote directories in the File Viewer

**Files:**
- Modify: `src/web/public/panels-ui.js:3488-3650`
- Modify: `test/file-browser-session-ownership.test.ts`

- [ ] **Step 1: Write the failing lazy-load test**

```ts
await host.toggleFileBrowserFolder('src');
expect(fetchImpl).toHaveBeenCalledWith('/api/sessions/tree-owner-session/files?path=src&showHidden=false');
expect(host.fileBrowserData.tree[0].children).toEqual([{ name: 'index.ts', path: 'src/index.ts', type: 'file' }]);
```

- [ ] **Step 2: Verify the test is red**

Run: `npm test -- test/file-browser-session-ownership.test.ts`

Expected: FAIL because expanding a folder only changes the expanded-set.

- [ ] **Step 3: Implement lazy tree merging**

When the response has `lazy: true`, fetch a directory only when it is first expanded, merge returned children into its matching node, and discard a stale response when tree owner or generation changes. Keep existing local loading intact. Retain client-side filtering for loaded remote nodes instead of issuing recursive remote `q` searches.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- test/file-browser-session-ownership.test.ts test/file-browser-download.test.ts test/routes/file-routes-remote-sftp.test.ts`

Expected: PASS.

```bash
git add src/web/public/panels-ui.js test/file-browser-session-ownership.test.ts
git commit -m "fix(ui): COD-252 lazy-load remote File Viewer directories"
```

### Task 4: Document and verify the complete change

**Files:**
- Modify: `docs/remote-sessions.md`
- Modify: `docs/superpowers/plans/2026-07-31-cod-252-remote-sftp-file-manager.md`

- [ ] **Step 1: Document the connection contract**

Add a File Viewer subsection explaining that the system OpenSSH SFTP client reuses each saved host's port, identity, jump host, SOCKS proxy, and extra SSH options.

- [ ] **Step 2: Run fresh safe verification**

```bash
npm test -- test/remote-sftp.test.ts test/routes/file-routes-remote-sftp.test.ts test/routes/file-routes.test.ts test/file-browser-session-ownership.test.ts test/file-browser-download.test.ts
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run build
```

Expected: every command exits 0. Do not run the unsafe full Vitest suite from this managed Codeman session.

- [ ] **Step 3: Commit docs and update Jira**

```bash
git add docs/remote-sessions.md docs/superpowers/plans/2026-07-31-cod-252-remote-sftp-file-manager.md
git commit -m "docs: COD-252 document remote File Viewer SFTP"
JIRA_PROFILE=work JIRA_SITE=https://aakhter.atlassian.net jira comment COD-252 --body "Implemented on branch COD-252-remote-sftp-file-manager; record commits and fresh verification before transition."
```
