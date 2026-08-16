/**
 * @fileoverview Real-browser coverage for COD-299 rail layout and interaction.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const constants = readFileSync(resolve(publicDir, 'constants.js'), 'utf8');
const controller = readFileSync(resolve(publicDir, 'tab-rail-resize.js'), 'utf8');

describe('COD-299 vertical rail in Chromium', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent(`
      <!doctype html>
      <html data-tab-orientation="vertical">
        <head><style>${styles}</style></head>
        <body>
          <main class="main" style="width:1280px;height:700px">
            <div class="tab-rail" id="tabRail">
              <div class="session-tabs">
                <div class="session-tab active">
                  <span class="tab-number">1</span>
                  <span class="tab-status idle"></span>
                  <span class="tab-info"><span class="tab-name-row"><span class="tab-mode codex">cx</span><span class="tab-name">w2-codeman-super-long-unbroken-session-name-for-wrapping</span></span></span>
                  <span class="tab-actions"><span class="tab-gear">gear</span><span class="tab-close">x</span><button class="tab-more">...</button></span>
                </div>
              </div>
              <div id="tabRailResizeHandle" class="tab-rail-resize-handle" role="separator" tabindex="0" aria-valuemin="208" aria-valuemax="360" aria-valuenow="256"></div>
            </div>
            <div id="tabRailResizeShield" class="tab-rail-resize-shield" hidden></div>
            <div class="terminal-wrap"><iframe title="Dashboard" style="width:100%;height:100%;border:0"></iframe></div>
          </main>
          <select id="appSettingsTabRailWidth"><option value="custom">Custom</option><option value="208">Compact</option><option value="256">Default</option><option value="320">Wide</option><option value="360">Maximum</option></select>
        </body>
      </html>
    `);
    await page.addScriptTag({ content: constants });
    await page.addScriptTag({
      content: `
        class CodemanApp {}
        window.CodemanApp = CodemanApp;
      `,
    });
    await page.addScriptTag({ content: controller });
    await page.evaluate(() => {
      const app = new (window as any).CodemanApp();
      const settings = { tabRailWidth: 256 };
      (window as any).__settings = settings;
      app.activeSessionId = 'session-1';
      app.detachedSessions = new Set();
      app.loadAppSettingsFromStorage = () => settings;
      app.saveAppSettingsToStorage = (next: Record<string, unknown>) => Object.assign(settings, next);
      app.fitAddon = { proposeDimensions: () => ({ cols: 80, rows: 24 }), fit: () => undefined };
      app.sendResize = async () => {
        (window as any).__resizeCount = ((window as any).__resizeCount || 0) + 1;
        return true;
      };
      app.initTabRailResize();
      document.querySelector('.tab-more')?.addEventListener('click', () => {
        (window as any).__moreClickCount = ((window as any).__moreClickCount || 0) + 1;
      });
      (window as any).app = app;
    });
  });

  afterAll(async () => {
    await browser.close();
  });

  it('keeps the full label while clamping its rendered height to two lines', async () => {
    const metrics = await page.locator('.tab-name').evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        text: element.textContent,
        whiteSpace: style.whiteSpace,
        lineClamp: style.getPropertyValue('-webkit-line-clamp'),
        overflowWrap: style.overflowWrap,
        height: element.getBoundingClientRect().height,
        lineHeight: parseFloat(style.lineHeight),
      };
    });
    expect(metrics.text).toBe('w2-codeman-super-long-unbroken-session-name-for-wrapping');
    expect(metrics.whiteSpace).toBe('normal');
    expect(metrics.lineClamp).toBe('2');
    expect(metrics.overflowWrap).toBe('anywhere');
    expect(metrics.height).toBeLessThanOrEqual(metrics.lineHeight * 2 + 1);
  });

  it('resizes from the keyboard and sends one settled terminal resize', async () => {
    const handle = page.locator('#tabRailResizeHandle');
    await handle.focus();
    await handle.press('ArrowRight');
    expect(await handle.getAttribute('aria-valuenow')).toBe('264');
    expect(await page.evaluate(() => (window as any).app._tabRailResizeOwnsObserver)).toBe(true);
    await page.waitForTimeout(175);
    expect(await page.evaluate(() => (window as any).__resizeCount)).toBe(1);
    await page.waitForTimeout(20);
    expect(await page.evaluate(() => (window as any).app._tabRailResizeOwnsObserver)).toBe(false);
  });

  it('keeps pointer capture across iframe content and settles once', async () => {
    await page.evaluate(() => document.documentElement.setAttribute('data-tab-orientation', 'vertical'));
    const handle = page.locator('#tabRailResizeHandle');
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    const before = await page.evaluate(() => (window as any).__resizeCount || 0);
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 40);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 48, box!.y + 40, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(175);

    expect(Number(await handle.getAttribute('aria-valuenow'))).toBeGreaterThan(264);
    expect(await page.locator('#tabRailResizeShield').isHidden()).toBe(true);
    expect(await page.evaluate(() => (window as any).__resizeCount)).toBe(before + 1);
  });

  it('cleans up the shield if pointer capture is lost', async () => {
    const handle = page.locator('#tabRailResizeHandle');
    const box = await handle.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 40);
    await page.mouse.down();
    expect(await page.locator('body').evaluate((body) => body.classList.contains('tab-rail-resizing'))).toBe(true);
    await handle.dispatchEvent('lostpointercapture', { pointerId: 1 });
    expect(await page.locator('#tabRailResizeShield').isHidden()).toBe(true);
    expect(await page.locator('body').evaluate((body) => body.classList.contains('tab-rail-resizing'))).toBe(false);
    await page.mouse.up();
    await page.waitForTimeout(175);
  });

  it('preserves a preferred width across a temporarily narrow viewport', async () => {
    await page.setViewportSize({ width: 700, height: 800 });
    const narrow = await page.evaluate(() => {
      (window as any).__settings.tabRailWidth = 360;
      const effective = (window as any).app.applyTabRailWidth();
      return { effective, preferred: (window as any).__settings.tabRailWidth };
    });
    expect(narrow).toEqual({ effective: 280, preferred: 360 });

    await page.setViewportSize({ width: 1280, height: 800 });
    expect(await page.evaluate(() => (window as any).app.applyTabRailWidth())).toBe(360);
  });

  it('uses the compact overflow affordance without changing horizontal tabs', async () => {
    await page.evaluate(() => {
      document.documentElement.classList.add('tab-rail-compact');
      document.documentElement.setAttribute('data-tab-orientation', 'vertical');
    });
    expect(await page.locator('.tab-more').isVisible()).toBe(true);
    expect(await page.locator('.tab-gear').isVisible()).toBe(false);
    await page.locator('.tab-more').click();
    expect(await page.evaluate(() => (window as any).__moreClickCount)).toBe(1);

    await page.evaluate(() => {
      document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
      document.body.appendChild(document.querySelector('.session-tabs')!);
    });
    expect(await page.locator('#tabRailResizeHandle').isVisible()).toBe(false);
    expect(await page.locator('.tab-gear').isVisible()).toBe(true);
  });
});
