# COD-292 Trusted External Attachment Roots Design

## Status

Approved direction, security-reviewed before drafting. This specification covers local document uploads only. It does not
change remote-session transfer behavior.

## Problem

Codeman uploads a dropped document into `.codeman-attachments` under the active session workspace, registers the resulting
file, inserts a workspace-relative attachment reference into the terminal, and exposes the file through opaque attachment
routes. The local upload route deliberately rejects `.codeman-attachments` when it is a symbolic link.

Some workspaces intentionally keep runtime data outside the repository and expose a dedicated external attachment directory
through a compatibility symlink. In those workspaces the browser accepts the drop, but the server returns HTTP 403 because
the attachment directory is not a regular directory. Even if that first check were removed, registration would still fail:
the upload path currently forces workspace confinement, while the symlink-resolved file is outside the workspace.

The browser then hides the useful server message. It logs the error to the console and reports only a generic failure count.

The fix must support an operator-approved external attachment directory without turning an agent-controlled workspace
symlink into a general filesystem write or deletion primitive.

## Goals

- Preserve current upload behavior for a regular workspace-local `.codeman-attachments` directory.
- Permit a local workspace symlink only when its canonical target exactly matches an operator-approved attachment root.
- Keep upload, registration, history, preview, raw download, and removal working across a server restart.
- Preserve request ownership, CSRF, rate limits, content validation, attachment blocklists, opaque IDs, restrictive file modes,
  and symlink-safe file-leaf creation.
- Make the final browser toast include an actionable, path-safe server error.
- Configure the production KB workspace without replacing its intentional compatibility symlink.

## Non-goals

- No support for trusted roots on remote SSH sessions; their transfer path remains unchanged.
- No general permission for workspace symlinks or ancestor-root containment.
- No browser-editable trusted-root setting or App Settings UI.
- No per-case storage schema in this iteration.
- No migration of existing attachment files.
- No change to supported document extensions or file-size limits.

## Threat model

The workspace and terminal output are agent-controlled. A prompt-injected or compromised agent may create, replace, or
repoint workspace symlinks; choose filenames; race upload and delete requests; and know another live session ID. In
multi-user mode a non-admin may be actively malicious and must not access another user's session or a shared host attachment
root. Browser requests are authenticated but remain untrusted input.

The operator controls the Codeman process environment and the exact trusted attachment directories. A configured trusted
root is a dedicated Codeman attachment enclave, not a broad runtime-data ancestor. Environment changes require a server
restart.

Codeman cannot create a perfect privilege boundary from an agent running as the same operating-system user. The purpose of
these guards is to prevent the web API and prompt-driven session from accidentally widening their existing authority.

## Security review findings incorporated

The pre-design review found three issues that constrain the implementation:

1. The local upload and delete routes call `findSessionOrFail` without the request, skipping multi-user ownership checks. One
   history fallback also turns an ownership denial into an unchecked lookup. These are prerequisite fixes.
2. Deletion is more dangerous than upload because the existing path-only rule survives restarts but can unlink any file under
   the resolved attachment directory. Trusted-root deletion therefore needs both fresh root resolution and persisted upload
   provenance.
3. An allowlist widens access and must never be writable through the browser settings API. Trusted roots are environment-only.

## Design decisions

### 1. Environment-only, exact roots

Add `CODEMAN_TRUSTED_ATTACHMENT_ROOTS`, a comma-separated list of absolute local directories. Parse and canonicalize this
configuration once per process startup. A test-only reset hook may clear the cached snapshot.

Each entry is accepted only when all of the following hold:

- it is an absolute path;
- it exists and is a directory;
- `realpath(entry) === entry`, so the configured root itself is not reached through a symlink;
- it is not blocked by `isSensitivePath` or the active attachment blocked-tree policy;
- it is unique after canonicalization.

Invalid entries are ignored with a path-safe warning that identifies the configuration position, not the rejected host path.
The feature is disabled when the resulting list is empty.

