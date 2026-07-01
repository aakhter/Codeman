import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync('src/web/public/app.js', 'utf8');
const settingsSource = readFileSync('src/web/public/settings-ui.js', 'utf8');
const htmlSource = readFileSync('src/web/public/index.html', 'utf8');

describe('shortcut registry and overlay', () => {
  it('defines shortcut metadata that can be overridden from global settings', () => {
    expect(appSource).toContain('const DEFAULT_SHORTCUTS = [');
    expect(appSource).toContain('shortcutOverrides');
    expect(appSource).toContain('getShortcutRegistry()');
    expect(appSource).toContain('matchesShortcutEvent(e, shortcut)');
  });

  it('renders a shortcut overlay modal from the registry', () => {
    expect(htmlSource).toContain('id="shortcutOverlayModal"');
    expect(htmlSource).toContain('id="shortcutOverlayList"');
    expect(appSource).toContain('showShortcutOverlay()');
    expect(appSource).toContain('renderShortcutOverlay()');
    expect(appSource).toContain('closeShortcutOverlay()');
  });

  it('adds Ctrl/Option question-mark bindings for the overlay', () => {
    expect(appSource).toContain("id: 'show-shortcuts'");
    expect(appSource).toContain("modifiers: ['ctrl']");
    expect(appSource).toContain("modifiers: ['alt']");
    expect(appSource).toContain("key: '?'");
    expect(appSource).toContain("code: 'Slash'");
  });

  it('exposes shortcut overrides in App Settings persistence', () => {
    expect(htmlSource).toContain('id="appSettingsShortcutOverrides"');
    expect(settingsSource).toContain('renderShortcutOverrideEditor');
    expect(settingsSource).toContain('readShortcutOverridesFromEditor');
    expect(settingsSource).toContain('settings.shortcutOverrides');
  });
});
