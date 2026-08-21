import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/mux-factory.js', () => ({
  createMultiplexer: () =>
    Object.assign(new EventEmitter(), {
      backend: 'tmux',
      destroy: vi.fn(),
      capturePaneText: vi.fn(),
    }),
}));

import { claudeProjectHash, serializeSubagentKey } from '../src/claude-project-identity.js';
import {
  BoundedActivityScheduler,
  FINAL_AGENT_SETTLE_MS,
  SessionAgentActivityCoordinator,
  type AgentEvidence,
  type CoordinatorSession,
  type ObservableSessionProject,
} from '../src/session-agent-activity-coordinator.js';
import { Session } from '../src/session.js';
import { subagentWatcher, type SubagentInfo } from '../src/subagent-watcher.js';
import type { ProcessInspectionSource } from '../src/subagent-process-inspector.js';
import { approvalInbox } from '../src/web/approval-inbox.js';
import { SseEvent } from '../src/web/sse-events.js';
import { WebServer, subagentConversationIdForCleanup } from '../src/web/server.js';
import { sessionWaits } from '../src/web/session-wait-registry.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function internals(server: WebServer) {
  return server as unknown as {
    app: { inject(options: Record<string, unknown>): Promise<{ statusCode: number }> };
    setupRoutes(): Promise<void>;
    createRouteContext(): {
      addSession(session: Session): Promise<unknown>;
      getSessionStateWithRespawn(session: Session): Record<string, unknown>;
      agentActivity: {
        detachSession(session: Session): void;
        identityChanged(session: Session): void;
        terminalActivity(session: Session): void;
        sessionExited(session: Session): void;
        setTrackingEnabled(enabled: boolean): void;
      };
    };
    cleanupSession(sessionId: string, killMux?: boolean, reason?: string): Promise<void>;
    sessions: Map<string, Session>;
    activityAdapters: Map<Session, CoordinatorSession>;
    runSummaryTrackers: Map<
      string,
      {
        recordHookEvent: ReturnType<typeof vi.fn>;
        recordSessionStopped: ReturnType<typeof vi.fn>;
        stop: ReturnType<typeof vi.fn>;
      }
    >;
    cachedLightState: unknown;
    cachedSessionsList: unknown;
    mux: { capturePaneText: ReturnType<typeof vi.fn> };
    sse: { broadcast: ReturnType<typeof vi.fn>; cleanupSessionBatches: ReturnType<typeof vi.fn> };
    sendPushNotifications: ReturnType<typeof vi.fn>;
  };
}

function visibleWaitingFrame(count: number): string {
  return [
    `✳ Waiting for ${count} background agents to finish`,
    '────────',
    '❯',
    '────────',
    'Opus 5 in:1 out:1 ctx:1%',
  ].join('\n');
}

function agent(session: Session, agentId: string): SubagentInfo {
  const projectHash = claudeProjectHash(session.workingDir);
  return {
    agentKey: serializeSubagentKey(projectHash, session.claudeSessionId!, agentId),
    agentId,
    projectHash,
    sessionId: session.claudeSessionId!,
    filePath: `/tmp/${session.claudeSessionId}-${agentId}.jsonl`,
    startedAt: new Date(0).toISOString(),
    lastActivityAt: 1,
    status: 'active',
    toolCallCount: 0,
    entryCount: 0,
    fileSize: 1,
  };
}

function setRawIdle(session: Session): void {
  (session as unknown as { _status: string })._status = 'idle';
}

const noRoleProcessSource: ProcessInspectionSource = {
  listPids: async () => [237],
  readCmdline: async () => 'claude\0--resume\0parent-conversation\0',
  readEnviron: async () => '',
  statProcessCwd: async () => ({ dev: 1, ino: 1 }),
  statWorkingDirectory: async () => ({ dev: 1, ino: 1 }),
};

const activeServers = new Set<WebServer>();

