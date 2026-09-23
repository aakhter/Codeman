import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { SessionAgentActivityCoordinator } from '../src/session-agent-activity-coordinator.js';
import { createSessionListeners } from '../src/web/session-listener-wiring.js';
import { SseEvent } from '../src/web/sse-events.js';
import { approvalInbox } from '../src/web/approval-inbox.js';

function listenerDeps(frame = '› ready for another prompt') {
  return {
    broadcast: vi.fn(),
    batchTerminalData: vi.fn(),
    batchTaskUpdate: vi.fn(),
    broadcastSessionStateDebounced: vi.fn(),
    sendPushNotifications: vi.fn(),
    persistSessionState: vi.fn(),
    getSessionStateWithRespawn: vi.fn(() => ({})),
    getRunSummaryTracker: vi.fn(() => undefined),
    stopTranscriptWatcher: vi.fn(),
    cleanupSessionBatches: vi.fn(),
    cancelPersistDebounce: vi.fn(),
    removeRunSummaryTracker: vi.fn(),
    removeSessionListenerRefs: vi.fn(),
    cleanupRespawnOnExit: vi.fn(),
    getStore: vi.fn(() => ({ updateRalphState: vi.fn() })),
    registerAttachment: vi.fn(async () => undefined),
    agentActivity: {
      terminalActivity: vi.fn(),
      sessionExited: vi.fn(),
      allocateEvent: vi.fn((_session, kind) => ({ sequence: 1, kind })),
      decideEvent: vi.fn((_session, event) => ({ event, presentToHuman: true, settleEndedEarly: false })),
    },
    mux: { capturePaneBuffer: vi.fn(() => frame) },
  } as unknown as Parameters<typeof createSessionListeners>[1];
}

afterEach(() => {
  for (const item of approvalInbox.listPending()) {
    approvalInbox.resolveForSession(item.sessionId, 'dismissed');
  }
  approvalInbox.onPending = approvalInbox.onUpdated = approvalInbox.onResolved = undefined;
});

