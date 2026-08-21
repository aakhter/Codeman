/** @fileoverview Real-browser coverage for COD-343 Case Settings default groups. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page, type Route } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const sessionUi = readFileSync(resolve(publicDir, 'session-ui.js'), 'utf8');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const mobileStyles = readFileSync(resolve(publicDir, 'mobile.css'), 'utf8');

type GroupData = { groupId: string | null; groups: Array<{ id: string; name: string }> };

const groups = [
  { id: 'group-nzbdav', name: 'nzbdav' },
  { id: 'group-tcc', name: 'tcc' },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('COD-343 case default group controls in Chromium', () => {
  let browser: Browser;
  let page: Page;
  let getData: Map<string, GroupData>;
  let pendingGets: Map<string, ReturnType<typeof deferred<GroupData>>>;
  let pendingPut: ReturnType<typeof deferred<GroupData>> | null;
  let rejectPut: boolean;
  let rejectGets: Set<string>;
  let getPaths: string[];
  let putBodies: Array<{ pathname: string; body: unknown }>;

  async function expectControlsPresent() {
    expect(await page.locator('#caseDefaultGroup').count()).toBe(1);
    expect(await page.locator('#caseDefaultGroupMobile').count()).toBe(1);
  }

  async function handleDefaultGroup(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    const caseName = decodeURIComponent(url.pathname.split('/')[3] ?? '');
    if (request.method() === 'GET') {
      getPaths.push(url.pathname);
      if (rejectGets.has(caseName)) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'Load rejected' }),
        });
        return;
      }
      const response = pendingGets.get(caseName)
        ? await pendingGets.get(caseName)!.promise
        : (getData.get(caseName) ?? { groupId: null, groups });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: response }) });
      return;
    }

    const body = request.postDataJSON();
    putBodies.push({ pathname: url.pathname, body });
    if (rejectPut) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Save rejected' }),
      });
      return;
    }
    const response = pendingPut
      ? await pendingPut.promise
      : { groupId: body.groupId ?? null, groups: getData.get(caseName)?.groups ?? groups };
    getData.set(caseName, response);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: response }) });
  }

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.route('**/api/cases/*/default-group', handleDefaultGroup);
  });

  beforeEach(async () => {
    getData = new Map([
      ['nzbdav', { groupId: 'group-tcc', groups }],
      ['tcc', { groupId: null, groups }],
    ]);
    pendingGets = new Map();
    pendingPut = null;
    rejectPut = false;
    rejectGets = new Set();
    getPaths = [];
    putBodies = [];
    await page.setViewportSize({ width: 900, height: 700 });

    const caseSelect = html.match(/<select id="quickStartCase"[\s\S]*?<\/select>/)?.[0] ?? '';
    const desktop = html.match(/<div class="case-settings-popover hidden"[\s\S]*?<\/div>/)?.[0] ?? '';
    const mobile = html.match(/<div class="case-settings-popover-mobile hidden"[\s\S]*?<\/div>/)?.[0] ?? '';
    await page.setContent(
      `<!doctype html><html><head><base href="http://codeman.test/"></head><body>${caseSelect}${desktop}${mobile}</body></html>`,
      { waitUntil: 'domcontentloaded' }
    );
    await page.addScriptTag({
      content: `class CodemanApp {}\n${sessionUi}\nwindow.__cod343App = Object.create(CodemanApp.prototype);`,
    });
    await page.evaluate(() => {
      const app = (window as any).__cod343App;
      app.showToast = (message: string, kind: string) => ((window as any).__toasts ??= []).push({ message, kind });
      (window as any).__toasts = [];
      (window as any).app = app;
      (document.getElementById('quickStartCase') as HTMLSelectElement).innerHTML =
        '<option value="nzbdav">nzbdav</option><option value="tcc">tcc</option>';
    });
  });

  afterAll(async () => {
    await page.close();
    await browser.close();
  });

  it('loads server order/value from either popover and mirrors one owner-scoped save', async () => {
    await expectControlsPresent();
    await page.evaluate(() => (window as any).app.toggleCaseSettings());
    await expect.poll(() => page.locator('#caseDefaultGroup').inputValue()).toBe('group-tcc');

    for (const id of ['caseDefaultGroup', 'caseDefaultGroupMobile']) {
      expect(await page.locator(`#${id} option`).allTextContents()).toEqual(['Ungrouped', 'nzbdav', 'tcc']);
      expect(await page.locator(`#${id}`).isEnabled()).toBe(true);
    }

    await page.selectOption('#caseDefaultGroup', 'group-nzbdav');
    await expect.poll(() => putBodies.length).toBe(1);
    expect(putBodies).toEqual([{ pathname: '/api/cases/nzbdav/default-group', body: { groupId: 'group-nzbdav' } }]);
    expect(await page.locator('#caseDefaultGroupMobile').inputValue()).toBe('group-nzbdav');

    await page.evaluate(() => {
      document.getElementById('caseSettingsPopoverMobile')!.classList.add('hidden');
      (window as any).app.toggleCaseSettingsMobile();
    });
    await expect.poll(() => page.locator('#caseDefaultGroupMobile').inputValue()).toBe('group-nzbdav');
  });

  it('disables both controls during load and save', async () => {
    await expectControlsPresent();
    const waitingGet = deferred<GroupData>();
    pendingGets.set('nzbdav', waitingGet);
    await page.evaluate(() => {
      void (window as any).app.loadCaseDefaultGroup('nzbdav');
    });
    await expect.poll(() => page.locator('#caseDefaultGroup').isDisabled()).toBe(true);
    expect(await page.locator('#caseDefaultGroupMobile').isDisabled()).toBe(true);
    waitingGet.resolve({ groupId: 'group-tcc', groups });
    await expect.poll(() => page.locator('#caseDefaultGroup').isEnabled()).toBe(true);

    const waitingPut = deferred<GroupData>();
    pendingPut = waitingPut;
    await page.selectOption('#caseDefaultGroup', 'group-nzbdav');
    await expect.poll(() => page.locator('#caseDefaultGroup').isDisabled()).toBe(true);
    expect(await page.locator('#caseDefaultGroupMobile').isDisabled()).toBe(true);
    waitingPut.resolve({ groupId: 'group-nzbdav', groups });
    await expect.poll(() => page.locator('#caseDefaultGroupMobile').isEnabled()).toBe(true);
  });

  it('restores the last confirmed value and reports a rejected PUT', async () => {
    await expectControlsPresent();
    await page.evaluate(() => (window as any).app.loadCaseDefaultGroup('nzbdav'));
    await expect.poll(() => page.locator('#caseDefaultGroup').inputValue()).toBe('group-tcc');
    rejectPut = true;
    await page.selectOption('#caseDefaultGroupMobile', 'group-nzbdav');

    await expect.poll(() => page.locator('#caseDefaultGroup').inputValue()).toBe('group-tcc');
    expect(await page.locator('#caseDefaultGroupMobile').inputValue()).toBe('group-tcc');
    await expect
      .poll(() => page.evaluate(() => (window as any).__toasts))
      .toEqual([expect.objectContaining({ kind: 'error' })]);
  });

  it('uses stable IDs across rename and shows Ungrouped after server-side deletion clearing', async () => {
    await expectControlsPresent();
    await page.evaluate(() => (window as any).app.loadCaseDefaultGroup('nzbdav'));
    await expect.poll(() => page.locator('#caseDefaultGroup').inputValue()).toBe('group-tcc');

    getData.set('nzbdav', {
      groupId: 'group-tcc',
      groups: [groups[0], { id: 'group-tcc', name: 'thirdculturecoffee' }],
    });
    await page.evaluate(() => (window as any).app.loadCaseDefaultGroup('nzbdav'));
    expect(await page.locator('#caseDefaultGroup option:checked').textContent()).toBe('thirdculturecoffee');

    getData.set('nzbdav', { groupId: null, groups: [groups[0]] });
    await page.evaluate(() => (window as any).app.loadCaseDefaultGroup('nzbdav'));
    expect(await page.locator('#caseDefaultGroup').inputValue()).toBe('');
    expect(await page.locator('#caseDefaultGroupMobile option:checked').textContent()).toBe('Ungrouped');
  });

  it('ignores a stale response after switching cases', async () => {
    await expectControlsPresent();
    const stale = deferred<GroupData>();
    pendingGets.set('nzbdav', stale);
    await page.evaluate(() => {
      void (window as any).app.loadCaseDefaultGroup('nzbdav');
    });

    await page.selectOption('#quickStartCase', 'tcc');
    await page.evaluate(() => (window as any).app.loadCaseDefaultGroup('tcc'));
    await expect.poll(() => page.locator('#caseDefaultGroup').inputValue()).toBe('');
    stale.resolve({ groupId: 'group-nzbdav', groups });
    await page.waitForTimeout(20);

    expect(await page.locator('#caseDefaultGroup').inputValue()).toBe('');
    expect(await page.locator('#caseDefaultGroup option').allTextContents()).toEqual(['Ungrouped', 'nzbdav', 'tcc']);
    expect(await page.evaluate(() => (window as any).__toasts)).toEqual([]);
  });

  it('serializes a reopen load behind a pending save so old GET state cannot win', async () => {
    await page.evaluate(() => (window as any).app.loadCaseDefaultGroup('nzbdav'));
    await expect.poll(() => page.locator('#caseDefaultGroup').inputValue()).toBe('group-tcc');
    const initialGetCount = getPaths.length;

    const waitingPut = deferred<GroupData>();
    pendingPut = waitingPut;
    await page.selectOption('#caseDefaultGroup', 'group-nzbdav');
    await expect.poll(() => putBodies.length).toBe(1);
    await page.evaluate(() => {
      void (window as any).app.loadCaseDefaultGroup('nzbdav');
    });
    await page.waitForTimeout(30);
    const reloadStartedBeforeSaveSettled = getPaths.length > initialGetCount;

    waitingPut.resolve({ groupId: 'group-nzbdav', groups });
    await expect.poll(() => page.locator('#caseDefaultGroup').inputValue()).toBe('group-nzbdav');
    await expect.poll(() => getPaths.length).toBe(initialGetCount + 1);
    expect(reloadStartedBeforeSaveSettled).toBe(false);
    expect(await page.locator('#caseDefaultGroupMobile').inputValue()).toBe('group-nzbdav');
  });

  it('clears and locks stale controls when the newly selected case fails to load', async () => {
    await page.evaluate(() => (window as any).app.loadCaseDefaultGroup('nzbdav'));
    await expect.poll(() => page.locator('#caseDefaultGroup').inputValue()).toBe('group-tcc');

    rejectGets.add('tcc');
    await page.selectOption('#quickStartCase', 'tcc');
    await page.evaluate(() => (window as any).app.loadCaseDefaultGroup('tcc'));

    for (const id of ['caseDefaultGroup', 'caseDefaultGroupMobile']) {
      expect(await page.locator(`#${id}`).isDisabled()).toBe(true);
      expect(await page.locator(`#${id}`).inputValue()).toBe('');
      expect(await page.locator(`#${id} option`).allTextContents()).toEqual(['Ungrouped']);
      expect(await page.locator(`#${id}`).getAttribute('data-confirmed-value')).toBeNull();
    }
    expect(await page.evaluate(() => (window as any).__toasts)).toEqual([
      expect.objectContaining({ kind: 'error', message: expect.stringContaining('Load rejected') }),
    ]);

    rejectGets.delete('tcc');
    await page.evaluate(() => (window as any).app.loadCaseDefaultGroup('tcc'));
    expect(await page.locator('#caseDefaultGroup').isEnabled()).toBe(true);
    expect(await page.locator('#caseDefaultGroup option').allTextContents()).toEqual(['Ungrouped', 'nzbdav', 'tcc']);
  });

  it('never paints a completed save into a different active case', async () => {
    await page.evaluate(() => (window as any).app.loadCaseDefaultGroup('nzbdav'));
    await expect.poll(() => page.locator('#caseDefaultGroup').inputValue()).toBe('group-tcc');

    const waitingPut = deferred<GroupData>();
    pendingPut = waitingPut;
    await page.selectOption('#caseDefaultGroup', 'group-nzbdav');
    await expect.poll(() => putBodies.length).toBe(1);
    await page.selectOption('#quickStartCase', 'tcc');
    await page.evaluate(() => (window as any).app.loadCaseDefaultGroup('tcc'));
    expect(await page.locator('#caseDefaultGroup').inputValue()).toBe('');

    waitingPut.resolve({ groupId: 'group-nzbdav', groups });
    await expect.poll(() => page.evaluate(() => !(window as any).app._caseDefaultGroupPendingSave)).toBe(true);
    expect(await page.locator('#caseDefaultGroup').inputValue()).toBe('');
    expect(await page.locator('#caseDefaultGroupMobile').inputValue()).toBe('');
  });

  it('keeps the mobile selector visible and reachable in the actual mobile popover layout', async () => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.addStyleTag({ content: `${styles}\n${mobileStyles}` });
    await page.evaluate(() => (window as any).app.toggleCaseSettingsMobile());
    await expect.poll(() => page.locator('#caseDefaultGroupMobile').isVisible(), { timeout: 1000 }).toBe(true);
    const bounds = await page.locator('#caseDefaultGroupMobile').boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(8);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(382);
  });
});
