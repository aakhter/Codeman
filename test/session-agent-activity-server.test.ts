import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/mux-factory.js', () => ({
  createMultiplexer: () => Object.assign(new EventEmitter(), { backend: 'tmux', destroy: vi.fn() }),
}));
import { Session } from '../src/session.js';
import { WebServer } from '../src/web/server.js';
import { subagentWatcher, type SubagentInfo } from '../src/subagent-watcher.js';
import { claudeProjectHash, serializeSubagentKey } from '../src/claude-project-identity.js';
import { approvalInbox } from '../src/web/approval-inbox.js';
import { SseEvent } from '../src/web/sse-events.js';

function internals(server: WebServer) {
  return server as unknown as {
    createRouteContext(): {
      addSession(session: Session): Promise<unknown>;
      getSessionStateWithRespawn(session: Session): Record<string, unknown>;
      agentActivity: { detachSession(session: Session): void };
    };
    cachedLightState: unknown;
    cachedSessionsList: unknown;
    sessions: Map<string, Session>;
    sse: { cleanupSessionBatches(sessionId: string): void; broadcast: ReturnType<typeof vi.fn> };
  };
}

afterEach(() => {
  for (const item of approvalInbox.listPending()) approvalInbox.resolveForSession(item.sessionId, 'dismissed');
  vi.restoreAllMocks();
});

describe('WebServer agent activity ownership', () => {
  it('attaches before visibility and always emits the runtime projection on the wire', async () => {
    const server = new WebServer(0, false, true);
    const state = internals(server);
    const ctx = state.createRouteContext();
    const session = new Session({ id: 'activity-local', workingDir: '/tmp/activity-local', mode: 'claude' });
    let finishReconcile!: () => void;
    const reconcile = vi.spyOn(subagentWatcher, 'reconcileConversation').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishReconcile = () => resolve([]);
        })
    );

    const adding = ctx.addSession(session);

    await vi.waitFor(() =>
      expect(reconcile).toHaveBeenCalledWith(claudeProjectHash(session.workingDir), session.claudeSessionId)
    );
    expect(session.activityProjection.activityStatus).toBe('checking_agents');
    expect(state.sessions.has(session.id)).toBe(false);
    finishReconcile();
    await adding;
    expect(state.sessions.get(session.id)).toBe(session);
    expect(ctx.getSessionStateWithRespawn(session)).toMatchObject({
      status: session.status,
      activityStatus: 'checking_agents',
    });
    expect(session.toState()).not.toHaveProperty('activityStatus');
    await server.stop();
  });

  it.each([
    new Session({
      id: 'activity-remote',
      workingDir: '/tmp',
      mode: 'claude',
      remote: { hostId: 'h', label: 'h', host: 'h', username: 'u', remotePath: '/tmp' },
    }),
    new Session({ id: 'activity-docker', workingDir: '/tmp', mode: 'claude', docker: { image: 'test' } }),
  ])('keeps remote and container sessions on the legacy projection', async (session) => {
    const server = new WebServer(0, false, true);
    await internals(server).createRouteContext().addSession(session);
    expect(session.activityProjection.activityStatus).toBe(session.status);
    await server.stop();
  });

  it('commits watcher discovery before agent SSE and invalidates session caches', async () => {
    const server = new WebServer(0, false, true);
    const state = internals(server);
    const ctx = state.createRouteContext();
    const session = new Session({ id: 'activity-watch', workingDir: '/tmp/activity-watch', mode: 'claude' });
    session.owner = 'alice';
    await ctx.addSession(session);
    state.sse.broadcast = vi.fn();
    session.setActivityProjection({ activityStatus: 'idle', activityStatusSince: null });
    (session as unknown as { _status: string })._status = 'idle';
    state.cachedLightState = { data: {}, timestamp: Date.now() };
    state.cachedSessionsList = { data: [], timestamp: Date.now() };
    const pending = approvalInbox.notePrompt({
      sessionId: session.id,
      sessionName: session.name,
      kind: 'idle',
      mode: 'claude',
    });
    expect(pending).toBeDefined();
    const info: SubagentInfo = {
      agentKey: serializeSubagentKey(claudeProjectHash(session.workingDir), session.claudeSessionId!, 'agent-1'),
      agentId: 'agent-1',
      projectHash: claudeProjectHash(session.workingDir),
      sessionId: session.claudeSessionId!,
      filePath: '/tmp/agent-1.jsonl',
      startedAt: new Date().toISOString(),
      lastActivityAt: Date.now(),
      status: 'active',
      toolCallCount: 0,
      entryCount: 0,
      fileSize: 1,
    };

    subagentWatcher.emit('subagent:discovered', info);

    expect(session.activityProjection.activityStatus).toBe('waiting_agents');
    expect(state.cachedLightState).toBeNull();
    expect(state.cachedSessionsList).toBeNull();
    expect(approvalInbox.getForSession(session.id)).toBeUndefined();
    expect(state.sse.broadcast).toHaveBeenCalledWith(
      SseEvent.SubagentDiscovered,
      expect.objectContaining({
        sessionId: session.claudeSessionId,
        codemanSessionId: session.id,
        codemanOwner: 'alice',
      }),
      undefined
    );

    state.cachedLightState = { data: {}, timestamp: Date.now() };
    state.cachedSessionsList = { data: [], timestamp: Date.now() };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(subagentWatcher, 'resolveSubagentReference').mockReturnValue({ status: 'found', info });
    subagentWatcher.emit('subagent:error', new Error('tail failed'), info.agentKey);
    expect(state.cachedLightState).toBeNull();
    expect(state.cachedSessionsList).toBeNull();
    expect(session.activityProjection.activityStatus).toBe('waiting_agents');
    await server.stop();
  });

  it('publishes one derived idle edge when tracking is disabled and gates sessions created while disabled', async () => {
    const server = new WebServer(0, false, true);
    const state = internals(server);
    const ctx = state.createRouteContext() as ReturnType<typeof state.createRouteContext> & {
      agentActivity: { setTrackingEnabled(enabled: boolean): void };
    };
    const first = new Session({ id: 'activity-toggle-1', workingDir: '/tmp/activity-toggle', mode: 'claude' });
    await ctx.addSession(first);
    (first as unknown as { _status: string })._status = 'idle';
    first.setActivityProjection({ activityStatus: 'checking_agents', activityStatusSince: 1 });
    state.sse.broadcast = vi.fn();

    ctx.agentActivity.setTrackingEnabled(false);

    const idleUpdates = state.sse.broadcast.mock.calls.filter(
      ([event, payload]) => event === SseEvent.SessionUpdated && (payload as { id?: string }).id === first.id
    );
    expect(idleUpdates).toHaveLength(1);
    expect(first.activityProjection).toEqual({ activityStatus: 'idle', activityStatusSince: null });

    subagentWatcher.emit('subagent:reset', { reason: 'stop' });
    expect(first.activityProjection).toEqual({ activityStatus: 'idle', activityStatusSince: null });

    const second = new Session({ id: 'activity-toggle-2', workingDir: '/tmp/activity-toggle', mode: 'claude' });
    await ctx.addSession(second);
    expect(second.activityProjection.activityStatus).toBe(second.status);
    await server.stop();
  });
});
