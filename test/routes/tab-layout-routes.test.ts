/**
 * @fileoverview Owner-scoped tab-layout HTTP concurrency and validation contract.
 */
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabLayoutService } from '../../src/tab-layout-service.js';
import { registerTabLayoutRoutes } from '../../src/web/routes/tab-layout-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import type { TabLayout } from '../../src/tab-layout.js';

const layout = (version = 3): TabLayout => ({
  version,
  groups: [],
  ungrouped: [{ kind: 'session', id: 'mine' }],
  updatedAt: '2026-08-16T00:00:00.000Z',
});

async function harness(username?: string, role: 'admin' | 'user' = 'user') {
  const app = Fastify({ logger: false });
  if (username) {
    app.addHook('onRequest', async (req) => {
      (req as unknown as { authUser: { username: string; role: 'admin' | 'user' } }).authUser = { username, role };
    });
  }
  const service = {
    getSnapshot: vi.fn(async () => ({ layout: layout(), placements: [] })),
    put: vi.fn(async (_owner: string, desired: unknown, baseVersion: number) => ({
      status: 'updated' as const,
      layout: { ...(desired as TabLayout), version: baseVersion + 1 },
    })),
    putOperations: vi.fn(async (_owner: string, _operations: unknown[], baseVersion: number) => ({
      status: 'updated' as const,
      layout: layout(baseVersion + 1),
      placements: [],
    })),
  };
  registerTabLayoutRoutes(app, { tabLayouts: service } as never);
  installRouteErrorHandler(app);
  await app.ready();
  return { app, service };
}

afterEach(() => vi.unstubAllEnvs());

