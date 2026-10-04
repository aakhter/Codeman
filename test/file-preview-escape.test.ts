// @vitest-environment jsdom
/** @fileoverview COD-474 — Escape closes the file/attachment preview overlay. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const publicDir = join(process.cwd(), 'src/web/public');

let proto: Record<string, any>;
let app: any;

beforeAll(() => {
  const source = readFileSync(join(publicDir, 'panels-ui.js'), 'utf8');
  (0, eval)(
    `var CodemanApp = function(){}; var escapeHtml = (v) => String(v ?? '');\n${source}\n` +
      ';globalThis.__panelsProto = CodemanApp.prototype;'
  );
  proto = (globalThis as any).__panelsProto;
});

const makeEscapeEvent = (overrides: Record<string, unknown> = {}) => ({
  key: 'Escape',
  defaultPrevented: false,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  ...overrides,
});

const overlay = () => document.getElementById('filePreviewOverlay') as HTMLElement;
const openPreview = () => overlay().classList.add('visible');

beforeEach(() => {
  document.body.innerHTML = `
    <div class="file-preview-overlay" id="filePreviewOverlay">
      <div class="file-preview-window"><div id="filePreviewBody"></div></div>
    </div>
  `;
  app = Object.create(proto);
  app.$ = (id: string) => document.getElementById(id);
  app.terminal = { focus: vi.fn() };
  app._updateFilePreviewToolbar = vi.fn();
  app._stopFilePreviewMedia = vi.fn();
  app._resetFilePreviewExternalAction = vi.fn();
});

describe('COD-474 Escape closes the file preview', () => {
  it('reports whether the preview is open', () => {
    expect(app._isFilePreviewOpen()).toBe(false);
    openPreview();
    expect(app._isFilePreviewOpen()).toBe(true);
  });

  it('closes an open preview, consumes the key and refocuses the terminal', () => {
    openPreview();
    const e = makeEscapeEvent();

    expect(app._maybeCloseFilePreviewOnEscape(e)).toBe(true);

    expect(overlay().classList.contains('visible')).toBe(false);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(e.stopPropagation).toHaveBeenCalledTimes(1);
    expect(app.terminal.focus).toHaveBeenCalledTimes(1);
  });

  it('does nothing and does not consume Escape when the preview is closed', () => {
    const e = makeEscapeEvent();

    expect(app._maybeCloseFilePreviewOnEscape(e)).toBe(false);

    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(e.stopPropagation).not.toHaveBeenCalled();
    expect(app.terminal.focus).not.toHaveBeenCalled();
  });

  it('closes only the annotation popover when one is open', () => {
    openPreview();
    app._openAnnotationPopover('some passage');
    expect(document.getElementById('annotationPopover')).not.toBeNull();
    const e = makeEscapeEvent();

    expect(app._maybeCloseFilePreviewOnEscape(e)).toBe(true);

    expect(document.getElementById('annotationPopover')).toBeNull();
    expect(overlay().classList.contains('visible')).toBe(true);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('leaves the preview open when an inner handler already used the Escape (docx comment card)', () => {
    openPreview();
    const e = makeEscapeEvent({ defaultPrevented: true });

    expect(app._maybeCloseFilePreviewOnEscape(e)).toBe(true);

    expect(overlay().classList.contains('visible')).toBe(true);
    expect(app.terminal.focus).not.toHaveBeenCalled();
  });

  it('keeps the preview open, still consuming the key, when discarding unsaved edits is cancelled', () => {
    openPreview();
    app.filePreviewEdit = { dirty: true };
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const e = makeEscapeEvent();

    expect(app._maybeCloseFilePreviewOnEscape(e)).toBe(true);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(overlay().classList.contains('visible')).toBe(true);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(app.terminal.focus).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('closes after a confirmed discard of unsaved edits', () => {
    openPreview();
    app.filePreviewEdit = { dirty: true };
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    expect(app._maybeCloseFilePreviewOnEscape(makeEscapeEvent())).toBe(true);

    expect(overlay().classList.contains('visible')).toBe(false);
    confirmSpy.mockRestore();
  });
});

describe('COD-474 wiring', () => {
  const appSrc = readFileSync(join(publicDir, 'app.js'), 'utf8');
  const termSrc = readFileSync(join(publicDir, 'terminal-ui.js'), 'utf8');

  it('the global Escape handler tries the file preview before the Response Viewer', () => {
    const preview = appSrc.indexOf('this._maybeCloseFilePreviewOnEscape?.(e)');
    const viewer = appSrc.indexOf('this._maybeCloseResponseViewerOnEscape(e)');
    expect(preview).toBeGreaterThan(-1);
    expect(preview).toBeLessThan(viewer);
  });

  it('xterm does not forward Escape to the PTY while the preview is open', () => {
    expect(termSrc).toMatch(/ev\.key === 'Escape' && this\._isFilePreviewOpen\?\.\(\)/);
  });
});
