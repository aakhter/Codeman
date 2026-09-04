import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext } from 'playwright';
import type { WebServer } from '../../src/web/server.js';
import { getBrowser } from './helpers/browser.js';
import { PORTS } from './helpers/constants.js';
import { createTestServer, stopTestServer } from './helpers/server.js';

const PORT = PORTS.MOBILE_TAB_GROUPS;
const BASE_URL = `http://localhost:${PORT}`;

describe('Mobile grouped session sheet collapse state', () => {
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

  it('starts with all mobile groups expanded and persists mobile-only collapse', async () => {
    const context = await browser.newContext({
      viewport: { width: 440, height: 900 },
      hasTouch: true,
    });
    contexts.push(context);
    const page = await context.newPage();

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.app && window.MobileTabSheet);

    const rows = await page.evaluate(() => {
      window.localStorage.removeItem('codeman:mobile-tab-groups-collapsed');
      window.localStorage.removeItem('codeman:mobile-focus-group-collapsed');
      window.MobileTabSheet.render();
      return {
        mobileCollapsed: window.MobileTabSheet._mobileCollapsedGroupIds(),
        desktopCollapsed: [...window.app.collapsedTabGroupIds],
      };
    });

    expect(rows.mobileCollapsed).toEqual([]);
    expect(rows.desktopCollapsed).toEqual([]);
  });
});
