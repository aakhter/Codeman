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
    expect(settingsJs).toMatch(/tabRail[\s\S]{0,400}appendChild/);
    // Horizontal must put the strip back in the header, before the right-hand cluster.
    expect(settingsJs).toMatch(/headerRight[\s\S]{0,200}insertBefore|insertBefore[\s\S]{0,200}headerRight/);
  });

  it('re-fits the terminal when the orientation changes', () => {
    // Slice from the DEFINITION, not the earlier call site.
    const defStart = settingsJs.indexOf('applyTabOrientation() {');
    expect(defStart).toBeGreaterThan(-1);
    const applyBlock = settingsJs.slice(defStart, defStart + 2500);
    expect(applyBlock).toMatch(/fitAddon\?\.fit\(\)|restoreTerminalSize|fitTerminal/);
  });

  it('is applied on load alongside the other tab settings', () => {
    expect(appJs).toContain('applyTabOrientation');
    expect(settingsJs).toContain('this.applyTabOrientation');
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
