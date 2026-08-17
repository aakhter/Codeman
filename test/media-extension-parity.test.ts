/**
 * @fileoverview Media-extension parity — attachment registry ⇄ frontend copies.
 *
 * CLAUDE.md single-sources playable media extensions in
 * `VIDEO_ATTACHMENT_EXTENSIONS`/`AUDIO_ATTACHMENT_EXTENSIONS`
 * (src/attachment-registry.ts): the workspace preview and the out-of-workspace
 * attachment path must agree on what plays. The frontend cannot import that
 * module, so two hand-maintained copies exist and BOTH have drifted:
 *
 *  - `FILE_PREVIEW_EXTENSIONS` (constants.js) decides whether a clicked
 *    terminal/chat path opens the preview overlay or the tail/log viewer. It
 *    was missing `m4v ogv ogg oga m4a aac flac opus`, so an in-workspace
 *    `.m4a` routed to the log viewer and rendered as binary noise while the
 *    same file in /tmp played fine.
 * The <video>/<audio> markup choice is NOT a frontend copy here: the preview
 * renders off `data.type` ('video'/'audio'), which `detectAttachmentType()`
 * derives from those same registry sets, so that half cannot drift by
 * construction. constants.js is the one hand-maintained copy left, and it is
 * what this file pins.
 *
 * Same technique as test/sse-registry-parity.test.ts: the backend sets are
 * imported, the frontend copy is extracted from the shipped source as text
 * (no build-time link exists), and the sets are compared. No port needed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AUDIO_ATTACHMENT_EXTENSIONS, VIDEO_ATTACHMENT_EXTENSIONS } from '../src/attachment-registry.js';

const publicFile = (name: string) =>
  readFileSync(resolve(import.meta.dirname, '..', 'src', 'web', 'public', name), 'utf8');

/** `FILE_PREVIEW_EXTENSIONS` is a space-separated string literal in constants.js. */
function filePreviewExtensions(): Set<string> {
  const src = publicFile('constants.js');
  const m = src.match(/const FILE_PREVIEW_EXTENSIONS = new Set\(\s*\('([^']+)'\)\.split\(' '\)\s*\)/);
  expect(m, 'FILE_PREVIEW_EXTENSIONS literal not found in constants.js').not.toBeNull();
  return new Set(m![1].split(' '));
}

describe('media extension parity (attachment registry ⇄ frontend)', () => {
  it('extracts non-trivial sets from every source (guards the parsers)', () => {
    expect(VIDEO_ATTACHMENT_EXTENSIONS.size).toBeGreaterThanOrEqual(5);
    expect(AUDIO_ATTACHMENT_EXTENSIONS.size).toBeGreaterThanOrEqual(8);
    expect(filePreviewExtensions().size).toBeGreaterThan(10);
  });

  it('every playable media extension routes to the preview overlay, not the log viewer', () => {
    const preview = filePreviewExtensions();
    const missing = [...VIDEO_ATTACHMENT_EXTENSIONS, ...AUDIO_ATTACHMENT_EXTENSIONS].filter((e) => !preview.has(e));
    expect(
      missing,
      `media extensions in attachment-registry.ts but not constants.js FILE_PREVIEW_EXTENSIONS: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('renders media off the registry-derived type, with no extension copy in panels-ui.js', () => {
    // The upstream copies (VIDEO_EXTS/AUDIO_EXTS) were removed when the preview
    // moved to server-supplied `data.type`. A reintroduced copy is a copy that
    // can drift, which is the whole reason this file exists — so it fails here.
    const src = publicFile('panels-ui.js');
    expect(src).not.toMatch(/const (VIDEO|AUDIO)_EXTS = new Set\(/);
    expect(src).toContain("data.type === 'video'");
    expect(src).toContain("data.type === 'audio'");
  });
});
