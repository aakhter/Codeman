# Configured KB Attachment Enclave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codeman service installation carry the operator-approved external attachment-root configuration so the KB workspace symlink can accept uploads without weakening the fail-closed path guard.

**Architecture:** Keep `CODEMAN_TRUSTED_ATTACHMENT_ROOTS` as an environment-only, exact-root allowlist. Extend both the TypeScript service installer and legacy shell installer to propagate the already supplied variable into generated service definitions. Improve the upload-directory error only by naming the missing configuration condition; never include filesystem targets in public errors.

**Tech Stack:** TypeScript/ESM, Bash, Vitest, systemd user units, macOS LaunchAgent plists.

---

### Task 1: Define service-environment propagation behavior

**Files:**
- Modify: `test/service-installer.test.ts`
- Modify: `test/routes/attachment-upload-routes.test.ts`

- [ ] **Step 1: Write the failing service-builder test**

Add a `buildServiceEnv` test that sets `CODEMAN_TRUSTED_ATTACHMENT_ROOTS` to an exact temporary-enclave string and expects the generated environment to carry it.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- test/service-installer.test.ts -t "trusted attachment roots"`

Expected: FAIL because `buildServiceEnv` currently omits `CODEMAN_TRUSTED_ATTACHMENT_ROOTS`.

- [ ] **Step 3: Write the failing upload-diagnostic test**

Add a local upload test with `.codeman-attachments` as a symlink, no trusted-root configuration, and an admin harness. Assert HTTP 403, the actionable unconfigured-root message, and that neither the symlink target nor any configured path is disclosed.

- [ ] **Step 4: Run the focused test to verify it fails**

Run: `npm test -- test/routes/attachment-upload-routes.test.ts -t "unconfigured trusted"`

Expected: FAIL because the route currently returns only `.codeman-attachments is not an approved upload directory`.

### Task 2: Implement service configuration propagation

**Files:**
- Modify: `src/service-installer.ts:129-145`
- Modify: `install.sh:2040-2155`

- [ ] **Step 1: Add the minimal TypeScript propagation**

In `buildServiceEnv`, copy `process.env.CODEMAN_TRUSTED_ATTACHMENT_ROOTS` into the returned environment only when it is non-empty. Leave passwords and all other unlisted environment variables excluded.

- [ ] **Step 2: Run the service-builder test**

Run: `npm test -- test/service-installer.test.ts -t "trusted attachment roots"`

Expected: PASS.

- [ ] **Step 3: Add legacy installer parity**

Make `install.sh` include the caller’s `CODEMAN_TRUSTED_ATTACHMENT_ROOTS` in generated systemd and launchd definitions when set, using the existing systemd/XML escaping helpers. Do not invent a default root and do not copy unrelated environment variables.

- [ ] **Step 4: Add the actionable guard message**

Split the symlink rejection path in `src/config/attachment-guard.ts` so an external `.codeman-attachments` symlink with no matching configured root returns `External .codeman-attachments requires an approved trusted attachment root`, while malformed, broken, non-admin, or otherwise invalid paths retain the generic safe rejection. No error includes the resolved target or configured-root values.

- [ ] **Step 5: Run the upload-diagnostic test**

Run: `npm test -- test/routes/attachment-upload-routes.test.ts -t "unconfigured trusted"`

Expected: PASS.

### Task 3: Verify service output and end-to-end upload behavior

**Files:**
- Modify: `test/service-installer.test.ts`
- Modify: `test/routes/attachment-upload-routes.test.ts`

- [ ] **Step 1: Add builder serialization assertions**

Assert the trusted-root environment appears in both the generated systemd unit and LaunchAgent plist, remains correctly escaped, and is absent when unset.

- [ ] **Step 2: Run focused regression suites**

Run: `npm test -- test/service-installer.test.ts test/routes/attachment-upload-routes.test.ts`

Expected: PASS with no unrelated failures.

- [ ] **Step 3: Run static validation**

Run: `npm run typecheck && npm run lint && npm run format:check && npm run check:lockfile`

Expected: all commands pass.

- [ ] **Step 4: Build the application**

Run: `npm run build`

Expected: production `dist/` build succeeds.

- [ ] **Step 5: Reinstall the user service with the exact KB root**

Run with the exact dedicated directory:

```bash
CODEMAN_TRUSTED_ATTACHMENT_ROOTS=/mnt/c/kb-data/runtime/codeman-attachments aicodeman service install
```

Expected: the generated service definition contains the exact root and the server responds after restart.

- [ ] **Step 6: Verify the deployed service configuration**

Run: `systemctl --user cat codeman-web.service` and confirm the exact `CODEMAN_TRUSTED_ATTACHMENT_ROOTS` entry is present; do not report success without this receipt.

- [ ] **Step 7: Verify the user-visible upload path**

Use the active Codeman session upload flow for the C2 PPTX and confirm the attachment card appears. Verify the file lands under the exact configured enclave and that preview/history remain available.

### Task 4: Final review and handoff

**Files:**
- Review: all changed files and `git diff`

- [ ] **Step 1: Run the independent security review checklist**

Confirm no arbitrary external symlink is auto-approved, no public error leaks a target path, non-admin trusted-root use remains rejected, and no secret environment variables are copied into service files.

- [ ] **Step 2: Commit the focused change**

Run: `git add src/service-installer.ts src/config/attachment-guard.ts install.sh test/service-installer.test.ts test/routes/attachment-upload-routes.test.ts docs/superpowers/plans/2026-09-15-cod-437-configured-kb-attachment-enclave.md && git commit -m "fix: COD-437 propagate trusted attachment roots"`

- [ ] **Step 3: Report verification receipts**

Report the COD-437 key, branch/commit, tests, build checks, deployed service configuration, and any remaining limitation (the C2 PPTX upload itself requires the user’s active browser action).
