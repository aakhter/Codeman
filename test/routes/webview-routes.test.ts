/**
 * CRUD + capability behaviour for /api/webviews.
 *
 * Uses app.inject() (no port) against a temp CODEMAN_DATA_DIR, so nothing touches
 * the developer's real ~/.codeman/webviews.json.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { registerWebviewRoutes } from '../../src/web/routes/webview-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { webviewCapabilities } from '../../src/webview-capabilities.js';
import { capabilityFromProxyPath } from '../../src/web/webview-proxy.js';
import { writeWebviews } from '../../src/webview-store.js';
import { TabLayoutService } from '../../src/tab-layout-service.js';
import type { TabLayout } from '../../src/tab-layout.js';
import { MAX_WEBVIEWS } from '../../src/config/webview-limits.js';
import { writeWebviews } from '../../src/webview-store.js';
import type { AuthUser, Webview } from '../../src/types.js';

const CONSTANTS_SOURCE = readFileSync(new URL('../../src/web/public/constants.js', import.meta.url), 'utf8');
const TAB_LAYOUT_SOURCE = readFileSync(new URL('../../src/web/public/tab-layout-browser.js', import.meta.url), 'utf8');
const WEBVIEW_TABS_SOURCE = readFileSync(new URL('../../src/web/public/webview-tabs.js', import.meta.url), 'utf8');

let app: FastifyInstance;
let tmpDir: string;
let savedDataDir: string | undefined;
const broadcasts: Array<{ event: string; data: unknown }> = [];
const webviewCreated = vi.fn(async () => {});
const webviewDeleted = vi.fn(async () => {});

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeman-webviews-'));
  savedDataDir = process.env.CODEMAN_DATA_DIR;
  process.env.CODEMAN_DATA_DIR = tmpDir;
  broadcasts.length = 0;
  webviewCreated.mockClear();
  webviewDeleted.mockClear();

  app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  // The proxy route declares a wsHandler, so the plugin must be present.
  await app.register(fastifyWebsocket);
  registerWebviewRoutes(app, {
    broadcast: (event: string, data: unknown) => broadcasts.push({ event, data }),
    tabLayouts: { webviewCreated, webviewDeleted },
  } as never);
  installRouteErrorHandler(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  if (savedDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = savedDataDir;
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

const create = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/webviews', payload });

async function createAuthenticatedApp(authUser: AuthUser): Promise<FastifyInstance> {
  const ownedApp = Fastify({ logger: false });
  await ownedApp.register(fastifyCookie);
  await ownedApp.register(fastifyWebsocket);
  ownedApp.addHook('onRequest', async (req) => {
    req.authUser = authUser;
  });
  registerWebviewRoutes(ownedApp, {
    broadcast: (event: string, data: unknown) => broadcasts.push({ event, data }),
    tabLayouts: { webviewCreated, webviewDeleted },
  } as never);
  installRouteErrorHandler(ownedApp);
  await ownedApp.ready();
  return ownedApp;
}

function ownedWebview(id: string, owner: string): Webview {
  return {
    id,
    owner,
    name: id,
    url: `https://${id}.example/`,
    embedMode: 'proxy',
    trusted: false,
    createdAt: 1,
  };
}

async function projectBrowserResponse(webviews: Webview[]): Promise<string[]> {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const win = dom.window as unknown as Window &
    typeof globalThis & {
      CodemanApp: new () => Record<string, any>;
      CodemanTabLayout: { project(layout: unknown, options: unknown): { visibleRefs: Array<{ id: string }> } };
    };
  (win as unknown as { eval(source: string): void }).eval(
    ['window.CodemanApp = class CodemanApp {};', CONSTANTS_SOURCE, TAB_LAYOUT_SOURCE, WEBVIEW_TABS_SOURCE].join('\n')
  );
  win.localStorage.setItem('codeman-webview-order', '["bob-view","alice-view"]');
  const browser = new win.CodemanApp();
  browser._apiJson = vi.fn(async () => ({ webviews }));
  browser.renderWebviewMenuItems = vi.fn();
  browser.renderSessionTabs = vi.fn();
  await browser.initWebviews();
  return win.CodemanTabLayout.project(
    {
      version: 1,
      updatedAt: '2026-08-16T00:00:00.000Z',
      groups: [],
      ungrouped: [{ kind: 'webview', id: 'alice-view' }],
    },
    { openWebviewIds: browser.webviewOrder }
  ).visibleRefs.map((ref) => ref.id);
}

describe('GET /api/webviews', () => {
  it('starts empty and reports the frame budget the client must honour', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/webviews' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.webviews).toEqual([]);
    expect(typeof body.data.maxLiveFrames).toBe('number');
  });

  it('returns only the authenticated layout owner records even for an admin', async () => {
    const previous = process.env.CODEMAN_MULTIUSER;
    process.env.CODEMAN_MULTIUSER = '1';
    const ownedApp = await createAuthenticatedApp({ username: 'alice', role: 'admin' });
    try {
      await writeWebviews(tmpDir, [ownedWebview('alice-view', 'alice'), ownedWebview('bob-view', 'bob')]);

      const response = await ownedApp.inject({ method: 'GET', url: '/api/webviews' });
      const listed = response.json().data.webviews as Webview[];

      expect(response.statusCode).toBe(200);
      expect(listed.map((webview) => webview.id)).toEqual(['alice-view']);
      expect(await projectBrowserResponse(listed)).toEqual(['alice-view']);
    } finally {
      await ownedApp.close();
      if (previous === undefined) delete process.env.CODEMAN_MULTIUSER;
      else process.env.CODEMAN_MULTIUSER = previous;
    }
  });

  it('maps undefined saved-webview ownership to the single-user layout owner', async () => {
    await writeWebviews(tmpDir, [
      { ...ownedWebview('single-view', 'discarded'), owner: undefined },
      ownedWebview('multiuser-leftover', 'alice'),
    ]);

    const response = await app.inject({ method: 'GET', url: '/api/webviews' });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.webviews.map((webview: Webview) => webview.id)).toEqual(['single-view']);
  });
});

describe('POST /api/webviews', () => {
  it('creates a dashboard that defaults to proxied and sandboxed', async () => {
    const res = await create({ name: 'Grafana', url: 'http://127.0.0.1:4000/' });
    expect(res.statusCode).toBe(200);
    const w = res.json().data;
    // Proxy + untrusted are the safe defaults and must not drift.
    expect(w.embedMode).toBe('proxy');
    expect(w.trusted).toBe(false);
    expect(w.id).toBeTruthy();
  });

  it('broadcasts the change so other devices re-fetch', async () => {
    const created = (await create({ name: 'G', url: 'http://127.0.0.1:4000/' })).json().data;
    expect(broadcasts).toContainEqual({
      event: 'webview:changed',
      data: { action: 'created', id: created.id, owner: '@single' },
    });
  });

  it('persists across a fresh read of the store', async () => {
    await create({ name: 'G', url: 'http://127.0.0.1:4000/' });
    const list = (await app.inject({ method: 'GET', url: '/api/webviews' })).json().data.webviews;
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('G');
  });

  it('accepts exactly the configured per-owner limit and rejects the next save', async () => {
    for (let index = 0; index < MAX_WEBVIEWS; index++) {
      const response = await create({ name: `view-${index}`, url: `https://view-${index}.example/` });
      expect(response.statusCode, `webview ${index + 1}`).toBe(200);
    }

    const overflow = await create({ name: 'overflow', url: 'https://overflow.example/' });
    expect(overflow.statusCode).toBe(400);
    expect(overflow.json().error).toContain(`max ${MAX_WEBVIEWS}`);
    expect((await app.inject({ method: 'GET', url: '/api/webviews' })).json().data.webviews).toHaveLength(MAX_WEBVIEWS);
  });

  it('counts the configured quota by exact owner even when the requester is an admin', async () => {
    const previous = process.env.CODEMAN_MULTIUSER;
    process.env.CODEMAN_MULTIUSER = '1';
    const ownedApp = await createAuthenticatedApp({ username: 'alice', role: 'admin' });
    try {
      const records = [
        ...Array.from({ length: MAX_WEBVIEWS }, (_, index) => ownedWebview(`bob-${index}`, 'bob')),
        ...Array.from({ length: MAX_WEBVIEWS - 1 }, (_, index) => ownedWebview(`alice-${index}`, 'alice')),
      ];
      await writeWebviews(tmpDir, records);

      const lastAllowed = await ownedApp.inject({
        method: 'POST',
        url: '/api/webviews',
        payload: { name: 'alice-last', url: 'https://alice-last.example/' },
      });
      const overflow = await ownedApp.inject({
        method: 'POST',
        url: '/api/webviews',
        payload: { name: 'alice-overflow', url: 'https://alice-overflow.example/' },
      });
      const listed = (await ownedApp.inject({ method: 'GET', url: '/api/webviews' })).json().data.webviews;

      expect(lastAllowed.statusCode).toBe(200);
      expect(lastAllowed.json().data.owner).toBe('alice');
      expect(overflow.statusCode).toBe(400);
      expect(listed).toHaveLength(MAX_WEBVIEWS);
      expect(listed.every((webview: Webview) => webview.owner === 'alice')).toBe(true);
    } finally {
      await ownedApp.close();
      if (previous === undefined) delete process.env.CODEMAN_MULTIUSER;
      else process.env.CODEMAN_MULTIUSER = previous;
    }
  });

  it('rejects URLs that are not plain http(s)', async () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) {
      const res = await create({ name: 'bad', url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().errorCode).toBe('INVALID_INPUT');
    }
  });

  it('rolls back webview persistence and emits nothing when layout capacity rejects insertion', async () => {
    const refs = Array.from({ length: 512 }, (_, index) => ({ kind: 'session' as const, id: `s-${index}` }));
    const original: TabLayout = {
      version: 9,
      groups: [],
      ungrouped: refs,
      updatedAt: '2026-08-16T00:00:00.000Z',
    };
    let stored = original;
    let sessionOrder: string[] = [];
    const live = new Map(refs.map((ref, index) => [ref.id, { id: ref.id, createdAt: index }]));
    const atomicBroadcast = vi.fn();
    const service = new TabLayoutService({
      store: {
        getTabLayout: () => stored,
        getTabLayouts: () => ({ '@single': structuredClone(stored) }),
        commitTabLayoutProjection: (
          updates: Readonly<Record<string, TabLayout>>,
          projectOrder: (latest: readonly string[]) => readonly string[]
        ) => {
          if (updates['@single']) stored = structuredClone(updates['@single']);
          sessionOrder = [...projectOrder(sessionOrder)];
          return { layouts: structuredClone(updates), sessionOrder: [...sessionOrder] };
        },
        getSessions: () => ({}),
        getSessionOrder: () => [...sessionOrder],
      } as never,
      sessions: live,
      readWebviews: async () =>
        (await import('../../src/webview-store.js')).readWebviews(tmpDir) as Promise<
          Array<{ id: string; owner?: string }>
        >,
      broadcast: atomicBroadcast,
      broadcastSessionOrder: vi.fn(),
    });
    const atomicApp = Fastify({ logger: false });
    await atomicApp.register(fastifyCookie);
    await atomicApp.register(fastifyWebsocket);
    registerWebviewRoutes(atomicApp, {
      broadcast: atomicBroadcast,
      tabLayouts: service,
    } as never);
    installRouteErrorHandler(atomicApp);
    await atomicApp.ready();

    const response = await atomicApp.inject({
      method: 'POST',
      url: '/api/webviews',
      payload: { name: 'overflow', url: 'https://example.test/' },
    });
    const list = (await atomicApp.inject({ method: 'GET', url: '/api/webviews' })).json().data.webviews;

    expect(response.statusCode).toBe(500);
    expect(list).toEqual([]);
    expect(stored).toEqual(original);
    expect(atomicBroadcast).not.toHaveBeenCalled();
    await atomicApp.close();
  });

  it('rejects URLs carrying embedded credentials', async () => {
    const res = await create({ name: 'bad', url: 'http://user:pass@host:4000/' });
    expect(res.statusCode).toBe(400);
  });

  it('requires a name', async () => {
    expect((await create({ url: 'http://127.0.0.1:4000/' })).statusCode).toBe(400);
    expect((await create({ name: '   ', url: 'http://127.0.0.1:4000/' })).statusCode).toBe(400);
  });
});

describe('PATCH /api/webviews/:id', () => {
  it('updates fields and revokes the outstanding capability', async () => {
    const id = (await create({ name: 'G', url: 'http://127.0.0.1:4000/' })).json().data.id;
    const opened = await app.inject({ method: 'POST', url: `/api/webviews/${id}/open` });
    const cap = capabilityFromProxyPath(opened.json().data.embedUrl)!;
    expect(webviewCapabilities.resolve(cap)).toBeDefined();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/webviews/${id}`,
      payload: { url: 'http://127.0.0.1:4001/' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.url).toBe('http://127.0.0.1:4001/');
    // A token minted against the OLD url must not survive the repoint.
    expect(webviewCapabilities.resolve(cap)).toBeUndefined();
    expect(broadcasts).toContainEqual({
      event: 'webview:changed',
      data: { action: 'updated', id, owner: '@single' },
    });
  });

  it('404s an unknown id', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/webviews/nope', payload: { name: 'x' } });
    expect(res.statusCode).toBe(404);
  });

  it('still validates the URL on update', async () => {
    const id = (await create({ name: 'G', url: 'http://127.0.0.1:4000/' })).json().data.id;
    const res = await app.inject({ method: 'PATCH', url: `/api/webviews/${id}`, payload: { url: 'file:///etc' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/webviews/:id', () => {
  it('removes it and revokes its capability', async () => {
    const id = (await create({ name: 'G', url: 'http://127.0.0.1:4000/' })).json().data.id;
    const opened = await app.inject({ method: 'POST', url: `/api/webviews/${id}/open` });
    const cap = capabilityFromProxyPath(opened.json().data.embedUrl)!;

    expect((await app.inject({ method: 'DELETE', url: `/api/webviews/${id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/webviews' })).json().data.webviews).toEqual([]);
    expect(webviewCapabilities.resolve(cap)).toBeUndefined();
    expect(broadcasts).toContainEqual({
      event: 'webview:changed',
      data: { action: 'deleted', id, owner: '@single' },
    });
  });

  it('keeps the exact saved record and emits nothing when layout deletion fails', async () => {
    const created = (await create({ name: 'Keep me', url: 'https://keep.example/' })).json().data;
    broadcasts.length = 0;
    webviewDeleted.mockRejectedValueOnce(new Error('tab layout restoration failed'));

    const response = await app.inject({ method: 'DELETE', url: `/api/webviews/${created.id}` });
    const list = (await app.inject({ method: 'GET', url: '/api/webviews' })).json().data.webviews;

    expect(response.statusCode).toBe(500);
    expect(list).toEqual([created]);
    expect(broadcasts).toEqual([]);
  });

  it('keeps the exact saved record and emits nothing when layout deletion fails', async () => {
    const created = (await create({ name: 'Keep me', url: 'https://keep.example/' })).json().data;
    broadcasts.length = 0;
    webviewDeleted.mockRejectedValueOnce(new Error('tab layout restoration failed'));

    const response = await app.inject({ method: 'DELETE', url: `/api/webviews/${created.id}` });
    const list = (await app.inject({ method: 'GET', url: '/api/webviews' })).json().data.webviews;

    expect(response.statusCode).toBe(500);
    expect(list).toEqual([created]);
    expect(broadcasts).toEqual([]);
  });

  it('404s an unknown id', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/webviews/nope' })).statusCode).toBe(404);
  });

  it('preserves explicit admin edit and delete authority over foreign records', async () => {
    const previous = process.env.CODEMAN_MULTIUSER;
    process.env.CODEMAN_MULTIUSER = '1';
    const ownedApp = await createAuthenticatedApp({ username: 'alice', role: 'admin' });
    try {
      await writeWebviews(tmpDir, [ownedWebview('bob-view', 'bob')]);

      const updated = await ownedApp.inject({
        method: 'PATCH',
        url: '/api/webviews/bob-view',
        payload: { name: 'Admin corrected' },
      });
      const updateEvent = broadcasts.at(-1);
      const deleted = await ownedApp.inject({ method: 'DELETE', url: '/api/webviews/bob-view' });
      const deleteEvent = broadcasts.at(-1);

      expect(updated.statusCode).toBe(200);
      expect(updated.json().data.owner).toBe('bob');
      expect(deleted.statusCode).toBe(200);
      expect(updateEvent).toEqual({
        event: 'webview:changed',
        data: { action: 'updated', id: 'bob-view', owner: 'bob' },
      });
      expect(deleteEvent).toEqual({
        event: 'webview:changed',
        data: { action: 'deleted', id: 'bob-view', owner: 'bob' },
      });
    } finally {
      await ownedApp.close();
      if (previous === undefined) delete process.env.CODEMAN_MULTIUSER;
      else process.env.CODEMAN_MULTIUSER = previous;
    }
  });
});

describe('POST /api/webviews/:id/open', () => {
  it('mints a same-origin embed path for a proxied dashboard', async () => {
    const id = (await create({ name: 'G', url: 'http://127.0.0.1:4000/' })).json().data.id;
    const data = (await app.inject({ method: 'POST', url: `/api/webviews/${id}/open` })).json().data;
    expect(data.embedUrl).toMatch(/^\/webview\/[A-Za-z0-9_-]{16,}\/$/);
    expect(capabilityFromProxyPath(data.embedUrl)).toBeTruthy();
  });

  it('does not let an admin open a foreign-owner webview outside their layout', async () => {
    const previous = process.env.CODEMAN_MULTIUSER;
    process.env.CODEMAN_MULTIUSER = '1';
    const ownedApp = await createAuthenticatedApp({ username: 'alice', role: 'admin' });
    try {
      await writeWebviews(tmpDir, [ownedWebview('bob-view', 'bob')]);

      const response = await ownedApp.inject({ method: 'POST', url: '/api/webviews/bob-view/open' });

      expect(response.statusCode).toBe(403);
      expect(response.json().errorCode).toBe('FORBIDDEN');
    } finally {
      await ownedApp.close();
      if (previous === undefined) delete process.env.CODEMAN_MULTIUSER;
      else process.env.CODEMAN_MULTIUSER = previous;
    }
  });

  it('returns no embed path in direct mode, where the iframe uses the real URL', async () => {
    const id = (await create({ name: 'G', url: 'https://ok.example/', embedMode: 'direct' })).json().data.id;
    const data = (await app.inject({ method: 'POST', url: `/api/webviews/${id}/open` })).json().data;
    expect(data.embedUrl).toBeUndefined();
    expect(data.webview.url).toBe('https://ok.example/');
  });

  it('reuses the capability across repeated opens instead of leaking one per click', async () => {
    const id = (await create({ name: 'G', url: 'http://127.0.0.1:4000/' })).json().data.id;
    const first = (await app.inject({ method: 'POST', url: `/api/webviews/${id}/open` })).json().data.embedUrl;
    const second = (await app.inject({ method: 'POST', url: `/api/webviews/${id}/open` })).json().data.embedUrl;
    expect(second).toBe(first);
  });

  it('records lastOpenedAt', async () => {
    const id = (await create({ name: 'G', url: 'http://127.0.0.1:4000/' })).json().data.id;
    await app.inject({ method: 'POST', url: `/api/webviews/${id}/open` });
    const list = (await app.inject({ method: 'GET', url: '/api/webviews' })).json().data.webviews;
    expect(typeof list[0].lastOpenedAt).toBe('number');
  });

  it('404s an unknown id', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/webviews/nope/open' })).statusCode).toBe(404);
  });
});

describe('proxy route', () => {
  it('refuses an unknown or expired capability', async () => {
    const res = await app.inject({ method: 'GET', url: `/webview/${'Z'.repeat(32)}/` });
    expect(res.statusCode).toBe(403);
  });

  it('redirects the prefix without a trailing slash, so relative URLs resolve inside it', async () => {
    const cap = 'Y'.repeat(32);
    const res = await app.inject({ method: 'GET', url: `/webview/${cap}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/webview/${cap}/`);
  });
});

describe('POST /api/webviews/probe', () => {
  it('reports an unreachable target as a normal answer, not a 500', async () => {
    // Port 1 is reserved and refuses instantly.
    const res = await app.inject({
      method: 'POST',
      url: '/api/webviews/probe',
      payload: { url: 'http://127.0.0.1:1/' },
    });
    expect(res.statusCode).toBe(200);
    const probe = res.json().data;
    expect(probe.reachable).toBe(false);
    expect(probe.recommendedMode).toBe('proxy');
  });

  it('rejects an invalid URL up front', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/webviews/probe', payload: { url: 'file:///etc' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('egress policy: link-local and cloud-metadata targets', () => {
  it('refuses to SAVE a metadata address, in every spelling, with a message that says why', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://2852039166/', // decimal form of 169.254.169.254
      'http://[fd00:ec2::254]/',
      'http://metadata.google.internal/computeMetadata/v1/',
    ]) {
      const res = await create({ name: 'IMDS', url });
      expect(res.statusCode, url).toBe(400);
      expect(res.body, url).toMatch(/Blocked URL/);
    }
  });

  it('still saves the loopback dashboards the feature exists for', async () => {
    expect((await create({ name: 'Grafana', url: 'http://127.0.0.1:4000/' })).statusCode).toBe(200);
    expect((await create({ name: 'Local', url: 'http://localhost:3080/' })).statusCode).toBe(200);
  });

  it('the probe refuses the same targets up front, before any connection is attempted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/webviews/probe',
      payload: { url: 'http://169.254.169.254/' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/Blocked URL/);
  });

  it('the proxy refuses a record saved before the rule existed with a 403, never a relay', async () => {
    // Written straight to the store: the schema would refuse it today, which is
    // exactly why the proxy must judge the target again at connect time.
    await writeWebviews(tmpDir, [
      {
        id: 'legacy-imds',
        name: 'legacy',
        url: 'http://169.254.169.254/',
        embedMode: 'proxy',
        trusted: false,
        createdAt: Date.now(),
      },
    ]);
    const cap = webviewCapabilities.mint('legacy-imds', undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await app.inject({ method: 'GET', url: `/webview/${cap}/latest/meta-data/` });
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/link-local or cloud-metadata/);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused by egress policy'));
    } finally {
      warn.mockRestore();
      webviewCapabilities.revokeWebview('legacy-imds');
    }
  });
});
