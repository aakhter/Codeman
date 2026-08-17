/**
 * @fileoverview Real-browser event sequencing coverage for COD-315 group menus.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const constants = readFileSync(resolve(publicDir, 'constants.js'), 'utf8');
const appSource = readFileSync(resolve(publicDir, 'app.js'), 'utf8');

describe('COD-315 group menu in Chromium', () => {
  let browser: Browser | undefined;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <button class="tab-layout-group-menu" aria-haspopup="menu" aria-expanded="false">Group actions</button>
          <div id="sessionTabs">
            <div class="session-tab" data-id="other" role="tab" tabindex="0">
              <span class="tab-name">Other tab</span>
            </div>
          </div>
        </body>
      </html>
    `);
    await page.addScriptTag({ content: constants });
    await page.addScriptTag({
      content: `
        var MobileDetection = { isTouchDevice: () => false };
        var KeyboardHandler = {};
        var SwipeHandler = {};
        var VoiceInput = {};
        var DeepgramProvider = {};
        var NotificationManager = function() {};
        ${appSource}
        window.__Cod315App = CodemanApp;
      `,
    });
    await page.evaluate(() => {
      const App = (window as any).__Cod315App;
      const app = Object.create(App.prototype);
      app.tabLayout = { groups: [{ id: 'g1', name: 'Group', refs: [] }] };
      app.startTabGroupRename = () => ((window as any).__groupActions += 1);
      app.editTabLayout = () => ((window as any).__groupActions += 1);
      app.deleteTabGroup = () => ((window as any).__groupActions += 1);
      app.selectSession = (id: string) => (window as any).__activations.push(id);
      app.$ = (id: string) => document.getElementById(id);
      (window as any).__groupActions = 0;
      (window as any).__activations = [];
      (window as any).__tabPointerdowns = 0;

      const trigger = document.querySelector('.tab-layout-group-menu')!;
      const tab = document.querySelector('.session-tab')!;
      trigger.addEventListener('click', (event) => app.openTabGroupMenu(event, 'g1'));
      tab.addEventListener('pointerdown', () => ((window as any).__tabPointerdowns += 1));
      tab.addEventListener('click', (event) => app.handleSessionTabClick(event, 'other'));
      (window as any).app = app;
    });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('dismisses and activates an outside tab from one trusted click without running a menu action', async () => {
    await page.locator('.tab-layout-group-menu').click();
    expect(await page.locator('.tab-layout-group-action-menu').count()).toBe(1);

    await page.locator('.session-tab .tab-name').click();

    expect(await page.locator('.tab-layout-group-action-menu').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).__tabPointerdowns)).toBe(1);
    expect(await page.evaluate(() => (window as any).__activations)).toEqual(['other']);
    expect(await page.evaluate(() => (window as any).__groupActions)).toBe(0);
  });
});
