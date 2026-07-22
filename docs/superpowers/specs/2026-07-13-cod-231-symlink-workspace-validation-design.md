# COD-231 Symlinked Workspace Validation Design

## Context

COD-231 correctly bound Files-panel actions to the session that produced the displayed tree, but production acceptance exposed a separate backend boundary failure. The roadmap sessions use `/home/aakhter/projects/kb` as their working directory; that path is a symlink to the canonical OneDrive workspace under `/mnt/c`. The Files scanner walks the configured path and lists the requested DOCX, while `validateSessionFilePath()` canonicalizes only the requested file. It then compares the canonical `/mnt/c/...` file against the unresolved `/home/...` base and falsely classifies the file as outside the workspace.

This affects every session-scoped route that uses the shared validator, including file metadata, raw download, converted preview, thumbnails, attachment confinement, and related consumers.

## Design

`validateSessionFilePath(sessionWorkingDir, filePath)` will canonicalize both sides of the containment check:

1. Resolve the requested path against the configured working directory.
2. Resolve the working directory itself with `realpathSync()`.
3. Resolve the requested path with `realpathSync()`.
4. Calculate the relative path from the canonical workspace root to the canonical requested path.
5. Reject the request if either realpath operation fails, or if the relative result starts with `..` or is absolute.
6. Return the canonical requested path and canonical workspace-relative path for accepted files.

Canonicalizing both operands preserves the existing security model. A workspace symlink becomes a valid root alias, while a nested symlink whose target leaves that canonical root remains rejected.

## Alternatives Rejected

- **Patch only Files-panel routes:** avoids changing other consumers but leaves the same false 404 in thumbnails, attachments, and any other shared-validator path.
- **Normalize session working directories globally:** creates a broader persistence and display-path change, with unnecessary compatibility risk.
- **Compare lexical unresolved paths:** would make the pictured file work but weaken protection against nested symlink escapes.

## Error Handling

The validator remains fail-closed. An unreadable or missing workspace, an unreadable or missing requested file, or any canonical path outside the workspace returns `null`; callers retain their current structured 404/validation behavior.

## Verification

Focused tests will prove:

- a real file under a symlinked workspace root is accepted;
- the returned `resolvedPath` and `relativePath` are canonical and workspace-relative;
- a nested symlink targeting a file outside the canonical workspace is rejected;
- missing workspace and missing requested files are rejected;
- existing traversal, route, attachment, and file-browser ownership behavior remains green.

Functional verification will use the exact production workspace alias and pictured roadmap DOCX. Before deployment, the candidate must demonstrate successful metadata, raw download, and DOCX-to-PDF preview behavior without weakening the escape test. Production deployment remains separately authorization-gated.

## Scope

The implementation is limited to the shared validator and focused regression coverage. It does not change Files-panel ownership, session persistence, displayed paths, attachment identity, or arbitrary absolute-path policy.