describe('session listener wiring', () => {
  it('suppresses raw idle effects while the coordinator reports live agents', async () => {
    const session = new Session({ id: 'wiring-agent-idle-suppressed', workingDir: '/tmp', mode: 'claude' });
    const deps = listenerDeps();
    deps.agentActivity.decideEvent.mockResolvedValue({
      presentToHuman: false,
      settleEndedEarly: false,
      autonomyBlocked: true,
    });
    const refs = createSessionListeners(session, deps as never);

    refs.idle({ reason: 'turn-end' });
    await Promise.resolve();

    expect(deps.agentActivity.allocateEvent).toHaveBeenCalledWith(session, 'raw_idle');
    expect(deps.broadcast).not.toHaveBeenCalledWith(SseEvent.SessionIdle, expect.anything());
    expect(approvalInbox.getForSession(session.id)).toBeUndefined();
  });

  it('fails safe without legacy idle effects when raw-idle reconciliation errors', async () => {
    const session = new Session({ id: 'wiring-agent-idle-unknown', workingDir: '/tmp', mode: 'claude' });
    const deps = listenerDeps();
    deps.agentActivity.decideEvent.mockRejectedValue(new Error('inspection unavailable'));
    const refs = createSessionListeners(session, deps as never);

    refs.idle({ reason: 'turn-end' });
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.broadcast).not.toHaveBeenCalledWith(SseEvent.SessionIdle, expect.anything());
  });

  it('invalidates coordinated activity before output, working, and exit broadcasts', () => {
    const session = new Session({ id: 'wiring-agent-activity', workingDir: '/tmp', mode: 'claude' });
    const order: string[] = [];
    const deps = listenerDeps();
    deps.agentActivity.terminalActivity.mockImplementation(() => order.push('activity'));
    deps.agentActivity.sessionExited.mockImplementation(() => order.push('exit-activity'));
    deps.batchTerminalData.mockImplementation(() => order.push('terminal'));
    deps.broadcast.mockImplementation((event: string) => order.push(event));
    const refs = createSessionListeners(session, deps as never);

    refs.terminalActivity();
    refs.terminal('x');
    expect(order.slice(0, 2)).toEqual(['activity', 'terminal']);

    order.length = 0;
    refs.working();
    expect(order[0]).toBe('activity');

    order.length = 0;
    refs.exit(0);
    expect(order[0]).toBe('exit-activity');
  });

  it('forwards the attachment request source through registerAttachment', async () => {
    const session = new Session({ id: 'wiring-attach-source-test', workingDir: '/tmp', mode: 'codex' });
    const registerAttachment = vi.fn(async () => undefined);
    const deps = { registerAttachment } as unknown as Parameters<typeof createSessionListeners>[1];

    const refs = createSessionListeners(session, deps);
    refs.attachmentRequested({ path: '/tmp/mockup.png', source: 'codex-generated' });
    refs.attachmentRequested({ path: '/tmp/report.pdf', source: 'external' });

    expect(registerAttachment).toHaveBeenNthCalledWith(
      1,
      'wiring-attach-source-test',
      '/tmp/mockup.png',
      'codex-generated'
    );
    expect(registerAttachment).toHaveBeenNthCalledWith(2, 'wiring-attach-source-test', '/tmp/report.pdf', 'external');
  });

  it('forwards one checkpoint progress payload to session:checkpoint', () => {
    const session = new Session({ id: 'wiring-checkpoint-test', workingDir: '/tmp', mode: 'codex' });
    const broadcast = vi.fn();
    const broadcastSessionStateDebounced = vi.fn();
    const persistSessionState = vi.fn();
    const deps = {
      broadcast,
      broadcastSessionStateDebounced,
      persistSessionState,
      registerAttachment: vi.fn(),
    } as unknown as Parameters<typeof createSessionListeners>[1];
    const refs = createSessionListeners(session, deps);

    refs.checkpointProgress({
      mode: 'compact',
      phase: 'failed',
      step: 'continue',
      attempt: 2,
      stage: 'enter',
      reason: 'continuation-delivery-failed',
      updatedAt: 123,
    });

    expect(broadcast).toHaveBeenCalledWith(SseEvent.SessionCheckpoint, {
      sessionId: 'wiring-checkpoint-test',
      mode: 'compact',
      phase: 'failed',
      step: 'continue',
      attempt: 2,
      stage: 'enter',
      reason: 'continuation-delivery-failed',
      updatedAt: 123,
    });
    expect(broadcastSessionStateDebounced).toHaveBeenCalledWith('wiring-checkpoint-test');
    expect(persistSessionState).toHaveBeenCalledWith(session);
  });

  it("preserves the legacy session:checkpoint phase:'start' payload without persisting twice", () => {
    const session = new Session({ id: 'wiring-checkpoint-start-test', workingDir: '/tmp', mode: 'codex' });
    const broadcast = vi.fn();
    const persistSessionState = vi.fn();
    const deps = {
      broadcast,
      broadcastSessionStateDebounced: vi.fn(),
      persistSessionState,
      registerAttachment: vi.fn(),
    } as unknown as Parameters<typeof createSessionListeners>[1];
    const refs = createSessionListeners(session, deps);

    refs.checkpointStart({ mode: 'new', runId: 'new-run' });

    expect(broadcast).toHaveBeenCalledWith(SseEvent.SessionCheckpoint, {
      sessionId: 'wiring-checkpoint-start-test',
      phase: 'start',
      mode: 'new',
      runId: 'new-run',
    });
    expect(persistSessionState).not.toHaveBeenCalled();
  });
});

