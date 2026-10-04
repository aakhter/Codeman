import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSessionRecoveryRoutes } from '../../src/web/routes/session-recovery-routes.js';
import { recoverySessionConfig } from '../../src/web/routes/session-recovery-routes.js';
import { recoveryCleanupKillsMux } from '../../src/web/routes/session-recovery-routes.js';
import { createDeferred } from '../mocks/index.js';

describe('session recovery routes', () => {
  let harness: RouteTestHarness;
  const recovery = {
    id: 'recovery-1',
    sourceSessionId: 'dead-1',
    owner: 'alice',
    mode: 'codex' as const,
    workingDir: '/tmp',
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

  it('enforces ownership for read-only previews and never launches or updates a recovery', async () => {
    const denied = await harness.app.inject({ method: 'GET', url: '/api/session-recoveries/recovery-bob/preview' });
    expect(denied.statusCode).toBe(404);
    const response = await harness.app.inject({ method: 'GET', url: '/api/session-recoveries/recovery-1/preview' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ available: false });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(harness.ctx.addSession).not.toHaveBeenCalled();
    expect(harness.ctx.store.upsertSessionRecovery).not.toHaveBeenCalled();
  });

  it('refreshes an unavailable local Codex record from its exact on-disk identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-recovery-refresh-'));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    try {
      const dir = join(root, 'sessions', '2026', '10', '03');
      mkdirSync(dir, { recursive: true });
      const id = '01a0c810-a5c4-7b32-be0b-1599d9d5995d';
      writeFileSync(
        join(dir, 'rollout-refresh.jsonl'),
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id,
            cwd: '/tmp',
            originator: 'codeman_dead-1',
            source: 'cli',
          },
        }) + '\n'
      );
      harness.ctx.store.getSessionRecoveries.mockReturnValue([
        { ...recovery, transport: 'local', nativeResumeId: undefined, status: 'unavailable' },
      ]);
      const response = await harness.app.inject({ method: 'POST', url: '/api/session-recoveries/recovery-1/refresh' });
      expect(response.statusCode).toBe(200);
      expect(response.json().recovery).toMatchObject({ status: 'resumable', nativeResumeId: id });
      expect(harness.ctx.addSession).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refreshes a local Claude recovery using its exact transcript ID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-recovery-refresh-'));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;
    const id = '01a0c810-a5c4-7b32-be0b-1599d9d5995d';
    try {
      const dir = join(root, 'projects', '-tmp');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${id}.jsonl`),
        JSON.stringify({ type: 'user', sessionId: id, cwd: '/tmp', message: { content: 'work' } }) + '\n'
      );
      harness.ctx.store.getSessionRecoveries.mockReturnValue([
        {
          ...recovery,
          sourceSessionId: id,
          mode: 'claude',
          transport: 'local',
          nativeResumeId: undefined,
          status: 'unavailable',
        },
      ]);
      const response = await harness.app.inject({ method: 'POST', url: '/api/session-recoveries/recovery-1/refresh' });
      expect(response.statusCode).toBe(200);
      expect(response.json().recovery).toMatchObject({ status: 'resumable', claudeResumeId: id });
      expect(harness.ctx.addSession).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['codex', 'claude'] as const)(
    'downgrades a stale persisted %s ID on Refresh without losing original identity',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'stale-recovery-'));
      const envKey = mode === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
      const previous = process.env[envKey];
      process.env[envKey] = root;
      const id = '01a0c810-a5c4-7b32-be0b-1599d9d5995d';
      try {
        const identity = mode === 'codex' ? { nativeResumeId: id } : { nativeResumeId: undefined, claudeResumeId: id };
        harness.ctx.store.getSessionRecoveries.mockReturnValue([
          { ...recovery, mode, transport: 'local', status: 'resumable', ...identity },
        ]);
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/session-recoveries/recovery-1/refresh',
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().recovery).toMatchObject({
          status: 'unavailable',
          ...(mode === 'codex' ? { nativeResumeId: id } : { claudeResumeId: id }),
          lastCheckedAt: expect.any(Number),
        });
        expect(harness.ctx.addSession).not.toHaveBeenCalled();
      } finally {
        if (previous === undefined) delete process.env[envKey];
        else process.env[envKey] = previous;
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('refuses to resume into a missing local working directory', async () => {
    harness.ctx.store.getSessionRecoveries.mockReturnValue([
      { ...recovery, transport: 'local', status: 'resumable', workingDir: '/cod468-missing-directory' },
    ]);
    const response = await harness.app.inject({ method: 'POST', url: '/api/session-recoveries/recovery-1/resume' });
    expect(response.statusCode).toBe(409);
    expect(harness.ctx.addSession).not.toHaveBeenCalled();
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
    let records = [{ ...recovery, transport: 'local' as const, status: 'resumable' as const }];
    harness.ctx.store.getSessionRecoveries.mockImplementation(() => records);
    harness.ctx.store.upsertSessionRecovery.mockImplementation((next) => {
      records = [next];
    });
    harness.ctx.mux.createSession.mockResolvedValue({
      sessionId: 'created',
      muxName: 'codeman-created',
      pid: 1,
      createdAt: Date.now(),
      workingDir: '/tmp',
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
    expect(records[0]).toMatchObject({ restoreEvidence: 'launch_returned' });

    const sequential = await harness.app.inject({ method: 'POST', url: '/api/session-recoveries/recovery-1/resume' });
    expect(sequential.statusCode).toBe(409);
    expect(harness.ctx.addSession).toHaveBeenCalledTimes(1);
  });

  it('threads a Docker native resume id through the docker launch resume option', () => {
    expect(
      recoverySessionConfig(
        {
          ...recovery,
          transport: 'docker',
          docker: { containerName: 'agent', image: 'agent:latest', containerWorkdir: '/workspace' },
        },
        undefined,
        {
          docker: {
            hostId: 'docker-1',
            label: 'Docker',
            engine: 'docker',
            image: 'agent:latest',
            containerName: 'agent',
            hostWorkspacePath: '/tmp',
            containerWorkdir: '/workspace',
            network: 'bridge',
            mountCredentials: false,
            hooksEnabled: true,
            resumeOnStart: true,
          },
        }
      ).resumeSessionId
    ).toBe('rollout-1');
  });

  it('reconnects an owned live remote by attaching its source remote tmux target', () => {
    expect(
      recoverySessionConfig(
        { ...recovery, transport: 'remote', remote: { hostId: 'remote-1', owned: true } },
        'reconnect',
        {
          remote: {
            hostId: 'remote-1',
            label: 'Remote',
            host: 'example.test',
            username: 'alice',
            remotePath: '/tmp',
            owned: true,
          },
        }
      ).remote
    ).toMatchObject({ owned: true, remoteSessionName: 'codeman-ssh-dead-1' });
  });

  it('reconnects a live owned source through its source target instead of treating it as unavailable', async () => {
    const remote = {
      hostId: 'remote-1',
      label: 'Remote',
      host: 'example.test',
      username: 'alice',
      remotePath: '/tmp',
      owned: true,
    };
    harness.ctx.store.getSessionRecoveries.mockReturnValue([
      { ...recovery, remote: { hostId: 'remote-1', owned: true } },
    ]);
    Object.assign(harness.ctx, {
      resolveRecoveryTransport: vi.fn(async () => ({ remote })),
      probeRecoveryTarget: vi.fn(async () => true),
      setAttached: vi.fn(),
    });
    harness.ctx.mux.createSession.mockImplementation(async (options) => ({
      sessionId: options.sessionId,
      muxName: `codeman-${options.sessionId}`,
      pid: 1,
      createdAt: Date.now(),
      workingDir: options.workingDir,
      mode: options.mode,
      attached: false,
      remote: options.remote,
    }));

    const response = await harness.app.inject({ method: 'POST', url: '/api/session-recoveries/recovery-1/reconnect' });

    expect(response.statusCode).toBe(200);
    expect(harness.ctx.probeRecoveryTarget).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSessionId: 'dead-1' }),
      remote
    );
    expect(harness.ctx.mux.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        remote: expect.objectContaining({ owned: true, remoteSessionName: 'codeman-ssh-dead-1' }),
      })
    );
  });

  it('reconnects a live owned source without executing its opaque custom launcher', async () => {
    const remote = {
      hostId: 'remote-1',
      label: 'Remote',
      host: 'example.test',
      username: 'alice',
      remotePath: '/tmp',
      owned: true,
    };
    harness.ctx.store.getSessionRecoveries.mockReturnValue([
      {
        ...recovery,
        remote: { hostId: 'remote-1', owned: true },
        status: 'manual_required',
        launch: { kind: 'manual_required', hint: 'manual only' },
      },
    ]);
    Object.assign(harness.ctx, {
      resolveRecoveryTransport: vi.fn(async () => ({ remote })),
      probeRecoveryTarget: vi.fn(async () => true),
    });
    harness.ctx.mux.createSession.mockImplementation(async (options) => ({
      sessionId: options.sessionId,
      muxName: `codeman-${options.sessionId}`,
      pid: 1,
      createdAt: Date.now(),
      workingDir: options.workingDir,
      mode: options.mode,
      attached: false,
      remote: options.remote,
    }));

    const response = await harness.app.inject({ method: 'POST', url: '/api/session-recoveries/recovery-1/reconnect' });

    expect(response.statusCode).toBe(200);
    expect(harness.ctx.mux.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        remote: expect.objectContaining({ remoteSessionName: 'codeman-ssh-dead-1' }),
      })
    );
  });

  it('does not mutate or launch unavailable and recovered recovery records', async () => {
    for (const record of [
      { ...recovery, status: 'unavailable' as const },
      { ...recovery, status: 'recovered' as const, recoveredSessionId: 'replacement-1' },
    ]) {
      harness.ctx.store.getSessionRecoveries.mockReturnValue([record]);
      const response = await harness.app.inject({ method: 'POST', url: '/api/session-recoveries/recovery-1/refresh' });
      expect(response.statusCode).toBe(409);
      expect(harness.ctx.store.upsertSessionRecovery).not.toHaveBeenCalled();
    }
  });

  it('lets dismiss cancel an in-progress recovery before it can persist a recovered session id', async () => {
    const gate = createDeferred<void>();
    harness.ctx.store.getSessionRecoveries.mockReturnValue([{ ...recovery, transport: 'local', status: 'resumable' }]);
    harness.ctx.addSession.mockImplementationOnce(async () => gate.promise);
    const pending = harness.app.inject({ method: 'POST', url: '/api/session-recoveries/recovery-1/resume' });
    await vi.waitFor(() => expect(harness.ctx.addSession).toHaveBeenCalledTimes(1));
    expect(
      (await harness.app.inject({ method: 'POST', url: '/api/session-recoveries/recovery-1/dismiss' })).statusCode
    ).toBe(200);
    gate.resolve();
    await pending;
    expect(harness.ctx.store.upsertSessionRecovery).not.toHaveBeenCalled();
  });

  it('detaches a dismissed in-flight remote reconnect without killing its source tmux session', () => {
    expect(recoveryCleanupKillsMux({ ...recovery, transport: 'remote' }, 'reconnect')).toBe(false);
    expect(recoveryCleanupKillsMux({ ...recovery, transport: 'remote', status: 'resumable' }, 'resume')).toBe(true);
    expect(recoveryCleanupKillsMux({ ...recovery, transport: 'docker', status: 'resumable' }, 'resume')).toBe(true);
  });

  it('does not resurrect a dismissed recovery when its held refresh probe resolves', async () => {
    const gate = createDeferred<boolean>();
    harness.ctx.store.getSessionRecoveries.mockReturnValue([
      { ...recovery, id: 'recovery-refresh', remote: { hostId: 'r1', owned: true } },
    ]);
    Object.assign(harness.ctx, {
      resolveRecoveryTransport: vi.fn(async () => ({
        remote: { hostId: 'r1', label: 'R', host: 'h', username: 'u', remotePath: '/tmp', owned: true },
      })),
      probeRecoveryTarget: vi.fn(async () => gate.promise),
    });
    const refresh = harness.app.inject({ method: 'POST', url: '/api/session-recoveries/recovery-refresh/refresh' });
    await vi.waitFor(() => expect(harness.ctx.probeRecoveryTarget).toHaveBeenCalled());
    await harness.app.inject({ method: 'POST', url: '/api/session-recoveries/recovery-refresh/dismiss' });
    gate.resolve(true);
    expect((await refresh).statusCode).toBe(409);
    expect(harness.ctx.store.upsertSessionRecovery).not.toHaveBeenCalled();
  });

  it('uses dedicated wrapper cleanup for a dismissed owned remote reconnect', async () => {
    const gate = createDeferred<void>();
    harness.ctx.store.getSessionRecoveries.mockReturnValue([
      { ...recovery, id: 'recovery-reconnect', remote: { hostId: 'r1', owned: true } },
    ]);
    Object.assign(harness.ctx, {
      resolveRecoveryTransport: vi.fn(async () => ({
        remote: { hostId: 'r1', label: 'R', host: 'h', username: 'u', remotePath: '/tmp', owned: true },
      })),
      probeRecoveryTarget: vi.fn(async () => true),
      cleanupRecoveryReconnectWrapper: vi.fn(async () => {}),
    });
    harness.ctx.addSession.mockImplementationOnce(async () => gate.promise);
    const reconnect = harness.app.inject({
      method: 'POST',
      url: '/api/session-recoveries/recovery-reconnect/reconnect',
    });
    await vi.waitFor(() => expect(harness.ctx.addSession).toHaveBeenCalledTimes(1));
    await harness.app.inject({ method: 'POST', url: '/api/session-recoveries/recovery-reconnect/dismiss' });
    gate.resolve();
    expect((await reconnect).statusCode).toBe(409);
    expect(harness.ctx.cleanupRecoveryReconnectWrapper).toHaveBeenCalledTimes(1);
    expect(harness.ctx.cleanupSession).not.toHaveBeenCalled();
  });
});
