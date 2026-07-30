/**
 * COD-124 unit 2, Gap A — park() obligation interlock.
 *
 * Parking a session must neutralize any live automation armed against it
 * (respawn controller, auto-resume usage-limit timer, Ralph tracker) so it
 * never fires into a dead/detached pane. Since Session.park() itself has no
 * visibility into the WebServer-held respawn controller map, the route layer
 * is responsible for disarming it — mirroring the exact sequence used by
 * POST /respawn/stop.
 *
 * Contract:
 *  - If obligations exist (armed respawn controller / auto-resume timer /
 *    enabled ralph tracker) and the request body does not set `force: true`,
 *    the route returns 409 CONFLICT with an `obligations` array so the UI
 *    can show a confirmation dialog.
 *  - With `force: true` (or when there are no obligations), the route
 *    disarms the respawn controller (controller.stop(), removes it from
 *    ctx.respawnControllers, clears+deletes any ctx.respawnTimers entry,
 *    calls ctx.mux.clearRespawnConfig()) and proceeds to park() normally.
 *  - auto-resume and ralph teardown are already handled entirely inside
 *    Session.park() (via _clearAllTimers()/cleanupTrackerListeners()) — these
 *    tests document/confirm that pre-existing behavior via the MockSession
 *    surface rather than driving new production code for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { ApiErrorCode } from '../../src/types.js';

describe('POST /api/sessions/:id/park — obligation interlock (COD-124)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSessionRoutes);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 409 CONFLICT with obligations=["respawn"] when a respawn controller is armed, without force', async () => {
    const fakeController = { stop: vi.fn() };
    harness.ctx.respawnControllers.set(harness.ctx._sessionId, fakeController as never);

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/park`,
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe(ApiErrorCode.CONFLICT);
    expect(body.obligations).toEqual(['respawn']);

    // Must not have parked or disarmed anything yet.
    expect(harness.ctx._session.park).not.toHaveBeenCalled();
    expect(fakeController.stop).not.toHaveBeenCalled();
    expect(harness.ctx.respawnControllers.has(harness.ctx._sessionId)).toBe(true);
  });

  it('with force:true, disarms the respawn controller (mirrors /respawn/stop) and parks', async () => {
    const fakeController = { stop: vi.fn() };
    harness.ctx.respawnControllers.set(harness.ctx._sessionId, fakeController as never);
    const fakeTimer = setTimeout(() => {}, 100000);
    harness.ctx.respawnTimers.set(harness.ctx._sessionId, {
      timer: fakeTimer,
      endAt: Date.now(),
      startedAt: Date.now(),
    });

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/park`,
      payload: { force: true },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).not.toBe(false);

    expect(fakeController.stop).toHaveBeenCalledTimes(1);
    expect(harness.ctx.respawnControllers.has(harness.ctx._sessionId)).toBe(false);
    expect(harness.ctx.respawnTimers.has(harness.ctx._sessionId)).toBe(false);
    expect(harness.ctx.mux.clearRespawnConfig).toHaveBeenCalledWith(harness.ctx._sessionId);
    expect(harness.ctx._session.park).toHaveBeenCalledTimes(1);

    clearTimeout(fakeTimer);
  });

  it('parks normally (200, no obligations array) when nothing is armed', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/park`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).not.toBe(false);
    expect(body.obligations).toBeUndefined();
    expect(harness.ctx._session.park).toHaveBeenCalledTimes(1);
  });

  it('reports obligations=["autoResume"] when an auto-resume timer is armed (autoResumeAt set)', async () => {
    harness.ctx._session.autoResumeEnabled = true;
    harness.ctx._session.autoResumeAt = Date.now() + 60000;

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/park`,
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.obligations).toEqual(['autoResume']);
  });

  it('reports obligations=["ralph"] when the ralph tracker is enabled', async () => {
    harness.ctx._session.ralphTracker = { enabled: true } as never;

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/park`,
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.obligations).toEqual(['ralph']);
  });

  it('combines multiple obligations in a stable order', async () => {
    const fakeController = { stop: vi.fn() };
    harness.ctx.respawnControllers.set(harness.ctx._sessionId, fakeController as never);
    harness.ctx._session.autoResumeEnabled = true;
    harness.ctx._session.autoResumeAt = Date.now() + 60000;
    harness.ctx._session.ralphTracker = { enabled: true } as never;

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/park`,
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.obligations).toEqual(['respawn', 'autoResume', 'ralph']);
  });

  it('already-parked session short-circuits before obligations are even considered', async () => {
    harness.ctx._session.status = 'parked';
    const fakeController = { stop: vi.fn() };
    harness.ctx.respawnControllers.set(harness.ctx._sessionId, fakeController as never);

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/park`,
    });

    expect(res.statusCode).toBe(200);
    expect(harness.ctx._session.park).not.toHaveBeenCalled();
    // Idempotent short-circuit doesn't touch the (unrelated) armed controller.
    expect(fakeController.stop).not.toHaveBeenCalled();
  });
});
