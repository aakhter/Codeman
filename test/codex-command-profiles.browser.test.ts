/** @fileoverview Browser coverage for COD-351 remote Codex command profiles. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page, type Route } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const ui = readFileSync(resolve(publicDir, 'session-ui.js'), 'utf8');
const css = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
let profiles: Array<{ id: string; name: string; command: string; usage: Array<{ name: string }> }>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function remoteMarkup() {
  return (
    html.match(/<div class="set-section hidden" id="case-remote">([\s\S]*?)<\/div>\s*<!-- Docker Tab -->/)?.[0] ?? ''
  );
}
function managerMarkup() {
  return html.match(/<div class="modal" id="codexCommandProfileManager">([\s\S]*?)<\/div>\s*<!--/)?.[0] ?? '';
}

describe('COD-351 Codex command profiles in Chromium', () => {
  let browser: Browser;
  let page: Page;
  let bodies: unknown[];
  let failList = false;
  let pendingProfileGet: ReturnType<typeof deferred<void>> | null;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  });
  afterAll(async () => {
    await browser.close();
  });
  beforeEach(async () => {
    bodies = [];
    failList = false;
    pendingProfileGet = null;
    profiles = [
      { id: 'p-work', name: 'Work', command: 'codex --profile work', usage: [{ name: 'remote-a' }] },
      { id: 'p-unused', name: 'Unused', command: 'codex --profile unused', usage: [] },
    ];
    await page.route('**/api/codex-command-profiles**', async (route: Route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        if (pendingProfileGet) await pendingProfileGet.promise;
        return route.fulfill({
          status: failList ? 500 : 200,
          contentType: 'application/json',
          body: JSON.stringify(failList ? { success: false, error: 'offline' } : { success: true, data: { profiles } }),
        });
      }
      const body = request.postDataJSON();
      bodies.push(body);
      if (request.method() === 'PUT' && !body.confirmReferencedUpdate) {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, requiresConfirmation: true, usage: [{ name: 'remote-a' }] }),
        });
      }
      if (request.method() === 'DELETE' && request.url().endsWith('/p-work')) {
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            error: 'Profile is still used by remote cases',
            usage: [{ name: 'remote-a' }],
          }),
        });
      }
      if (request.method() === 'DELETE')
        profiles = profiles.filter((profile) => !request.url().endsWith(`/${profile.id}`));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { id: 'p-new', name: 'New', command: 'codex new' } }),
      });
    });
    await page.setContent(
      `<!doctype html><head><base href="http://codeman.test/"><style>${css}</style></head><body>${remoteMarkup()}${managerMarkup()}</body>`
    );
    await page.addScriptTag({
      content: `class CodemanApp {}\n${ui}\nwindow.app = Object.create(CodemanApp.prototype);`,
    });
    await page.evaluate(() => {
      (window as any).app.showToast = () => {};
      for (const id of ['newCaseName', 'newCaseDescription', 'linkCaseName', 'linkCasePath', 'remoteHostId']) {
        const input = document.createElement('input');
        input.id = id;
        document.body.append(input);
      }
    });
  });
  it('loads Default, alphabetic profiles and Custom, then emits one selection payload', async () => {
    await page.evaluate(() => (window as any).app.loadCodexCommandProfiles());
    expect(await page.locator('#remoteCaseCodexProfile option').allTextContents()).toEqual([
      'Default',
      'Unused',
      'Work',
      'Custom',
    ]);
    await page.selectOption('#remoteCaseCodexProfile', 'profile:p-work');
    expect(await page.locator('#remoteCaseCodexProfilePreview').inputValue()).toBe('codex --profile work');
    expect(await page.evaluate(() => (window as any).app._readRemoteCaseCommandsFromForm())).toEqual({
      codexCommandSelection: { kind: 'profile', profileId: 'p-work' },
    });
  });
  it('confirms referenced updates, surfaces usage/delete conflicts, and deletes unused profiles', async () => {
    await page.evaluate(() => (window as any).app.openCodexCommandProfileManager());
    await expect.poll(() => page.locator('#codexCommandProfileManager').getAttribute('class')).toContain('active');
    expect(await page.locator('#codexCommandProfileManager').textContent()).toContain('remote-a');
    await page.getByText('Work — used by remote-a').click();
    await page.locator('#codexCommandProfileCommand').fill('codex --profile revised');
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#codexCommandProfileSave').click();
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies).toContainEqual({ name: 'Work', command: 'codex --profile revised' });
    expect(bodies).toContainEqual({ name: 'Work', command: 'codex --profile revised', confirmReferencedUpdate: true });
    await page.getByText('Work — used by remote-a').click();
    await page.locator('#codexCommandProfileDelete').click();
    expect(await page.locator('#codexCommandProfileManager').textContent()).toContain('remote-a');
    await page.getByRole('button', { name: 'Unused', exact: true }).click();
    await page.locator('#codexCommandProfileDelete').click();
    expect(bodies).toEqual(
      expect.arrayContaining([expect.anything(), expect.anything(), expect.anything(), expect.anything()])
    );
    await expect.poll(() => page.locator('#codexCommandProfileList').textContent()).not.toContain('Unused');
  });
  it('restores the confirmed selection while safely disabling controls when loading fails', async () => {
    await page.evaluate(() => (window as any).app.loadCodexCommandProfiles());
    await page.selectOption('#remoteCaseCodexProfile', 'profile:p-work');
    failList = true;
    await page.evaluate(() => (window as any).app.loadCodexCommandProfiles());
    expect(await page.locator('#remoteCaseCodexProfile').isDisabled()).toBe(true);
    expect(await page.locator('#remoteCaseCodexProfile').inputValue()).toBe('profile:p-work');
    expect(await page.locator('#remoteCaseCodexProfile option:checked').textContent()).toBe('Work');
  });
  it('resets a new remote case to Default instead of carrying a prior profile selection', async () => {
    await page.evaluate(() => (window as any).app.loadCodexCommandProfiles());
    await page.selectOption('#remoteCaseCodexProfile', 'profile:p-work');
    await page.evaluate(() => {
      const app = (window as any).app;
      app.isCliAvailable = () => true;
      app.resetCaseModalFields();
    });
    expect(await page.locator('#remoteCaseCodexProfile').inputValue()).toBe('default');
    expect(await page.evaluate(() => (window as any).app._readRemoteCaseCommandsFromForm())).toEqual({
      codexCommandSelection: { kind: 'default' },
    });
  });
  it('focuses, traps, escapes, and returns focus for the profile manager dialog', async () => {
    await page.locator('#manageCodexCommandProfiles').focus();
    await page.evaluate(() => (window as any).app.openCodexCommandProfileManager());
    expect(
      await page.locator('#codexCommandProfileNew').evaluate((element) => document.activeElement === element)
    ).toBe(true);
    await page.keyboard.press('Tab');
    expect(
      await page
        .locator('#codexCommandProfileManager .modal-close')
        .evaluate((element) => document.activeElement === element)
    ).toBe(true);
    await page.keyboard.press('Escape');
    expect(await page.locator('#codexCommandProfileManager').getAttribute('class')).not.toContain('active');
    expect(
      await page.locator('#manageCodexCommandProfiles').evaluate((element) => document.activeElement === element)
    ).toBe(true);
  });
  it('keeps the manager keyboard lifecycle active while profiles are still loading', async () => {
    pendingProfileGet = deferred<void>();
    await page.locator('#manageCodexCommandProfiles').focus();
    await page.evaluate(() => {
      void (window as any).app.openCodexCommandProfileManager();
    });
    expect(
      await page.locator('#codexCommandProfileNew').evaluate((element) => document.activeElement === element)
    ).toBe(true);
    await page.keyboard.press('Tab');
    expect(
      await page
        .locator('#codexCommandProfileManager .modal-close')
        .evaluate((element) => document.activeElement === element)
    ).toBe(true);
    await page.keyboard.press('Escape');
    expect(
      await page.locator('#manageCodexCommandProfiles').evaluate((element) => document.activeElement === element)
    ).toBe(true);
    pendingProfileGet.resolve();
    await page.waitForTimeout(20);
    expect(
      await page.locator('#manageCodexCommandProfiles').evaluate((element) => document.activeElement === element)
    ).toBe(true);
  });
  it('updates the custom preview and keeps visible remote controls within a 390px viewport', async () => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.locator('#case-remote').evaluate((element) => element.classList.remove('hidden'));
    await page.evaluate(() => (window as any).app.loadCodexCommandProfiles());
    await page.selectOption('#remoteCaseCodexProfile', 'custom');
    await page.locator('#remoteCaseCodexCommandCustomInput').fill('codex custom');
    expect(await page.locator('#remoteCaseCodexProfilePreview').inputValue()).toBe('codex custom');
    const geometry = await page.locator('.remote-codex-profile-row').evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      visible: element.getBoundingClientRect().height > 0,
    }));
    expect(geometry.visible).toBe(true);
    expect(geometry.width).toBeGreaterThan(0);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  });
});
