import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';

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
    configureAgentTrackingBeforeRestore(): Promise<boolean>;
    isSubagentTrackingEnabled(): Promise<boolean>;
    createRouteContext(): {
      addSession(session: Session): Promise<unknown>;
      getSessionStateWithRespawn(session: Session): Record<string, unknown>;
      agentActivity: { detachSession(session: Session): void };
    };
    cachedLightState: unknown;
    cachedSessionsList: unknown;
    sessions: Map<string, Session>;
    sse: {
      addClient(
        reply: FastifyReply,
        sessionFilter: Set<string> | null,
        isRemote: boolean,
        clientId?: string,
        identity?: { username: string; role: 'user' | 'admin' }
      ): void;
      cleanupSessionBatches(sessionId: string): void;
      broadcast: ReturnType<typeof vi.fn>;
    };
  };
}

function sseClient() {
  const writes: string[] = [];
  return {
    writes,
    reply: { raw: { write: (chunk: string) => (writes.push(chunk), true) } } as unknown as FastifyReply,
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
    vi.spyOn(subagentWatcher, 'getSemanticSnapshot').mockReturnValue({ revision: 1, agents: [info] });
    subagentWatcher.emit('subagent:error', new Error('tail failed'), info.agentKey);
    expect(state.cachedLightState).toBeNull();
    expect(state.cachedSessionsList).toBeNull();
    expect(session.activityProjection.activityStatus).toBe('waiting_agents');
    await server.stop();
  });

  it('delivers coordinator-mapped subagent SSE only to its trusted owner and admins', async () => {
    const previousMultiuser = process.env.CODEMAN_MULTIUSER;
    process.env.CODEMAN_MULTIUSER = '1';
    const server = new WebServer(0, false, true);
    try {
      const state = internals(server);
      vi.spyOn(subagentWatcher, 'reconcileConversation').mockResolvedValue([]);
      const aliceSession = new Session({
        id: 'codeman-alice',
        workingDir: '/tmp/shared-owner-routing',
        mode: 'claude',
      });
      aliceSession.owner = 'alice';
      // Deliberately collide Alice's Claude conversation ID with Bob's trusted
      // Codeman session ID. Routing by the visualization `sessionId` would leak.
      aliceSession.adoptClaudeSessionId('codeman-bob');
      const bobSession = new Session({
        id: 'codeman-bob',
        workingDir: '/tmp/shared-owner-routing',
        mode: 'claude',
      });
      bobSession.owner = 'bob';
      bobSession.adoptClaudeSessionId('bob-conversation');
      await state.createRouteContext().addSession(aliceSession);
      await state.createRouteContext().addSession(bobSession);
      const alice = sseClient();
      const bob = sseClient();
      const admin = sseClient();
      state.sse.addClient(alice.reply, null, false, undefined, { username: 'alice', role: 'user' });
      state.sse.addClient(bob.reply, null, false, undefined, { username: 'bob', role: 'user' });
      state.sse.addClient(admin.reply, null, false, undefined, { username: 'root', role: 'admin' });
      const info: SubagentInfo = {
        agentKey: serializeSubagentKey(
          claudeProjectHash(aliceSession.workingDir),
          aliceSession.claudeSessionId!,
          'alice-agent'
        ),
        agentId: 'alice-agent',
        projectHash: claudeProjectHash(aliceSession.workingDir),
        sessionId: aliceSession.claudeSessionId!,
        filePath: '/tmp/alice-agent.jsonl',
        startedAt: new Date().toISOString(),
        lastActivityAt: Date.now(),
        status: 'active',
        toolCallCount: 0,
        entryCount: 0,
        fileSize: 1,
      };

      subagentWatcher.emit('subagent:discovered', info);

      const subagentEvents = (writes: string[]) =>
        writes.filter((write) => write.startsWith('event: subagent:discovered'));
      expect(subagentEvents(alice.writes)).toHaveLength(1);
      expect(subagentEvents(bob.writes)).toEqual([]);
      expect(subagentEvents(admin.writes)).toEqual(subagentEvents(alice.writes));
      const delivered = JSON.parse(subagentEvents(alice.writes)[0].split('\ndata: ')[1]) as Record<string, unknown>;
      expect(delivered).toMatchObject({
        sessionId: 'codeman-bob',
        codemanSessionId: 'codeman-alice',
        codemanOwner: 'alice',
      });
    } finally {
      try {
        await server.stop();
      } finally {
        if (previousMultiuser === undefined) delete process.env.CODEMAN_MULTIUSER;
        else process.env.CODEMAN_MULTIUSER = previousMultiuser;
      }
    }
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

  it('applies persisted disabled tracking before restored sessions attach and reconciles all on re-enable', async () => {
    const server = new WebServer(0, false, true);
    const state = internals(server);
    vi.spyOn(state, 'isSubagentTrackingEnabled').mockResolvedValue(false);
    const reconcile = vi.spyOn(subagentWatcher, 'reconcileConversation').mockResolvedValue([]);

    await state.configureAgentTrackingBeforeRestore();
    const restored = new Session({ id: 'restored-disabled', workingDir: '/tmp/restored-disabled', mode: 'claude' });
    const ctx = state.createRouteContext() as ReturnType<typeof state.createRouteContext> & {
      agentActivity: { setTrackingEnabled(enabled: boolean): void };
    };
    await ctx.addSession(restored);

    expect(restored.activityProjection.activityStatus).toBe(restored.status);
    expect(reconcile).not.toHaveBeenCalled();

    ctx.agentActivity.setTrackingEnabled(true);
    expect(reconcile).toHaveBeenCalledWith(claudeProjectHash(restored.workingDir), restored.claudeSessionId);
    await server.stop();
  });

  it.each(['EACCES', 'EIO'])('keeps %s exact reconciliation unknown rather than committing zero', async (code) => {
    const server = new WebServer(0, false, true);
    const state = internals(server);
    vi.spyOn(subagentWatcher, 'reconcileConversation').mockRejectedValue(
      Object.assign(new Error('unreadable identity'), { code })
    );
    const session = new Session({ id: 'activity-unreadable', workingDir: '/tmp/unreadable', mode: 'claude' });

    await state.createRouteContext().addSession(session);

    expect(session.activityProjection.activityStatus).toBe('checking_agents');
    await server.stop();
  });

  it('routes a zero-agent directory watcher error to only its exact same-directory conversation', async () => {
    const server = new WebServer(0, false, true);
    const state = internals(server);
    vi.spyOn(subagentWatcher, 'reconcileConversation').mockResolvedValue([]);
    const affected = new Session({ id: 'watch-error-a', workingDir: '/tmp/shared-watch', mode: 'claude' });
    const peer = new Session({ id: 'watch-error-b', workingDir: '/tmp/shared-watch', mode: 'claude' });
    affected.adoptClaudeSessionId('conversation-a');
    peer.adoptClaudeSessionId('conversation-b');
    await state.createRouteContext().addSession(affected);
    await state.createRouteContext().addSession(peer);
    const peerInfo: SubagentInfo = {
      agentKey: serializeSubagentKey(claudeProjectHash(peer.workingDir), peer.claudeSessionId!, 'peer-agent'),
      agentId: 'peer-agent',
      projectHash: claudeProjectHash(peer.workingDir),
      sessionId: peer.claudeSessionId!,
      filePath: '/tmp/peer-agent.jsonl',
      startedAt: new Date().toISOString(),
      lastActivityAt: Date.now(),
      status: 'active',
      toolCallCount: 0,
      entryCount: 0,
      fileSize: 1,
    };
    subagentWatcher.emit('subagent:discovered', peerInfo);
    expect(peer.activityProjection.activityStatus).toBe('waiting_agents');
    state.sse.broadcast = vi.fn();
    state.cachedLightState = { data: {}, timestamp: Date.now() };
    state.cachedSessionsList = { data: [], timestamp: Date.now() };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    subagentWatcher.emit('subagent:error', Object.assign(new Error('watch EIO'), { code: 'EIO' }), {
      projectHash: claudeProjectHash(affected.workingDir),
      sessionId: affected.claudeSessionId!,
    });

    expect(affected.activityProjection.activityStatus).toBe('checking_agents');
    expect(peer.activityProjection.activityStatus).toBe('waiting_agents');
    expect(state.cachedLightState).toBeNull();
    expect(state.cachedSessionsList).toBeNull();
    expect(state.sse.broadcast).toHaveBeenCalledWith(
      SseEvent.SessionUpdated,
      expect.objectContaining({ id: affected.id, activityStatus: 'checking_agents' }),
      undefined
    );
    expect(state.sse.broadcast).not.toHaveBeenCalledWith(
      SseEvent.SessionUpdated,
      expect.objectContaining({ id: peer.id }),
      undefined
    );
    await server.stop();
  });

  it('clears the old watcher generation immediately when SessionStart replaces the Claude identity', async () => {
    const server = new WebServer(0, false, true);
    const state = internals(server);
    const ctx = state.createRouteContext() as ReturnType<typeof state.createRouteContext> & {
      agentActivity: { identityChanged(session: Session): void };
    };
    vi.spyOn(subagentWatcher, 'reconcileConversation').mockResolvedValue([]);
    const session = new Session({ id: 'identity-replaced', workingDir: '/tmp/identity-replaced', mode: 'claude' });
    session.adoptClaudeSessionId('old-conversation');
    await ctx.addSession(session);
    const infoFor = (conversationId: string, agentId: string): SubagentInfo => ({
      agentKey: serializeSubagentKey(claudeProjectHash(session.workingDir), conversationId, agentId),
      agentId,
      projectHash: claudeProjectHash(session.workingDir),
      sessionId: conversationId,
      filePath: `/tmp/${agentId}.jsonl`,
      startedAt: new Date().toISOString(),
      lastActivityAt: Date.now(),
      status: 'active',
      toolCallCount: 0,
      entryCount: 0,
      fileSize: 1,
    });
    subagentWatcher.emit('subagent:discovered', infoFor('old-conversation', 'old-agent'));
    expect(session.activityProjection.activityStatus).toBe('waiting_agents');

    session.adoptClaudeSessionStartId('new-conversation');
    ctx.agentActivity.identityChanged(session);
    expect(session.activityProjection.activityStatus).toBe('checking_agents');

    subagentWatcher.emit('subagent:discovered', infoFor('old-conversation', 'late-old-agent'));
    expect(session.activityProjection.activityStatus).toBe('checking_agents');
    subagentWatcher.emit('subagent:discovered', infoFor('new-conversation', 'new-agent'));
    expect(session.activityProjection.activityStatus).toBe('waiting_agents');
    await server.stop();
  });
});
