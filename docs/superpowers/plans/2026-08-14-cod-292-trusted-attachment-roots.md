# COD-292 Trusted External Attachment Roots Implementation Plan

**Specification:** `docs/superpowers/specs/2026-08-14-cod-292-trusted-attachment-roots-design.md`

**Branch:** `COD-292-trusted-attachment-roots`

**Rule:** follow RED → GREEN for every behavioral change. Never run the unscoped Vitest suite from the managed session.

## Task 1 — Close request-ownership bypasses

### Files

- Modify `src/web/routes/file-routes.ts`.
- Extend the focused multi-user route tests that cover file content, attachment upload, history, and deletion.

### RED

Add tests proving a non-admin receives the normal ownership-safe not-found response when using another user's session ID for:

- `GET /api/sessions/:id/file-content`;
- `POST /api/sessions/:id/attachments/upload`;
- `GET /api/sessions/:id/attachments`;
- `DELETE /api/sessions/:id/attachments/uploaded`.

Run only the affected test files and confirm the new assertions fail against the current unchecked lookups.

### GREEN

- Pass `req` to the upload and delete `findSessionOrFail` calls.
- Remove the `/file-content` ownership-denial fallback to an unchecked session lookup.
- Keep response shape and single-user behavior unchanged.
- Re-run the focused tests until green.

### Commit

`fix(security): COD-292 enforce attachment session ownership`

## Task 2 — Implement trusted-root backend lifecycle

This task is intentionally cohesive: configuration, storage resolution, upload registration, restart reconstruction, and
deletion share one security boundary and must not be implemented as independent competing rules.

### Files

- Modify `src/config/attachment-guard.ts`.
- Modify `src/attachment-registry.ts`.
- Modify `src/types/session.ts` and `src/session-attachment-history.ts`.
- Modify `src/web/routes/file-routes.ts`.
- Modify route-test harnesses only as needed.
- Add focused configuration/resolver tests and extend upload/remove/history/raw route tests.

### RED A — configuration and resolver

Add tests for:

- unset/empty, invalid, blocked, missing, non-directory, non-canonical, and duplicate roots;
- regular directory and first-upload `ENOENT` creation;
- exact approved symlink target;
- unapproved, broken, repointed, and configured-ancestor/child mismatch;
- multi-user non-admin refusal;
- canonicalized temporary fixtures for platforms whose temp root is itself a symlink.

Confirm the new resolver tests fail.

### GREEN A

- Add env-only `CODEMAN_TRUSTED_ATTACHMENT_ROOTS` startup parsing and a test reset hook.
- Reject browser/settings configuration for trusted roots by leaving it out of `SettingsUpdateSchema`.
- Add one shared `resolveLocalUploadDirectory(workingDir, authUser)` implementation.
- Preserve race-safe non-recursive creation for a missing regular workspace directory.
- Require exact canonical-root equality for trusted symlinks; never create a trusted target.
- Return path-safe public errors.

### RED B — upload, registration, reads, and restart

Add route tests proving:

- regular workspace upload is unchanged;
- unapproved symlink remains 403;
- approved exact root writes bytes canonically and returns `.codeman-attachments/<name>`;
- concurrent names remain distinct;
- configured root strings do not appear in failure bodies;
- CSRF, rate, byte-signature, extension, and size guards remain active;
- raw/preview/thumbnail reads use a revalidated `trustedUploadBoundary`;
- the trusted boundary uses `MAX_PASTE_IMAGE_BYTES` rather than the generated-artifact cap;
- a forged persisted boundary cannot widen access;
- restart-style registry clearing and history reconstruction recompute the trusted boundary.

Confirm these assertions fail before production changes.

### GREEN B

