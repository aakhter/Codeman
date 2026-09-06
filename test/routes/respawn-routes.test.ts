/**
 * @fileoverview Tests for respawn route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerRespawnRoutes } from '../../src/web/routes/respawn-routes.js';

describe('respawn-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerRespawnRoutes);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/sessions/:id/respawn ==========

  describe('GET /api/sessions/:id/respawn', () => {
    it('returns disabled status when no controller exists', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.enabled).toBe(false);
      expect(body.status).toBeNull();
    });

    it('returns status when controller exists', async () => {
      const mockController = {
        getStatus: vi.fn(() => ({
          state: 'watching',
          health: 100,
          cycleCount: 0,
        })),
        getConfig: vi.fn(() => ({})),
        start: vi.fn(),
        stop: vi.fn(),
        updateConfig: vi.fn(),
      };
      harness.ctx.respawnControllers.set(harness.ctx._sessionId, mockController as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.enabled).toBe(true);
      expect(body.state).toBe('watching');
    });
  });

  // ========== GET /api/sessions/:id/respawn/config ==========

  describe('GET /api/sessions/:id/respawn/config', () => {
    it('returns null config when no controller and no pre-saved config', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn/config`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Handler now returns a bare payload; the uniform envelope wraps it to
      // { success:true, data:{ config, active } } in production. At the route-handler
      // layer the harness sees the bare return, so config/active stay top-level.
      expect(body.config).toBeNull();
      expect(body.active).toBe(false);
    });

    it('returns active config when controller exists', async () => {
      const mockConfig = { idleTimeoutMs: 5000, enabled: true };
      const mockController = {
        getConfig: vi.fn(() => mockConfig),
        getStatus: vi.fn(() => ({})),
      };
      harness.ctx.respawnControllers.set(harness.ctx._sessionId, mockController as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn/config`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Handler returns a bare { config, active } payload (wrapped under data by the
      // uniform envelope in production); the harness sees the bare return.
      expect(body.active).toBe(true);
      expect(body.config.idleTimeoutMs).toBe(5000);
    });
  });

  // ========== POST /api/sessions/:id/respawn/stop ==========

  describe('POST /api/sessions/:id/respawn/stop', () => {
    it('returns error when no controller exists', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn/stop`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('stops existing controller and cleans up', async () => {
      const mockController = {
        stop: vi.fn(),
        getConfig: vi.fn(() => ({})),
        getStatus: vi.fn(() => ({})),
      };
      harness.ctx.respawnControllers.set(harness.ctx._sessionId, mockController as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn/stop`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Handler returns a bare {} on success; the uniform envelope wraps it to
      // { success:true, data:{} } in production. At the route-handler layer the
      // harness sees the bare return, so success is signalled by the 200 + empty
      // body plus the side effects asserted below.
      expect(body).toEqual({});
      expect(mockController.stop).toHaveBeenCalled();
      expect(harness.ctx.respawnControllers.has(harness.ctx._sessionId)).toBe(false);
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('respawn:stopped', {
        sessionId: harness.ctx._sessionId,
      });
    });
  });

  // ========== POST /api/sessions/:id/respawn/start ==========

  describe('POST /api/sessions/:id/respawn/start', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/respawn/start',
      });
      // findSessionOrFail throws with statusCode 404
      expect(res.statusCode).toBe(404);
    });

    it('rejects opencode sessions', async () => {
      harness.ctx._session.mode = 'opencode';
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn/start`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    /**
     * COD-416 / Q23. This gate used to name `opencode|codex|gemini|antigravity` — the external
     * set as it stood when antigravity was added (dda03c3a), never extended when pi, grok,
     * deepseek and omp arrived. Its own comment said "not supported for external CLI sessions",
     * so the LIST was the bug and `isExternalCliMode()` is what it meant.
     *
     * ⚠️ Deliberate behaviour change, approved on the ticket: four modes that were accepted
     * before are now refused. They were never actually supported — respawn drives Claude-shaped
     * `/clear` + re-prompt into a CLI that has no idea what that means.
     */
    it.each(['opencode', 'codex', 'gemini', 'antigravity', 'pi', 'grok', 'deepseek', 'omp'] as const)(
      'refuses respawn for external CLI mode %s',
      async (mode) => {
        harness.ctx._session.mode = mode;
        const res = await harness.app.inject({
          method: 'POST',
          url: `/api/sessions/${harness.ctx._sessionId}/respawn/start`,
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success, `${mode} must be refused`).toBe(false);
      }
    );

    /**
     * The other half, and the reason this is `!isExternalCliMode()` rather than
     * `capabilities.respawn`: shell is `respawn: false` in the registry but is NOT an external
     * CLI, and shell respawn works today. Gating on the capability would have silently killed
     * it — a regression dressed as a cleanup.
     */
    it.each(['claude', 'shell'] as const)('still allows respawn for non-external mode %s', async (mode) => {
      harness.ctx._session.mode = mode;
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn/start`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success, `${mode} must still be allowed`).not.toBe(false);
    });
  });

  // ========== PUT /api/sessions/:id/respawn/config ==========

  describe('PUT /api/sessions/:id/respawn/config', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/sessions/nonexistent/respawn/config',
        payload: { idleTimeoutMs: 5000 },
      });
      expect(res.statusCode).toBe(404);
    });

    it('rejects invalid config', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn/config`,
        payload: { idleTimeoutMs: 'not-a-number' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('updates running controller config', async () => {
      const mockController = {
        updateConfig: vi.fn(),
        getConfig: vi.fn(() => ({ idleTimeoutMs: 5000 })),
        getStatus: vi.fn(() => ({})),
      };
      harness.ctx.respawnControllers.set(harness.ctx._sessionId, mockController as never);

      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn/config`,
        payload: { idleTimeoutMs: 5000 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Handler returns a bare { config } payload (wrapped under data by the uniform
      // envelope in production); the harness sees the bare return.
      expect(body.config).toBeDefined();
      expect(mockController.updateConfig).toHaveBeenCalled();
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        'respawn:configUpdated',
        expect.objectContaining({ sessionId: harness.ctx._sessionId })
      );
    });

    it('saves pre-config when no controller running', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn/config`,
        payload: { idleTimeoutMs: 5000 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Handler returns a bare { config } payload (wrapped under data by the uniform
      // envelope in production); the harness sees the bare return.
      expect(body.config).toBeDefined();
      expect(harness.ctx.mux.updateRespawnConfig).toHaveBeenCalled();
    });
  });

  // ========== POST /api/sessions/:id/respawn/enable ==========

  describe('POST /api/sessions/:id/respawn/enable', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/respawn/enable',
      });
      // findSessionOrFail not used here — let's check the actual response
      expect(res.statusCode).toBe(404);
    });
  });
});
