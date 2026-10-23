import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as remoteHosts from '../src/remote-hosts.js';
import { TmuxManager, buildRemoteLaunchCommand } from '../src/tmux-manager.js';
import { createWorkerRecoveryRecord, workerResumeOptions } from '../src/remote-worker-recovery.js';
import type { MuxSession, RespawnPaneOptions } from '../src/mux-interface.js';
import { Session } from '../src/session.js';
import { WebServer } from '../src/web/server.js';
import type { SessionState } from '../src/types/session.js';
import type { SessionRecoveryRecord } from '../src/types/session-recovery.js';

const OLD = '11111111-1111-4111-8111-111111111111';
const NEW = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const remote = {
  hostId: 'worker',
  host: 'worker',
  label: 'worker',
  username: 'dev',
  remotePath: '/project',
  owned: true,
};
const options: RespawnPaneOptions = { sessionId: ID, workingDir: '/project', mode: 'claude', remote };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => vi.restoreAllMocks());

function setup(saved: Partial<MuxSession> = {}) {
  const manager = new TmuxManager();
  const session: MuxSession = {
    sessionId: ID,
    muxName: `codeman-${ID.slice(0, 8)}`,
    pid: 42,
    createdAt: 1,
    workingDir: '/project',
    mode: 'claude',
    attached: true,
    remote,
    ...saved,
  };
  manager.registerSession(session);
  const dead = vi.spyOn(manager, 'isPaneDead').mockResolvedValue(false);
  vi.spyOn(manager, 'getPaneExit').mockReturnValue({ status: 255, at: 1 });
  const probe = vi.spyOn(remoteHosts, 'probeRemoteWorker');
  const dropped: Array<{ sessionId: string; attempt: number; workerReboot?: boolean }> = [];
  manager.on('remoteSessionDropped', (event) => dropped.push(event));
  return { manager, session, dead, probe, dropped };
}

