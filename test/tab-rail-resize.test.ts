/** @fileoverview COD-358 resizable vertical session rail policy and wiring. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const readPublic = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');
const indexHtml = readPublic('index.html');
const stylesCss = readPublic('styles.css');
const settingsJs = readPublic('settings-ui.js');
const appJs = readPublic('app.js');
const terminalUiJs = readPublic('terminal-ui.js');
const buildJs = readFileSync(resolve(import.meta.dirname, '../scripts/build.mjs'), 'utf8');

type RailPolicy = {
  DEFAULT_WIDTH: number;
  MIN_WIDTH: number;
  MAX_WIDTH: number;
  resolveWidth: (input?: Record<string, unknown>) => number;
  resolveKeyboardWidth: (input: Record<string, unknown>) => number | null;
};

function loadRailPolicy(): RailPolicy {
  const context = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(readPublic('constants.js'), context, { filename: 'constants.js' });
  return (context.window as { CodemanTabRail: RailPolicy }).CodemanTabRail;
}

afterEach(() => vi.useRealTimers());

describe('tab rail width policy', () => {
  it('uses fixed storage bounds and separate viewport/terminal clamps', () => {
    const policy = loadRailPolicy();
    expect(policy.DEFAULT_WIDTH).toBe(256);
    expect(policy.MIN_WIDTH).toBe(208);
    expect(policy.MAX_WIDTH).toBe(360);
    expect(policy.resolveWidth()).toBe(256);
    expect(policy.resolveWidth({ width: 120 })).toBe(208);
    expect(policy.resolveWidth({ width: 900 })).toBe(360);
    expect(policy.resolveWidth({ width: 360, viewportWidth: 700 })).toBe(280);
    expect(policy.resolveWidth({ width: 360 })).toBe(360);
    expect(policy.resolveWidth({ width: 360, mainWidth: 700, minTerminalWidth: 400 })).toBe(300);
  });

  it('supports accessible keyboard steps and reset keys', () => {
    const policy = loadRailPolicy();
    const base = { currentWidth: 256, viewportWidth: 1600, mainWidth: 1200, minTerminalWidth: 400 };
    expect(policy.resolveKeyboardWidth({ ...base, key: 'ArrowLeft' })).toBe(248);
    expect(policy.resolveKeyboardWidth({ ...base, key: 'ArrowRight' })).toBe(264);
    expect(policy.resolveKeyboardWidth({ ...base, key: 'ArrowRight', shiftKey: true })).toBe(288);
    expect(policy.resolveKeyboardWidth({ ...base, key: 'Home' })).toBe(208);
    expect(policy.resolveKeyboardWidth({ ...base, key: 'End' })).toBe(360);
    expect(policy.resolveKeyboardWidth({ ...base, key: 'Enter' })).toBe(256);
    expect(policy.resolveKeyboardWidth({ ...base, key: 'Escape' })).toBeNull();
  });
});

describe('tab rail resize wiring', () => {
  it('ships an accessible handle and width presets', () => {
    expect(indexHtml).toContain('id="tabRailResizeHandle"');
    expect(indexHtml).toContain('role="separator"');
    expect(indexHtml).toContain('aria-orientation="vertical"');
    expect(indexHtml).toContain('aria-valuemin="208"');
    expect(indexHtml).toContain('aria-valuemax="360"');
    expect(indexHtml).toContain('id="appSettingsTabRailWidth"');
    expect(indexHtml).toContain('<option value="208">Compact');
    expect(indexHtml).toContain('<option value="256">Default');
    expect(indexHtml).toContain('<option value="320">Wide');
    expect(indexHtml).toContain('<option value="360">Maximum');
  });

  it('keeps preferred width device-local and distinct from effective width', () => {
    expect(settingsJs).toMatch(/tabRailWidth:\s*256/);
    expect(settingsJs).toMatch(/tabRailWidth:\s*this\.readTabRailWidthSetting/);
    const displayKeys = settingsJs.slice(settingsJs.indexOf('const displayKeys = new Set(['));
    expect(displayKeys.slice(0, 1900)).toContain("'tabRailWidth'");
    const controller = readPublic('tab-rail-resize.js');
    expect(controller).toContain('_scheduleTabRailSettle(resolved, preferred)');
    expect(controller).toContain('_scheduleTabRailSettle(effective, preferred)');
    expect(controller).toContain('applyTabOrientation?.()');
    expect(controller).toContain('applyTabRailWidth({ persist: false })');
  });

  it('installs the controller before terminal creation and owns generic observer churn', () => {
    const controller = readPublic('tab-rail-resize.js');
    expect(indexHtml).toContain('<script defer src="tab-rail-resize.js"></script>');
    expect(appJs).toContain('this.initTabRailResize?.()');
    expect(controller).toContain('setPointerCapture');
    expect(controller).toContain("addEventListener('lostpointercapture'");
    expect(controller).toContain('_tabRailResizeWatchdog');
    expect(terminalUiJs).toMatch(/if \(this\._tabRailResizeOwnsObserver\) return/);
    expect(buildJs).toContain("run('minify tab-rail-resize.js'");
    expect(buildJs).toMatch(/HASHABLE[\s\S]{0,1000}'tab-rail-resize\.js'/);
  });

  it('coalesces effective changes while persisting the preferred width', async () => {
    vi.useFakeTimers();
    const controller = readPublic('tab-rail-resize.js');
    class FakeCodemanApp {}
    const context = vm.createContext({
      CodemanApp: FakeCodemanApp,
      window: {},
      document: { querySelector: () => null },
      console,
      clearTimeout,
      setTimeout,
    });
    vm.runInContext(controller, context, { filename: 'tab-rail-resize.js' });
    const app = new FakeCodemanApp() as FakeCodemanApp & Record<string, any>;
    app.activeSessionId = 'session-1';
    app.sendResize = vi.fn(async () => true);
    app._persistTabRailWidth = vi.fn();
    app._tabRailResizeOwnsObserver = true;

    app._scheduleTabRailSettle(280, 360);
    app._scheduleTabRailSettle(300, 360);
    await vi.advanceTimersByTimeAsync(150);
    expect(app._persistTabRailWidth).toHaveBeenCalledOnce();
    expect(app._persistTabRailWidth).toHaveBeenCalledWith(360);
    expect(app.sendResize).toHaveBeenCalledOnce();
    expect(app._tabRailResizeOwnsObserver).toBe(false);
  });

  it('retains complete labels and clamps only the settled vertical presentation', () => {
    expect(appJs).toContain('class="tab-name-prefix"');
    const start = stylesCss.indexOf("html[data-tab-orientation='vertical'] .tab-rail .session-tab .tab-name");
    const rule = stylesCss.slice(start, start + 800);
    expect(rule).toContain('-webkit-line-clamp: 2');
    expect(rule).toContain('overflow-wrap: anywhere');
    expect(rule).toContain('white-space: normal');
  });
});
