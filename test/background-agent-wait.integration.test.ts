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
import { RespawnController } from '../src/respawn-controller.js';
import { Session } from '../src/session.js';
import { subagentWatcher, type SubagentInfo } from '../src/subagent-watcher.js';
import type { ProcessInspectionSource } from '../src/subagent-process-inspector.js';
import { approvalInbox } from '../src/web/approval-inbox.js';
import { SseEvent } from '../src/web/sse-events.js';
import { WebServer, subagentConversationIdForCleanup } from '../src/web/server.js';
import { SessionWaitRegistry, sessionWaits } from '../src/web/session-wait-registry.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function internals(server: WebServer) {
  return server as unknown as {
    app: {
      inject(options: Record<string, unknown>): Promise<{ statusCode: number; json(): unknown }>;
    };
    setupRoutes(): Promise<void>;
    createRouteContext(): {
      addSession(session: Session): Promise<unknown>;
      setupSessionListeners(session: Session): void;
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
  it('resolves restored and newly attached server sessions from checking to exact live on reconnect', async () => {
    const server = new WebServer(0, false, true);
    activeServers.add(server);
    const state = internals(server);
    await state.setupRoutes();
    const ctx = state.createRouteContext();
    ctx.agentActivity.setTrackingEnabled(false);

    const restored = new Session({ id: 'restored-parent', workingDir: '/tmp/cod350-restore', mode: 'claude' });
    restored.adoptClaudeSessionId('restored-conversation');
    setRawIdle(restored);
    const fresh = new Session({ id: 'fresh-parent', workingDir: '/tmp/cod350-fresh', mode: 'claude' });
    fresh.adoptClaudeSessionId('fresh-conversation');
    setRawIdle(fresh);
    const evidence = new Map([
      [restored.claudeSessionId!, [agent(restored, 'restored-agent')]],
      [fresh.claudeSessionId!, [agent(fresh, 'fresh-agent')]],
    ]);
    const reconciliations = new Map<string, ReturnType<typeof deferred<SubagentInfo[]>>>();
    vi.spyOn(subagentWatcher, 'reconcileConversation').mockImplementation((_projectHash, conversationId) => {
      let pending = reconciliations.get(conversationId);
      if (!pending) {
        pending = deferred<SubagentInfo[]>();
        reconciliations.set(conversationId, pending);
      }
      return pending.promise;
    });
    vi.spyOn(subagentWatcher, 'getSemanticSnapshot').mockImplementation((_projectHash, conversationId) => ({
      revision: 1,
      agents: evidence.get(conversationId) ?? [],
    }));

    await ctx.addSession(restored);
    expect(restored.activityProjection.activityStatus).toBe('idle');
    ctx.agentActivity.setTrackingEnabled(true);
    expect(restored.activityProjection.activityStatus).toBe('checking_agents');
    await vi.waitFor(() => expect(reconciliations.has(restored.claudeSessionId!)).toBe(true));
    reconciliations.get(restored.claudeSessionId!)!.resolve(evidence.get(restored.claudeSessionId!)!);
    await vi.waitFor(() => expect(restored.activityProjection.activityStatus).toBe('waiting_agents'));

    const addingFresh = ctx.addSession(fresh);
    await vi.waitFor(() => expect(reconciliations.has(fresh.claudeSessionId!)).toBe(true));
    expect(fresh.activityProjection.activityStatus).toBe('checking_agents');
    expect(state.sessions.has(fresh.id)).toBe(false);
    reconciliations.get(fresh.claudeSessionId!)!.resolve(evidence.get(fresh.claudeSessionId!)!);
    await addingFresh;
    expect(fresh.activityProjection.activityStatus).toBe('waiting_agents');

    // A reconnect reads the canonical server serialization, not a browser-local
    // reconstruction of watcher state.
    const reconnect = await state.app.inject({ method: 'GET', url: '/api/sessions' });
    expect(reconnect.statusCode).toBe(200);
    const rows = (reconnect.json() as { data: Array<Record<string, unknown>> }).data;
    expect(rows.find((row) => row.id === restored.id)).toMatchObject({
      status: 'idle',
      activityStatus: 'waiting_agents',
      activityStatusSince: expect.any(Number),
    });
    expect(rows.find((row) => row.id === fresh.id)).toMatchObject({
      status: 'idle',
      activityStatus: 'waiting_agents',
      activityStatusSince: expect.any(Number),
    });

    await server.stop();
    activeServers.delete(server);
  });

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
    ctx.setupSessionListeners(parent);
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

  it('publishes one natural derived-idle edge when the final watcher agent settles', async () => {
    vi.useFakeTimers();
    const server = new WebServer(0, false, true);
    activeServers.add(server);
    const state = internals(server);
    const ctx = state.createRouteContext();
    const parent = new Session({ id: 'natural-settle', workingDir: '/tmp/cod350-natural-settle', mode: 'claude' });
    parent.adoptClaudeSessionId('natural-settle-conversation');
    setRawIdle(parent);
    const finalAgent = agent(parent, 'final-agent');
    let snapshot = { revision: 0, agents: [] as SubagentInfo[] };
    vi.spyOn(subagentWatcher, 'reconcileConversation').mockResolvedValue([]);
    vi.spyOn(subagentWatcher, 'getSemanticSnapshot').mockImplementation(() => snapshot);
    await ctx.addSession(parent);
    ctx.setupSessionListeners(parent);
    state.sse.broadcast = vi.fn();
    // WebServer owns the process singleton in production. Use a fresh concrete
    // registry as the consumer so earlier server-shutdown tests cannot leave its
    // one-way shutdown latch set, and forward the real producer call into it.
    const waitRegistry = new SessionWaitRegistry();
    const notifySignal = vi
      .spyOn(sessionWaits, 'notifySignal')
      .mockImplementation((sessionId, signal) => waitRegistry.notifySignal(sessionId, signal));

    snapshot = { revision: 1, agents: [finalAgent] };
    subagentWatcher.emit('subagent:discovered', finalAgent);
    expect(parent.activityProjection.activityStatus).toBe('waiting_agents');
    state.sse.broadcast.mockClear();
    notifySignal.mockClear();
    const waiterDelivered = vi.fn();
    const idleWait = waitRegistry
      .waitForSignal(parent.id, {
        until: ['idle'],
        timeoutMs: FINAL_AGENT_SETTLE_MS * 4,
      })
      .then((result) => {
        waiterDelivered(result);
        return result;
      });
    expect(waitRegistry.signalWaiterCount(parent.id)).toBe(1);

    const completed = { ...finalAgent, status: 'completed' as const };
    snapshot = { revision: 2, agents: [] };
    subagentWatcher.emit('subagent:completed', completed);
    await vi.advanceTimersByTimeAsync(FINAL_AGENT_SETTLE_MS - 1);
    expect(parent.activityProjection.activityStatus).toBe('waiting_agents');
    expect(notifySignal).not.toHaveBeenCalledWith(parent.id, 'idle');

    await vi.advanceTimersByTimeAsync(1);
    expect(parent.activityProjection.activityStatus).toBe('idle');
    await expect(idleWait).resolves.toMatchObject({
      signal: 'idle',
      timedOut: false,
      immediate: false,
      ended: false,
      aborted: false,
    });
    expect(waiterDelivered).toHaveBeenCalledTimes(1);
    expect(waitRegistry.signalWaiterCount(parent.id)).toBe(0);
    expect(notifySignal.mock.calls.filter(([id, signal]) => id === parent.id && signal === 'idle')).toHaveLength(1);
    expect(
      state.sse.broadcast.mock.calls.filter(
        ([event, payload]) => event === SseEvent.SessionIdle && (payload as { id?: string }).id === parent.id
      )
    ).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(FINAL_AGENT_SETTLE_MS * 2);
    subagentWatcher.emit('subagent:completed', completed);
    await vi.advanceTimersByTimeAsync(FINAL_AGENT_SETTLE_MS);
    expect(waiterDelivered).toHaveBeenCalledTimes(1);
    expect(waitRegistry.signalWaiterCount(parent.id)).toBe(0);
    expect(notifySignal.mock.calls.filter(([id, signal]) => id === parent.id && signal === 'idle')).toHaveLength(1);
    expect(
      state.sse.broadcast.mock.calls.filter(
        ([event, payload]) => event === SseEvent.SessionIdle && (payload as { id?: string }).id === parent.id
      )
    ).toHaveLength(1);

    await server.stop();
    activeServers.delete(server);
  });

  it('blocks actual hook and heuristic respawn cycles until agent observation is none', async () => {
    vi.useFakeTimers();
    const session = new Session({ id: 'respawn-parent', workingDir: '/tmp/cod350-respawn', mode: 'claude' });
    setRawIdle(session);
    (session as unknown as { _pid: number })._pid = 237;
    const controller = new RespawnController(session, {
      completionConfirmMs: 50,
      noOutputTimeoutMs: 500,
      idleTimeoutMs: 500,
      aiIdleCheckEnabled: false,
      adaptiveTimingEnabled: false,
    });
    const cycleStarted = vi.fn();
    controller.on('respawnCycleStarted', cycleStarted);
    controller.start();

    session.setActivityProjection({ activityStatus: 'waiting_agents', activityStatusSince: Date.now() });
    controller.signalIdlePrompt();
    expect(cycleStarted).not.toHaveBeenCalled();
    expect(controller.getDetectionStatus()).toMatchObject({
      idlePromptReceived: false,
      completionMessageDetected: false,
    });

    session.setActivityProjection({ activityStatus: 'checking_agents', activityStatusSince: Date.now() });
    session.emit('terminal', 'Worked for 1s\n❯');
    await vi.advanceTimersByTimeAsync(200);
    expect(cycleStarted).not.toHaveBeenCalled();
    expect(controller.state).toBe('watching');
    expect(controller.getDetectionStatus().completionMessageDetected).toBe(false);

    session.setActivityProjection({ activityStatus: 'idle', activityStatusSince: null });
    controller.signalIdlePrompt();
    expect(cycleStarted).toHaveBeenCalledTimes(1);
    controller.stop();
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

  it('aborts an in-flight inspection on the actual PTY-exit listener without late projection publication', async () => {
    const processRead = deferred<number[]>();
    let inspectionSignal: AbortSignal | undefined;
    const processSource: ProcessInspectionSource = {
      listPids: (signal) => {
        inspectionSignal = signal;
        return processRead.promise;
      },
      readCmdline: async () => '',
      readEnviron: async () => '',
      statProcessCwd: async () => ({ dev: 1, ino: 1 }),
      statWorkingDirectory: async () => ({ dev: 1, ino: 1 }),
    };
    const server = new WebServer(0, false, true, '127.0.0.1', undefined, false, {
      runtimeVersion: '2.1.237',
      source: processSource,
    });
    activeServers.add(server);
    const state = internals(server);
    state.mux.capturePaneText = vi.fn(() => visibleWaitingFrame(1));
    await state.setupRoutes();
    const ctx = state.createRouteContext();
    const session = new Session({ id: 'pty-exit-parent', workingDir: '/tmp/cod350-pty-exit', mode: 'claude' });
    session.adoptClaudeSessionId('pty-exit-conversation');
    setRawIdle(session);
    const liveAgent = agent(session, 'exit-agent');
    vi.spyOn(subagentWatcher, 'reconcileConversation').mockResolvedValue([]);
    vi.spyOn(subagentWatcher, 'getSemanticSnapshot').mockReturnValue({ revision: 1, agents: [liveAgent] });
    await ctx.addSession(session);
    ctx.setupSessionListeners(session);
    (session as unknown as { _muxSession: { muxName: string } })._muxSession = { muxName: 'cod350-exit-mux' };
    subagentWatcher.emit('subagent:discovered', liveAgent);
    expect(session.activityProjection.activityStatus).toBe('waiting_agents');
    state.sse.broadcast = vi.fn();

    const hook = state.app.inject({
      method: 'POST',
      url: '/api/hook-event',
      payload: { event: 'idle_prompt', sessionId: session.id, data: null },
    });
    await vi.waitFor(() => expect(inspectionSignal).toBeDefined());

    // This is the real Session event wired by WebServer.setupSessionListeners;
    // it is not a direct coordinator detach shortcut.
    session.emit('exit', 0);
    expect(inspectionSignal?.aborted).toBe(true);
    expect(state.activityAdapters.has(session)).toBe(false);
    const sessionUpdatesAtExit = state.sse.broadcast.mock.calls.filter(
      ([event, payload]) => event === SseEvent.SessionUpdated && (payload as { id?: string }).id === session.id
    ).length;
    const lightCacheAfterExit = { data: { exit: true }, timestamp: Date.now() };
    const listCacheAfterExit = { data: [{ id: session.id }], timestamp: Date.now() };
    state.cachedLightState = lightCacheAfterExit;
    state.cachedSessionsList = listCacheAfterExit;

    processRead.resolve([237]);
    expect((await hook).statusCode).toBe(200);
    await Promise.resolve();
    expect(session.activityProjection).toEqual({ activityStatus: 'idle', activityStatusSince: null });
    expect(state.cachedLightState).toBe(lightCacheAfterExit);
    expect(state.cachedSessionsList).toBe(listCacheAfterExit);
    expect(
      state.sse.broadcast.mock.calls.filter(
        ([event, payload]) => event === SseEvent.SessionUpdated && (payload as { id?: string }).id === session.id
      )
    ).toHaveLength(sessionUpdatesAtExit);

    await server.stop();
    activeServers.delete(server);
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