- Add a separate in-memory `trustedUploadBoundary`; do not overload or persist `generatedArtifactBoundary`.
- Parameterize the shared boundary validator's byte cap.
- Keep workspace uploads force-confined; trusted uploads use the freshly resolved exact boundary.
- Write to the canonical directory with existing exclusive/no-follow flags and `0600`.
- Replace filesystem details in upload/delete response bodies with fixed messages and stable error codes; log details server-side.
- Add optional `uploadProvenance?: 'codeman-upload'` to history while keeping history `source: 'external'` unchanged.
- Sanitize and persist the optional provenance field.
- Reconstruct trusted upload records only from current resolver output plus persisted provenance.
- Ensure existing-record reuse cannot turn registry `source` into deletion authority.

### RED C — history path and deletion

Add tests proving:

- approved uploads expose a POSIX logical removable path;
- trusted delete accepts only `.codeman-attachments/<basename>`;
- trusted delete rejects empty names, `.`, `..`, separators, traversal, nested paths, and file-leaf symlinks;
- trusted delete requires a direct-child regular file and matching per-session `uploadProvenance`;
- sibling files and uploads owned by another session cannot be deleted;
- removed configuration or a repointed workspace symlink fails closed;
- old history without provenance remains readable but is not removable;
- regular workspace removal remains unchanged;
- registry clearing followed by history reconstruction still permits deletion of a proven upload.

Confirm these assertions fail.

### GREEN C

- Synthesize the POSIX logical path only for freshly resolved proven uploads.
- Keep `validateSessionFilePath` unchanged for the regular workspace branch.
- Implement basename-only trusted deletion directly against the canonical root with `lstat` regular-file validation.
- Re-run the shared resolver and provenance match on every trusted mutation.
- Remove only one file, then update history/registry and persist state.

### Commit

`feat(attachments): COD-292 support trusted upload roots`

## Task 3 — Surface deterministic, path-safe frontend failures and document invariants

### Files

- Modify `src/web/public/document-input.js`.
- Extend the focused document-upload UI tests.
- Modify `docs/architecture-invariants.md`.
- Modify operator-facing configuration documentation where environment variables are listed.

### RED

Add frontend tests proving:

- failures retain filename/message by selection index despite concurrent completion order;
- the final toast uses the lowest failing selection index;
- displayed messages are single-line and capped at 160 characters;
- non-JSON failures fall back to a generic HTTP message;
- every failure still produces a console warning.

Confirm the focused tests fail.

### GREEN

- Store structured per-index success/failure results.
- Build the final aggregate toast from ordered results.
- Normalize the first displayed reason to one line and 160 characters.
- Retain current successful path insertion and all console diagnostics.
- Document the eleven security invariants from the approved spec and the environment-only configuration/rollout caveat.

### Commit

`fix(attachments): COD-292 surface upload failure reasons`

## Task 4 — Verification, independent review, and release gate

### Focused verification

Run every touched/new focused test file. Then run:

- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm run check:lockfile`
- `npm run check:frontend-syntax`
- `npm run build`

Run `git diff --check` and confirm the worktree is clean after commits.

### Functional beta verification

- Start or refresh the isolated beta from the candidate branch without touching production data.
- Configure a temporary canonical trusted root and a workspace symlink to it.
- Upload a harmless PDF through the real endpoint/UI and confirm logical path insertion, history, raw/preview behavior, restart
  reconstruction, and Remove.
- Repoint the symlink and confirm upload/delete refusal.
- Confirm no response or toast contains the canonical host root.

### Independent reviews

- Spec-compliance review against the approved specification.
- Code-quality/security review of all commits since the pre-implementation base.
- Resolve every Critical or Important finding and re-run affected tests.
- Run a final Cisco Enterprise Claude adversarial review before merge because COD-292 changes a filesystem trust boundary.

### Landing and deployment

- Merge the reviewed branch into `local` only after all gates pass.
- Push Bitbucket `origin/local`; never push `upstream`.
- Build and deploy production from the merged `local` branch using the repository's safe IT15 beta→production procedure.
- Add the machine-local trusted-root environment configuration without committing its path.
- Verify production health, the active managed session, attachment upload/preview/remove, and the attach channel.
- Update Jira with commits, verification evidence, deployment result, and transition COD-292 to Done.