describe('worker reboot recovery', () => {
  it('learns a baseline from a running remote agent, survives an outage, resumes on a new boot, and commits the new boot after success', async () => {
    const { manager, session, dead, probe, dropped } = setup();
    probe.mockResolvedValue({ bootId: OLD, alive: true, agentRunning: true });
    await manager.runRemoteReconnectTick(0, true, true);
    await flush();
    expect(session.remoteBootId).toBe(OLD);
    expect(dropped).toEqual([]);
    dead.mockResolvedValue(true);
    probe.mockResolvedValue(undefined);
    await manager.runRemoteReconnectTick(30_000, true, true);
    await flush();
    await manager.runRemoteReconnectTick(35_000, true, true);
    expect(dropped).toEqual([]);
    probe.mockResolvedValue({ bootId: NEW, alive: false });
    await manager.runRemoteReconnectTick(60_000, true, true);
    await flush();
    await manager.runRemoteReconnectTick(65_000, true, true);
    expect(dropped).toEqual([{ sessionId: ID, attempt: 1, workerReboot: true }]);
    expect(session.remoteBootId).toBe(OLD);
    await manager.runRemoteReconnectTick(70_000, true, true);
    expect(dropped).toHaveLength(1); // no overlapping resume
    manager.noteRemoteReconnect(ID, true);
    expect(session.remoteBootId).toBe(NEW);
    manager.destroy();
  });

  it('refreshes a missing-session answer and never resurrects a session already gone in the old boot', async () => {
    const { manager, session, dead, probe, dropped } = setup({ remoteBootId: OLD });
    dead.mockResolvedValue(true);
    probe.mockResolvedValue({ bootId: OLD, alive: false });
    await manager.runRemoteReconnectTick(0, true, true);
    await flush();
    expect(session.remoteRecoverySuppressed).toBe(true);
    probe.mockResolvedValue({ bootId: NEW, alive: false });
    await manager.runRemoteReconnectTick(30_000, true, true);
    await flush();
    await manager.runRemoteReconnectTick(35_000, true, true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(dropped).toEqual([]);
    manager.destroy();
  });

  it.each([
    { remoteBootId: undefined },
    { remoteRecoverySuppressed: true },
    { remote: { ...remote, owned: false } },
    { remote: { ...remote, remoteSessionName: 'discovered' } },
    { discovered: true },
  ])('fails closed with unsafe or missing metadata: %j', async (metadata) => {
    const { manager, dead, probe, dropped } = setup({ remoteBootId: OLD, ...metadata });
    dead.mockResolvedValue(true);
    probe.mockResolvedValue({ bootId: NEW, alive: false });
    await manager.runRemoteReconnectTick(0, true, true);
    await flush();
    await manager.runRemoteReconnectTick(5_000, true, true);
    expect(dropped).toEqual([]);
    manager.destroy();
  });

  it('does not infer a reboot from an unreachable worker or an unparseable boot identity', async () => {
    const { manager, dead, probe, dropped } = setup({ remoteBootId: OLD });
    dead.mockResolvedValue(true);
    probe.mockResolvedValue(undefined);
    await manager.runRemoteReconnectTick(0, true, true);
    await flush();
    probe.mockResolvedValue({ alive: false });
    await manager.runRemoteReconnectTick(30_000, true, true);
    await flush();
    await manager.runRemoteReconnectTick(35_000, true, true);
    expect(dropped).toEqual([]);
    manager.destroy();
  });

  it.each([0, 1])('does not resume a wrapper that exited with status %s', async (status) => {
    const { manager, dead, probe, dropped } = setup({ remoteBootId: OLD });
    dead.mockResolvedValue(true);
    vi.spyOn(manager, 'getPaneExit').mockReturnValue({ status, at: 1 });
    probe.mockResolvedValue({ bootId: NEW, alive: false });
    await manager.runRemoteReconnectTick(0, true, true);
    await flush();
    await manager.runRemoteReconnectTick(5_000, true, true);
    expect(dropped).toEqual([]);
    manager.destroy();
  });

  it('honors disabled reboot recovery and reconnect settings', async () => {
    const { manager, dead, probe, dropped } = setup({ remoteBootId: OLD });
    dead.mockResolvedValue(true);
    probe.mockResolvedValue({ bootId: NEW, alive: false });
    await manager.runRemoteReconnectTick(0, false, true);
    expect(probe).not.toHaveBeenCalled();
    await manager.runRemoteReconnectTick(30_000, true, false);
    await flush();
    await manager.runRemoteReconnectTick(35_000, true, false);
    expect(dropped).toEqual([]);
    manager.destroy();
  });

  it('discards a probe that finishes after intentional teardown', async () => {
    const { manager, dead, probe, dropped, session } = setup({ remoteBootId: OLD });
    dead.mockResolvedValue(true);
    let resolve!: (value: remoteHosts.RemoteWorkerObservation) => void;
    probe.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    await manager.runRemoteReconnectTick(0, true, true);
    manager.guardRemoteReconnect(ID);
    resolve({ bootId: NEW, alive: false });
    await flush();
    await manager.runRemoteReconnectTick(5_000, true, true);
    expect(dropped).toEqual([]);
    expect(session.remoteBootId).toBe(OLD);
    manager.destroy();
  });

  it('keeps a failed resume eligible with bounded retries, without adopting the new boot prematurely', async () => {
    const { manager, session, dead, probe, dropped } = setup({ remoteBootId: OLD });
    dead.mockResolvedValue(true);
    probe.mockResolvedValue({ bootId: NEW, alive: false });
    const exhausted: unknown[] = [];
    manager.on('remoteReconnectExhausted', (event) => exhausted.push(event));
    for (let n = 0; n < 10; n++) {
      await manager.runRemoteReconnectTick(n * 600_000, true, true);
      await flush();
      await manager.runRemoteReconnectTick(n * 600_000 + 5_000, true, true);
      manager.noteRemoteReconnect(ID, false);
    }
    expect(dropped).toHaveLength(6);
    expect(exhausted).toHaveLength(1);
    expect(session.remoteBootId).toBe(OLD);
    manager.destroy();
  });

  it('does not arm automatic resume for an already-exited retained remote pane', async () => {
    const { manager, session, probe } = setup();
    probe.mockResolvedValue({ bootId: OLD, alive: true, agentRunning: false });
    await manager.runRemoteReconnectTick(0, true, true);
    await flush();
    expect(session.remoteBootId).toBeUndefined();
    expect(session.remoteRecoverySuppressed).toBe(true);
    manager.destroy();
  });
});

describe('exact worker conversation resume', () => {
  it('renders Claude resume with no fresh-conversation fallback', () => {
    const pinned = workerResumeOptions(options, null)!;
    const command = buildRemoteLaunchCommand({ ...pinned, remote });
    expect(command).toContain(`--resume ${ID}`);
    expect(command).not.toContain('--session-id');
    expect(command).not.toContain(' || claude');
  });
  it('renders exact Codex and OpenCode resume and rejects strict launches without an identity', () => {
    const codex = workerResumeOptions({ ...options, mode: 'codex' }, OLD)!;
    const openCode = workerResumeOptions({ ...options, mode: 'opencode' }, 'ses_abc123')!;
    expect(buildRemoteLaunchCommand({ ...codex, remote })).toContain(`resume ${OLD}`);
    expect(buildRemoteLaunchCommand({ ...openCode, remote })).toContain('ses_abc123');
    expect(() => buildRemoteLaunchCommand({ ...options, mode: 'codex', remoteResumeOnly: true, remote })).toThrow();
  });
  it('retains an explicitly resumed Claude identity rather than the tab UUID', () => {
    expect(workerResumeOptions({ ...options, resumeSessionId: OLD }, null)?.resumeSessionId).toBe(OLD);
  });
  it('requires an exact native identity for Codex and OpenCode', () => {
    expect(workerResumeOptions({ ...options, mode: 'codex' }, null)).toBeNull();
    expect(workerResumeOptions({ ...options, mode: 'opencode' }, null)).toBeNull();
    expect(workerResumeOptions({ ...options, mode: 'codex' }, OLD)?.codexConfig?.resumeSessionId).toBe(OLD);
    expect(workerResumeOptions({ ...options, mode: 'opencode' }, 'ses_abc123')?.openCodeConfig?.continueSession).toBe(
      'ses_abc123'
    );
  });
  it.each(['shell', 'pi', 'omp', 'gemini'] as const)('does not start a fresh %s session', (mode) => {
    expect(workerResumeOptions({ ...options, mode }, OLD)).toBeNull();
  });
  it('rejects attach-only sessions, opaque overrides and malformed identities', () => {
    expect(workerResumeOptions({ ...options, remote: { ...remote, owned: false } }, null)).toBeNull();
    expect(
      workerResumeOptions({ ...options, remote: { ...remote, commands: { claude: 'custom-cli' } } }, null)
    ).toBeNull();
    expect(workerResumeOptions({ ...options, resumeSessionId: 'bad;command' }, null)).toBeNull();
    expect(
      workerResumeOptions({ ...options, mode: 'codex', codexConfig: { baseCommand: 'custom-cli' } }, OLD)
    ).toBeNull();
  });

  it('uses attach-only options for transport reconnects even if a probe raced a reboot', async () => {
    const manager = new TmuxManager();
    const session = new Session({ id: ID, workingDir: '/project', mode: 'claude', remote, mux: manager, useMux: true });
    await session.startInteractive();
    const respawn = vi.spyOn(manager, 'respawnPane').mockResolvedValue(4242);
    vi.spyOn(manager, 'muxSessionExists').mockResolvedValue(true);
    expect(await session.reattachRemote()).toBe(true);
    expect(respawn).toHaveBeenCalledWith(
      expect.objectContaining({
        remote: expect.objectContaining({ owned: true, remoteSessionName: `codeman-ssh-${ID.slice(0, 8)}` }),
      })
    );
    session.markClosing(true);
    expect(await session.resumeRemoteAfterWorkerReboot()).toBe(false);
    expect(respawn).toHaveBeenCalledTimes(1);
    await session.stop();
    manager.destroy();
  });
  it('passes the pinned resume through the real Session method to the mux', async () => {
    const manager = new TmuxManager();
    const session = new Session({ id: ID, workingDir: '/project', mode: 'claude', remote, mux: manager, useMux: true });
    await session.startInteractive();
    const respawn = vi.spyOn(manager, 'respawnPane').mockResolvedValue(4242);
    vi.spyOn(manager, 'muxSessionExists').mockResolvedValue(true);
    expect(await session.resumeRemoteAfterWorkerReboot()).toBe(true);
    expect(respawn).toHaveBeenCalledWith(expect.objectContaining({ remoteResumeOnly: true, resumeSessionId: ID }));
    vi.spyOn(remoteHosts, 'probeRemoteWorker').mockResolvedValue({ alive: true, agentRunning: false, bootId: NEW });
    expect(await session.resumeRemoteAfterWorkerReboot()).toBe(false);
    await session.stop();
    manager.destroy();
  });
});

describe('worker recovery server integration', () => {
  function harness() {
    const state: SessionState = {
      id: ID,
      workingDir: '/project',
      mode: 'claude',
      remote,
      pid: 42,
      status: 'busy',
      currentTaskId: null,
      createdAt: 1,
    };
    const session = {
      resumeRemoteAfterWorkerReboot: vi.fn(async () => true),
      reattachRemote: vi.fn(async () => true),
      toState: () => state,
    };
    const records: SessionRecoveryRecord[] = [];
    const store = {
      getSessionRecoveries: vi.fn(() => records),
      upsertSessionRecovery: vi.fn((record: SessionRecoveryRecord) => {
        const index = records.findIndex((row) => row.id === record.id);
        if (index === -1) records.push(record);
        else records[index] = record;
      }),
    };
    const server = new WebServer(0, false, true) as unknown as {
      sessions: Map<string, typeof session>;
      store: typeof store;
      readSettings: (fresh?: boolean) => Promise<Record<string, unknown>>;
      noteRemoteReconnect: (id: string, success: boolean) => void;
      persistSessionState: (value: typeof session) => void;
      broadcast: (event: string, value: unknown) => void;
      handleRemoteSessionDropped: (id: string, workerReboot?: boolean) => Promise<void>;
    };
    server.sessions = new Map([[ID, session]]);
    server.store = store;
    server.readSettings = vi.fn(async () => ({ remoteAutoReconnect: true, autoRecoverSessionsAfterReboot: true }));
    server.noteRemoteReconnect = vi.fn();
    server.persistSessionState = vi.fn();
    server.broadcast = vi.fn();
    return { server, session, records, store };
  }
  it('registers the Recovery Queue routes on the actual server, including the public API alias', async () => {
    const server = new WebServer(0, false, true);
    const internal = server as unknown as { app: FastifyInstance; setupRoutes: () => Promise<void> };
    await internal.setupRoutes();
    const app = internal.app;
    try {
      for (const url of ['/api/session-recoveries', '/api/v1/session-recoveries']) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ success: true, data: { recoveries: expect.any(Array) } });
      }
    } finally {
      await app.close();
    }
  });
  it('dispatches a reboot to resume and a transport drop to attach', async () => {
    const { server, session } = harness();
    await server.handleRemoteSessionDropped(ID, true);
    expect(session.resumeRemoteAfterWorkerReboot).toHaveBeenCalledTimes(1);
    expect(session.reattachRemote).not.toHaveBeenCalled();
    expect(server.noteRemoteReconnect).toHaveBeenCalledWith(ID, true);
    await server.handleRemoteSessionDropped(ID);
    expect(session.reattachRemote).toHaveBeenCalledTimes(1);
  });
  it('preserves an actionable exact recovery after failure and marks it recovered on a later successful retry', async () => {
    const { server, session, records } = harness();
    session.resumeRemoteAfterWorkerReboot.mockResolvedValueOnce(false);
    await server.handleRemoteSessionDropped(ID, true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'resumable', claudeResumeId: ID });
    await server.handleRemoteSessionDropped(ID, true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'recovered', recoveredSessionId: ID });
  });
  it('preserves recovery evidence if the resume throws', async () => {
    const { server, session, records } = harness();
    session.resumeRemoteAfterWorkerReboot.mockRejectedValueOnce(new Error('worker still starting'));
    await server.handleRemoteSessionDropped(ID, true);
    expect(records[0]).toMatchObject({ status: 'resumable', claudeResumeId: ID });
    expect(server.noteRemoteReconnect).toHaveBeenCalledWith(ID, false);
  });
  it('rechecks live settings before launching, releasing the in-flight attempt when disabled', async () => {
    const { server, session } = harness();
    server.readSettings = vi.fn(async () => ({ autoRecoverSessionsAfterReboot: false }));
    await server.handleRemoteSessionDropped(ID, true);
    expect(session.resumeRemoteAfterWorkerReboot).not.toHaveBeenCalled();
    expect(server.noteRemoteReconnect).toHaveBeenCalledWith(ID, false);
  });
  it('does not revive a session removed while settings were being read', async () => {
    const { server, session } = harness();
    server.readSettings = vi.fn(async () => {
      server.sessions.delete(ID);
      return { autoRecoverSessionsAfterReboot: true };
    });
    await server.handleRemoteSessionDropped(ID, true);
    expect(session.resumeRemoteAfterWorkerReboot).not.toHaveBeenCalled();
  });
  it('retains the newest adopted Claude conversation in a worker recovery record', () => {
    const record = createWorkerRecoveryRecord({
      id: ID,
      mode: 'claude',
      workingDir: '/project',
      remote,
      status: 'stopped',
      currentTaskId: null,
      pid: null,
      createdAt: 1,
      claudeSessionChain: [ID, OLD],
    });
    expect(record.claudeResumeId).toBe(OLD);
  });
  it('provides a manual record when no exact remote native identity is available', () => {
    const record = createWorkerRecoveryRecord({
      id: ID,
      mode: 'codex',
      workingDir: '/project',
      remote,
      status: 'stopped',
      currentTaskId: null,
      pid: null,
      createdAt: 1,
    });
    expect(record.status).toBe('manual_required');
    expect(record.launch.kind).toBe('manual_required');
  });
});

