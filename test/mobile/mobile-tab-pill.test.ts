import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext } from 'playwright';
import type { WebServer } from '../../src/web/server.js';
import { getBrowser } from './helpers/browser.js';
import { PORTS } from './helpers/constants.js';
import { createTestServer, stopTestServer } from './helpers/server.js';

const PORT = PORTS.MOBILE_TAB_PILL;
const BASE_URL = `http://localhost:${PORT}`;

describe('Mobile session-switcher pill eligibility', () => {
  let browser: Browser;
  let server: WebServer;
  const contexts: BrowserContext[] = [];

  beforeAll(async () => {
    server = await createTestServer(PORT);
    browser = await getBrowser('chromium');
  });

  afterAll(async () => {
    await Promise.all(contexts.map((context) => context.close()));
    await stopTestServer(server);
  });

  it.each([
    { width: 430, expectedEnabled: true, expectedPillDisplay: 'flex', expectedStripDisplay: 'none' },
    { width: 440, expectedEnabled: true, expectedPillDisplay: 'flex', expectedStripDisplay: 'none' },
    { width: 599, expectedEnabled: true, expectedPillDisplay: 'flex', expectedStripDisplay: 'none' },
    { width: 600, expectedEnabled: false, expectedPillDisplay: 'none', expectedStripDisplay: 'flex' },
  ])(
    'uses the phone switcher boundary at $width px',
    async ({ width, expectedEnabled, expectedPillDisplay, expectedStripDisplay }) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        hasTouch: true,
      });
      contexts.push(context);
      const page = await context.newPage();

      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.app && window.MobileTabSheet);

      const result = await page.evaluate(() => {
        window.app.sessionOrder = Array.from({ length: 12 }, (_, index) => `session-${index + 1}`);
        window.MobileTabSheet.updatePill();

        const pill = document.getElementById('mobileTabPill');
        const strip = document.getElementById('sessionTabsHost');
        if (!pill || !strip) throw new Error('Mobile tab controls were not rendered');

        return {
          width: window.innerWidth,
          enabled: window.MobileTabSheet._isEnabled(),
          pillDisplay: getComputedStyle(pill).display,
          stripDisplay: getComputedStyle(strip).display,
        };
      });

      expect(result).toEqual({
        width,
        enabled: expectedEnabled,
        pillDisplay: expectedPillDisplay,
        stripDisplay: expectedStripDisplay,
      });
    }
  );

  it('toggles the sheet and shows the complete active session name at 440px', async () => {
    const context = await browser.newContext({
      viewport: { width: 440, height: 900 },
      hasTouch: true,
    });
    contexts.push(context);
    const page = await context.newPage();

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.app && window.MobileTabSheet);

    const initial = await page.evaluate(() => {
      const app = window.app as any;
      const activeSessionId = 'mobile-pill-active';
      app.sessionOrder = [activeSessionId, ...Array.from({ length: 11 }, (_, index) => `session-${index + 1}`)];
      app.sessions.set(activeSessionId, {
        id: activeSessionId,
        name: 'w1-Codeman',
        status: 'idle',
        mode: 'codex',
        workingDir: '/tmp/Codeman',
      });
      app.activeSessionId = activeSessionId;
      window.MobileTabSheet.updatePill();

      const pill = document.getElementById('mobileTabPill');
      const label = pill?.querySelector('.pill-mini');
      if (!pill || !label) throw new Error('Mobile tab pill was not rendered');

      return {
        label: label.textContent,
        labelClientWidth: label.clientWidth,
        labelScrollWidth: label.scrollWidth,
        expanded: pill.getAttribute('aria-expanded'),
      };
    });

    expect(initial.label).toBe('w1-Codeman');
    expect(initial.labelScrollWidth).toBeLessThanOrEqual(initial.labelClientWidth);
    expect(initial.expanded).toBe('false');

    await page.locator('#mobileTabPill').click();
    await expect
      .poll(() =>
        page.evaluate(() => ({
          sheetOpen: document.getElementById('mobileTabSheet')?.classList.contains('open'),
          scrimOpen: document.getElementById('mobileTabScrim')?.classList.contains('open'),
          expanded: document.getElementById('mobileTabPill')?.getAttribute('aria-expanded'),
        }))
      )
      .toEqual({ sheetOpen: true, scrimOpen: true, expanded: 'true' });

    await page.evaluate(() => document.getElementById('mobileTabPill')?.click());
    await expect
      .poll(() =>
        page.evaluate(() => ({
          sheetOpen: document.getElementById('mobileTabSheet')?.classList.contains('open'),
          scrimOpen: document.getElementById('mobileTabScrim')?.classList.contains('open'),
          expanded: document.getElementById('mobileTabPill')?.getAttribute('aria-expanded'),
        }))
      )
      .toEqual({ sheetOpen: false, scrimOpen: false, expanded: 'false' });
  });
});