describe('tab layout routes', () => {
  it('maps single-user requests to @single and never accepts an owner override', async () => {
    vi.stubEnv('CODEMAN_MULTIUSER', '0');
    const { app, service } = await harness();
    const response = await app.inject({ method: 'GET', url: '/api/tab-layout?owner=foreign' });
    expect(response.statusCode).toBe(200);
    expect(service.getSnapshot).toHaveBeenCalledWith('@single');
    await app.close();
  });

  it('uses the authenticated username in multi-user mode, including for admins', async () => {
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    const { app, service } = await harness('admin-a', 'admin');
    await app.inject({ method: 'GET', url: '/api/tab-layout?owner=someone-else' });
    expect(service.getSnapshot).toHaveBeenCalledWith('admin-a');
    await app.close();
  });

  it.each([2, 4])('returns 409 with the current layout when baseVersion=%s', async (baseVersion) => {
    const { app, service } = await harness();
    service.put.mockResolvedValueOnce({ status: 'conflict', layout: layout(3) });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/tab-layout',
      payload: { baseVersion, layout: layout(baseVersion) },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().data.layout).toEqual(layout(3));
    await app.close();
  });

  it('rejects malformed writes before invoking the service', async () => {
    const { app, service } = await harness();
    const response = await app.inject({ method: 'PUT', url: '/api/tab-layout', payload: { baseVersion: -1 } });
    expect(response.statusCode).toBe(400);
    expect(service.put).not.toHaveBeenCalled();
    await app.close();
  });

  it('routes semantic operation batches by authenticated owner and rejects ambiguous payloads', async () => {
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    const { app, service } = await harness('alice');
    const operations = [{ type: 'followParent', ref: { kind: 'session', id: 'child' } }];
    const response = await app.inject({
      method: 'PUT',
      url: '/api/tab-layout',
      payload: { baseVersion: 3, operations },
    });
    expect(response.statusCode).toBe(200);
    expect(service.putOperations).toHaveBeenCalledWith('alice', operations, 3);

    const ambiguous = await app.inject({
      method: 'PUT',
      url: '/api/tab-layout',
      payload: { baseVersion: 3, operations, layout: layout() },
    });
    expect(ambiguous.statusCode).toBe(400);
    await app.close();
  });

  it('forwards a recovery base and returns the authoritative applied-prefix count on conflict', async () => {
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    const { app, service } = await harness('alice');
    const operations = [
      { type: 'createGroup', id: 'new', name: 'New' },
      { type: 'followParent', ref: { kind: 'session', id: 'child' } },
      { type: 'renameGroup', groupId: 'new', name: 'Recovered' },
    ];
    service.putOperations.mockResolvedValueOnce({
      status: 'conflict',
      layout: layout(8),
      placements: [],
      appliedOperationCount: 2,
    });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/tab-layout',
      payload: { baseVersion: 3, operations, recoveryBaseLayout: layout(3) },
    });

    expect(response.statusCode).toBe(409);
    expect(service.putOperations).toHaveBeenCalledWith('alice', operations, 3, layout(3));
    expect(response.json().data.appliedOperationCount).toBe(2);
    await app.close();
  });

  it('returns 409 through the real service when a stale Follow parent is now dangling', async () => {
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    const current: TabLayout = {
      ...layout(8),
      ungrouped: [{ kind: 'session', id: 'child', placement: 'manual' }],
    };
    const recoveryBase: TabLayout = {
      ...layout(7),
      groups: [{ id: 'g', name: 'Work', refs: [{ kind: 'session', id: 'parent' }] }],
      ungrouped: [{ kind: 'session', id: 'child', placement: 'manual' }],
    };
    const layouts: Record<string, TabLayout> = { alice: current };
    const service = new TabLayoutService({
      store: {
        getTabLayout: (owner: string) => layouts[owner] ?? null,
        setTabLayout: (owner: string, next: TabLayout) => {
          layouts[owner] = next;
        },
        getSessions: () => ({
          child: { id: 'child', owner: 'alice', createdAt: 1, parentSessionId: 'missing' },
        }),
        getSessionOrder: () => ['child'],
      } as never,
      sessions: new Map(),
      readWebviews: async () => [],
      broadcast: vi.fn(),
      now: () => '2026-08-16T12:00:00.000Z',
    });
    const app = Fastify({ logger: false });
    app.addHook('onRequest', async (request) => {
      (request as unknown as { authUser: { username: string; role: 'user' } }).authUser = {
        username: 'alice',
        role: 'user',
      };
    });
    registerTabLayoutRoutes(app, { tabLayouts: service });
    installRouteErrorHandler(app);
    await app.ready();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/tab-layout',
      payload: {
        baseVersion: 7,
        operations: [{ type: 'followParent', ref: { kind: 'session', id: 'child' } }],
        recoveryBaseLayout: recoveryBase,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().data.layout).toEqual(current);
    expect(response.json().data.appliedOperationCount).toBeUndefined();

    for (const staleVersion of [7, 9]) {
      const malformedRecovery = await app.inject({
        method: 'PUT',
        url: '/api/tab-layout',
        payload: {
          baseVersion: staleVersion,
          operations: [{ type: 'followParent', ref: { kind: 'session', id: 'child' } }],
          recoveryBaseLayout: { version: staleVersion },
        },
      });
      expect(malformedRecovery.statusCode).toBe(409);
      expect(malformedRecovery.json().data.layout).toEqual(current);
    }
    const matchingMalformedRecovery = await app.inject({
      method: 'PUT',
      url: '/api/tab-layout',
      payload: {
        baseVersion: 8,
        operations: [{ type: 'followParent', ref: { kind: 'session', id: 'child' } }],
        recoveryBaseLayout: { version: 8 },
      },
    });
    expect(matchingMalformedRecovery.statusCode).toBe(400);

    const malformedOperations = [
      { type: 'unknown' },
      { type: 'followParent', ref: null },
      { type: 'followParent', ref: { kind: 'invalid', id: 'child' } },
      { type: 'followParent', ref: { kind: 'session', id: '' } },
      { type: 'followParent', ref: { kind: 'webview', id: 'child' } },
      { type: 'createGroup', id: '', name: 'New' },
      { type: 'createGroup', id: 'new', name: ' ' },
      { type: 'createGroup', id: 'new', name: 'x'.repeat(61) },
      { type: 'createGroup', id: 'new', name: 'New', index: -1 },
      { type: 'createGroup', id: 'new', name: 'New', index: 999 },
      { type: 'renameGroup', groupId: '', name: 'Renamed' },
      { type: 'deleteGroup', groupId: null },
      { type: 'reorderGroup', groupId: 'g', index: 1.5 },
      {
        type: 'moveRef',
        ref: { kind: 'session', id: 'child' },
        groupId: 4,
        index: 0,
      },
      {
        type: 'moveRef',
        ref: { kind: 'session', id: 'child' },
        groupId: null,
        index: -1,
      },
      {
        type: 'moveRef',
        ref: { kind: 'session', id: 'child' },
        groupId: null,
        index: 999,
      },
      { type: 'setManualPlacement', ref: { kind: 'session', id: 'child' }, manual: false },
    ];
    for (const operation of malformedOperations) {
      for (const staleVersion of [7, 9]) {
        const staleMalformedOperation = await app.inject({
          method: 'PUT',
          url: '/api/tab-layout',
          payload: { baseVersion: staleVersion, operations: [operation], recoveryBaseLayout: recoveryBase },
        });
        expect(staleMalformedOperation.statusCode, JSON.stringify(operation)).toBe(409);
        expect(staleMalformedOperation.json().data.layout).toEqual(current);
      }
      const matchingMalformedOperation = await app.inject({
        method: 'PUT',
        url: '/api/tab-layout',
        payload: { baseVersion: 8, operations: [operation], recoveryBaseLayout: recoveryBase },
      });
      expect(matchingMalformedOperation.statusCode, JSON.stringify(operation)).toBe(400);
    }
    for (const malformedBatch of [null, {}, []]) {
      for (const staleVersion of [7, 9]) {
        const staleMalformedBatch = await app.inject({
          method: 'PUT',
          url: '/api/tab-layout',
          payload: { baseVersion: staleVersion, operations: malformedBatch },
        });
        expect(staleMalformedBatch.statusCode, JSON.stringify(malformedBatch)).toBe(409);
        expect(staleMalformedBatch.json().data.layout).toEqual(current);
      }
      const matchingMalformedBatch = await app.inject({
        method: 'PUT',
        url: '/api/tab-layout',
        payload: { baseVersion: 8, operations: malformedBatch },
      });
      expect(matchingMalformedBatch.statusCode, JSON.stringify(malformedBatch)).toBe(400);
    }
    await app.close();
  });

  it('has an explicit conservative body limit', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/tab-layout',
      payload: { baseVersion: 3, layout: layout(), padding: 'x'.repeat(140 * 1024) },
    });
    expect(response.statusCode).toBe(413);
    await app.close();
  });
});