describe('read-only worker probe', () => {
  it('parses Linux and macOS boot identity, running/retained panes, and missing tmux', () => {
    expect(remoteHosts.parseRemoteWorkerObservation(`${OLD}\nALIVE 0\n`)).toEqual({
      bootId: OLD,
      alive: true,
      agentRunning: true,
    });
    expect(remoteHosts.parseRemoteWorkerObservation(`${NEW}\nALIVE 1\n`)).toEqual({
      bootId: NEW,
      alive: true,
      agentRunning: false,
    });
    const mac = '{ sec = 12345, usec = 0 } Mon Oct 5';
    expect(remoteHosts.parseRemoteWorkerObservation(`${mac}\nGONE\n`)).toEqual({
      bootId: mac,
      alive: false,
      agentRunning: false,
    });
    expect(remoteHosts.parseRemoteWorkerObservation('garbage\nGONE\n')?.bootId).toBeUndefined();
    expect(remoteHosts.parseRemoteWorkerObservation('connection refused')).toBeUndefined();
  });
  it('uses the configured SSH path and quotes target names safely without waking or starting anything', () => {
    const command = remoteHosts.buildRemoteWorkerProbeCommand(
      { ...remote, port: 2222, jumpHost: 'bastion' },
      "unsafe'; command"
    );
    expect(command).toContain('-p 2222');
    expect(command).toContain('-J');
    expect(command).toContain('/proc/sys/kernel/random/boot_id');
    expect(command).not.toContain('new-session');
    expect(command).not.toContain('send-keys');
  });
});
