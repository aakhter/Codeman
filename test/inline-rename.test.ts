/**
 * Inline rename input tests.
 *
 * Covers the three fixes shipped after the audit of #81:
 *   1. CJK composition guard — Enter/Escape during IME composition belong to
 *      the IME and must not commit/cancel the rename.
 *   2. Ghost tab cleanup — when a session is deleted while its tab is being
 *      renamed, _cleanupSessionData() must cancel the rename so the inline
 *      <input> doesn't ghost on screen.
 *   3. Settle-once — cancel()/blur convergence is idempotent and reliably
 *      clears _activeRename, even on repeated invocation.
 *
 * Strategy: stub a synthetic .tab-name node and a fake session entry, then
 * drive the rename function directly via page.evaluate(). No real PTY/tmux.
 *
 * Port: 3164 (per MEMORY.md, ports 3150+ for tests)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3164;
const BASE_URL = `http://localhost:${PORT}`;

describe('Inline rename input', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = new WebServer(PORT, false, true); // testMode = true
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    // Wait for app.js to expose window.app and finish constructor init.
    await page.waitForFunction(
      () =>
        typeof (window as { app?: unknown }).app !== 'undefined' &&
        !!(window as { app?: { sessions?: Map<string, unknown> } }).app?.sessions
    );
  }, 60000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  }, 60000);

  // Reset state between tests so each starts from a clean slate.
  async function resetState(): Promise<void> {
    await page.evaluate(() => {
      const app = (
        window as unknown as { app: { _activeRename: { cancel: () => void } | null; sessions: Map<string, unknown> } }
      ).app;
      if (app._activeRename) app._activeRename.cancel();
      app.sessions.clear();
      document.querySelectorAll('[data-test-tab]').forEach((n) => n.remove());
    });
    // Allow any cancel-triggered renderSessionTabs to settle.
    await page.waitForTimeout(20);
  }

  // Helper: stub a session + tab-name DOM node, then start rename.
  // Returns whether the rename input was successfully created.
  async function startRename(sessionId: string, name: string): Promise<boolean> {
    return page.evaluate(
      ({ id, name }) => {
        const app = (
          window as unknown as {
            app: {
              sessions: Map<string, { id: string; name: string }>;
              startInlineRename: (id: string) => void;
            };
          }
        ).app;
        app.sessions.set(id, { id, name });
        const wrap = document.createElement('div');
        wrap.setAttribute('data-test-tab', '1');
        const tabName = document.createElement('span');
        tabName.className = 'tab-name';
        tabName.setAttribute('data-session-id', id);
        tabName.textContent = name;
        wrap.appendChild(tabName);
        document.body.appendChild(wrap);
        app.startInlineRename(id);
        return !!tabName.querySelector('input.tab-rename-input');
      },
      { id: sessionId, name }
    );
  }

  it('CJK guard: Enter with isComposing=true does not commit', async () => {
    await resetState();
    expect(await startRename('cjk-isc', 'OldName')).toBe(true);

    const result = await page.evaluate(() => {
      const app = (window as unknown as { app: { _activeRename: unknown } }).app;
      const input = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      input.value = 'partial-pinyin';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
      return {
        inputStillInDom: document.body.contains(input),
        renameStillActive: !!app._activeRename,
      };
    });

    expect(result.inputStillInDom).toBe(true);
    expect(result.renameStillActive).toBe(true);
  });

  it('CJK guard: Enter with legacy keyCode 229 does not commit', async () => {
    await resetState();
    expect(await startRename('cjk-229', 'OldName')).toBe(true);

    const renameStillActive = await page.evaluate(() => {
      const app = (window as unknown as { app: { _activeRename: unknown } }).app;
      const input = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      // Some Safari/Edge versions report keyCode 229 with isComposing=false on the
      // Enter that triggers compositionend — the legacy guard catches that case.
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }));
      return !!app._activeRename;
    });

    expect(renameStillActive).toBe(true);
  });

  it('CJK guard: regular Enter (no IME) DOES commit', async () => {
    await resetState();
    expect(await startRename('regular-enter', 'OldName')).toBe(true);

    // Stub fetch so the commit doesn't hit the real API.
    const result = await page.evaluate(async () => {
      const app = (window as unknown as { app: { _activeRename: unknown } }).app;
      let fetchUrl: string | null = null;
      const origFetch = window.fetch;
      window.fetch = (async (input: RequestInfo | URL) => {
        fetchUrl = String(input);
        return new Response('{"success":true}', { status: 200 });
      }) as typeof window.fetch;

      const inputEl = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      inputEl.value = 'NewName';
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      // Enter calls input.blur() which fires the async finishRename. Wait for it.
      await new Promise((r) => setTimeout(r, 30));

      window.fetch = origFetch;
      return { fetchUrl, renameActive: !!app._activeRename };
    });

    expect(result.fetchUrl).toContain('/api/sessions/regular-enter/name');
    expect(result.renameActive).toBe(false);
  });

  it('Ghost tab: _cleanupSessionData cancels rename for the deleted session', async () => {
    await resetState();
    expect(await startRename('ghost-id', 'OldName')).toBe(true);

    const result = await page.evaluate(async () => {
      const app = (
        window as unknown as {
          app: {
            _activeRename: { sessionId: string } | null;
            sessions: Map<string, unknown>;
            _cleanupSessionData: (id: string) => void;
          };
        }
      ).app;

      let fetchFired = false;
      const origFetch = window.fetch;
      window.fetch = (async (input: RequestInfo | URL) => {
        if (String(input).includes('/api/sessions/ghost-id/name')) fetchFired = true;
        return new Response('{}', { status: 200 });
      }) as typeof window.fetch;

      const matchedBefore = app._activeRename?.sessionId === 'ghost-id';
      app._cleanupSessionData('ghost-id');
      // Cancel triggers async renderSessionTabs; allow it to settle.
      await new Promise((r) => setTimeout(r, 50));

      window.fetch = origFetch;
      return {
        matchedBefore,
        renameActiveAfter: !!app._activeRename,
        sessionGone: !app.sessions.has('ghost-id'),
        fetchFired,
      };
    });

    expect(result.matchedBefore).toBe(true);
    expect(result.renameActiveAfter).toBe(false);
    expect(result.sessionGone).toBe(true);
    // Cancel path skips the API call — deleting a session shouldn't trigger a stale rename PUT.
    expect(result.fetchFired).toBe(false);
  });

  it('Ghost tab: _cleanupSessionData for a DIFFERENT session does NOT cancel rename', async () => {
    await resetState();
    expect(await startRename('keep-rename', 'OldName')).toBe(true);

    const result = await page.evaluate(() => {
      const app = (
        window as unknown as {
          app: {
            _activeRename: unknown;
            sessions: Map<string, { id: string; name: string }>;
            _cleanupSessionData: (id: string) => void;
          };
        }
      ).app;
      // Add an unrelated session and delete it — the rename for keep-rename must survive.
      app.sessions.set('unrelated', { id: 'unrelated', name: 'X' });
      app._cleanupSessionData('unrelated');
      return { renameStillActive: !!app._activeRename };
    });

    expect(result.renameStillActive).toBe(true);
  });

  it('Settle-once: cancel() is idempotent and clears _activeRename', async () => {
    await resetState();
    expect(await startRename('idempotent-id', 'OldName')).toBe(true);

    const result = await page.evaluate(async () => {
      const app = (window as unknown as { app: { _activeRename: { cancel: () => void } | null } }).app;
      const cancelFn = app._activeRename!.cancel;
      cancelFn();
      const afterFirst = app._activeRename;
      let threw = false;
      try {
        cancelFn();
      } catch {
        threw = true;
      }
      // Allow any async re-renders to settle.
      await new Promise((r) => setTimeout(r, 30));
      const afterSecond = app._activeRename;
      return { afterFirstNull: afterFirst === null, afterSecondNull: afterSecond === null, threw };
    });

    expect(result.afterFirstNull).toBe(true);
    expect(result.afterSecondNull).toBe(true);
    expect(result.threw).toBe(false);
  });

  it('Re-entry: starting rename while one is active aborts the previous one', async () => {
    await resetState();
    expect(await startRename('first-id', 'First')).toBe(true);

    const result = await page.evaluate(() => {
      const app = (
        window as unknown as {
          app: {
            _activeRename: { sessionId: string } | null;
            sessions: Map<string, { id: string; name: string }>;
            startInlineRename: (id: string) => void;
          };
        }
      ).app;
      const firstActive = app._activeRename?.sessionId;
      // Start a second rename without cancelling — startInlineRename should
      // pre-emptively cancel the previous one so state never gets stuck on the dead session.
      app.sessions.set('second-id', { id: 'second-id', name: 'Second' });
      const wrap = document.createElement('div');
      wrap.setAttribute('data-test-tab', '1');
      const tabName = document.createElement('span');
      tabName.className = 'tab-name';
      tabName.setAttribute('data-session-id', 'second-id');
      tabName.textContent = 'Second';
      wrap.appendChild(tabName);
      document.body.appendChild(wrap);
      app.startInlineRename('second-id');
      return { firstActive, secondActive: app._activeRename?.sessionId };
    });

    expect(result.firstActive).toBe('first-id');
    expect(result.secondActive).toBe('second-id');
  });
});
