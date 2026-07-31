# COD-255 macOS SFTP listing compatibility design

## Problem

The macOS OpenSSH SFTP server emits `?` for the hard-link-count column in an `ls -l` response. Codeman currently requires that column to be numeric, drops otherwise valid records, and returns an empty successful File Viewer tree.

## Decision

Treat the link-count column as opaque formatting metadata and accept either a numeric value or `?`. Continue requiring a numeric size field, so file size metadata and the existing security boundaries remain unchanged.

## Verification

Add a unit regression using the captured macOS shape, prove it fails under the old parser, then verify the focused SFTP and File Viewer route tests pass.
