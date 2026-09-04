import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { WebServer } from '../../src/web/server.js';
import { getBrowser } from './helpers/browser.js';
import { PORTS } from './helpers/constants.js';
import { createTestServer, stopTestServer } from './helpers/server.js';

const PORT = PORTS.MOBILE_TAB_GROUPS;
const BASE_URL = `http://localhost:${PORT}`;

async function seedGroupedSheet(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = window.app as any;
    window.localStorage.removeItem('codeman:mobile-tab-groups-collapsed');
    window.localStorage.removeItem('codeman:mobile-focus-group-collapsed');
    for (const id of ['focus-a', 'alpha-1', 'alpha-2', 'beta-1', 'ungrouped-1']) {
      app.sessions.set(id, { id, name: id, status: 'idle', mode: 'claude', workingDir: '/tmp/Codeman' });
    }
    app.sessionOrder = ['alpha-1', 'alpha-2', 'beta-1', 'ungrouped-1', 'focus-a'];
    app.activeSessionId = 'alpha-1';
    app.tabAlerts.set('ungrouped-1', 'action');
    app.tabLayout = {
      version: 0,
      updatedAt: '2026-09-04T00:00:00.000Z',
      groups: [
        {
          id: 'g-alpha',
          name: 'Alpha',
          refs: [
            { kind: 'session', id: 'alpha-1' },
            { kind: 'session', id: 'alpha-2' },
          ],
        },
        { id: 'g-beta', name: 'Beta', refs: [{ kind: 'session', id: 'beta-1' }] },
      ],
      ungrouped: [
        { kind: 'session', id: 'focus-a', focus: true },
        { kind: 'session', id: 'ungrouped-1' },
      ],
    };
    window.MobileTabSheet._q = '';
    window.MobileTabSheet._filter = 'all';
    window.MobileTabSheet.render();
  });
}

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
    await page.waitForFunction(() => typeof window.MobileTabSheet?._mobileCollapsedGroupIds === 'function');

    const rows = await page.evaluate(() => {
      window.localStorage.removeItem('codeman:mobile-tab-groups-collapsed');
      window.localStorage.removeItem('codeman:mobile-focus-group-collapsed');
      const initial = {
        mobileCollapsed: window.MobileTabSheet._mobileCollapsedGroupIds(),
        focusCollapsed: window.MobileTabSheet._mobileFocusCollapsed(),
        desktopCollapsed: [...window.app.collapsedTabGroupIds],
      };
      window.localStorage.setItem('codeman:mobile-tab-groups-collapsed', JSON.stringify(['g1', 'g1', '', 42]));
      const seeded = {
        mobileCollapsed: window.MobileTabSheet._mobileCollapsedGroupIds(),
      };
      window.localStorage.setItem('codeman:mobile-focus-group-collapsed', 'true');
      const seededFocus = {
        focusCollapsed: window.MobileTabSheet._mobileFocusCollapsed(),
      };
      window.localStorage.setItem('codeman:mobile-tab-groups-collapsed', 'not-json');
      const corruptJson = {
        mobileCollapsed: window.MobileTabSheet._mobileCollapsedGroupIds(),
      };
      window.localStorage.setItem('codeman:mobile-tab-groups-collapsed', '{"x":1}');
      const corruptShape = {
        mobileCollapsed: window.MobileTabSheet._mobileCollapsedGroupIds(),
      };
      window.localStorage.setItem('codeman:mobile-focus-group-collapsed', 'maybe');
      const corruptFocus = {
        focusCollapsed: window.MobileTabSheet._mobileFocusCollapsed(),
      };
      return { initial, seeded, seededFocus, corruptJson, corruptShape, corruptFocus };
    });

    expect(rows.initial.mobileCollapsed).toEqual([]);
    expect(rows.initial.focusCollapsed).toBe(false);
    expect(rows.initial.desktopCollapsed).toEqual([]);
    expect(rows.seeded.mobileCollapsed).toEqual(['g1']);
    expect(rows.seededFocus.focusCollapsed).toBe(true);
    expect(rows.corruptJson.mobileCollapsed).toEqual([]);
    expect(rows.corruptShape.mobileCollapsed).toEqual([]);
    expect(rows.corruptFocus.focusCollapsed).toBe(false);
  });

  it('toggles mobile groups without changing desktop collapse state', async () => {
    const context = await browser.newContext({
      viewport: { width: 440, height: 900 },
      hasTouch: true,
    });
    contexts.push(context);
    const page = await context.newPage();

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.app && window.MobileTabSheet);
    await page.waitForFunction(() => typeof window.MobileTabSheet?.toggleMobileGroupCollapsed === 'function');

    const result = await page.evaluate(() => {
      window.localStorage.removeItem('codeman:mobile-tab-groups-collapsed');
      window.localStorage.removeItem('codeman:mobile-focus-group-collapsed');
      window.MobileTabSheet.toggleMobileGroupCollapsed('group-b');
      return {
        mobileCollapsed: window.MobileTabSheet._mobileCollapsedGroupIds(),
        desktopCollapsed: [...window.app.collapsedTabGroupIds],
      };
    });

    expect(result.mobileCollapsed).toEqual(['group-b']);
    expect(result.desktopCollapsed).toEqual([]);

    const focusOn = await page.evaluate(() => {
      window.MobileTabSheet.toggleMobileFocusCollapsed();
      return window.MobileTabSheet._mobileFocusCollapsed();
    });
    expect(focusOn).toBe(true);

    const focusOff = await page.evaluate(() => {
      window.MobileTabSheet.toggleMobileFocusCollapsed();
      return window.MobileTabSheet._mobileFocusCollapsed();
    });
    expect(focusOff).toBe(false);
  });

  it('uses exact sidebar group and member order without urgency sorting', async () => {
    const context = await browser.newContext({
      viewport: { width: 440, height: 900 },
      hasTouch: true,
    });
    contexts.push(context);
    const page = await context.newPage();

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.app && window.MobileTabSheet);
    await seedGroupedSheet(page);

    const order = await page.evaluate(() =>
      [...document.querySelectorAll('#mobileTabList .sheet-row')].map((row) => row.getAttribute('data-session-id'))
    );

    expect(order).toEqual(['focus-a', 'alpha-1', 'alpha-2', 'beta-1', 'ungrouped-1']);
  });

  it('renders Focus, named groups, and Ungrouped headers', async () => {
    const context = await browser.newContext({
      viewport: { width: 440, height: 900 },
      hasTouch: true,
    });
    contexts.push(context);
    const page = await context.newPage();

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.app && window.MobileTabSheet);
    await seedGroupedSheet(page);

    const headers = await page.evaluate(() =>
      [...document.querySelectorAll('#mobileTabList .sheet-group-name')].map((node) => node.textContent?.trim())
    );

    expect(headers).toEqual(['Focus', 'Alpha', 'Beta', 'Ungrouped']);
  });
});