Trusted roots do not appear in `SettingsUpdateSchema` and are not read from browser-writable settings. The environment is the
only authority. The deployment must configure the dedicated attachment directory itself, never a parent such as a general
runtime-data root.

### 2. One canonical directory resolver

Introduce one shared resolver for local attachment storage. Both upload and delete must call it; neither route may implement
its own trust rule.

Conceptually it returns:

```ts
type ResolvedUploadDirectory = { kind: 'workspace'; canonicalDir: string } | { kind: 'trusted'; canonicalDir: string };
```

Resolution rules:

1. Inspect `{workingDir}/.codeman-attachments` with `lstat`.
2. If it is a regular directory, return the current workspace behavior after canonical containment validation.
3. If it is a symlink, allow the trusted branch only for a single-user request or a multi-user administrator.
4. Resolve the symlink target and require it to be a directory whose canonical path exactly equals one configured root.
5. Re-assert that the configured root still resolves to itself.
6. Reject every other file type, broken symlink, nested directory under a configured ancestor, or unapproved target with 403.

The resolver returns no configured path in its error. Public errors use messages such as `.codeman-attachments is not an
approved upload directory`.

Exact equality is intentional. Allowing any descendant of a broad trusted ancestor would let the agent choose a destination
and would widen deletion to agent-selected directories. The existing string-prefix `isUnderTree` helper is suitable for a
fail-safe blocklist but must not be reused for an allowlist.

### 3. Request ownership prerequisite

Before widening storage, make every affected session lookup request-aware:

- local document upload calls `findSessionOrFail(ctx, id, req)`;
- uploaded-document deletion calls `findSessionOrFail(ctx, id, req)`;
- attachment-history lookup never falls back from an ownership-filtered miss to an unchecked session lookup.

Focused multi-user tests must prove that a non-admin receives the normal not-found response when using another user's session
ID for upload, delete, or history.

This lands as a separate prerequisite commit so the security correction is independently reviewable.

### 4. Canonical writes

The local upload route uses the shared resolver and writes directly to `canonicalDir`, never through the workspace symlink.
Immediately before opening the destination file, it revalidates that `realpath(canonicalDir) === canonicalDir`.

File creation keeps the current flags and mode:

- `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`;
- mode `0600`;
- a sanitized basename with timestamp and random suffix;
- byte-signature, extension, size, CSRF, and rate-limit checks before the write.

The workspace-local branch remains force-confined to the workspace. Only the trusted branch substitutes its approved
canonical boundary for workspace confinement.

### 5. Boundary-validated registration and reads

Do not represent trust as a transient boolean on the in-memory registry. The registry is lost on restart, so authorization
must be recomputable from the workspace, persisted history provenance, and current environment configuration.

Generalize the existing generated-artifact boundary validation into a reusable attachment-boundary primitive, or add a
trusted-upload boundary field that uses the same validation implementation. A trusted upload record stores its canonical
attachment root as a boundary. Every raw, preview, and thumbnail read re-resolves both file and boundary and requires:

- the boundary still resolves to itself;
- the file still resolves inside that boundary;
- the extension, size, and attachment blocklist remain valid.

The workspace-local branch keeps `forceWorkspaceConfinement: true`. The trusted branch passes the approved canonical boundary
and does not force workspace confinement.

### 6. Persisted upload provenance

Extend attachment history with an optional backward-compatible provenance field that distinguishes Codeman uploads from
detected or externally registered files. Newly uploaded documents persist `source: 'upload'`. Existing history records with no
source retain their current read behavior but are not treated as trusted-root upload ownership evidence.

When attachment history is rebuilt after restart, a record can regain trusted-upload boundary treatment only when all of the
following are true:

- persisted provenance is `upload`;
- the session remains owned by the requester;
- the workspace's current `.codeman-attachments` resolves through the shared resolver to an approved exact root;
- the history file resolves directly inside that canonical root.

