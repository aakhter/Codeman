// @vitest-environment jsdom
/**
 * COD-97 — Monitor "Tmux Sessions" list drifts out of sync with open tabs.
 *
 * The Monitor panel renders `this.muxSessions` (from /api/mux-sessions) while the
 * real open tabs live in `this.sessions` (the UI-session source of truth). Those
 * two can drift client-side: orphaned/`restored-*` mux rows whose sessionId is not
 * in `this.sessions` get rendered as if they were normal tabs, closed tabs leave
 * stale Monitor rows, and the Monitor isn't loaded on init when shown via setting.
 *
 * This suite drives the EXACT shipping artifacts under jsdom (same harness shape as
 * test/document-outline-ui.test.ts): we concat constants.js + app.js + panels-ui.js
 * + settings-ui.js into ONE eval scope and lift `CodemanApp` out, then exercise the
 * real prototype methods (`_renderMuxSessionsImmediate`, `_onSessionDeleted`,
 * `applyMonitorVisibility`).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const publicDir = join(process.cwd(), 'src/web/public');

let CodemanApp: { new (): any };

beforeAll(() => {
  const read = (file: string) => readFileSync(join(publicDir, file), 'utf8');
  const combined =
    'var marked, MobileDetection = { isMobile: function(){ return false; } }, ' +
    'KeyboardHandler = {}, SwipeHandler = {}, VoiceInput = {}, DeepgramProvider = {}, ' +
    'NotificationManager = function(){}, FocusTrap = function(){ return { activate(){}, deactivate(){} }; };\n' +
    read('constants.js') +
    '\n' +
    read('app.js') +
    '\n' +
    read('panels-ui.js') +
    '\n' +
    read('settings-ui.js') +
    '\n;globalThis.__CodemanApp = CodemanApp;';
  (0, eval)(combined);
  CodemanApp = (globalThis as any).__CodemanApp as { new (): any };
});

/** Bare instance + minimal DOM/state the methods under test touch. */
function makeApp(): any {
  const app = Object.create(CodemanApp.prototype);
  app._elemCache = {};
  app.sessions = new Map();
  app.muxSessions = [];
  app._debounceTimers = {};
  // Run debounced renders synchronously so tests don't have to wait on timers.
  app._debouncedCall = function (_key: string, fn: () => void) {
    fn.call(this);
  };
  return app;
}

function muxBody(): HTMLElement {
  let el = document.getElementById('muxSessionsBody');
  if (!el) {
    el = document.createElement('div');
    el.id = 'muxSessionsBody';
    document.body.appendChild(el);
  }
  el.innerHTML = '';
  return el;
}

describe('COD-97 (a) orphan mux rows are not rendered as normal tabs', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('omits / distinctly marks a mux row whose sessionId is absent from this.sessions', () => {
    const app = makeApp();
    const body = muxBody();
    // One real open tab...
    app.sessions.set('s-real', { status: 'idle', isWorking: false });
    // ...and one orphan/restored mux entry with no matching UI session.
    app.muxSessions = [
      { sessionId: 's-real', name: 'real', muxName: 'codeman-real', stats: {} },
      { sessionId: 'restored-xyz', name: 'Restored: codeman-xyz', muxName: 'codeman-xyz', stats: {} },
    ];

    app._renderMuxSessionsImmediate();

    const items = body.querySelectorAll('.process-item');
    // The orphan must NOT appear as a normal clickable tab row.
    const normalRows = body.querySelectorAll('.process-item.process-item-clickable');
    const realRowPresent = [...items].some((n) => n.outerHTML.includes("app.selectSession('s-real')"));
    const orphanAsNormal = [...normalRows].some((n) => n.outerHTML.includes('restored-xyz'));

    expect(realRowPresent).toBe(true);
    expect(orphanAsNormal).toBe(false);

    // If the orphan is rendered at all, it must carry a visually-distinct treatment,
    // never be silently mixed in with the normal rows.
    const orphanHtml = [...body.querySelectorAll('*')].some((n) => n.outerHTML.includes('restored-xyz'));
    if (orphanHtml) {
      expect(body.querySelector('.process-item-orphan')).not.toBeNull();
    }
  });

  it('renders all rows normally when every mux session has a matching tab', () => {
    const app = makeApp();
    const body = muxBody();
    app.sessions.set('s1', { status: 'idle', isWorking: false });
    app.sessions.set('s2', { status: 'busy', isWorking: true });
    app.muxSessions = [
      { sessionId: 's1', name: 'one', muxName: 'codeman-1', stats: {} },
      { sessionId: 's2', name: 'two', muxName: 'codeman-2', stats: {} },
    ];

    app._renderMuxSessionsImmediate();

    expect(body.querySelectorAll('.process-item-clickable').length).toBe(2);
    expect(body.querySelector('.process-item-orphan')).toBeNull();
  });
});

