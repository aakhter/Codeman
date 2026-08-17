/**
 * @fileoverview COD-286 — vertical session tabs.
 *
 * `resolveTabOrientation` is the pure policy (unit-tested through vm, like the
 * sibling tab-overflow helper); the rest are static guards over the wiring that
 * cannot regress silently — the rail element, the CSS hook, the settings
 * round-trip, and the per-device merge policy.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');
const stylesCss = readFileSync(resolve(import.meta.dirname, '../src/web/public/styles.css'), 'utf8');
const settingsJs = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');
const appJs = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
const schemasTs = readFileSync(resolve(import.meta.dirname, '../src/web/schemas.ts'), 'utf8');

/**
 * The body of `applyTabOrientation`, from its DEFINITION (not the earlier call
 * sites) to the next method at the same indent. Sliced structurally rather than
 * by a character budget so that adding a comment inside it cannot silently push
 * a guarded line out of range and turn a real assertion into a no-op.
 */
function applyTabOrientationBody(): string {
  const start = settingsJs.indexOf('applyTabOrientation(options = {}) {');
  expect(start, 'applyTabOrientation definition not found in settings-ui.js').toBeGreaterThan(-1);
  const rest = settingsJs.slice(start);
  const end = rest.indexOf('\n  },\n');
  expect(end, 'applyTabOrientation body terminator not found').toBeGreaterThan(-1);
  return rest.slice(0, end);
}

function loadTabOverflowHelper() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (
    context.window as {
      CodemanTabOverflow: {
        resolveTabOrientation: (input: unknown) => string;
      };
    }
  ).CodemanTabOverflow;
}

describe('resolveTabOrientation (COD-286)', () => {
  it('returns vertical only when the setting asks for it', () => {
    const helper = loadTabOverflowHelper();
    expect(helper.resolveTabOrientation({ deviceType: 'desktop', setting: 'vertical' })).toBe('vertical');
    expect(helper.resolveTabOrientation({ deviceType: 'desktop', setting: 'horizontal' })).toBe('horizontal');
  });

  it('defaults to horizontal for missing, empty, or unknown input', () => {
    const helper = loadTabOverflowHelper();
    expect(helper.resolveTabOrientation(undefined)).toBe('horizontal');
    expect(helper.resolveTabOrientation({})).toBe('horizontal');
    expect(helper.resolveTabOrientation({ deviceType: 'desktop', setting: 'sideways' })).toBe('horizontal');
    expect(helper.resolveTabOrientation({ deviceType: 'desktop', setting: undefined })).toBe('horizontal');
  });

  it('keeps phones horizontal even when the setting says vertical', () => {
    const helper = loadTabOverflowHelper();
    expect(helper.resolveTabOrientation({ deviceType: 'mobile', setting: 'vertical' })).toBe('horizontal');
  });

  it('allows tablets to go vertical', () => {
    const helper = loadTabOverflowHelper();
    expect(helper.resolveTabOrientation({ deviceType: 'tablet', setting: 'vertical' })).toBe('vertical');
  });
});

describe('vertical tab rail wiring (COD-286)', () => {
  it('ships a rail mount point inside the main area', () => {
    expect(indexHtml).toContain('id="tabRail"');
    // The rail must precede the terminal so the tabs sit to its left.
    expect(indexHtml.indexOf('id="tabRail"')).toBeLessThan(indexHtml.indexOf('id="terminalContainer"'));
    expect(indexHtml.indexOf('<main class="main">')).toBeLessThan(indexHtml.indexOf('id="tabRail"'));
  });

  it('offers an orientation picker in App Settings', () => {
    expect(indexHtml).toContain('id="appSettingsTabOrientation"');
    expect(indexHtml).toContain('<option value="horizontal">');
    expect(indexHtml).toContain('<option value="vertical">');
  });

  it('drives the layout from a data-tab-orientation attribute on <html>', () => {
    expect(stylesCss).toContain("html[data-tab-orientation='vertical']");
    expect(stylesCss).toContain('.tab-rail');
    expect(settingsJs).toContain('data-tab-orientation');
  });

  it('moves the strip between the header and the rail instead of duplicating it', () => {
    expect(settingsJs).toContain('applyTabOrientation');
    // Scoped to the definition rather than a character budget: the body carries
    // comments, and a budget just measures how much prose sits between two lines.
    expect(applyTabOrientationBody()).toContain("getElementById('tabRail')");
    expect(applyTabOrientationBody()).toContain('rail.appendChild(tabsEl)');
    // Horizontal must put the strip back in the header. Its markup home is
    // #sessionTabsHost (shared with the sidebar layout, which restores it there
    // too); the pre-host fallback still inserts before the right-hand cluster.
    expect(applyTabOrientationBody()).toMatch(/sessionTabsHost[\s\S]*appendChild\(tabsEl\)/);
    expect(settingsJs).toMatch(/headerRight[\s\S]{0,200}insertBefore|insertBefore[\s\S]{0,200}headerRight/);
  });

  it('re-fits the terminal when the orientation changes', () => {
    expect(applyTabOrientationBody()).toMatch(/fitAddon\?\.fit\(\)|restoreTerminalSize|fitTerminal/);
  });

  it('is applied on load alongside the other tab settings', () => {
    expect(appJs).toContain('applyTabOrientation');
    expect(settingsJs).toContain('this.applyTabOrientation');
  });

  it('re-evaluates the home screen after a settings-driven orientation change', () => {
    const applyCall = settingsJs.indexOf('this.applyTabOrientation({ settleRailWidth: true })');
    expect(applyCall).toBeGreaterThan(-1);
    const saveTail = settingsJs.slice(applyCall, applyCall + 1800);
    expect(saveTail).toMatch(/if \(!this\.activeSessionId\) this\.showWelcome\(\)/);
  });

  it('skips the horizontal auto-wrap machinery while vertical', () => {
    const start = appJs.indexOf('updateTabOverflowMode() {');
    expect(start).toBeGreaterThan(-1);
    const overflow = appJs.slice(start, start + 4000);
    expect(overflow).toContain('resolveTabOrientation');
    // The vertical branch must bail out before the measure-and-wrap logic.
    expect(overflow).toContain('shouldAutoWrapTabs');
    expect(overflow.indexOf('resolveTabOrientation')).toBeLessThan(overflow.indexOf('shouldAutoWrapTabs'));
  });
});

describe('tabOrientation settings policy (COD-286)', () => {
  it('defaults to horizontal so an untouched install is unchanged', () => {
    expect(settingsJs).toMatch(/tabOrientation:\s*'horizontal'/);
  });

  it('is a per-device display key, seeded from the server but never overwritten', () => {
    const displayKeys = settingsJs.slice(settingsJs.indexOf('const displayKeys = new Set(['));
    expect(displayKeys.slice(0, 1400)).toContain("'tabOrientation'");
  });

  it('round-trips through the settings form', () => {
    expect(settingsJs).toContain("document.getElementById('appSettingsTabOrientation').value");
    expect(settingsJs).toMatch(/tabOrientation:\s*document\.getElementById\('appSettingsTabOrientation'\)\.value/);
  });

  it('is accepted by the strict server schema like its tabTwoRows sibling', () => {
    expect(schemasTs).toMatch(/tabOrientation:\s*z\.enum\(\['horizontal',\s*'vertical'\]\)\.optional\(\)/);
  });
});
