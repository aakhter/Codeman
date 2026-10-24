/**
 * @fileoverview Browser coverage for Add Case > Manage > Edit Case after COD-544.
 *
 * The per-case default session group has ONE writer: the Case settings popover
 * (`app.onCaseDefaultGroupChanged` -> `PUT /api/cases/:name/default-group`). Edit Case
 * (COD-343) used to carry a second control for the same stored value; it is gone, so
 * opening or saving Edit Case must neither read nor write the default group.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page, type Route } from 'playwright';

const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
const groups = [
  { id: 'group-nzbdav', name: 'nzbdav' },
  { id: 'group-tcc', name: 'tcc' },
];

describe('COD-544 Edit Case without a default-group control in Chromium', () => {
  let browser: Browser;
  let page: Page;
  let updateBodies: unknown[];
  let defaultGroupRequests: string[];

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.route('**/api/cases/sandbox', async (route: Route) => {
      updateBodies.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: {} }),
      });
    });
    await page.route('**/api/cases/*/default-group', async (route: Route) => {
      defaultGroupRequests.push(`${route.request().method()} ${route.request().url()}`);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { groupId: 'group-tcc', groups } }),
      });
    });
  });

  beforeEach(async () => {
    updateBodies = [];
    defaultGroupRequests = [];
    await page.setContent(`<!doctype html><html><head><base href="http://codeman.test/"></head><body>
      <div id="createCaseModal"><button class="set-rail-item"></button></div>
      <input id="dockerCaseName"><input id="dockerWorkspacePath"><input id="dockerHostId"><input id="dockerImage">
      <select id="dockerNetwork"><option value="bridge">bridge</option></select>
    </body></html>`);
    await page.addScriptTag({
      content: `class CodemanApp {}\n${sessionUi}\nwindow.__app = Object.create(CodemanApp.prototype);`,
    });
    await page.evaluate(() => {
      const app = (window as any).__app;
      app.caseEditOriginalName = 'nzbdav';
      app.resetCaseModalFields = () => {};
      app.switchCaseModalTab = (tab: string) => (app.selectedCaseModalTab = tab);
      (window as any).__toasts = [];
      app.showToast = (message: string, kind: string) => ((window as any).__toasts ??= []).push({ message, kind });
    });
  });

  afterAll(async () => {
    await page.close();
    await browser.close();
  });

  it('drops the Edit Case default-group loader and reader', async () => {
    expect(
      await page.evaluate(() => {
        const app = (window as any).__app;
        return [typeof app.loadCaseEditDefaultGroup, typeof app._caseEditDefaultGroupId];
      })
    ).toEqual(['undefined', 'undefined']);
  });

  it('opens a Docker case on its Docker edit panel without touching the default group', async () => {
    await page.evaluate(() => {
      const app = (window as any).__app;
      app.cases = [
        {
          name: 'sandbox',
          location: 'docker',
          docker: { path: '/srv/sandbox', hostId: 'local', image: 'codeman/agent:base', network: 'bridge' },
        },
      ];
      return app.editCase('sandbox');
    });

    expect(await page.evaluate(() => (window as any).__app.selectedCaseModalTab)).toBe('case-docker');
    expect(await page.locator('#dockerCaseName').inputValue()).toBe('sandbox');
    expect(await page.locator('#dockerWorkspacePath').isDisabled()).toBe(true);
    await page.waitForTimeout(100);
    expect(defaultGroupRequests).toEqual([]);
  });

  it('saves Edit Case without a defaultGroupId in the case update request', async () => {
    await page.evaluate(() => {
      const app = (window as any).__app;
      app.caseEditOriginalName = 'sandbox';
      app.caseEditOriginalLocation = 'docker';
      (document.getElementById('dockerCaseName') as HTMLInputElement).value = 'sandbox';
      app.closeCreateCaseModal = () => {};
      app.loadQuickStartCases = async () => {};
      app.saveLastUsedCase = async () => {};
    });
    await page.evaluate(() => (window as any).__app.updateCase());

    await expect.poll(() => updateBodies).toEqual([{ name: 'sandbox' }]);
    expect(defaultGroupRequests).toEqual([]);
  });

  it('reenables Docker configuration fields after closing an edited Docker case', async () => {
    await page.evaluate(() => {
      for (const id of ['dockerWorkspacePath', 'dockerHostId', 'dockerImage', 'dockerNetwork']) {
        (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).disabled = true;
      }
      (window as any).__app.resetCaseEditState();
    });

    for (const id of ['dockerWorkspacePath', 'dockerHostId', 'dockerImage', 'dockerNetwork']) {
      expect(await page.locator(`#${id}`).isEnabled()).toBe(true);
    }
  });
});