describe('COD-97 (b) deleting a UI session removes its Monitor row', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('re-renders the Monitor so the closed session row disappears', () => {
    const app = makeApp();
    const body = muxBody();
    app.sessions.set('s-keep', { status: 'idle', isWorking: false });
    app.sessions.set('s-gone', { status: 'idle', isWorking: false });
    app.muxSessions = [
      { sessionId: 's-keep', name: 'keep', muxName: 'codeman-keep', stats: {} },
      { sessionId: 's-gone', name: 'gone', muxName: 'codeman-gone', stats: {} },
    ];
    app._renderMuxSessionsImmediate();
    expect(body.outerHTML).toContain('s-gone');

    // Stub the rest of the delete pipeline; we only care that the Monitor refreshes.
    app.activeSessionId = null;
    app._wsSessionId = null;
    app.isSoloWindow = false;
    app.detachedSessions = new Map();
    app.renderSessionTabs = () => {};
    app.renderRalphStatePanel = () => {};
    app.renderProjectInsightsPanel = () => {};
    app.stopSystemStatsPolling = () => {};
    app._cleanupSessionData = (id: string) => {
      app.sessions.delete(id);
    };

    app._onSessionDeleted({ id: 's-gone' });

    // The deleted session must no longer be rendered as an open tab in the Monitor.
    const orphanGone = body.querySelector('.process-item-orphan');
    const goneAsNormal = [...body.querySelectorAll('.process-item-clickable')].some((n) =>
      n.outerHTML.includes("app.selectSession('s-gone')")
    );
    expect(goneAsNormal).toBe(false);
    // The surviving session is still shown.
    expect(body.outerHTML).toContain("app.selectSession('s-keep')");
    void orphanGone;
  });
});

describe('COD-97 (c) showing the Monitor via setting loads mux sessions', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('applyMonitorVisibility() runs loadMuxSessions when the Monitor is shown', () => {
    const app = makeApp();
    const panel = document.createElement('div');
    panel.id = 'monitorPanel';
    document.body.appendChild(panel);

    // Force showMonitor on via the settings cache; stub the unrelated panels.
    app._cachedAppSettings = { showMonitor: true, showSubagents: false, showFileBrowser: false };
    app.getDefaultSettings = () => ({ showMonitor: false, showSubagents: false, showFileBrowser: false });
    app.activeSessionId = null;
    app.loadFileBrowser = () => {};
    app.makeWindowDraggable = () => ({});

    const loadSpy = vi.fn();
    app.loadMuxSessions = loadSpy;

    app.applyMonitorVisibility();

    expect(loadSpy).toHaveBeenCalled();
  });

  it('does NOT load mux sessions when the Monitor is hidden', () => {
    const app = makeApp();
    const panel = document.createElement('div');
    panel.id = 'monitorPanel';
    document.body.appendChild(panel);

    app._cachedAppSettings = { showMonitor: false, showSubagents: false, showFileBrowser: false };
    app.getDefaultSettings = () => ({ showMonitor: false, showSubagents: false, showFileBrowser: false });
    app.activeSessionId = null;
    app.loadFileBrowser = () => {};

    const loadSpy = vi.fn();
    app.loadMuxSessions = loadSpy;

    app.applyMonitorVisibility();

    expect(loadSpy).not.toHaveBeenCalled();
  });
});
