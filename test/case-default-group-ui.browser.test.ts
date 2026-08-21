/** @fileoverview Browser coverage for COD-343 Case Management default groups. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page, type Route } from 'playwright';

const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
const groups = [
  { id: 'group-nzbdav', name: 'nzbdav' },
  { id: 'group-tcc', name: 'tcc' },
];

describe('COD-343 Case Management default groups in Chromium', () => {
  let browser: Browser;
  let page: Page;
  let rejectLoad = false;
  let updateBodies: unknown[];

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
      if (rejectLoad) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Load rejected' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { groupId: 'group-tcc', groups } }),
      });
    });
  });

  beforeEach(async () => {
    rejectLoad = false;
    updateBodies = [];
    await page.setContent(`<!doctype html><html><head><base href="http://codeman.test/"></head><body>
      <div id="createCaseModal"><button class="set-rail-item"></button></div>
      <input id="dockerCaseName"><input id="dockerWorkspacePath"><input id="dockerHostId"><input id="dockerImage">
      <select id="dockerNetwork"><option value="bridge">bridge</option></select>
      <div id="caseEditDefaultGroupRow" class="hidden">
        <select id="caseEditDefaultGroup" disabled><option value="">Ungrouped</option></select>
      </div>
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

  it('loads the saved default into the Edit Case control and exposes its selected ID for the case update', async () => {
    await page.evaluate(() => (window as any).__app.loadCaseEditDefaultGroup('nzbdav'));

    await expect.poll(() => page.locator('#caseEditDefaultGroup').inputValue()).toBe('group-tcc');
    expect(
      await page.locator('#caseEditDefaultGroupRow').evaluate((element) => element.classList.contains('hidden'))
    ).toBe(false);
    expect(await page.locator('#caseEditDefaultGroup option').allTextContents()).toEqual([
      'Ungrouped',
      'nzbdav',
      'tcc',
    ]);

    await page.selectOption('#caseEditDefaultGroup', 'group-nzbdav');
    expect(await page.evaluate(() => (window as any).__app._caseEditDefaultGroupId())).toBe('group-nzbdav');
  });

  it('keeps the Edit Case control disabled when its authoritative value fails to load', async () => {
    rejectLoad = true;
    await page.evaluate(() => (window as any).__app.loadCaseEditDefaultGroup('nzbdav'));

    await expect.poll(() => page.locator('#caseEditDefaultGroup').isDisabled()).toBe(true);
    expect(await page.locator('#caseEditDefaultGroup option').allTextContents()).toEqual(['Ungrouped']);
    expect(await page.evaluate(() => (window as any).__app._caseEditDefaultGroupId())).toBeUndefined();
    expect(await page.evaluate(() => (window as any).__toasts)).toEqual([
      expect.objectContaining({ kind: 'error', message: expect.stringContaining('Load rejected') }),
    ]);
  });

  it('opens a Docker case on its Docker edit panel before loading the shared default group', async () => {
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

    await expect.poll(() => page.locator('#caseEditDefaultGroup').isEnabled()).toBe(true);
    expect(await page.evaluate(() => (window as any).__app.selectedCaseModalTab)).toBe('case-docker');
    expect(await page.locator('#dockerCaseName').inputValue()).toBe('sandbox');
    expect(await page.locator('#dockerWorkspacePath').isDisabled()).toBe(true);
  });

  it('saves the Edit Case selection with the normal case update request', async () => {
    await page.evaluate(() => {
      const app = (window as any).__app;
      app.caseEditOriginalName = 'sandbox';
      app.caseEditOriginalLocation = 'docker';
      (document.getElementById('dockerCaseName') as HTMLInputElement).value = 'sandbox';
      app.closeCreateCaseModal = () => {};
      app.loadQuickStartCases = async () => {};
      app.saveLastUsedCase = async () => {};
    });
    await page.evaluate(() => (window as any).__app.loadCaseEditDefaultGroup('sandbox'));
    await expect.poll(() => page.locator('#caseEditDefaultGroup').isEnabled()).toBe(true);
    await page.selectOption('#caseEditDefaultGroup', 'group-nzbdav');
    await page.evaluate(() => (window as any).__app.updateCase());

    await expect.poll(() => updateBodies).toEqual([{ name: 'sandbox', defaultGroupId: 'group-nzbdav' }]);
  });
});
