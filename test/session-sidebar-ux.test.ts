/** @fileoverview Structural and schema coverage for COD-339 sidebar UX. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SettingsUpdateSchema } from '../src/web/schemas.js';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const app = readFileSync(resolve(publicDir, 'app.js'), 'utf8');
const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const settingsUi = readFileSync(resolve(publicDir, 'settings-ui.js'), 'utf8');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const i18n = readFileSync(resolve(publicDir, 'i18n.js'), 'utf8');

describe('COD-339 session sidebar UX contract', () => {
  it('accepts only integer session-name sizes from 11 through 18 pixels', () => {
    for (const value of [11, 14, 18]) {
      expect(SettingsUpdateSchema.safeParse({ sessionSidebarFontSize: value }).success).toBe(true);
    }
    for (const value of [10, 19, 14.5, '14']) {
      expect(SettingsUpdateSchema.safeParse({ sessionSidebarFontSize: value }).success).toBe(false);
    }
  });

  it('places one existing action cluster inside the name row only for sidebar layouts', () => {
    expect(app).toContain('const inlineSidebarActions = this.isSessionSidebarActive();');
    expect(app).toContain('const tabActionsHtml =');
    expect(app).toContain("${inlineSidebarActions ? tabActionsHtml : ''}");
    expect(app).toContain("${inlineSidebarActions ? '' : tabActionsHtml}");
    expect(app.match(/class="tab-actions"/g)).toHaveLength(1);

    expect(styles).toMatch(
      /html\[data-session-list="sidebar"\] \.session-sidebar \.tab-name-row,[\s\S]*?\{[^}]*min-width: 0;/
    );
    expect(styles).toMatch(
      /html\[data-session-list="sidebar"\] \.session-sidebar \.tab-actions \{[^}]*flex-shrink: 0;/s
    );
  });

  it('wires a device-scoped 11–18px range through load, save, defaults, apply and first paint', () => {
    expect(html).toContain('id="appSettingsSessionSidebarFontSize"');
    expect(html).toContain('id="appSettingsSessionSidebarFontSizeValue"');
    expect(html).toMatch(/id="appSettingsSessionSidebarFontSize"[^>]*min="11"[^>]*max="18"[^>]*step="1"/);
    expect(html).toContain('sessionSidebarFontSize');
    expect(html).toContain('--session-sidebar-name-font-size');

    expect(settingsUi).toContain("document.getElementById('appSettingsSessionSidebarFontSize').value =");
    expect(settingsUi).toContain('sessionSidebarFontSize: this.resolveSessionSidebarFontSize(');
    expect(settingsUi).toContain('sessionSidebarFontSize: 14,');
    expect(settingsUi).toContain("'sessionSidebarFontSize'");

    expect(app).toContain('resolveSessionSidebarFontSize(value)');
    expect(app).toContain('applySessionSidebarFontSize(settings = null)');
    expect(app).toContain("root.style.setProperty('--session-sidebar-name-font-size', `${size}px`);");
    expect(app).toContain('this.applySessionSidebarFontSize();');

    expect(styles).toMatch(
      /html\[data-session-list="sidebar"\] \.session-sidebar \.tab-name \{[^}]*font-size: var\(--session-sidebar-name-font-size, 14px\);/s
    );
  });

  it('labels and translates the session-name-only scope', () => {
    expect(html).toContain('Session Name Font Size');
    expect(html).toContain('Adjust only session names in the vertical sidebar.');
    expect(i18n).toContain("'Session Name Font Size':");
    expect(i18n).toContain("'Adjust only session names in the vertical sidebar.':");
  });
});