afterEach(async () => {
  for (const server of activeServers) {
    try {
      await server.stop();
    } catch {
      // Preserve the test's original failure while still best-effort cleaning
      // globally shared watcher/listener state.
    }
  }
  activeServers.clear();
  for (const item of approvalInbox.listPending()) approvalInbox.resolveForSession(item.sessionId, 'dismissed');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('background-agent wait integration', () => {
  it('models the screenshot without turning exact live agents into a human approval or autonomous idle', async () => {
    const server = new WebServer(0, false, true, '127.0.0.1', undefined, false, {
      runtimeVersion: '2.1.237',
      source: noRoleProcessSource,
    });
    activeServers.add(server);
    const state = internals(server);
    const push = vi.spyOn(state, 'sendPushNotifications').mockResolvedValue(undefined);
    state.mux.capturePaneText = vi.fn(() => visibleWaitingFrame(2));
    await state.setupRoutes();

    const parent = new Session({ id: 'codeman-parent', workingDir: '/tmp/cod350-shared', mode: 'claude' });
    parent.adoptClaudeSessionId('parent-conversation');
    const peer = new Session({ id: 'codeman-peer', workingDir: parent.workingDir, mode: 'claude' });
    peer.adoptClaudeSessionId('peer-conversation');
    const parentAgents = [agent(parent, 'researcher'), agent(parent, 'synthesizer')];
    let revision = 1;
    let liveAgents = parentAgents;
    vi.spyOn(subagentWatcher, 'reconcileConversation').mockResolvedValue([]);
    vi.spyOn(subagentWatcher, 'getSemanticSnapshot').mockImplementation((projectHash, conversationId) => ({
      revision,
      agents:
        projectHash === claudeProjectHash(parent.workingDir) && conversationId === parent.claudeSessionId
          ? liveAgents
          : [],
    }));
    const ctx = state.createRouteContext();
    await ctx.addSession(parent);
    await ctx.addSession(peer);
    (parent as unknown as { _muxSession: { muxName: string } })._muxSession = { muxName: 'cod350-parent-mux' };
    setRawIdle(parent);
    setRawIdle(peer);
    state.sse.broadcast = vi.fn();
    const notifySignal = vi.spyOn(sessionWaits, 'notifySignal');

    for (const info of parentAgents) subagentWatcher.emit('subagent:discovered', info);
    parent.emit('idle', { reason: 'silence' });
    await vi.waitFor(() => expect(parent.activityProjection.activityStatus).toBe('waiting_agents'));

    const response = await state.app.inject({
      method: 'POST',
      url: '/api/hook-event',
      payload: { event: 'idle_prompt', sessionId: parent.id, data: { message: 'waiting for input' } },
    });

    expect(response.statusCode).toBe(200);
    expect(ctx.getSessionStateWithRespawn(parent)).toMatchObject({
      status: 'idle',
      activityStatus: 'waiting_agents',
      activityStatusSince: expect.any(Number),
    });
    // The peer remains in its own startup reconciliation state; the two agents
    // from the shared directory never leak into its distinct conversation.
    expect(peer.activityProjection.activityStatus).toBe('checking_agents');
    expect(approvalInbox.getForSession(parent.id)).toBeUndefined();
    expect(state.sse.broadcast.mock.calls.map(([event]) => event)).toContain(SseEvent.HookSuppressed);
    expect(state.sse.broadcast.mock.calls.map(([event]) => event)).not.toContain(SseEvent.HookIdlePrompt);
    expect(push).not.toHaveBeenCalled();
    expect(notifySignal).not.toHaveBeenCalledWith(parent.id, 'idle');
    expect(parent.isAutonomouslyIdle()).toBe(false);
    expect(parent.blocksIdleAutomation).toBe(true);
    parent.setCheckpoint(true);
    expect(parent.requestCheckpoint()).toEqual({ triggered: false, reason: 'activity-blocked' });

    const runSummary = { recordHookEvent: vi.fn(), recordSessionStopped: vi.fn(), stop: vi.fn() };
    state.runSummaryTrackers.set(parent.id, runSummary);
    notifySignal.mockClear();
    state.sse.broadcast.mockClear();
    const stop = await state.app.inject({
      method: 'POST',
      url: '/api/hook-event',
      payload: { event: 'stop', sessionId: parent.id, data: { message: 'parent stopped' } },
    });
    expect(stop.statusCode).toBe(200);
    expect(notifySignal).toHaveBeenCalledWith(parent.id, 'stop');
    expect(runSummary.recordHookEvent).toHaveBeenCalledWith(
      'stop',
      expect.objectContaining({ message: 'parent stopped' })
    );
    expect(state.sse.broadcast.mock.calls.map(([event]) => event)).toContain(SseEvent.HookStop);
    expect(parent.activityProjection.activityStatus).toBe('waiting_agents');
    expect(parent.blocksIdleAutomation).toBe(true);

    const killSubagents = vi.spyOn(subagentWatcher, 'killSubagentsForSession').mockResolvedValue([]);
    await state.cleanupSession(parent.id, true, 'integration-proof');
    expect(killSubagents).toHaveBeenCalledWith(parent.workingDir, 'parent-conversation');
    expect(subagentConversationIdForCleanup(parent)).toBe('parent-conversation');
    expect(state.activityAdapters.has(parent)).toBe(false);
    expect(state.sessions.has(parent.id)).toBe(false);

    liveAgents = [];
    revision += 1;
    await server.stop();
    activeServers.delete(server);
  });

  it('settles final completion once, cancels on parent output, and lets fresh exact-zero events end grace', async () => {
    vi.useFakeTimers();
    const derivedIdle = vi.fn();
    let evidence: AgentEvidence = {
      observation: 'live',
      semanticRevision: 0,
      exactWatcherCount: 2,
      exactWatcherAgentKeys: ['key-a', 'key-b'],
      observedWatcherAgentKeys: ['key-a', 'key-b'],
      currentFrame: {
        source: 'tmux_visible_frame',
        status: 'positive',
        reason: 'matching_visible_renderer',
        renderedCount: 2,
      },
      processReason: 'no_registered_role_signature',
    };
    const coordinator = new SessionAgentActivityCoordinator({
      inspect: async () => evidence,
      onDerivedIdle: derivedIdle,
    });
    const target: CoordinatorSession & { status: 'idle' | 'busy'; terminalActivityEpoch: number } = {
      id: 'settle-parent',
      status: 'idle',
      mode: 'claude',
      workingDir: '/tmp/cod350-settle',
      claudeSessionId: 'settle-conversation',
      terminalActivityEpoch: 0,
      setActivityProjection() {},
    };
    coordinator.attachSession(target);
    expect(coordinator.project(target).activityStatus).toBe('checking_agents');
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.project(target).activityStatus).toBe('waiting_agents');

    coordinator.onWatcherSnapshot(target, ['key-a'], 2);
    coordinator.onWatcherSnapshot(target, [], 3);
    await vi.advanceTimersByTimeAsync(FINAL_AGENT_SETTLE_MS - 1);
    expect(coordinator.project(target).activityStatus).toBe('waiting_agents');
    expect(derivedIdle).not.toHaveBeenCalled();

    target.status = 'busy';
    target.terminalActivityEpoch += 1;
    coordinator.onTerminalOutput(target);
    await vi.advanceTimersByTimeAsync(1);
    expect(coordinator.project(target).activityStatus).toBe('busy');
    expect(derivedIdle).not.toHaveBeenCalled();

    target.status = 'idle';
    coordinator.onWatcherSnapshot(target, ['key-c'], 4);
    coordinator.onWatcherSnapshot(target, [], 5);
    evidence = { observation: 'none', semanticRevision: 5, exactWatcherCount: 0 };
    const stop = coordinator.allocateEvent(target, 'stop');
    const stopResult = await coordinator.reconcileForEvent(target, stop);
    const stopReconciliation = coordinator.reconciliationForEvent(target, stop, stopResult);
    expect(coordinator.decisionForEvent(target, stop, { reconciliation: stopReconciliation })).toMatchObject({
      settleEndedEarly: true,
      presentToHuman: true,
      autonomyBlocked: false,
    });
    expect(coordinator.project(target).activityStatus).toBe('idle');
    expect(derivedIdle).toHaveBeenCalledTimes(1);

    coordinator.onWatcherSnapshot(target, ['key-d'], 6);
    coordinator.onWatcherSnapshot(target, [], 7);
    evidence = { observation: 'none', semanticRevision: 7, exactWatcherCount: 0 };
    const rawIdle = coordinator.allocateEvent(target, 'raw_idle');
    const idleResult = await coordinator.reconcileForEvent(target, rawIdle);
    const idleReconciliation = coordinator.reconciliationForEvent(target, rawIdle, idleResult);
    expect(coordinator.decisionForEvent(target, rawIdle, { reconciliation: idleReconciliation })).toMatchObject({
      settleEndedEarly: true,
      presentToHuman: true,
    });
    expect(derivedIdle).toHaveBeenCalledTimes(2);
    coordinator.cleanup();
  });

  it('gates startup, reconnect, restored sessions, and rejects every late lifecycle result', async () => {
    vi.useFakeTimers();
    const pending = Array.from({ length: 6 }, () => deferred<AgentEvidence>());
    const inspectionSignals: AbortSignal[] = [];
    let inspection = 0;
    const inspect = vi.fn((_project: ObservableSessionProject, signal: AbortSignal) => {
      const current = pending[inspection++];
      inspectionSignals.push(signal);
      signal.addEventListener('abort', () => undefined, { once: true });
      return current.promise;
    });
    // In WebServer this callback invalidates both light-state caches and emits
    // the session:updated SSE. Treat it as the externally visible mutation seam.
    const publishProjection = vi.fn();
    const coordinator = new SessionAgentActivityCoordinator({
      inspect,
      scheduler: new BoundedActivityScheduler(2, 1),
      onProjectionChanged: publishProjection,
    });
    const projectionWrites = new Map<string, ReturnType<typeof vi.fn>>();
    const makeSession = (
      id: string
    ): CoordinatorSession & { claudeSessionId: string | null; terminalActivityEpoch: number } => ({
      id,
      status: 'idle',
      mode: 'claude',
      workingDir: '/tmp/cod350-lifecycle',
      claudeSessionId: `${id}-conversation`,
      terminalActivityEpoch: 0,
      setActivityProjection: (projection) => projectionWrites.get(id)?.(projection),
    });
    const sessions = ['delete', 'exit', 'identity', 'tracking', 'shutdown', 'restored'].map(makeSession);
    for (const item of sessions) projectionWrites.set(item.id, vi.fn());
    for (const item of sessions) coordinator.attachSession(item);
    expect(sessions.map((item) => coordinator.project(item).activityStatus)).toEqual(Array(6).fill('checking_agents'));
    await vi.advanceTimersByTimeAsync(0);
    expect(inspect).toHaveBeenCalledTimes(1);

    // One background inspection is in flight and the rest are queued. Every lifecycle
    // invalidation must fence both categories before their old evidence lands.
    coordinator.detachSession(sessions[0]);
    coordinator.detachSession(sessions[1]);
    await Promise.resolve();
    sessions[2].claudeSessionId = 'identity-new-conversation';
    coordinator.identityChanged(sessions[2]);
    coordinator.trackingDisabled(sessions[3]);
    expect(coordinator.project(sessions[3]).activityStatus).toBe('idle');

    // A restored session is legacy while tracking is disabled, then fail-safe
    // checking immediately on reconnect until exact live evidence arrives.
    coordinator.trackingDisabled(sessions[5]);
    expect(coordinator.project(sessions[5]).activityStatus).toBe('idle');
    coordinator.trackingEnabled(sessions[5]);
    expect(coordinator.project(sessions[5]).activityStatus).toBe('checking_agents');

    coordinator.cleanup();
    expect(inspectionSignals.length).toBeGreaterThanOrEqual(1);
    expect(inspectionSignals.every((signal) => signal.aborted)).toBe(true);
    const publishCountAtShutdown = publishProjection.mock.calls.length;
    const writesAtShutdown = new Map(
      [...projectionWrites].map(([id, write]) => [id, write.mock.calls.length] as const)
    );
    for (const item of pending) {
      item.resolve({
        observation: 'live',
        semanticRevision: 99,
        exactWatcherCount: 1,
        exactWatcherAgentKeys: ['late-key'],
      });
    }
    await vi.runAllTimersAsync();
    expect(publishProjection).toHaveBeenCalledTimes(publishCountAtShutdown);
    for (const [id, write] of projectionWrites) {
      expect(write).toHaveBeenCalledTimes(writesAtShutdown.get(id)!);
    }
    expect(coordinator.project(sessions[0]).activityStatus).toBe('idle');
    expect(coordinator.project(sessions[1]).activityStatus).toBe('idle');
    expect(coordinator.project(sessions[2]).activityStatus).toBe('idle');
    expect(coordinator.project(sessions[3]).activityStatus).toBe('idle');
    expect(coordinator.project(sessions[4]).activityStatus).toBe('idle');
    expect(coordinator.project(sessions[5]).activityStatus).toBe('idle');
  });
});
