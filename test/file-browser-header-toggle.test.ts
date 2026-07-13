// @vitest-environment jsdom
/**
 * @fileoverview COD-235 — the desktop Files header button is a session-gated toggle whose
 * state is derived from the canonical file-browser panel, including non-header entry points.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';

const publicDir = join(process.cwd(), 'src/web/public');
const readPublic = (file: string) => readFileSync(join(publicDir, file), 'utf8');

let CodemanApp: { new (): any };

beforeAll(() => {
  const combined =
    'var marked, MobileDetection = { isMobile: function(){ return false; }, isTouchDevice: function(){ return false; }, getDeviceType: function(){ return "desktop"; } }, ' +
    'KeyboardHandler = {}, SwipeHandler = {}, VoiceInput = {}, DeepgramProvider = {}, ' +
    'NotificationManager = function(){}, FocusTrap = function(){ return { activate(){}, deactivate(){} }; };\n' +
    readPublic('constants.js') +
    '\n' +
    readPublic('app.js') +
    '\n' +
    readPublic('panels-ui.js') +
    '\n' +
    readPublic('settings-ui.js') +
    '\n;globalThis.__Cod235App = CodemanApp;';
  (0, eval)(combined);
  CodemanApp = (globalThis as any).__Cod235App as { new (): any };
});

function mountFileBrowserDom() {
  document.body.innerHTML = `
    <button id="fileBrowserBtn" aria-expanded="false" disabled></button>
    <div id="fileBrowserPanel"></div>
  `;
  return {
    button: document.getElementById('fileBrowserBtn') as HTMLButtonElement,
    panel: document.getElementById('fileBrowserPanel') as HTMLDivElement,
  };
}

function makeApp(activeSessionId: string | null = null): any {
  const app = Object.create(CodemanApp.prototype);
  app._elemCache = {};
  app.activeSessionId = activeSessionId;
  app.fileBrowserDragListeners = {};
  app.loadFileBrowser = vi.fn();
  app.makeWindowDraggable = vi.fn(() => ({}));
  app.loadAppSettingsFromStorage = vi.fn(() => ({}));
  app.saveAppSettingsToStorage = vi.fn();
  return app;
}

beforeEach(() => {
  mountFileBrowserDom();
});

describe('COD-235 Files header markup and phone policy', () => {
  it('ships an accessible, initially disabled folder toggle beside Sources and Library', () => {
    const html = readPublic('index.html');
    const match = html.match(/<button\b[^>]*id="fileBrowserBtn"[^>]*>[\s\S]*?<\/button>/);

    expect(match, '#fileBrowserBtn is missing').toBeTruthy();
    const button = match![0];
    expect(button).toContain('class="btn-icon-header btn-files"');
    expect(button).toContain('onclick="app.toggleFileBrowserPanel()"');
    expect(button).toContain('title="Files"');
    expect(button).toContain('aria-label="Open files panel"');
    expect(button).toContain('aria-expanded="false"');
    expect(button).toMatch(/<button\b[^>]*\sdisabled(?:\s|>)/);
    expect(button).toMatch(/<svg\b[\s\S]*?<path\b/);

    const sourcesIndex = html.indexOf('id="sourcesBtn"');
    const filesIndex = html.indexOf('id="fileBrowserBtn"');
    const libraryIndex = html.indexOf('id="libraryBtn"');
    expect(sourcesIndex).toBeGreaterThan(-1);
    expect(filesIndex).toBeGreaterThan(sourcesIndex);
    expect(filesIndex).toBeLessThan(libraryIndex);
  });

  it('independently hides .btn-files at phone width', () => {
    const hiddenAtPhone = new Set<string>();
    postcss.parse(readPublic('mobile.css')).walkAtRules('media', (atRule) => {
      const max = atRule.params.match(/max-width:\s*(\d+)px/);
      const min = atRule.params.match(/min-width:\s*(\d+)px/);
      if (max && 393 > Number(max[1])) return;
      if (min && 393 < Number(min[1])) return;
      if (!max && !min) return;

      atRule.walkRules((rule) => {
        const hides = rule.nodes.some(
          (node) =>
            node.type === 'decl' && node.prop === 'display' && node.value.replace(/!important/i, '').trim() === 'none'
        );
        if (hides && rule.selector.includes('.btn-files')) hiddenAtPhone.add('btn-files');
      });
    });

    expect(hiddenAtPhone.has('btn-files')).toBe(true);
  });
});

describe('COD-235 canonical Files header behavior', () => {
  it('does nothing without an active session or the required panel DOM', () => {
    const app = makeApp(null);
    app.showFileBrowserPanel = vi.fn();
    app.closeFileBrowserPanel = vi.fn();

    expect(app.toggleFileBrowserPanel).toBeTypeOf('function');
    app.toggleFileBrowserPanel();
    expect(app.showFileBrowserPanel).not.toHaveBeenCalled();
    expect(app.closeFileBrowserPanel).not.toHaveBeenCalled();

    app.activeSessionId = 'session-a';
    document.getElementById('fileBrowserPanel')?.remove();
    expect(() => app.toggleFileBrowserPanel()).not.toThrow();
    expect(app.showFileBrowserPanel).not.toHaveBeenCalled();
    expect(app.closeFileBrowserPanel).not.toHaveBeenCalled();
  });

  it('routes closed to canonical show for the active session and open to canonical close', () => {
    const { panel } = mountFileBrowserDom();
    const app = makeApp('session-a');
    app.showFileBrowserPanel = vi.fn();
    app.closeFileBrowserPanel = vi.fn();

    app.toggleFileBrowserPanel();
    expect(app.showFileBrowserPanel).toHaveBeenCalledWith('session-a');
    expect(app.closeFileBrowserPanel).not.toHaveBeenCalled();

    panel.classList.add('visible');
    app.toggleFileBrowserPanel();
    expect(app.closeFileBrowserPanel).toHaveBeenCalledOnce();
  });

  it('derives disabled, active, and aria-expanded only from session plus panel visibility', () => {
    const { button, panel } = mountFileBrowserDom();
    const app = makeApp(null);

    panel.classList.add('visible');
    app.updateFileBrowserHeaderButton();
    expect(button.disabled).toBe(true);
    expect(button.classList.contains('active')).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('false');

    app.activeSessionId = 'session-a';
    app.updateFileBrowserHeaderButton();
    expect(button.disabled).toBe(false);
    expect(button.classList.contains('active')).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');

    panel.classList.remove('visible');
    app.updateFileBrowserHeaderButton();
    expect(button.disabled).toBe(false);
    expect(button.classList.contains('active')).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('synchronizes derived header state after canonical show and close', () => {
    const app = makeApp('session-a');
    app.updateFileBrowserHeaderButton = vi.fn();

    CodemanApp.prototype.showFileBrowserPanel.call(app, 'session-a');
    expect(app.updateFileBrowserHeaderButton).toHaveBeenCalledOnce();

    app.updateFileBrowserHeaderButton.mockClear();
    app.fileBrowserDragListeners = null;
    CodemanApp.prototype.closeFileBrowserPanel.call(app);
    expect(app.updateFileBrowserHeaderButton).toHaveBeenCalledOnce();
  });

  it('synchronizes after App Settings directly hides the panel', () => {
    const { panel } = mountFileBrowserDom();
    panel.classList.add('visible');
    const app = makeApp('session-a');
    app._cachedAppSettings = { showMonitor: false, showSubagents: false, showFileBrowser: false };
    app.getDefaultSettings = vi.fn(() => ({ showMonitor: false, showSubagents: false, showFileBrowser: false }));
    app.updateFileBrowserHeaderButton = vi.fn();

    app.applyMonitorVisibility();

    expect(panel.classList.contains('visible')).toBe(false);
    expect(app.updateFileBrowserHeaderButton).toHaveBeenCalledOnce();
  });

  it('synchronizes from the central session-tab render path', () => {
    const app = makeApp('session-a');
    app._inlineRenameActive = false;
    app._debouncedCall = vi.fn();
    app.updateFileBrowserHeaderButton = vi.fn();

    app.renderSessionTabs();

    expect(app.updateFileBrowserHeaderButton).toHaveBeenCalledOnce();
  });

  it('keeps an already-visible panel bound to its owner when session selection finishes', () => {
    const source = CodemanApp.prototype.selectSession.toString();
    const fileBrowserBlock = source.match(/\/\/ Load file browser if enabled([\s\S]*?)\n\s*}\);/i)?.[1] ?? '';

    expect(fileBrowserBlock).toContain("classList.contains('visible')");
    expect(fileBrowserBlock).toContain('this.showFileBrowserPanel(sessionId)');
    expect(fileBrowserBlock).not.toContain("classList.add('visible')");
    expect(fileBrowserBlock).not.toContain('this.loadFileBrowser(sessionId)');
    expect(fileBrowserBlock).not.toContain('this.makeWindowDraggable');
  });

  it('preserves Session Manager Open folder routing through canonical reveal', () => {
    const source = readPublic('terminal-ui.js');
    const openFolderBlock = source.match(/addItem\('Open folder',[\s\S]*?\n\s*}\);/)?.[0] ?? '';

    expect(openFolderBlock).toContain('this.selectSession(s.sessionId)');
    expect(openFolderBlock).toContain('this.showFileBrowserPanel?.(s.sessionId)');
  });
});
