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
    // Reset filter + collapse state so tests are isolated: collapse toggles
    // from other tests persist in localStorage, and _q/_filter leak in memory.
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

  it('filters within groups while preserving order and revealing matches', async () => {
    const context = await browser.newContext({
      viewport: { width: 440, height: 900 },
      hasTouch: true,
    });
    contexts.push(context);
    const page = await context.newPage();

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.app && window.MobileTabSheet);
    await seedGroupedSheet(page);

    await page.evaluate(() => {
      window.MobileTabSheet.toggleMobileGroupCollapsed('g-beta', true);
      window.MobileTabSheet._q = 'beta';
      window.MobileTabSheet._filter = 'all';
      window.MobileTabSheet.render();
    });

    const headers = await page.evaluate(() =>
      [...document.querySelectorAll('#mobileTabList .sheet-group-name')].map((node) => node.textContent?.trim())
    );
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('#mobileTabList .sheet-row')].map((row) => row.getAttribute('data-session-id'))
    );

    expect(headers).toEqual(['Beta']);
    expect(rows).toEqual(['beta-1']);

    await page.evaluate(() => {
      window.MobileTabSheet._q = '';
      window.MobileTabSheet._filter = 'all';
      window.MobileTabSheet.render();
    });
  });

  it('counts only rendered live sessions when sessionOrder contains stale IDs', async () => {
    const context = await browser.newContext({
      viewport: { width: 440, height: 900 },
      hasTouch: true,
    });
    contexts.push(context);
    const page = await context.newPage();

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.app && window.MobileTabSheet);
    await seedGroupedSheet(page);

    const counts = await page.evaluate(() => {
      window.app.sessionOrder = [...window.app.sessionOrder, 'missing-session'];
      window.MobileTabSheet.updatePill();
      window.MobileTabSheet.render();
      return {
        header: document.querySelector('#mobileTabSheet .sheet-count')?.textContent,
        footer: document.querySelector('#mobileTabSheet .sheet-footer-count')?.textContent,
        pill: document.querySelector('#mobileTabPill .pill-count')?.textContent,
      };
    });

    expect(counts).toEqual({ header: '5 / 5', footer: '5 tabs', pill: '5' });
  });

  it('activates and closes sessions from grouped rows', async () => {
    const context = await browser.newContext({
      viewport: { width: 440, height: 900 },
      hasTouch: true,
    });
    contexts.push(context);
    const page = await context.newPage();

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.app && window.MobileTabSheet);
    await seedGroupedSheet(page);

    // Stub closeSession so closeTab() actually removes the session from app state
    // without firing DELETE requests or tmux kills. selectSession is real: the
    // seeded sessions exist in app.sessions, so activation asserts a real change.
    await page.evaluate(() => {
      const app = window.app as any;
      app.closeSession = async (sessionId: string) => {
        app.sessions.delete(sessionId);
        app.sessionOrder = app.sessionOrder.filter((id: string) => id !== sessionId);
        if (app.activeSessionId === sessionId) {
          app.activeSessionId = app.sessionOrder[0] ?? null;
        }
        window.MobileTabSheet.render();
      };
    });

    await page.evaluate(() => window.MobileTabSheet.activate('beta-1'));
    await expect.poll(() => page.evaluate(() => window.app.activeSessionId), { timeout: 15000 }).toBe('beta-1');

    // Seeded sessions carry no pid, so selectSession's re-attach fetch 404s in
    // the test server — keep activation's real activeSessionId assertion, then
    // return to a pre-close live session before closing so no network can
    // interfere with the close path.
    await page.evaluate(() => window.MobileTabSheet.activate('alpha-1'));
    await expect.poll(() => page.evaluate(() => window.app.activeSessionId), { timeout: 15000 }).toBe('alpha-1');

    await page.evaluate(() => {
      window.MobileTabSheet.toggleMobileGroupCollapsed('g-alpha', true);
      window.MobileTabSheet.toggle(true);
      window.MobileTabSheet.closeTab('beta-1');
    });
    await expect
      .poll(() => page.evaluate(() => document.querySelector('#mobileTabList [data-session-id="beta-1"]') === null), {
        timeout: 5000,
      })
      .toBe(true);
    const collapsed = await page.evaluate(() => window.MobileTabSheet._mobileCollapsedGroupIds());
    expect(collapsed).toEqual(['g-alpha']);
  });

  it('falls back to one Ungrouped section when tab layout is unavailable', async () => {
    const context = await browser.newContext({
      viewport: { width: 440, height: 900 },
      hasTouch: true,
    });
    contexts.push(context);
    const page = await context.newPage();

    // Fresh page load (no seedGroupedSheet dependency): the fallback derives
    // rows from sessionOrder alone, so seed minimal session state directly.
    // Isolates this test from sessions removed by earlier tests in this file.
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.app && window.MobileTabSheet);

    const saved = await page.evaluate(() => {
      const app = window.app as any;
      window.localStorage.removeItem('codeman:mobile-tab-groups-collapsed');
      window.localStorage.removeItem('codeman:mobile-focus-group-collapsed');
      for (const id of ['focus-a', 'alpha-1', 'alpha-2', 'beta-1', 'ungrouped-1']) {
        app.sessions.set(id, { id, name: id, status: 'idle', mode: 'claude', workingDir: '/tmp/Codeman' });
      }
      app.sessionOrder = ['alpha-1', 'alpha-2', 'beta-1', 'ungrouped-1', 'focus-a'];
      app.activeSessionId = 'alpha-1';
      window.MobileTabSheet._q = '';
      window.MobileTabSheet._filter = 'all';
      const savedLayout = (window as any).CodemanTabLayout;
      (window.app as any).tabLayout = null;
      (window as any).CodemanTabLayout = undefined;
      window.MobileTabSheet._q = '';
      window.MobileTabSheet._filter = 'all';
      window.MobileTabSheet.render();
      return {
        saved: typeof savedLayout?.project === 'function',
        headers: [...document.querySelectorAll('#mobileTabList .sheet-group-name')].map((node) =>
          node.textContent?.trim()
        ),
        rows: [...document.querySelectorAll('#mobileTabList .sheet-row')].map((row) =>
          row.getAttribute('data-session-id')
        ),
      };
    });

    // Restore the layout helper for any later tests in this file.
    await page.evaluate(() => {
      window.location.reload();
    });
    await page.waitForFunction(() => window.app && window.MobileTabSheet);

    expect(saved.saved).toBe(true);
    expect(saved.headers).toEqual(['Ungrouped']);
    // Fallback derives row order from sessionOrder (session state), not from
    // the layout: the fixture puts focus-a last in sessionOrder, while the
    // projection renders the Focus shortcut section first.
    expect(saved.rows).toEqual(['alpha-1', 'alpha-2', 'beta-1', 'ungrouped-1', 'focus-a']);
    expect(saved.rows).toEqual(['alpha-1', 'alpha-2', 'beta-1', 'ungrouped-1', 'focus-a']);
  });
});
