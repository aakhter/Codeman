/**
 * @fileoverview COD-299 — resizable vertical session rail with smart name wrapping.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const indexHtml = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const stylesCss = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const settingsJs = readFileSync(resolve(publicDir, 'settings-ui.js'), 'utf8');
const appJs = readFileSync(resolve(publicDir, 'app.js'), 'utf8');
const terminalUiJs = readFileSync(resolve(publicDir, 'terminal-ui.js'), 'utf8');
const railResizeJs = readFileSync(resolve(publicDir, 'tab-rail-resize.js'), 'utf8');
const buildJs = readFileSync(resolve(import.meta.dirname, '../scripts/build.mjs'), 'utf8');

type RailPolicy = {
  DEFAULT_WIDTH: number;
  MIN_WIDTH: number;
  MAX_WIDTH: number;
  resolveWidth: (input?: {
    width?: unknown;
    viewportWidth?: number;
    mainWidth?: number;
    minTerminalWidth?: number;
  }) => number;
  resolveKeyboardWidth: (input: {
    key: string;
    shiftKey?: boolean;
    currentWidth: number;
    viewportWidth?: number;
    mainWidth?: number;
    minTerminalWidth?: number;
  }) => number | null;
};

function loadRailPolicy(): RailPolicy {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(publicDir, 'constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (context.window as { CodemanTabRail: RailPolicy }).CodemanTabRail;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('tab rail width policy (COD-299)', () => {
  it('defaults to 256px and clamps corrupt or out-of-range stored values', () => {
    const policy = loadRailPolicy();
    expect(policy.DEFAULT_WIDTH).toBe(256);
    expect(policy.MIN_WIDTH).toBe(208);
    expect(policy.MAX_WIDTH).toBe(360);
    expect(policy.resolveWidth()).toBe(256);
    expect(policy.resolveWidth({ width: Number.NaN })).toBe(256);
    expect(policy.resolveWidth({ width: 120 })).toBe(208);
    expect(policy.resolveWidth({ width: 900 })).toBe(360);
  });

  it('also protects viewport and terminal space', () => {
    const policy = loadRailPolicy();
    expect(policy.resolveWidth({ width: 360, viewportWidth: 800 })).toBe(320);
    expect(policy.resolveWidth({ width: 360, viewportWidth: 1400, mainWidth: 700, minTerminalWidth: 400 })).toBe(300);
  });

  it('supports accessible keyboard steps, bounds, and reset', () => {
    const policy = loadRailPolicy();
    const base = { currentWidth: 256, viewportWidth: 1600, mainWidth: 1200, minTerminalWidth: 400 };
    expect(policy.resolveKeyboardWidth({ ...base, key: 'ArrowLeft' })).toBe(248);
    expect(policy.resolveKeyboardWidth({ ...base, key: 'ArrowRight' })).toBe(264);
    expect(policy.resolveKeyboardWidth({ ...base, key: 'ArrowRight', shiftKey: true })).toBe(288);
    expect(policy.resolveKeyboardWidth({ ...base, key: 'Home' })).toBe(208);
    expect(policy.resolveKeyboardWidth({ ...base, key: 'End' })).toBe(360);
    expect(policy.resolveKeyboardWidth({ ...base, key: 'Enter', currentWidth: 320 })).toBe(256);
    expect(policy.resolveKeyboardWidth({ ...base, key: 'Escape' })).toBeNull();
  });
});

describe('tab rail resize and wrapping wiring (COD-299)', () => {
  it('ships an accessible separator and non-drag width presets', () => {
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

  it('keeps the setting device-local and round-trips it through App Settings', () => {
    expect(settingsJs).toMatch(/tabRailWidth:\s*256/);
    expect(settingsJs).toContain("document.getElementById('appSettingsTabRailWidth')");
    expect(settingsJs).toMatch(/tabRailWidth:\s*this\.readTabRailWidthSetting/);
    const displayKeys = settingsJs.slice(settingsJs.indexOf('const displayKeys = new Set(['));
    expect(displayKeys.slice(0, 1600)).toContain("'tabRailWidth'");
    expect(settingsJs).toMatch(/tabRailWidth:\s*_trw/);
  });

  it('installs a dedicated controller before the first terminal is created', () => {
    expect(indexHtml).toContain('<script defer src="tab-rail-resize.js"></script>');
    expect(appJs).toContain('this.initTabRailResize?.()');
    expect(railResizeJs).toContain('setPointerCapture');
    expect(railResizeJs).toContain('tab-rail-resizing');
    expect(railResizeJs).toMatch(/sendResize\(this\.activeSessionId/);
    expect(railResizeJs).toMatch(/150/);
    expect(railResizeJs).toContain("addEventListener('lostpointercapture'");
    expect(railResizeJs).toContain('_tabRailResizeWatchdog');
    expect(terminalUiJs).toMatch(/if \(this\._tabRailResizeOwnsObserver\) return/);
    expect(buildJs).toMatch(/run\(\s*'minify tab-rail-resize\.js'/);
    expect(buildJs).toMatch(/HASHABLE[\s\S]{0,800}'tab-rail-resize\.js'/);
  });

  it('coalesces repeated width changes into one settled PTY resize', async () => {
    vi.useFakeTimers();
    class FakeCodemanApp {}
    let orientation = 'vertical';
    const context = vm.createContext({
      CodemanApp: FakeCodemanApp,
      window: {},
      document: {
        documentElement: { getAttribute: () => orientation },
        querySelector: () => null,
      },
      console,
      clearTimeout,
      setTimeout,
    });
    vm.runInContext(railResizeJs, context, { filename: 'tab-rail-resize.js' });
    const app = new FakeCodemanApp() as FakeCodemanApp & {
      activeSessionId: string;
      sendResize: ReturnType<typeof vi.fn>;
      _persistTabRailWidth: ReturnType<typeof vi.fn>;
      _scheduleTabRailSettle: (width: number) => void;
      _tabRailResizeOwnsObserver?: boolean;
    };
    app.activeSessionId = 'session-1';
    app.sendResize = vi.fn(async () => true);
    app._persistTabRailWidth = vi.fn();
    app._tabRailResizeOwnsObserver = true;

    app._scheduleTabRailSettle(248);
    app._scheduleTabRailSettle(264);
    await vi.advanceTimersByTimeAsync(149);
    expect(app.sendResize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(app._persistTabRailWidth).toHaveBeenCalledOnce();
    expect(app._persistTabRailWidth).toHaveBeenCalledWith(264);
    expect(app.sendResize).toHaveBeenCalledOnce();
    expect(app.sendResize).toHaveBeenCalledWith('session-1');
    expect(app._tabRailResizeOwnsObserver).toBe(false);

    orientation = 'horizontal';
    app._tabRailResizeOwnsObserver = true;
    app._scheduleTabRailSettle(256);
    await vi.advanceTimersByTimeAsync(150);
    expect(app.sendResize).toHaveBeenCalledTimes(2);
    expect(app._tabRailResizeOwnsObserver).toBe(false);
  });

  it('wraps only vertical rail names to two lines while preserving unbroken names', () => {
    const verticalNameRule = stylesCss.slice(
      stylesCss.indexOf("html[data-tab-orientation='vertical'] .tab-rail .session-tab .tab-name"),
      stylesCss.indexOf("html[data-tab-orientation='vertical'] .tab-rail .session-tab .tab-name") + 700
    );
    expect(verticalNameRule).toContain('-webkit-line-clamp: 2');
    expect(verticalNameRule).toContain('overflow-wrap: anywhere');
    expect(verticalNameRule).toContain('white-space: normal');
  });

  it('provides visible focus, an adequate hit target, and reduced-motion behavior', () => {
    expect(stylesCss).toMatch(/\.tab-rail-resize-handle[\s\S]{0,500}width:\s*16px/);
    expect(stylesCss).toContain('.tab-rail-resize-handle:focus-visible');
    expect(stylesCss).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]{0,1200}tab-rail/);
  });

  it('keeps full names available and offers compact actions at narrow widths', () => {
    expect(appJs).toMatch(/const tabTooltip = [^;]*name/);
    expect(appJs).toContain('class="tab-name-prefix"');
    expect(appJs).toContain('data-full-name="${escapeHtml(name)}"');
    expect(appJs).toContain("tab.setAttribute('aria-label', accessibleName)");
    expect(stylesCss).toMatch(/data-tab-orientation='vertical'[\s\S]{0,100}\.tab-name-prefix/);
    expect(appJs).toContain('tab-more');
    expect(railResizeJs).toContain('openTabRailActionMenu');
    expect(stylesCss).toContain('tab-rail-compact');
  });

  it('routes Settings width changes through the same settled resize coordinator', () => {
    expect(settingsJs).toContain('applyTabOrientation({ settleRailWidth: true })');
    expect(settingsJs).toContain('this.applyTabRailWidth?.({ settle: shouldSettleRailWidth })');
    expect(settingsJs).toContain('if (!shouldSettleRailWidth) this.fitAddon?.fit()');
  });
});
