// Port 3208 - Header button visibility (real-browser E2E).
//
// Companion to the CI static guard (test/mobile-header-buttons-policy.test.ts).
// Renders the real app and asserts ACTUAL computed visibility, catching CSS/layout
// regressions the static parser can't see. Two behaviours are covered:
//   1. The minimal phone header hides the settings gear + lifecycle log.
//   2. The attachments button (COD-39) is OPT-IN — default-hidden everywhere, shown
//      only when App Settings → Display → "Attachments Button" is enabled. It first
//      shipped always-visible (mobile, then desktop), which is the regression here.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { WebServer } from '../../src/web/server.js';
import { createTestServer, stopTestServer } from './helpers/server.js';
import { createDevicePage, closeAllBrowsers } from './helpers/browser.js';
import { assertHidden, assertVisible } from './helpers/assertions.js';
import { REPRESENTATIVE_DEVICES } from './devices.js';
import { PORTS, WAIT } from './helpers/constants.js';

const PORT = PORTS.HEADER_BUTTONS;
const BASE_URL = `http://localhost:${PORT}`;

describe('Header button visibility (E2E)', () => {
  let server: WebServer;

  beforeAll(async () => {
    server = await createTestServer(PORT);
  });

  afterAll(async () => {
    await closeAllBrowsers();
    await stopTestServer(server);
  });

  it('hides the settings gear + lifecycle log on a standard phone (iPhone 14 Pro)', async () => {
    const { page } = await createDevicePage(REPRESENTATIVE_DEVICES['standard-phone'], BASE_URL);
    await page.waitForTimeout(WAIT.PAGE_SETTLE);
    await assertHidden(page, '.btn-icon-header.btn-settings');
    await assertHidden(page, '.btn-icon-header.btn-lifecycle-log');
  });

  it('collapses and expands header utilities on a 430px large phone', async () => {
    const { page } = await createDevicePage(REPRESENTATIVE_DEVICES['large-phone'], BASE_URL);
    await page.waitForTimeout(WAIT.PAGE_SETTLE);

    const toggle = page.locator('.mobile-header-utility-toggle');
    await assertVisible(page, '.mobile-header-utility-toggle');
    expect(await toggle.getAttribute('aria-controls')).toBe('headerRight');
    expect(await toggle.getAttribute('aria-expanded')).toBe('false');
    await assertHidden(page, '#headerRight');

    const collapsedPadding = await page
      .locator('.app')
      .evaluate((element) => parseFloat(getComputedStyle(element).paddingTop));

    await toggle.click();

    expect(await toggle.getAttribute('aria-expanded')).toBe('true');
    await assertVisible(page, '#headerRight');
    const expandedPadding = await page
      .locator('.app')
      .evaluate((element) => parseFloat(getComputedStyle(element).paddingTop));
    expect(expandedPadding).toBeGreaterThan(collapsedPadding);

    await toggle.click();

    expect(await toggle.getAttribute('aria-expanded')).toBe('false');
    await assertHidden(page, '#headerRight');
  });

  it('refits the active terminal after expanding header utilities on a 393px phone', async () => {
    const { page } = await createDevicePage(REPRESENTATIVE_DEVICES['standard-phone'], BASE_URL);
    let sessionId: string | undefined;

    try {
      sessionId = await page.evaluate(async () => {
        const createResponse = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workingDir: '/tmp' }),
        });
        const createData = await createResponse.json();
        if (!createData.success) throw new Error(`Failed to create shell session: ${createData.error}`);
        return createData.data.session.id;
      });

      await page.evaluate(async (id) => {
        const startResponse = await fetch(`/api/sessions/${id}/shell`, { method: 'POST' });
        const startData = await startResponse.json();
        if (!startData.success) throw new Error(`Failed to start shell session: ${startData.error}`);
      }, sessionId);

      const sessionTab = page.locator(`.session-tab[data-id="${sessionId}"]`);
      await sessionTab.waitFor({ state: 'visible' });
      await sessionTab.click();
      await page.waitForFunction(
        (id) => window.app?.activeSessionId === id && window.app?.fitAddon && window.app?.terminal,
        sessionId
      );

      const before = await page.evaluate(() => {
        const proposed = window.app.fitAddon.proposeDimensions();
        return {
          terminalRows: window.app.terminal.rows,
          proposedRows: proposed?.rows,
        };
      });
      expect(before.proposedRows).toBeDefined();
      expect(before.terminalRows).toBe(before.proposedRows);

      const toggleStartedAt = Date.now();
      await page.locator('.mobile-header-utility-toggle').click();
      expect(await page.locator('.mobile-header-utility-toggle').getAttribute('aria-expanded')).toBe('true');
      const after = (await page
        .waitForFunction(
          ({ beforeRows, toggleStartedAt }) => {
            const proposed = window.app?.fitAddon?.proposeDimensions();
            const terminalRows = window.app?.terminal?.rows;
            if (
              Date.now() - toggleStartedAt < 350 ||
              proposed === undefined ||
              terminalRows !== proposed.rows ||
              proposed.rows >= beforeRows
            ) {
              return null;
            }
            return { terminalRows, proposedRows: proposed.rows };
          },
          { beforeRows: before.terminalRows, toggleStartedAt },
          { timeout: 2000 }
        )
        .then((result) => result.jsonValue())) as { terminalRows: number; proposedRows: number };

      expect(after.proposedRows).toBeDefined();
      expect(after.terminalRows).toBe(after.proposedRows);
      expect(after.terminalRows).toBeLessThan(before.terminalRows);
    } finally {
      if (sessionId) {
        const deleteData = await page.evaluate(async (id) => {
          const response = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
          return response.json();
        }, sessionId);
        expect(deleteData.success).toBe(true);
      }
    }
  }, 30000);

  it('keeps desktop header utilities visible without a collapse toggle', async () => {
    const { page } = await createDevicePage(REPRESENTATIVE_DEVICES['large-tablet'], BASE_URL);
    await page.waitForTimeout(WAIT.PAGE_SETTLE);
    await assertHidden(page, '.mobile-header-utility-toggle');
    await assertVisible(page, '#headerRight');
  });

  it('keeps the opt-in attachments button HIDDEN by default on a desktop-class viewport', async () => {
    const { page } = await createDevicePage(REPRESENTATIVE_DEVICES['large-tablet'], BASE_URL);
    await page.waitForTimeout(WAIT.PAGE_SETTLE);
    await assertHidden(page, '#attachmentsHistoryBtn');
  });

  it('shows the attachments button once the setting is enabled', async () => {
    const { page } = await createDevicePage(REPRESENTATIVE_DEVICES['large-tablet'], BASE_URL);
    // Desktop-class devices use the non-mobile settings blob.
    await page.evaluate(() => {
      const cur = JSON.parse(localStorage.getItem('codeman-app-settings') || '{}');
      cur.showAttachmentsButton = true;
      localStorage.setItem('codeman-app-settings', JSON.stringify(cur));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(WAIT.PAGE_SETTLE);
    await assertVisible(page, '#attachmentsHistoryBtn');
  });
});