Persisted boundary strings are not trusted. The boundary is recomputed from current configuration each time.

### 7. Removal semantics

Regular workspace-local deletion retains its current behavior.

Trusted-root deletion uses a stricter branch:

1. Resolve the session with request ownership.
2. Re-run the shared upload-directory resolver for the current workspace.
3. Require `kind === 'trusted'` and revalidate the canonical root.
4. Resolve the requested file and require it to be a direct child of the exact canonical root; nested paths and traversal are
   rejected.
5. Require a matching persisted attachment-history item for this session with `source: 'upload'` and the same canonical file.
6. Delete only that single file, never recursively.
7. Remove the history and in-memory registry entries and persist the session state.

This keeps deletion restart-safe without assuming every file in a shared filesystem tree belongs to Codeman. Files that
predate upload provenance remain readable when otherwise allowed but do not gain a Remove action through this feature.

If the environment changes, the workspace symlink is repointed, or the history provenance is absent, deletion fails closed.

### 8. History and Remove affordance

History serialization remains backward-compatible. When building a route item for a trusted-root upload, synthesize the
logical agent path `.codeman-attachments/<basename>` only after the same resolver and provenance checks succeed. This logical
path enables the existing Remove affordance without exposing the canonical host path to the browser.

The server continues to store and resolve canonical paths internally. The terminal receives the logical relative attachment
path so the agent's established workflow remains unchanged.

### 9. Frontend error reporting

The document worker records the first upload failure as `{ fileName, message }` while retaining the existing console warning
for every failure. The final toast includes successes, the failure count, and the first safe reason, for example:

```text
2 documents ready · 1 failed: Quarterly Report.pdf — attachment directory is not approved
```

Server messages on this route must never include configured root paths. The frontend treats any unexpected or non-JSON
response as a generic HTTP failure and does not display response bodies verbatim.

## Data flow

1. The browser splits a drop into allowed documents and images.
2. Each document is POSTed to the existing session upload endpoint.
3. The server authenticates the request, verifies session ownership, validates CSRF/rate/content limits, and resolves storage.
4. A regular directory follows the existing workspace-confined path; an approved symlink follows the trusted exact-root path.
5. The server writes to the canonical directory, registers the attachment with the appropriate boundary, persists upload
   provenance, and returns a logical `.codeman-attachments/<name>` path.
6. The browser inserts the attachment block without Enter and shows a detailed aggregate result.
7. History reconstruction recomputes trust from the current workspace and environment rather than trusting stale registry or
   boundary state.
8. Removal repeats ownership, storage resolution, canonical containment, and provenance checks before unlinking one file.

## Error behavior

| Condition                                                            | Response                                                                         |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| No trusted roots configured and attachment directory is a symlink    | 403, path-safe unapproved-directory message                                      |
| Symlink target is not an exact configured root                       | 403                                                                              |
| Configured root is missing, blocked, non-directory, or non-canonical | Entry ignored; affected upload returns 403                                       |
| Non-admin attempts trusted-root use in multi-user mode               | 403                                                                              |
| Foreign session ID                                                   | Existing ownership-safe not-found response                                       |
| Root or symlink changes between resolution and write/delete          | Fail closed before mutation                                                      |
| Trusted deletion lacks persisted upload provenance                   | 403; file remains                                                                |
| Upload partially succeeds in a batch                                 | Successful logical paths are inserted; toast reports successes and first failure |

## Configuration and rollout

1. Deploy code with no trusted-root environment value. Existing workspaces are unchanged and intentional symlinks remain 403.
2. Configure the production service with the exact canonical dedicated attachment directory in
   `CODEMAN_TRUSTED_ATTACHMENT_ROOTS`.
3. Restart Codeman; trusted roots are snapshotted at process startup.
4. Verify upload, history, preview, restart recovery, and removal in beta with an isolated temporary directory.
5. Verify the production workspace after deployment by uploading a harmless document, confirming its logical relative path and
   preview, then removing it through the UI.

