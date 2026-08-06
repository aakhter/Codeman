/**
 * @fileoverview Issue #212 — File Viewer edit mode wired into the LOCAL preview.
 *
 * Upstream's edit UI was written against the old file-preview implementation
 * (single render, no polling). This checkout replaced that preview with a
 * polling/navigating/annotating one, so the edit helpers had to be wired by
 * hand. These tests pin the four seams where that wiring can silently rot —
 * every one of them fails OPEN (edit still "works", data is lost quietly), so
 * none of them would be caught by the backend's own tests.
 *
 * Behavioral, not source-grep: each exercises the real prototype method.
 * Pure JS-in-vm; no server, no tmux, no browser. Port: N/A.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Proto = Record<string, (...args: never[]) => unknown>;

/** Swapped per test; the vm context's `confirm` delegates here. */
let confirmImpl: (...args: unknown[]) => boolean = () => true;

function loadPanelsUiPrototype(): Proto {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');
  const context = vm.createContext({
    console,
    CodemanApp: class CodemanApp {},
    escapeHtml: (value: unknown) => String(value ?? ''),
    fetch: vi.fn(),
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    document: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    // Indirected so a test can swap the answer per case; the prototype closes
    // over the CONTEXT's binding, not the test file's globalThis.
    confirm: (...args: unknown[]) => confirmImpl(...args),
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return (context as { __proto: Proto }).__proto;
}

const PROTO = loadPanelsUiPrototype();

/** Minimal host with the elements the edit path touches. */
function makeHost(overrides: Record<string, unknown> = {}) {
  const els: Record<string, Record<string, unknown>> = {
    filePreviewEditBtn: { hidden: true },
    filePreviewEditBar: { hidden: true },
    filePreviewDirty: { hidden: true },
    filePreviewSaveBtn: { disabled: true, textContent: 'Save' },
    filePreviewOverlay: { classList: { contains: () => true, remove: vi.fn(), add: vi.fn() } },
    filePreviewBody: { innerHTML: '', querySelector: () => null },
    filePreviewFooter: { textContent: '' },
  };
  return {
    _els: els,
    filePreviewEdit: null as Record<string, unknown> | null,
    filePreviewEditTarget: null as Record<string, unknown> | null,
    filePreviewContent: 'x',
    $: (id: string) => els[id] ?? null,
    _stopFilePreviewPolling: vi.fn(),
    _resetFilePreviewExternalAction: vi.fn(),
    _hideFilePreviewNavigation: vi.fn(),
    _teardownOutlineScrollSpy: vi.fn(),
    _closeAnnotationPopover: vi.fn(),
    _closeAnnotationTray: vi.fn(),
    _resetFilePreviewEdit: PROTO._resetFilePreviewEdit,
    ...overrides,
  };
}

describe('#212 File Viewer edit mode — wiring into the local preview', () => {
  describe('live-refresh poller vs. the open editor', () => {
    it('does not poll while the editor is open (a re-render would eat unsaved keystrokes)', async () => {
      const fetchMeta = vi.fn();
      const host = makeHost({
        filePreviewState: { metadataUrl: '/meta', sessionId: 's1', filePath: 'a.txt' },
        filePreviewEdit: { dirty: true },
        _fetchFilePreviewMetadata: fetchMeta,
      });

      await (PROTO._pollFilePreview as () => Promise<void>).call(host);

      // The guard must come BEFORE any fetch: re-rendering the body replaces
      // innerHTML, destroying the textarea the user is typing into.
      expect(fetchMeta).not.toHaveBeenCalled();
    });

    it('still polls normally when NOT editing (the guard must not disable live refresh)', async () => {
      // Without this the first test passes for the wrong reason — a poller that
      // never runs at all would satisfy it while silently killing COD-58.
      const fetchMeta = vi.fn(async () => ({ mtimeMs: 1, size: 1 }));
      const host = makeHost({
        filePreviewState: { metadataUrl: '/meta', sessionId: 's1', filePath: 'a.txt', signature: 'same' },
        filePreviewEdit: null,
        _fetchFilePreviewMetadata: fetchMeta,
        _setFilePreviewExternalUrl: vi.fn(),
        _filePreviewSignature: () => 'same',
      });

      await (PROTO._pollFilePreview as () => Promise<void>).call(host);

      expect(fetchMeta).toHaveBeenCalledTimes(1);
    });
  });

  describe('closing with unsaved work', () => {
    it('asks before discarding a dirty buffer, and ABORTS the close on cancel', () => {
      const confirmFn = vi.fn(() => false);
      const host = makeHost({ filePreviewEdit: { dirty: true } });
      confirmImpl = confirmFn;
      try {
        (PROTO.closeFilePreview as () => void).call(host);
      } finally {
        confirmImpl = () => true;
      }

      expect(confirmFn).toHaveBeenCalled();
      // Aborted: the overlay stays up and the edit buffer survives.
      expect(host._els.filePreviewOverlay.classList).toBeDefined();
      expect(host.filePreviewEdit).not.toBeNull();
      expect(host._stopFilePreviewPolling).not.toHaveBeenCalled();
    });

    it('closes and clears edit state when the buffer is clean (no prompt)', () => {
      const confirmFn = vi.fn(() => true);
      const host = makeHost({ filePreviewEdit: { dirty: false } });
      confirmImpl = confirmFn;
      try {
        (PROTO.closeFilePreview as () => void).call(host);
      } finally {
        confirmImpl = () => true;
      }

      expect(confirmFn).not.toHaveBeenCalled();
      expect(host.filePreviewEdit).toBeNull();
      expect(host._stopFilePreviewPolling).toHaveBeenCalled();
    });
  });

  describe('the Edit affordance is server-decided', () => {
    it('_resetFilePreviewEdit re-hides the button and clears the target', () => {
      const host = makeHost({
        filePreviewEdit: { dirty: true },
        filePreviewEditTarget: { sessionId: 's1', filePath: 'a.txt' },
      });
      host._els.filePreviewEditBtn.hidden = false;
      host._els.filePreviewEditBar.hidden = false;

      (PROTO._resetFilePreviewEdit as () => void).call(host);

      expect(host.filePreviewEdit).toBeNull();
      expect(host.filePreviewEditTarget).toBeNull();
      expect(host._els.filePreviewEditBtn.hidden).toBe(true);
      expect(host._els.filePreviewEditBar.hidden).toBe(true);
      expect(host._els.filePreviewSaveBtn.disabled).toBe(true);
    });

    it('enterFilePreviewEdit is a no-op without a target (button can never act on a stale path)', async () => {
      const host = makeHost({ filePreviewEditTarget: null });
      await (PROTO.enterFilePreviewEdit as () => Promise<void>).call(host);
      expect(host.filePreviewEdit).toBeNull();
    });
  });

  describe('markup contract', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');

    it('ships the Edit button hidden and wired to the handler', () => {
      expect(html).toContain('id="filePreviewEditBtn"');
      expect(html).toContain('onclick="app.enterFilePreviewEdit()"');
      // Hidden by default: visibility is granted per-render from `data.editable`,
      // so a file the server refuses to edit never shows the affordance.
      expect(html).toMatch(/id="filePreviewEditBtn"[^>]*hidden/);
    });

    it('ships the edit bar with save/cancel wired', () => {
      expect(html).toContain('id="filePreviewEditBar"');
      expect(html).toContain('onclick="app.saveFilePreviewEdit()"');
      expect(html).toContain('onclick="app.cancelFilePreviewEdit()"');
    });
  });
});