describe('Codex Approvals Inbox idle wiring', () => {
  it('commits one Codex turn-end after terminal output through the real activity coordinator', () => {
    const session = new Session({ id: 'wiring-codex-real-coordinator', workingDir: '/tmp', mode: 'codex' });
    (session as unknown as { _status: 'idle' })._status = 'idle';
    const coordinator = new SessionAgentActivityCoordinator();
    coordinator.attachSession(session);
    const deps = listenerDeps();
    deps.agentActivity.terminalActivity.mockImplementation(() => coordinator.onTerminalOutput(session));
    deps.agentActivity.allocateEvent.mockImplementation((_session, kind) => coordinator.allocateEvent(session, kind));
    deps.agentActivity.decideEvent.mockImplementation((_session, event) =>
      coordinator.decisionForEvent(session, event)
    );
    const refs = createSessionListeners(session, deps as never);
    session.on('terminalActivity', refs.terminalActivity);
    session.on('terminal', refs.terminal);
    const initialEpoch = session.terminalActivityEpoch;

    (session as unknown as { _handleTerminalOutput(data: string): void })._handleTerminalOutput(
      'idle composer repaint'
    );
    refs.idle({ reason: 'turn-end' });

    expect(session.terminalActivityEpoch).toBe(initialEpoch + 1);
    expect(approvalInbox.getForSession(session.id)).toMatchObject({ kind: 'idle', mode: 'codex', sourceSequence: 1 });
    expect(deps.broadcast).toHaveBeenCalledTimes(1);
    expect(deps.broadcast).toHaveBeenCalledWith(SseEvent.SessionIdle, { id: session.id });
  });

  it.each([
    { mode: 'codex', reason: 'turn-end', creates: true },
    { mode: 'codex', reason: 'initial-ready', creates: false },
    { mode: 'claude', reason: 'turn-end', creates: false },
    { mode: 'gemini', reason: 'turn-end', creates: false },
  ] as const)('$mode + $reason creates=$creates', ({ mode, reason, creates }) => {
    const session = new Session({ id: `wiring-${mode}-${reason}`, workingDir: '/tmp', mode });
    (session as unknown as { _muxSession: { muxName: string } })._muxSession = {
      muxName: `codeman-test-${mode}`,
    };
    const refs = createSessionListeners(session, listenerDeps());

    refs.idle({ reason });

    const item = approvalInbox.getForSession(session.id);
    expect(Boolean(item)).toBe(creates);
    if (creates) {
      expect(item).toMatchObject({ kind: 'idle', mode: 'codex', sourceSequence: 1 });
      expect(item?.context).toBeTruthy();
    }
  });

  it('does not supersede an existing acknowledged idle item', () => {
    const session = new Session({ id: 'wiring-codex-dedupe', workingDir: '/tmp', mode: 'codex' });
    const refs = createSessionListeners(session, listenerDeps());
    refs.idle({ reason: 'turn-end' });
    const first = approvalInbox.getForSession(session.id)!;
    approvalInbox.acknowledge(session.id);

    refs.idle({ reason: 'turn-end' });

    const second = approvalInbox.getForSession(session.id)!;
    expect(second.id).toBe(first.id);
    expect(second.acknowledgedAt).toBe(first.acknowledgedAt);
  });

  it('creates a later item for terminal-driven turns whose submit timestamp is unchanged', () => {
    const session = new Session({ id: 'wiring-codex-terminal-turns', workingDir: '/tmp', mode: 'codex' });
    const refs = createSessionListeners(session, listenerDeps());
    refs.idle({ reason: 'turn-end' });
    const first = approvalInbox.getForSession(session.id)!;

    refs.working();
    expect(approvalInbox.getForSession(session.id)).toBeUndefined();
    refs.idle({ reason: 'turn-end' });

    const second = approvalInbox.getForSession(session.id);
    expect(second).toMatchObject({ kind: 'idle', mode: 'codex' });
    expect(second?.id).not.toBe(first.id);
  });

  it('sends the existing actionless idle push for a Codex approval', () => {
    const session = new Session({ id: 'wiring-codex-push', workingDir: '/tmp', mode: 'codex' });
    const deps = listenerDeps();
    const refs = createSessionListeners(session, deps);

    refs.idle({ reason: 'turn-end' });

    const item = approvalInbox.getForSession(session.id)!;
    expect(deps.sendPushNotifications).toHaveBeenCalledWith(SseEvent.HookIdlePrompt, {
      sessionId: session.id,
      sessionName: session.name,
      approvalId: item.id,
      approvalsInboxOnly: true,
    });
  });

  it('resolves the Codex idle item on working and exit', () => {
    const session = new Session({ id: 'wiring-codex-resolve', workingDir: '/tmp', mode: 'codex' });
    const refs = createSessionListeners(session, listenerDeps());

    refs.idle({ reason: 'turn-end' });
    refs.working();
    expect(approvalInbox.getForSession(session.id)).toBeUndefined();

    refs.idle({ reason: 'turn-end' });
    expect(approvalInbox.getForSession(session.id)).toBeDefined();
    refs.exit(0);
    expect(approvalInbox.getForSession(session.id)).toBeUndefined();
  });
  /** The listener reads the setting asynchronously; let its promise chain settle. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

  function autoNameDeps(session: Session, enabled: boolean) {
    const deps = {
      updateSessionName: vi.fn(() => true),
      persistSessionState: vi.fn(),
      broadcast: vi.fn(),
      getSessionStateWithRespawn: vi.fn(() => session.toState()),
      isAutoNameEnabled: vi.fn(async () => enabled),
    };
    return {
      deps,
      refs: createSessionListeners(session, deps as unknown as Parameters<typeof createSessionListeners>[1]),
    };
  }

  it('names a placeholder tab after its first real prompt, in the prefix form, once', async () => {
    const session = new Session({ id: 'wiring-auto-name-test', workingDir: '/tmp', name: 'w1-demo' });
    const { deps, refs } = autoNameDeps(session, true);

    // A slash command yields no title and leaves the session eligible; the
    // setting is not even read for it.
    refs.promptSubmitted('/clear');
    await flush();
    expect(deps.isAutoNameEnabled).not.toHaveBeenCalled();
    expect(session.name).toBe('w1-demo');

    refs.promptSubmitted('整理登录模块并补充测试');
    await flush();
    expect(session.name).toBe('w1-demo: 整理登录模块并补充测试');
    expect(session.nameSource).toBe('auto');
    expect(deps.updateSessionName).toHaveBeenCalledWith('wiring-auto-name-test', 'w1-demo: 整理登录模块并补充测试');
    expect(deps.persistSessionState).toHaveBeenCalledWith(session);
    expect(deps.broadcast).toHaveBeenCalledWith(
      SseEvent.SessionUpdated,
      expect.objectContaining({ name: 'w1-demo: 整理登录模块并补充测试', nameSource: 'auto' })
    );

    // The second prompt never reaches the setting: the tab is named.
    refs.promptSubmitted('1');
    await flush();
    expect(deps.isAutoNameEnabled).toHaveBeenCalledTimes(1);
    expect(session.name).toBe('w1-demo: 整理登录模块并补充测试');
  });

  it('leaves the tab alone while the setting is off, and never touches a manual name', async () => {
    const session = new Session({ id: 'wiring-auto-name-off', workingDir: '/tmp', name: 'w1-demo' });
    const { deps, refs } = autoNameDeps(session, false);

    refs.promptSubmitted('fix the login bug');
    await flush();
    expect(deps.isAutoNameEnabled).toHaveBeenCalledTimes(1);
    expect(session.name).toBe('w1-demo');
    // Still a placeholder: flipping the setting on names the NEXT prompt.
    expect(session.nameSource).toBe('placeholder');
    expect(deps.updateSessionName).not.toHaveBeenCalled();

    session.name = '人工命名';
    refs.promptSubmitted('新的任务不能覆盖人工命名');
    await flush();
    expect(deps.isAutoNameEnabled).toHaveBeenCalledTimes(1);
    expect(session.name).toBe('人工命名');
    expect(deps.persistSessionState).not.toHaveBeenCalled();
  });
});
