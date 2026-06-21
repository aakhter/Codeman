/**
 * @fileoverview COD-141 — Session Manager "⋯ → Open folder" must actually REVEAL the file
 * browser panel, not just fetch files into a hidden tree.
 *
 * Root cause: the per-row Open-folder handler called `loadFileBrowser(sessionId)`, which only
 * populates `#fileBrowserTree` and early-returns if the tree (i.e. the hidden panel) isn't
 * present. The reveal logic (add `.visible`, wire drag listeners) lived ONLY in settings-ui.js
 * gated behind the `showFileBrowser` App Setting (default OFF) — so with the setting off, Open
 * folder did nothing visible.
 *
 * Fix: a single canonical `showFileBrowserPanel(sessionId)` helper on the prototype (panels-ui.js)
 * that ALWAYS reveals (classList.add('visible')) and THEN calls loadFileBrowser. The
 * `showFileBrowser` setting only gates whether settings-ui.js CALLS the helper; the explicit
 * Open-folder action calls it unconditionally. The helper itself never consults the setting.
 *
 * This pins the reveal CONTRACT of the helper:
 *   1. adds the `visible` class to `#fileBrowserPanel`, then
 *   2. calls `loadFileBrowser(sessionId)` exactly once — AFTER the class is added (so the panel
 *      and `#fileBrowserTree` exist and loadFileBrowser won't early-return),
 *   3. routes the PASSED sessionId (not `this.activeSessionId`) to loadFileBrowser,
 *   4. early-returns without throwing (and without loading) when the panel element is absent.
 *
 * Loaded via `vm` against a stub `CodemanApp` (no jsdom — same harness as
 * connection-indicator.test.ts). panels-ui.js does `Object.assign(CodemanApp.prototype, {...})`
 * at module-eval, so we capture the real `showFileBrowserPanel` off the prototype and invoke it
 * against a minimal host whose `$`/`loadFileBrowser` are spies.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/** Eval the shipping panels-ui.js into a vm with a stub CodemanApp + escapeHtml, return its prototype. */
function loadPanelsUiPrototype(): Record<string, (...args: unknown[]) => unknown> {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');
  const context = vm.createContext({
    console,
    // panels-ui.js does `Object.assign(CodemanApp.prototype, {...})` — provide a stub class.
    CodemanApp: class CodemanApp {},
    // constants.js provides escapeHtml in the browser; panels-ui.js references it at module scope.
    escapeHtml: (s: unknown) => String(s ?? ''),
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    document: { addEventListener: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return (context as { __proto: Record<string, (...args: unknown[]) => unknown> }).__proto;
}

const proto = loadPanelsUiPrototype();

/** A fake `#fileBrowserPanel` element whose classList add/remove are spied. */
function fakePanel() {
  return {
    classList: { add: vi.fn(), remove: vi.fn() },
    // No header → the drag-attach block in the helper is skipped cleanly.
    querySelector: vi.fn(() => null),
    style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
}

type Host = {
  $: (id: string) => unknown;
  loadFileBrowser: ReturnType<typeof vi.fn>;
  fileBrowserDragListeners: unknown;
  makeWindowDraggable: ReturnType<typeof vi.fn>;
  showFileBrowserPanel: (sessionId: string) => void;
  activeSessionId: string | null;
};

/**
 * Build a host carrying the real `showFileBrowserPanel`. `panel` may be null to exercise the
 * missing-element early-return. `fileBrowserDragListeners` is preset truthy so the drag block is
 * skipped regardless — keeps each test focused on the reveal/load contract.
 */
function makeHost(panel: ReturnType<typeof fakePanel> | null): Host {
  const host = {
    $: vi.fn((id: string) => (id === 'fileBrowserPanel' ? panel : null)),
    loadFileBrowser: vi.fn(),
    fileBrowserDragListeners: {},
    makeWindowDraggable: vi.fn(() => ({})),
    activeSessionId: 'active-sess',
  } as unknown as Host;
  if (typeof proto.showFileBrowserPanel !== 'function') {
    throw new Error('panels-ui.js missing method: showFileBrowserPanel');
  }
  host.showFileBrowserPanel = proto.showFileBrowserPanel as Host['showFileBrowserPanel'];
  return host;
}

describe('COD-141 showFileBrowserPanel — canonical reveal helper', () => {
  it('adds the `visible` class AND loads the given session (load after add)', () => {
    const panel = fakePanel();
    const host = makeHost(panel);

    host.showFileBrowserPanel('sess-1');

    expect(panel.classList.add).toHaveBeenCalledTimes(1);
    expect(panel.classList.add).toHaveBeenCalledWith('visible');
    expect(host.loadFileBrowser).toHaveBeenCalledTimes(1);
    expect(host.loadFileBrowser).toHaveBeenCalledWith('sess-1');

    // Order: the panel must be revealed BEFORE loadFileBrowser runs (else it early-returns).
    const addOrder = panel.classList.add.mock.invocationCallOrder[0];
    const loadOrder = host.loadFileBrowser.mock.invocationCallOrder[0];
    expect(addOrder).toBeLessThan(loadOrder);
  });

  it('early-returns without throwing or loading when the panel element is absent', () => {
    const host = makeHost(null);

    expect(() => host.showFileBrowserPanel('sess-1')).not.toThrow();
    expect(host.loadFileBrowser).not.toHaveBeenCalled();
  });

  it('routes the PASSED sessionId to loadFileBrowser (does not read this.activeSessionId)', () => {
    const panel = fakePanel();
    const host = makeHost(panel);
    host.activeSessionId = 'active-sess';

    host.showFileBrowserPanel('other-sess');

    expect(host.loadFileBrowser).toHaveBeenCalledTimes(1);
    expect(host.loadFileBrowser).toHaveBeenCalledWith('other-sess');
    expect(host.loadFileBrowser).not.toHaveBeenCalledWith('active-sess');
  });

  it('does not consult a setting — reveals regardless (no showFileBrowser gating in the helper)', () => {
    const panel = fakePanel();
    const host = makeHost(panel) as Host & { showFileBrowser?: boolean };
    // Even with the setting conceptually OFF, the helper itself always reveals.
    host.showFileBrowser = false;

    host.showFileBrowserPanel('sess-1');

    expect(panel.classList.add).toHaveBeenCalledWith('visible');
    expect(host.loadFileBrowser).toHaveBeenCalledWith('sess-1');
  });
});
