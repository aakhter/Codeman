/**
 * @fileoverview Source-level a11y guards for the document-upload UI (COD-241 Part B).
 *
 * The upload UI lives in plain browser JS (panels-ui.js / document-input.js) with
 * no bundler, and jsdom fails at env setup on this box, so these are node-safe
 * source assertions (not DOM assertions): they pin the a11y contract — accessible
 * names, an accept allowlist, a polite live region for toasts, a file-naming
 * Remove label, and focus restoration after remove — against regressions. Real
 * DOM behavior is exercised by the browser suite in CI.
 *
 * Port: N/A (reads source files, no server).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'src', 'web', 'public');
const panelsUi = readFileSync(join(publicDir, 'panels-ui.js'), 'utf8');
const documentInput = readFileSync(join(publicDir, 'document-input.js'), 'utf8');

describe('document-upload a11y contract (source-level)', () => {
  it('"Add files" button is keyboard-focusable with an accessible name', () => {
    // A real <button> (implicitly focusable) carrying an aria-label.
    expect(panelsUi).toMatch(/<button[^>]*id="attachmentHistoryAddBtn"[^>]*aria-label="Add files"[^>]*>/);
  });

  it('the file <input> accept attribute covers the full upload allowlist', () => {
    const acceptMatch = documentInput.match(/input\.accept\s*=\s*'([^']+)'/);
    expect(acceptMatch).toBeTruthy();
    const accept = acceptMatch![1];
    for (const ext of ['.pdf', '.docx', '.pptx', '.md', '.markdown', '.txt']) {
      expect(accept).toContain(ext);
    }
  });

  it('the frontend accept list matches the _documentUploadExtensions allowlist', () => {
    // Parity guard: the two lists must not drift (mobile pickers rely on accept).
    const extsMatch = documentInput.match(/_documentUploadExtensions:\s*\[([^\]]+)\]/);
    expect(extsMatch).toBeTruthy();
    for (const ext of ['pdf', 'docx', 'pptx', 'md', 'markdown', 'txt']) {
      expect(extsMatch![1]).toContain(`'${ext}'`);
    }
  });

  it('toasts are announced: the toast container is a polite live region', () => {
    expect(panelsUi).toContain("setAttribute('aria-live', 'polite')");
    expect(panelsUi).toContain("setAttribute('role', 'status')");
  });

  it('the Remove control is a real <button> whose aria-label names the file', () => {
    expect(panelsUi).toMatch(/aria-label="Remove uploaded file \$\{escapeHtml\(item\.fileName\)\}"/);
  });

  it('focus is restored to a stable control after a remove re-renders the list', () => {
    expect(documentInput).toMatch(/getElementById\('attachmentHistoryAddBtn'\)\??\.focus\(\)/);
  });
});
