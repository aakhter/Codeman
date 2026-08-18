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

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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

  // Reset state between tests so each starts from a clean slate, including when
  // an assertion aborts a test before it can restore its own vertical-rail DOM.
  async function resetState(): Promise<void> {
    await page.evaluate(() => {
      const app = (
        window as unknown as {
          app: {
            _activeRename: { cancel: () => void } | null;
            _debounceTimers: Record<string, ReturnType<typeof setTimeout> | null | undefined>;
            sessions: Map<string, unknown>;
            sessionOrder: string[];
          };
        }
      ).app;
      if (app._activeRename) app._activeRename.cancel();
      clearTimeout(app._debounceTimers.sessionTabs);
      app._debounceTimers.sessionTabs = null;
      app.sessions.clear();
      app.sessionOrder = [];
      document.querySelectorAll('[data-test-tab]').forEach((n) => n.remove());
      const container = document.getElementById('sessionTabs') as HTMLElement;
      const host = document.getElementById('sessionTabsHost') as HTMLElement;
      host.appendChild(container);
      document.documentElement.dataset.tabOrientation = 'horizontal';
      document.documentElement.dataset.sessionList = 'header';
      document.documentElement.classList.remove('tab-rail-compact');
      const rail = document.getElementById('tabRail') as HTMLElement;
      rail.style.removeProperty('--tab-rail-width');
      container.setAttribute('role', 'tablist');
      container.setAttribute('aria-label', 'Session tabs');
      container.setAttribute('aria-orientation', 'horizontal');
    });
  }

  afterEach(async () => resetState());

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

  async function startCanonicalPrefixedRename(sessionId: string, name: string): Promise<boolean> {
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
        const separator = name.indexOf(': ');
        const prefix = name.slice(0, separator + 2);
        const suffix = name.slice(separator + 2);
        app.sessions.set(id, { id, name });
        const wrap = document.createElement('div');
        wrap.setAttribute('data-test-tab', '1');
        const tabName = document.createElement('span');
        tabName.className = 'tab-name';
        tabName.dataset.sessionId = id;
        tabName.dataset.fullName = name;
        const prefixLabel = document.createElement('span');
        prefixLabel.className = 'tab-name-prefix';
        prefixLabel.textContent = prefix;
        tabName.append(prefixLabel, document.createTextNode(suffix));
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

  it('Settle-once: a saved cancel callback is inert after a successful PUT', async () => {
    await resetState();
    expect(await startRename('late-cancel', 'OldName')).toBe(true);

    const result = await page.evaluate(async () => {
      const app = (
        window as unknown as {
          app: {
            _activeRename: { cancel: () => void } | null;
            sessions: Map<string, { id: string; name: string }>;
          };
        }
      ).app;
      const origFetch = window.fetch;
      window.fetch = (async () =>
        new Response('{"success":true,"data":{"name":"NewName"}}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof window.fetch;
      const cancel = app._activeRename!.cancel;
      const input = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      input.value = 'NewName';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      cancel();
      window.fetch = origFetch;
      const label = document.querySelector('.tab-name[data-session-id="late-cancel"]') as HTMLElement;
      return {
        label: label.textContent,
        mapName: app.sessions.get('late-cancel')?.name ?? null,
        renameActive: !!app._activeRename,
      };
    });

    expect(result).toEqual({ label: 'NewName', mapName: 'NewName', renameActive: false });
  });

  it('Render guard: _renderSessionTabsImmediate() does not destroy an open rename input', async () => {
    await resetState();

    // The debounced tab render is scheduled by renderSessionTabs() but EXECUTED by
    // _renderSessionTabsImmediate(). A render queued just before the rename opened
    // still fires ~100ms later and lands in the executor directly, so the guard has
    // to live there too, otherwise the incremental branch rewrites .tab-name's
    // innerHTML and the user's half-typed description is lost.
    //
    // The tab MUST live inside the real #sessionTabs container and be the only
    // session in app.sessions: the renderer walks that container, so a synthetic
    // node parked on <body> would make this test pass with the guard removed.
    const result = await page.evaluate(() => {
      const app = (
        window as unknown as {
          app: {
            sessions: Map<string, { id: string; name: string; status: string }>;
            sessionOrder: string[];
            startInlineRename: (id: string) => void;
            _renderSessionTabsImmediate: () => void;
            _activeRename: unknown;
          };
        }
      ).app;
      const id = 'render-race';
      app.sessions.set(id, { id, name: 'w9-case', status: 'idle' });
      app.sessionOrder = [id];

      const container = document.getElementById('sessionTabs') as HTMLElement;
      const tab = document.createElement('div');
      tab.setAttribute('data-test-tab', '1');
      tab.className = 'session-tab';
      tab.dataset.id = id;
      tab.innerHTML =
        '<span class="tab-status idle"></span><span class="tab-info"><span class="tab-name-row">' +
        `<span class="tab-name" data-session-id="${id}">w9-case</span>` +
        '</span></span>';
      container.appendChild(tab);

      app.startInlineRename(id);
      const input = document.querySelector('input.tab-rename-input') as HTMLInputElement | null;
      if (!input) return { opened: false };
      input.value = 'half-typed';

      // Exactly what a debounce timer queued before the rename would do.
      app._renderSessionTabsImmediate();

      const after = document.querySelector('input.tab-rename-input') as HTMLInputElement | null;
      return {
        opened: true,
        stillInDom: !!after && document.body.contains(after),
        value: after?.value ?? null,
        renameStillActive: !!app._activeRename,
      };
    });

    expect(result.opened).toBe(true);
    expect(result.stillInDom).toBe(true);
    expect(result.value).toBe('half-typed');
    expect(result.renameStillActive).toBe(true);
  });

  it('Modal: closeSessionOptions() commits the Session Name field before clearing the id', async () => {
    await resetState();

    // Every autosave handler in the session-options modal bails on a null
    // editingSessionId, and hiding the modal blurs the focused input. If the id is
    // cleared first, the blur-driven save is dropped and the typed name vanishes,
    // which is what Escape and backdrop-click used to do.
    const result = await page.evaluate(async () => {
      const app = (
        window as unknown as {
          app: {
            editingSessionId: string | null;
            sessions: Map<string, { id: string; name: string }>;
            closeSessionOptions: () => void;
          };
        }
      ).app;
      app.sessions.set('modal-id', { id: 'modal-id', name: 'w9-case' });
      app.editingSessionId = 'modal-id';

      const nameInput = document.getElementById('modalSessionName') as HTMLInputElement;
      const modal = document.getElementById('sessionOptionsModal') as HTMLElement;
      modal.classList.add('active');
      // The Session Name field lives on the modal's Context tab, which is hidden
      // until selected: a hidden input cannot take focus.
      document.getElementById('context-tab')?.classList.remove('hidden');
      nameInput.value = 'mydesc';
      nameInput.focus();
      const wasFocused = document.activeElement === nameInput;

      let putBody: string | null = null;
      const origFetch = window.fetch;
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/api/sessions/modal-id/name')) putBody = String(init?.body ?? '');
        return new Response('{"success":true}', { status: 200 });
      }) as typeof window.fetch;

      app.closeSessionOptions();
      await new Promise((r) => setTimeout(r, 30));
      window.fetch = origFetch;
      modal.classList.remove('active');

      return { wasFocused, putBody, editingAfter: app.editingSessionId };
    });

    expect(result.wasFocused).toBe(true);
    // Prefixed session: the suffix the user typed is appended to the w9-case prefix.
    expect(result.putBody).toContain('w9-case: mydesc');
    expect(result.editingAfter).toBe(null);
  });

  it('Commit writes the confirmed name into app.sessions WITHOUT any session:updated frame', async () => {
    await resetState();
    expect(await startRename('no-sse', 'w9-case')).toBe(true);

    // finishRename() re-renders the tab strip from app.sessions, so the rename
    // used to depend on the session:updated SSE frame to carry its own write
    // back. On a page whose stream has gone quiet without erroring, the PUT
    // stored the new name, the re-render repainted the stale one, and the tab
    // only showed it after a full reload. No SSE is dispatched here at all.
    const result = await page.evaluate(async () => {
      const app = (
        window as unknown as {
          app: { sessions: Map<string, { id: string; name: string }> };
        }
      ).app;
      const origFetch = window.fetch;
      window.fetch = (async () =>
        new Response('{"success":true,"data":{"name":"w9-case: fresh"}}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof window.fetch;

      const inputEl = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      inputEl.value = 'fresh';
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));

      window.fetch = origFetch;
      const label = document.querySelector('.tab-name[data-session-id="no-sse"]') as HTMLElement | null;
      return {
        mapName: app.sessions.get('no-sse')?.name ?? null,
        label: label?.textContent ?? null,
        classActive: label ? label.classList.contains('tab-name-renaming') : null,
      };
    });

    expect(result.mapName).toBe('w9-case: fresh');
    expect(result.label).toBe('w9-case: fresh');
    expect(result.classActive).toBe(false);
  });

  it('A rejected rename restores the old label and leaves app.sessions untouched', async () => {
    await resetState();
    expect(await startRename('rename-500', 'w9-case')).toBe(true);

    // _apiPut turns a network error into a null Response and an API-level
    // failure arrives as a non-ok status, neither of which throws, so a
    // rejected rename has to be detected from the response, or it reports
    // success and silently discards the user's edit.
    const result = await page.evaluate(async () => {
      const app = (
        window as unknown as {
          app: { sessions: Map<string, { id: string; name: string }>; showToast: (m: string, k: string) => void };
        }
      ).app;
      const toasts: string[] = [];
      const origToast = app.showToast;
      app.showToast = (msg: string) => void toasts.push(msg);
      const origFetch = window.fetch;
      window.fetch = (async () =>
        new Response('{"success":false,"error":"boom","errorCode":"INTERNAL"}', {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof window.fetch;

      const inputEl = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      inputEl.value = 'never-stored';
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));

      window.fetch = origFetch;
      app.showToast = origToast;
      const label = document.querySelector('.tab-name[data-session-id="rename-500"]') as HTMLElement | null;
      return {
        mapName: app.sessions.get('rename-500')?.name ?? null,
        label: label?.textContent ?? null,
        classActive: label ? label.classList.contains('tab-name-renaming') : null,
        toasts,
      };
    });

    expect(result.mapName).toBe('w9-case');
    expect(result.label).toBe('w9-case');
    expect(result.classActive).toBe(false);
    expect(result.toasts).toContain('Failed to rename');
  });

  it('Cancel restores the canonical prefixed label children', async () => {
    await resetState();
    expect(await startCanonicalPrefixedRename('canonical-cancel', 'w9-case: original')).toBe(true);

    const result = await page.evaluate(() => {
      const app = (window as unknown as { app: { _activeRename: { cancel: () => void } | null } }).app;
      app._activeRename!.cancel();
      const label = document.querySelector('.tab-name[data-session-id="canonical-cancel"]') as HTMLElement;
      return {
        text: label.textContent,
        fullName: label.dataset.fullName,
        prefixClass: label.firstElementChild?.className ?? null,
        prefixText: label.firstElementChild?.textContent ?? null,
      };
    });

    expect(result).toEqual({
      text: 'w9-case: original',
      fullName: 'w9-case: original',
      prefixClass: 'tab-name-prefix',
      prefixText: 'w9-case: ',
    });
  });

  it('A no-op commit restores the canonical prefixed label children', async () => {
    await resetState();
    expect(await startCanonicalPrefixedRename('canonical-noop', 'w9-case: original')).toBe(true);

    const result = await page.evaluate(async () => {
      const input = document.querySelector(
        '.tab-name[data-session-id="canonical-noop"] input.tab-rename-input'
      ) as HTMLInputElement;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const label = document.querySelector('.tab-name[data-session-id="canonical-noop"]') as HTMLElement;
      return {
        prefixClass: label.firstElementChild?.className ?? null,
        prefixText: label.firstElementChild?.textContent ?? null,
      };
    });

    expect(result).toEqual({ prefixClass: 'tab-name-prefix', prefixText: 'w9-case: ' });
  });

  it('A rejected rename restores the canonical prefixed label children', async () => {
    await resetState();
    expect(await startCanonicalPrefixedRename('canonical-failure', 'w9-case: original')).toBe(true);

    const result = await page.evaluate(async () => {
      const origFetch = window.fetch;
      window.fetch = (async () =>
        new Response('{"success":false}', {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof window.fetch;
      const input = document.querySelector(
        '.tab-name[data-session-id="canonical-failure"] input.tab-rename-input'
      ) as HTMLInputElement;
      input.value = 'rejected';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      window.fetch = origFetch;
      const label = document.querySelector('.tab-name[data-session-id="canonical-failure"]') as HTMLElement;
      return {
        prefixClass: label.firstElementChild?.className ?? null,
        prefixText: label.firstElementChild?.textContent ?? null,
      };
    });

    expect(result).toEqual({ prefixClass: 'tab-name-prefix', prefixText: 'w9-case: ' });
  });

  it('Deletion invalidates a pending rename PUT synchronously', async () => {
    await resetState();
    expect(await startRename('pending-delete', 'OldName')).toBe(true);

    const result = await page.evaluate(async () => {
      const app = (
        window as unknown as {
          app: {
            _activeRename: unknown;
            _inlineRenameActive: boolean;
            _cleanupSessionData: (id: string) => void;
            sessions: Map<string, { id: string; name: string }>;
          };
        }
      ).app;
      const origFetch = window.fetch;
      let resolvePut!: (response: Response) => void;
      window.fetch = (() => new Promise<Response>((resolve) => (resolvePut = resolve))) as typeof window.fetch;
      const input = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      input.value = 'PendingName';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const inlineReleasedWhilePending = app._inlineRenameActive === false;
      app._cleanupSessionData('pending-delete');
      const invalidatedSynchronously = !app._activeRename && app._inlineRenameActive === false;
      resolvePut(
        new Response('{"success":true,"data":{"name":"PendingName"}}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      window.fetch = origFetch;
      return {
        inlineReleasedWhilePending,
        invalidatedSynchronously,
        sessionGone: !app.sessions.has('pending-delete'),
      };
    });

    expect(result).toEqual({
      inlineReleasedWhilePending: true,
      invalidatedSynchronously: true,
      sessionGone: true,
    });
  });

  it('A pending session PUT cannot release a tab-group rename render guard', async () => {
    await resetState();
    expect(await startRename('group-guard-session', 'OldName')).toBe(true);

    const result = await page.evaluate(async () => {
      const app = (
        window as unknown as {
          app: {
            _inlineRenameActive: boolean;
            sessions: Map<string, { id: string; name: string }>;
            startTabGroupRename: (groupId: string) => boolean;
            tabLayout: { groups: Array<{ id: string; name: string; refs: unknown[] }> } | null;
          };
        }
      ).app;
      const origFetch = window.fetch;
      const origLayout = app.tabLayout;
      let resolvePut!: (response: Response) => void;
      window.fetch = (() => new Promise<Response>((resolve) => (resolvePut = resolve))) as typeof window.fetch;

      const sessionInput = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      sessionInput.value = 'ConfirmedName';
      sessionInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const container = document.getElementById('sessionTabs') as HTMLElement;
      const group = document.createElement('section');
      group.setAttribute('data-test-tab', '1');
      group.className = 'tab-layout-group';
      group.innerHTML =
        '<div class="tab-layout-group-header"><button data-tab-group-header="guard-group"></button>' +
        '<span class="tab-layout-group-label">Guard Group</span></div>';
      container.appendChild(group);
      app.tabLayout = {
        ...(origLayout ?? { groups: [] }),
        groups: [...(origLayout?.groups ?? []), { id: 'guard-group', name: 'Guard Group', refs: [] }],
      };
      const groupStarted = app.startTabGroupRename('guard-group');
      const groupInput = document.querySelector('.tab-layout-group-rename-input') as HTMLInputElement;

      resolvePut(
        new Response('{"success":true,"data":{"name":"ConfirmedName"}}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      const inputSurvives = document.body.contains(groupInput);
      const flagWhileGroupEditing = app._inlineRenameActive;
      if (inputSurvives) {
        groupInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
      const flagAfterGroupSettlement = app._inlineRenameActive;
      app.tabLayout = origLayout;
      window.fetch = origFetch;
      return { groupStarted, inputSurvives, flagWhileGroupEditing, flagAfterGroupSettlement };
    });

    expect(result).toEqual({
      groupStarted: true,
      inputSurvives: true,
      flagWhileGroupEditing: true,
      flagAfterGroupSettlement: false,
    });
  });

  it('Document F2 cannot replace a focused tab-group rename with a session editor', async () => {
    await resetState();

    const setup = await page.evaluate(() => {
      const app = (
        window as unknown as {
          app: {
            activeSessionId: string | null;
            sessions: Map<string, { id: string; name: string; status: string }>;
            sessionOrder: string[];
            startTabGroupRename: (groupId: string) => boolean;
            tabLayout: { groups: Array<{ id: string; name: string; refs: unknown[] }> } | null;
            tabLayoutReadOnly: boolean;
          };
          __inlineRenameOriginalLayout?: unknown;
          __inlineRenameOriginalReadOnly?: boolean;
        }
      ).app;
      const id = 'group-f2-session';
      const groupId = 'group-f2-owner';
      app.sessions.set(id, { id, name: 'Session Name', status: 'idle' });
      app.sessionOrder = [id];
      app.activeSessionId = id;
      const container = document.getElementById('sessionTabs') as HTMLElement;
      const tab = document.createElement('div');
      tab.setAttribute('data-test-tab', '1');
      tab.className = 'session-tab active';
      tab.dataset.id = id;
      tab.innerHTML =
        '<span class="tab-status idle"></span><span class="tab-info"><span class="tab-name-row">' +
        `<span class="tab-name" data-session-id="${id}" data-full-name="Session Name">Session Name</span>` +
        '</span></span>';
      container.appendChild(tab);
      const group = document.createElement('section');
      group.setAttribute('data-test-tab', '1');
      group.className = 'tab-layout-group';
      group.innerHTML =
        `<div class="tab-layout-group-header"><button data-tab-group-header="${groupId}"></button>` +
        '<span class="tab-layout-group-label">Owned Group</span></div>';
      container.appendChild(group);
      (window as unknown as { __inlineRenameOriginalLayout?: unknown }).__inlineRenameOriginalLayout = app.tabLayout;
      (window as unknown as { __inlineRenameOriginalReadOnly?: boolean }).__inlineRenameOriginalReadOnly =
        app.tabLayoutReadOnly;
      app.tabLayout = {
        ...(app.tabLayout ?? { groups: [] }),
        groups: [...(app.tabLayout?.groups ?? []), { id: groupId, name: 'Owned Group', refs: [] }],
      };
      app.tabLayoutReadOnly = false;
      return { started: app.startTabGroupRename(groupId) };
    });
    expect(setup.started).toBe(true);

    const groupInput = page.locator('.tab-layout-group-rename-input');
    expect(await groupInput.evaluate((input) => document.activeElement === input)).toBe(true);
    await groupInput.press('F2');
    const during = await page.evaluate(() => {
      const app = (
        window as unknown as {
          app: { _activeRename: unknown; _inlineRenameActive: boolean };
        }
      ).app;
      const input = document.querySelector('.tab-layout-group-rename-input');
      return {
        groupConnected: !!input?.isConnected,
        groupFocused: document.activeElement === input,
        sessionInputPresent: !!document.querySelector('input.tab-rename-input'),
        sessionRenameActive: !!app._activeRename,
        guardActive: app._inlineRenameActive,
      };
    });
    if (during.groupConnected) await groupInput.press('Escape');
    const after = await page.evaluate(() => {
      const app = (
        window as unknown as {
          app: {
            _inlineRenameActive: boolean;
            tabLayout: unknown;
            tabLayoutReadOnly: boolean;
          };
          __inlineRenameOriginalLayout?: unknown;
          __inlineRenameOriginalReadOnly?: boolean;
        }
      ).app;
      const originalLayout = (window as unknown as { __inlineRenameOriginalLayout?: unknown })
        .__inlineRenameOriginalLayout;
      app.tabLayout = originalLayout;
      app.tabLayoutReadOnly =
        (window as unknown as { __inlineRenameOriginalReadOnly?: boolean }).__inlineRenameOriginalReadOnly ?? true;
      delete (window as unknown as { __inlineRenameOriginalLayout?: unknown }).__inlineRenameOriginalLayout;
      delete (window as unknown as { __inlineRenameOriginalReadOnly?: boolean }).__inlineRenameOriginalReadOnly;
      return {
        groupSettled: !document.querySelector('.tab-layout-group-rename-input'),
        guardReleased: app._inlineRenameActive === false,
      };
    });

    expect(during).toEqual({
      groupConnected: true,
      groupFocused: true,
      sessionInputPresent: false,
      sessionRenameActive: false,
      guardActive: true,
    });
    expect(after).toEqual({ groupSettled: true, guardReleased: true });
  });

  it('Document F2 preserves a group editor over a pending session rename handle', async () => {
    await resetState();
    expect(await startRename('combined-owner-session', 'OldName')).toBe(true);

    const setup = await page.evaluate(async () => {
      const app = (
        window as unknown as {
          app: {
            _activeRename: unknown;
            _inlineRenameActive: boolean;
            activeSessionId: string | null;
            startTabGroupRename: (groupId: string) => boolean;
            tabLayout: { groups: Array<{ id: string; name: string; refs: unknown[] }> } | null;
            tabLayoutReadOnly: boolean;
          };
        }
      ).app;
      const globals = window as unknown as {
        __combinedOriginalFetch?: typeof window.fetch;
        __combinedOriginalLayout?: unknown;
        __combinedOriginalReadOnly?: boolean;
        __combinedPendingHandle?: unknown;
        __resolveCombinedPut?: (response: Response) => void;
      };
      globals.__combinedOriginalFetch = window.fetch;
      globals.__combinedOriginalLayout = app.tabLayout;
      globals.__combinedOriginalReadOnly = app.tabLayoutReadOnly;
      window.fetch = (() =>
        new Promise<Response>((resolve) => {
          globals.__resolveCombinedPut = resolve;
        })) as typeof window.fetch;

      const sessionInput = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      sessionInput.value = 'PendingName';
      sessionInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      globals.__combinedPendingHandle = app._activeRename;
      app.activeSessionId = 'combined-owner-session';

      const groupId = 'combined-owner-group';
      const container = document.getElementById('sessionTabs') as HTMLElement;
      const group = document.createElement('section');
      group.setAttribute('data-test-tab', '1');
      group.className = 'tab-layout-group';
      group.innerHTML =
        `<div class="tab-layout-group-header"><button data-tab-group-header="${groupId}"></button>` +
        '<span class="tab-layout-group-label">Combined Owner</span></div>';
      container.appendChild(group);
      app.tabLayout = {
        ...(app.tabLayout ?? { groups: [] }),
        groups: [...(app.tabLayout?.groups ?? []), { id: groupId, name: 'Combined Owner', refs: [] }],
      };
      app.tabLayoutReadOnly = false;
      return {
        groupStarted: app.startTabGroupRename(groupId),
        groupOwnsGuard: app._inlineRenameActive,
      };
    });
    expect(setup).toEqual({ groupStarted: true, groupOwnsGuard: true });

    const groupInput = page.locator('.tab-layout-group-rename-input');
    expect(await groupInput.evaluate((input) => document.activeElement === input)).toBe(true);
    await groupInput.press('F2');
    const during = await page.evaluate(() => {
      const app = (
        window as unknown as {
          app: {
            _activeRename: { ownsRenderGuard?: boolean } | null;
            _inlineRenameActive: boolean;
          };
        }
      ).app;
      const globals = window as unknown as { __combinedPendingHandle?: unknown };
      const input = document.querySelector('.tab-layout-group-rename-input');
      return {
        groupConnected: !!input?.isConnected,
        groupFocused: document.activeElement === input,
        groupGuardActive: app._inlineRenameActive,
        sessionInputPresent: !!document.querySelector('input.tab-rename-input'),
        pendingHandlePreserved: app._activeRename === globals.__combinedPendingHandle,
        pendingHandleOwnsGuard: app._activeRename?.ownsRenderGuard ?? null,
      };
    });

    await page.evaluate(() => {
      const resolvePut = (window as unknown as { __resolveCombinedPut?: (response: Response) => void })
        .__resolveCombinedPut;
      resolvePut?.(
        new Response('{"success":true,"data":{"name":"PendingName"}}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const afterResponse = await page.evaluate(() => {
      const app = (
        window as unknown as {
          app: { _activeRename: unknown; _inlineRenameActive: boolean };
        }
      ).app;
      const input = document.querySelector('.tab-layout-group-rename-input');
      return {
        groupConnected: !!input?.isConnected,
        groupFocused: document.activeElement === input,
        groupGuardActive: app._inlineRenameActive,
        pendingHandleCompleted: !app._activeRename,
      };
    });
    if (afterResponse.groupConnected) await groupInput.press('Escape');
    const afterSettlement = await page.evaluate(() => {
      const app = (
        window as unknown as {
          app: {
            _activeRename: { cancel: () => void } | null;
            _inlineRenameActive: boolean;
            tabLayout: unknown;
            tabLayoutReadOnly: boolean;
          };
        }
      ).app;
      const globals = window as unknown as {
        __combinedOriginalFetch?: typeof window.fetch;
        __combinedOriginalLayout?: unknown;
        __combinedOriginalReadOnly?: boolean;
        __combinedPendingHandle?: unknown;
        __resolveCombinedPut?: unknown;
      };
      app._activeRename?.cancel();
      app.tabLayout = globals.__combinedOriginalLayout;
      app.tabLayoutReadOnly = globals.__combinedOriginalReadOnly ?? true;
      if (globals.__combinedOriginalFetch) window.fetch = globals.__combinedOriginalFetch;
      delete globals.__combinedOriginalFetch;
      delete globals.__combinedOriginalLayout;
      delete globals.__combinedOriginalReadOnly;
      delete globals.__combinedPendingHandle;
      delete globals.__resolveCombinedPut;
      return {
        groupSettled: !document.querySelector('.tab-layout-group-rename-input'),
        guardReleased: app._inlineRenameActive === false,
      };
    });

    expect(during).toEqual({
      groupConnected: true,
      groupFocused: true,
      groupGuardActive: true,
      sessionInputPresent: false,
      pendingHandlePreserved: true,
      pendingHandleOwnsGuard: false,
    });
    expect(afterResponse).toEqual({
      groupConnected: true,
      groupFocused: true,
      groupGuardActive: true,
      pendingHandleCompleted: true,
    });
    expect(afterSettlement).toEqual({ groupSettled: true, guardReleased: true });
  });

  it('A late old failure cannot destroy or toast over a same-session re-entry', async () => {
    await resetState();
    expect(await startRename('pending-reentry', 'OldName')).toBe(true);

    const result = await page.evaluate(async () => {
      const app = (
        window as unknown as {
          app: {
            _activeRename: { sessionId: string } | null;
            startInlineRename: (id: string) => void;
            showToast: (message: string, kind: string) => void;
          };
        }
      ).app;
      const origFetch = window.fetch;
      const origToast = app.showToast;
      const toasts: string[] = [];
      app.showToast = (message: string) => void toasts.push(message);
      let resolveOld!: (response: Response) => void;
      window.fetch = (() => new Promise<Response>((resolve) => (resolveOld = resolve))) as typeof window.fetch;

      const oldInput = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      oldInput.value = 'FirstAttempt';
      oldInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      app.startInlineRename('pending-reentry');
      const newInput = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      newInput.value = 'SecondAttempt';

      resolveOld(
        new Response('{"success":false}', {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      window.fetch = origFetch;
      app.showToast = origToast;
      return {
        inputSurvives: document.body.contains(newInput),
        value: newInput.value,
        activeSessionId: app._activeRename?.sessionId ?? null,
        toasts,
      };
    });

    expect(result).toEqual({
      inputSurvives: true,
      value: 'SecondAttempt',
      activeSessionId: 'pending-reentry',
      toasts: [],
    });
  });

  it('A stale no-op queues a compensating write behind the pending rename', async () => {
    await resetState();
    expect(await startRename('pending-stale-noop', 'Old')).toBe(true);

    const result = await page.evaluate(async () => {
      const app = (
        window as unknown as {
          app: {
            sessions: Map<string, { id: string; name: string }>;
            startInlineRename: (id: string) => void;
          };
        }
      ).app;
      const origFetch = window.fetch;
      const requests: Array<{ body: string; resolve: (response: Response) => void }> = [];
      window.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          requests.push({ body: String(init?.body ?? ''), resolve });
        })) as typeof window.fetch;

      const firstInput = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      firstInput.value = 'First';
      firstInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      app.startInlineRename('pending-stale-noop');
      const staleInput = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      staleInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const requestCountBeforeFirstSettled = requests.length;
      requests[0].resolve(
        new Response('{"success":true,"data":{"name":"First"}}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const compensatingWriteStarted = requests.length === 2;
      if (compensatingWriteStarted) {
        requests[1].resolve(
          new Response('{"success":true,"data":{"name":"Old"}}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      window.fetch = origFetch;
      const label = document.querySelector('.tab-name[data-session-id="pending-stale-noop"]') as HTMLElement;
      return {
        requestCountBeforeFirstSettled,
        compensatingWriteStarted,
        bodies: requests.map(({ body }) => JSON.parse(body).name),
        mapName: app.sessions.get('pending-stale-noop')?.name ?? null,
        label: label.textContent,
      };
    });

    expect(result).toEqual({
      requestCountBeforeFirstSettled: 1,
      compensatingWriteStarted: true,
      bodies: ['First', 'Old'],
      mapName: 'Old',
      label: 'Old',
    });
  });

  it('Cancelling a re-entry does not erase the earlier confirmed write', async () => {
    await resetState();

    const result = await page.evaluate(async () => {
      const app = (
        window as unknown as {
          app: {
            _activeRename: { cancel: () => void } | null;
            sessions: Map<string, { id: string; name: string; status: string }>;
            sessionOrder: string[];
            startInlineRename: (id: string) => void;
          };
        }
      ).app;
      const id = 'pending-cancel-reentry';
      app.sessions.set(id, { id, name: 'Old', status: 'idle' });
      app.sessionOrder = [id];
      const container = document.getElementById('sessionTabs') as HTMLElement;
      const tab = document.createElement('div');
      tab.setAttribute('data-test-tab', '1');
      tab.className = 'session-tab';
      tab.dataset.id = id;
      tab.innerHTML =
        '<span class="tab-status idle"></span><span class="tab-info"><span class="tab-name-row">' +
        `<span class="tab-name" data-session-id="${id}" data-full-name="Old">Old</span>` +
        '</span></span>';
      container.appendChild(tab);

      const origFetch = window.fetch;
      let resolveFirst!: (response: Response) => void;
      window.fetch = (() => new Promise<Response>((resolve) => (resolveFirst = resolve))) as typeof window.fetch;
      app.startInlineRename(id);
      const firstInput = tab.querySelector('input.tab-rename-input') as HTMLInputElement;
      firstInput.value = 'First';
      firstInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      app.startInlineRename(id);
      app._activeRename!.cancel();

      resolveFirst(
        new Response('{"success":true,"data":{"name":"First"}}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      window.fetch = origFetch;
      const label = document.querySelector(`.tab-name[data-session-id="${id}"]`) as HTMLElement | null;
      return {
        mapName: app.sessions.get(id)?.name ?? null,
        label: label?.textContent ?? null,
        renameActive: !!app._activeRename,
      };
    });

    expect(result).toEqual({ mapName: 'First', label: 'First', renameActive: false });
  });

  it('Serializes successive rename writes in user-intent order', async () => {
    await resetState();
    expect(await startRename('pending-order', 'OldName')).toBe(true);

    const result = await page.evaluate(async () => {
      const app = (
        window as unknown as {
          app: {
            sessions: Map<string, { id: string; name: string }>;
            startInlineRename: (id: string) => void;
          };
        }
      ).app;
      const origFetch = window.fetch;
      const pending: Array<{ body: string; resolve: (response: Response) => void }> = [];
      window.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          pending.push({ body: String(init?.body ?? ''), resolve });
        })) as typeof window.fetch;

      const oldInput = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      oldInput.value = 'FirstAttempt';
      oldInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      app.startInlineRename('pending-order');
      const newInput = document.querySelector('input.tab-rename-input') as HTMLInputElement;
      newInput.value = 'SecondAttempt';
      newInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const requestCountBeforeFirstSettled = pending.length;
      pending[0].resolve(
        new Response('{"success":true,"data":{"name":"FirstAttempt"}}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const secondStartedAfterFirst = pending.length === 2;
      pending[1]?.resolve(
        new Response('{"success":true,"data":{"name":"SecondAttempt"}}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      window.fetch = origFetch;
      return {
        requestCountBeforeFirstSettled,
        secondStartedAfterFirst,
        bodies: pending.map(({ body }) => JSON.parse(body).name),
        mapName: app.sessions.get('pending-order')?.name ?? null,
      };
    });

    expect(result).toEqual({
      requestCountBeforeFirstSettled: 1,
      secondStartedAfterFirst: true,
      bodies: ['FirstAttempt', 'SecondAttempt'],
      mapName: 'SecondAttempt',
    });
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
      const firstInput = document.querySelector(
        '.tab-name[data-session-id="first-id"] input.tab-rename-input'
      ) as HTMLInputElement;
      // A browser moving focus to the second editor normally happens to commit
      // the first one. Stop that incidental blur settlement so this test proves
      // startInlineRename() itself tears down an already-active editor.
      firstInput.addEventListener('blur', (event) => event.stopImmediatePropagation(), true);
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
      const firstLabel = document.querySelector('.tab-name[data-session-id="first-id"]') as HTMLElement | null;
      return {
        firstActive,
        secondActive: app._activeRename?.sessionId,
        firstLabelPresent: !!firstLabel,
        firstLabel: firstLabel?.textContent ?? null,
        firstInputPresent: !!firstLabel?.querySelector('input.tab-rename-input'),
        firstRenameClassActive: firstLabel ? firstLabel.classList.contains('tab-name-renaming') : null,
        secondInputPresent: !!document.querySelector('.tab-name[data-session-id="second-id"] input.tab-rename-input'),
      };
    });

    expect(result.firstActive).toBe('first-id');
    expect(result.secondActive).toBe('second-id');
    expect(result.firstLabelPresent).toBe(true);
    expect(result.firstLabel).toBe('First');
    expect(result.firstInputPresent).toBe(false);
    expect(result.firstRenameClassActive).toBe(false);
    expect(result.secondInputPresent).toBe(true);
  });

  it('Vertical rail paints native typing inside an unclamped, visible rename editor', async () => {
    await resetState();

    const id = 'vertical-live-input';
    await page.evaluate((sessionId) => {
      const app = (
        window as unknown as {
          app: {
            sessions: Map<string, { id: string; name: string; status: string }>;
            sessionOrder: string[];
            startInlineRename: (id: string) => void;
          };
        }
      ).app;
      document.documentElement.dataset.tabOrientation = 'vertical';

      const container = document.getElementById('sessionTabs') as HTMLElement;
      const rail = document.getElementById('tabRail') as HTMLElement;
      rail.appendChild(container);

      app.sessions.set(sessionId, { id: sessionId, name: 'w9-case: old', status: 'idle' });
      app.sessionOrder = [sessionId];
      const tab = document.createElement('div');
      tab.setAttribute('data-test-tab', '1');
      tab.className = 'session-tab';
      tab.dataset.id = sessionId;
      tab.innerHTML =
        '<span class="tab-status idle"></span><span class="tab-info"><span class="tab-name-row">' +
        `<span class="tab-name" data-session-id="${sessionId}">w9-case: old</span>` +
        '</span></span>';
      container.appendChild(tab);

      app.startInlineRename(sessionId);
    }, id);

    const input = page.locator(`.tab-name[data-session-id="${id}"] input.tab-rename-input`);
    await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type('visible title');

    const liveState = await page.evaluate((sessionId) => {
      const tabName = document.querySelector(`.tab-name[data-session-id="${sessionId}"]`) as HTMLElement;
      const input = tabName.querySelector('input.tab-rename-input') as HTMLInputElement;
      const prefix = tabName.querySelector(':scope > span') as HTMLElement;
      const tabNameRect = tabName.getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      const prefixRect = prefix.getBoundingClientRect();
      return {
        focused: document.activeElement === input,
        value: input.value,
        classActive: tabName.classList.contains('tab-name-renaming'),
        webkitLineClamp: getComputedStyle(tabName).webkitLineClamp,
        inputRect,
        prefixRect,
        tabNameRect,
      };
    }, id);

    expect(liveState.focused).toBe(true);
    expect(liveState.value).toBe('visible title');
    expect({ classActive: liveState.classActive, webkitLineClamp: liveState.webkitLineClamp }).toEqual({
      classActive: true,
      webkitLineClamp: 'none',
    });
    expect(liveState.inputRect.width).toBeGreaterThan(0);
    expect(liveState.inputRect.height).toBeGreaterThan(0);
    expect(liveState.prefixRect.width).toBeGreaterThan(0);
    expect(liveState.prefixRect.height).toBeGreaterThan(0);
    expect(liveState.inputRect.left).toBeGreaterThanOrEqual(liveState.tabNameRect.left);
    expect(liveState.inputRect.right).toBeLessThanOrEqual(liveState.tabNameRect.right);
    expect(liveState.inputRect.top).toBeGreaterThanOrEqual(liveState.tabNameRect.top);
    expect(liveState.inputRect.bottom).toBeLessThanOrEqual(liveState.tabNameRect.bottom);

    const cancelledState = await page.evaluate((sessionId) => {
      const app = (window as unknown as { app: { _activeRename: { cancel: () => void } | null } }).app;
      app._activeRename!.cancel();
      const tabName = document.querySelector(`.tab-name[data-session-id="${sessionId}"]`) as HTMLElement;
      return {
        classActive: tabName.classList.contains('tab-name-renaming'),
        inputPresent: !!tabName.querySelector('input.tab-rename-input'),
        webkitLineClamp: getComputedStyle(tabName).webkitLineClamp,
      };
    }, id);

    expect(cancelledState.classActive).toBe(false);
    expect(cancelledState.inputPresent).toBe(false);
    expect(cancelledState.webkitLineClamp).toBe('2');
  });

  it('Compact 208px vertical rail reserves usable input width with a long prefix', async () => {
    await resetState();

    const result = await page.evaluate(() => {
      const app = (
        window as unknown as {
          app: {
            _activeRename: { cancel: () => void } | null;
            sessions: Map<string, { id: string; name: string; status: string }>;
            startInlineRename: (id: string) => void;
          };
        }
      ).app;
      const id = 'compact-long-prefix';
      const name = 'w123-this_is_a_very_long_valid_prefix: title';
      document.documentElement.dataset.tabOrientation = 'vertical';
      document.documentElement.classList.add('tab-rail-compact');
      const rail = document.getElementById('tabRail') as HTMLElement;
      rail.style.setProperty('--tab-rail-width', '208px');
      const container = document.getElementById('sessionTabs') as HTMLElement;
      rail.appendChild(container);
      app.sessions.set(id, { id, name, status: 'idle' });

      const tab = document.createElement('div');
      tab.setAttribute('data-test-tab', '1');
      tab.className = 'session-tab active';
      tab.dataset.id = id;
      tab.innerHTML =
        '<span class="tab-number">1</span><span class="tab-status idle"></span>' +
        '<span class="tab-info"><span class="tab-name-row">' +
        `<span class="tab-name" data-session-id="${id}" data-full-name="${name}">` +
        '<span class="tab-name-prefix">w123-this_is_a_very_long_valid_prefix: </span>title</span>' +
        '</span></span><button class="tab-ref-drag-handle" type="button">&#x2630;</button>' +
        '<span class="tab-actions"><span class="tab-gear">&#x2699;</span>' +
        '<span class="tab-detach">&#x29C9;</span><span class="tab-close">&times;</span>' +
        '<button class="tab-more" type="button">&#x22EF;</button></span>';
      container.appendChild(tab);
      app.startInlineRename(id);

      const tabName = tab.querySelector('.tab-name') as HTMLElement;
      const input = tabName.querySelector('.tab-rename-input') as HTMLInputElement;
      const prefix = tabName.querySelector('.tab-rename-prefix') as HTMLElement;
      const tabNameRect = tabName.getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      const prefixRect = prefix.getBoundingClientRect();
      const tabRect = tab.getBoundingClientRect();
      const railRect = rail.getBoundingClientRect();
      const dragHandle = tab.querySelector('.tab-ref-drag-handle') as HTMLElement;
      const actions = tab.querySelector('.tab-actions') as HTMLElement;
      const controlsHidden =
        getComputedStyle(dragHandle).display === 'none' && getComputedStyle(actions).display === 'none';
      const prefixOverflow = getComputedStyle(prefix).textOverflow;
      app._activeRename?.cancel();
      return {
        inputWidth: inputRect.width,
        prefixWidth: prefixRect.width,
        inputInside: inputRect.left >= tabNameRect.left && inputRect.right <= tabNameRect.right,
        prefixInside: prefixRect.left >= tabNameRect.left && prefixRect.right <= tabNameRect.right,
        rowInsideRail: tabRect.left >= railRect.left && tabRect.right <= railRect.right,
        prefixOverflow,
        controlsHidden,
        controlsRestored:
          getComputedStyle(dragHandle).display !== 'none' && getComputedStyle(actions).display !== 'none',
      };
    });

    expect(result.prefixWidth).toBeGreaterThanOrEqual(32);
    expect(result.inputWidth).toBeGreaterThanOrEqual(64);
    expect(result.inputInside).toBe(true);
    expect(result.prefixInside).toBe(true);
    expect(result.rowInsideRail).toBe(true);
    expect(result.prefixOverflow).toBe('ellipsis');
    expect(result.controlsHidden).toBe(true);
    expect(result.controlsRestored).toBe(true);
  });

  it('Session-list sidebar keeps its full-width inline editor', async () => {
    await resetState();

    const width = await page.evaluate(() => {
      const app = (
        window as unknown as {
          app: {
            sessions: Map<string, { id: string; name: string }>;
            startInlineRename: (id: string) => void;
          };
        }
      ).app;
      const id = 'sidebar-width';
      document.documentElement.dataset.sessionList = 'sidebar';
      app.sessions.set(id, { id, name: 'SidebarName' });
      const sidebar = document.createElement('aside');
      sidebar.className = 'session-sidebar';
      sidebar.setAttribute('data-test-tab', '1');
      const tabName = document.createElement('span');
      tabName.className = 'tab-name';
      tabName.dataset.sessionId = id;
      tabName.textContent = 'SidebarName';
      sidebar.appendChild(tabName);
      document.body.appendChild(sidebar);
      app.startInlineRename(id);
      return (tabName.querySelector('.tab-rename-input') as HTMLInputElement).style.width;
    });

    expect(width).toBe('100%');
  });
});
