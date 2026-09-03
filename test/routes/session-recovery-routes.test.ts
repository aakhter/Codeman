import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSessionRecoveryRoutes } from '../../src/web/routes/session-recovery-routes.js';
import { recoverySessionConfig } from '../../src/web/routes/session-recovery-routes.js';
import { createDeferred } from '../mocks/index.js';

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

  it('refuses a recovery that has already created a replacement session', async () => {
    harness.ctx.store.getSessionRecoveries.mockReturnValue([
      { ...recovery, status: 'recovered', recoveredSessionId: 'replacement-1' },
    ]);
    const response = await harness.app.inject({ method: 'POST', url: '/api/session-recoveries/recovery-1/resume' });
    expect(response.statusCode).toBe(409);
    expect(harness.ctx.addSession).not.toHaveBeenCalled();
  });

  it('claims a recovery before awaiting creation so concurrent resumes create only one session', async () => {
    const gate = createDeferred<void>();
    let records = [{ ...recovery, transport: 'local' as const }];
    harness.ctx.store.getSessionRecoveries.mockImplementation(() => records);
    harness.ctx.store.upsertSessionRecovery.mockImplementation((next) => {
      records = [next];
    });
    harness.ctx.mux.createSession.mockResolvedValue({
      sessionId: 'created',
      muxName: 'codeman-created',
      pid: 1,
      createdAt: Date.now(),
      workingDir: '/tmp/project',
      mode: 'codex',
      attached: false,
    });
    Object.assign(harness.ctx.mux, { setAttached: vi.fn() });
    harness.ctx.addSession.mockImplementationOnce(async () => gate.promise);

    const first = harness.app.inject({ method: 'POST', url: '/api/session-recoveries/recovery-1/resume' });
    await vi.waitFor(() => expect(harness.ctx.addSession).toHaveBeenCalledTimes(1));
    const second = await harness.app.inject({ method: 'POST', url: '/api/session-recoveries/recovery-1/resume' });
    expect(second.statusCode).toBe(409);
    expect(harness.ctx.addSession).toHaveBeenCalledTimes(1);
    gate.resolve();
    expect((await first).statusCode).toBe(200);
    expect(harness.ctx.store.upsertSessionRecovery).toHaveBeenCalledTimes(1);
    expect(records[0].recoveredSessionId).toBeTruthy();

    const sequential = await harness.app.inject({ method: 'POST', url: '/api/session-recoveries/recovery-1/resume' });
    expect(sequential.statusCode).toBe(409);
    expect(harness.ctx.addSession).toHaveBeenCalledTimes(1);
  });

  it('threads a Docker native resume id through the docker launch resume option', () => {
    expect(
      recoverySessionConfig({
        ...recovery,
        transport: 'docker',
        docker: { containerName: 'agent', image: 'agent:latest', containerWorkdir: '/workspace' },
      }).resumeSessionId
    ).toBe('rollout-1');
  });
});
