# Filesystem-backed Session Sources Design

## Goal

Make `.codeman-sources/` the authoritative inventory for file sources, so the
Session Sources modal always reflects the regular files present in the active
session's workspace.

## Scope

- The `GET /api/sessions/:id/sources` response will derive file-source entries
  from regular files directly inside `.codeman-sources/` on every request.
- URL and highlight sources will remain persisted session metadata and will be
  returned alongside the discovered files.
- A file's display title will be its basename and its detail will be its
  workspace-relative `.codeman-sources/<filename>` path.
- File-source IDs will be deterministic from the relative path, so the browser
  can reliably target a discovered file for deletion.
- Deleting a discovered file source will remove that regular file from
  `.codeman-sources/`; deleting a URL or highlight will continue to remove its
  metadata record only.

## Boundaries and Safety

- Scan only the dedicated `.codeman-sources/` directory, never the arbitrary
  session workspace.
- Include direct-child regular files only; ignore directories, symlinks, and
  other special files.
- The local implementation must resolve and delete only validated direct-child
  names under the sources directory. A missing file is an idempotent successful
  delete.
- Remote sessions must use their remote filesystem transport for listing and
  deletion. They must not attempt to read the remote workspace through local
  Node filesystem APIs.
- Persisted legacy `type: 'file'` source records must not be rendered beside a
  discovered file, preventing duplicate cards. URL and highlight metadata
  remains untouched.

## Data Flow

1. The browser opens Sources and requests the existing GET endpoint.
2. The route lists `.codeman-sources/`, converts valid direct children into
   filesystem-backed file-source cards, and merges them with persisted URL and
   highlight cards.
3. Browser upload still writes its bytes into `.codeman-sources/`; the
   subsequent reload sees it through the scan rather than relying on persisted
   file metadata.
4. A file-card delete request identifies the validated filesystem entry and
   deletes it from the source directory; a metadata-card delete continues to
   call `removeSource`.

## Verification

- Route tests prove that an unregistered PDF in `.codeman-sources/` appears in
  GET, while a persisted file record does not create a duplicate.
- Route tests prove that URLs and highlights still render from metadata.
- Route tests prove that deleting a discovered file removes it from disk and
  that missing files remain idempotent.
- Local and remote tests prove that their respective filesystem boundaries are
  used.
- The existing upload tests continue to prove that an uploaded source becomes
  visible after reloading the list.
