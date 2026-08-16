/**
 * @fileoverview Tests for the read-only legacy PUT /api/session-order endpoint.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Asserts the uniform envelope contract:
 *   SUCCESS -> 2xx, { success: true, data: { order } }
 *   ERROR   -> 4xx/5xx, { success: false, error, errorCode }
 * Legacy callers are directed to the owner-scoped tab-layout endpoint without writes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';

// registerSessionRoutes pulls in session.js which can shell out; stub the bits
// that would touch the OS at import/registration time. None are needed by the
// session-order handler itself, but the module imports them.
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(), spawn: vi.fn() };
});

import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';

interface LocalHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

async function buildHarness(): Promise<LocalHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);

  const ctx = createMockRouteContext();
  registerSessionRoutes(app, ctx as unknown as Parameters<typeof registerSessionRoutes>[1]);

  // Mirror production's uniform-envelope preSerialization hook (server.ts).
  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });

  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx };
}

describe('PUT /api/session-order', () => {
  let harness: LocalHarness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('is read-only and directs legacy clients to the owner layout endpoint', async () => {
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/session-order',
      payload: { order: ['a', 'b', 'c'] },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body).toEqual({
      success: false,
      error: 'Session order is read-only; migrate to /api/tab-layout',
      errorCode: ApiErrorCode.OPERATION_FAILED,
    });
    expect(harness.ctx.store.setSessionOrder).not.toHaveBeenCalled();
    expect(harness.ctx.broadcast).not.toHaveBeenCalled();
  });

  it('does not revive the legacy writer for malformed bodies', async () => {
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/session-order',
      payload: { order: 'nope' },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(harness.ctx.store.setSessionOrder).not.toHaveBeenCalled();
  });
});
