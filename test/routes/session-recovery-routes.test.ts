import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSessionRecoveryRoutes } from '../../src/web/routes/session-recovery-routes.js';

describe('session recovery routes', () => {
  let harness: RouteTestHarness;
  const recovery = {
    id: 'recovery-1',
    sourceSessionId: 'dead-1',
    owner: 'alice',
    mode: 'codex' as const,
    workingDir: '/tmp/project',
    transport: 'remote' as const,
    nativeResumeId: 'rollout-1',
    status: 'reattachable' as const,
    launch: { kind: 'built-in' as const },
    createdAt: 1,
  };

  beforeEach(async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    harness = await createRouteTestHarness(registerSessionRecoveryRoutes, {
      authUser: { username: 'alice', role: 'user' },
    });
    const recoveries = [recovery, { ...recovery, id: 'recovery-bob', owner: 'bob' }];
    Object.assign(harness.ctx.store, {
      getSessionRecoveries: vi.fn(() => recoveries),
      upsertSessionRecovery: vi.fn(),
      removeSessionRecovery: vi.fn(),
    });
  });

  afterEach(async () => {
    await harness.app.close();
    delete process.env.CODEMAN_MULTIUSER;
  });

  it('lists only owned recoveries without probing or booting a session', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/session-recoveries' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ recoveries: [recovery] });
    expect(harness.ctx.addSession).not.toHaveBeenCalled();
    expect(harness.ctx.mux.createSession).not.toHaveBeenCalled();
  });

  it('rejects malformed recovery ids before any recovery work', async () => {
    const response = await harness.app.inject({ method: 'POST', url: '/api/session-recoveries/not valid/resume' });
    expect(response.statusCode).toBe(400);
    expect(harness.ctx.addSession).not.toHaveBeenCalled();
  });

  it('refuses resume for a discovered unowned remote session without launching', async () => {
    harness.ctx.store.getSessionRecoveries.mockReturnValue([
      { ...recovery, transport: 'remote', remote: undefined, status: 'reattachable' },
    ]);
    const response = await harness.app.inject({ method: 'POST', url: '/api/session-recoveries/recovery-1/resume' });
    expect(response.statusCode).toBe(409);
    expect(harness.ctx.addSession).not.toHaveBeenCalled();
  });

  it('refuses an unsafe custom recovery without launching a session', async () => {
    harness.ctx.store.getSessionRecoveries.mockReturnValue([
      { ...recovery, launch: { kind: 'manual_required', hint: 'manual only' } },
    ]);
    const response = await harness.app.inject({ method: 'POST', url: '/api/session-recoveries/recovery-1/resume' });
    expect(response.statusCode).toBe(409);
    expect(harness.ctx.addSession).not.toHaveBeenCalled();
  });
});