The repository must not contain the machine-specific configured path. Deployment configuration remains local and secret-free.

## Testing strategy

Implementation follows RED to GREEN with real temporary directories and Fastify `app.inject()` route tests.

### Configuration and resolver

1. Empty/unset environment produces no trusted roots.
2. Relative, missing, non-directory, blocked, and whitespace entries are ignored.
3. A configured path reached through a symlink is rejected.
4. Duplicate canonical entries are deduplicated.
5. A regular workspace directory resolves as `workspace` without configuration.
6. A symlink to an exact configured root resolves as `trusted` for single-user/admin requests.
7. A symlink to a child beneath a configured root is rejected.
8. A broken or repointed symlink is rejected.
9. Non-admin trusted-root resolution is rejected in multi-user mode.

### Upload and reads

10. Regular-directory upload remains 200 and workspace-confined.
11. Unapproved symlink upload remains 403.
12. Exact approved-root upload returns 200, writes bytes at the canonical target, and returns a logical relative agent path.
13. Concurrent uploads produce distinct filenames.
14. CSRF, rate limit, byte signature, size, and extension validation remain unchanged on the trusted branch.
15. Raw, preview, and thumbnail reads succeed while the approved boundary remains valid.
16. A boundary or symlink change causes subsequent reads to fail closed.

### Ownership, history, and deletion

17. Foreign-session upload, history, and delete requests return the ownership-safe not-found response.
18. Trusted upload history persists `source: 'upload'` and exposes a logical removable path.
19. Clearing the in-memory registry and rebuilding from history restores preview and removal.
20. Trusted deletion removes a direct-child file with matching upload provenance.
21. Trusted deletion rejects a sibling file with no matching upload provenance.
22. Trusted deletion rejects traversal, nested paths, a removed root configuration, and a repointed workspace symlink.
23. Existing history without provenance remains readable but not removable through the trusted branch.
24. Regular workspace-local removal retains its current behavior.

### Frontend

25. A failed upload captures the filename and first server message.
26. The aggregate toast reports successful and failed counts plus the first reason.
27. Multiple failures retain console diagnostics but show only one bounded, path-safe reason.
28. A non-JSON failure falls back to a generic HTTP message.

### Verification gate

- Focused route and frontend tests only; never invoke the full Vitest suite from a managed session.
- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm run check:lockfile`
- `npm run check:frontend-syntax`
- `npm run build`
- Isolated beta functional check before production deployment.
- Post-deploy health, active-session, attachment upload/preview/remove, and attach-channel checks.

## Implementation sequence

1. Ownership prerequisite and regression tests; commit separately.
2. Environment parser and shared exact-root resolver with unit tests.
3. Trusted upload write and boundary-validated registration with route tests.
4. Persisted upload provenance, history reconstruction, and read checks.
5. Trusted deletion and Remove affordance with restart and symlink-swap tests.
6. Frontend error aggregation and focused UI tests.
7. Architecture/security documentation and deployment configuration notes.
8. Independent security review, complete verification gate, beta validation, merge, push, production deploy, and Jira evidence.

## Security invariants to document

1. Trusted upload roots are environment-only and never browser-writable.
2. A configured root must be absolute, canonical-to-itself, a directory, and outside blocked trees.
3. A symlinked workspace attachment directory must resolve exactly to a configured root.
4. Upload and delete share one resolver and recompute trust for every mutation.
5. Writes target the canonical directory and preserve exclusive no-follow file creation with mode `0600`.
6. Trusted reads revalidate their canonical boundary on every request.
7. Trusted deletion requires current root approval and persisted upload provenance for the requesting session.
8. Trusted roots are unavailable to non-admin users in multi-user mode.
9. Public errors and browser payloads never reveal configured canonical roots.
10. Regular workspace-local behavior remains unchanged.
