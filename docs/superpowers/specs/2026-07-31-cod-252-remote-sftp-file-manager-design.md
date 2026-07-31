# COD-252 Remote SFTP File Manager Design

## Goal

Make the existing File Viewer list and browse the workspace of an SSH-backed session without any extra user configuration.

## Root cause

The File Viewer always walks `session.workingDir` with Node's local filesystem. For a remote session, that directory is meaningful only on the SSH host, so the local walk returns an empty tree.

## Design

Use the installed OpenSSH `sftp` client as the remote file transport. This is deliberate: the existing remote-host record already captures the connection contract (identity file, port, jump host, SOCKS proxy, and additional `-o` options), and the OpenSSH SFTP client accepts the same contract. The new argument builder will reuse the existing SSH argv builder and translate only the port spelling from SSH's `-p` to SFTP's `-P`.

A focused SFTP helper owns connection setup, batch-command encoding, bounded directory listing, text reads, and streamed downloads. It accepts only a session's `SessionRemote` metadata plus a workspace-relative path. It resolves paths against `remote.remotePath`, rejects absolute paths, traversal, NULs, and line-control characters before constructing a batch command, and applies explicit operation timeouts.

The File Viewer routes will select the transport from the live session:

- local session: preserve the current Node filesystem implementation;
- remote session: call the SFTP helper for directory entries and file bytes.

Remote directory loading will be lazy: the first request returns the remote workspace root, and expanding a directory requests only that directory's children. This avoids a large recursive SFTP transfer while retaining the existing panel interaction. Text preview and download use the same SFTP transport, so a visible remote file never leads to a local-only action that fails.

## Error handling and compatibility

Connection and SFTP errors return the normal API error envelope with a clear remote-operation message. Local sessions, existing SSH terminal creation, and saved remote-host configuration are unchanged. The feature does not add alternate credentials, persist secrets, or create a separate SFTP host configuration.

## Tests

Unit tests cover SFTP argv conversion and batch-command validation, including identity, custom port, jump host, SOCKS proxy, and extra SSH options. Route tests mock the transport and cover remote root listing, child listing, an empty remote directory, invalid relative paths, and remote errors. Existing local File Viewer tests remain the compatibility baseline.
