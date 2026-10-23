/**
 * Mock context for route handler testing.
 *
 * Satisfies ALL port interfaces (SessionPort, EventPort, RespawnPort,
 * ConfigPort, InfraPort, AuthPort) so any route module can be tested.
 * Override specific methods in individual tests as needed.
 *
 * Uses app.inject() — no real HTTP ports needed.
 */
import { vi } from 'vitest';
import { MockSession, createMockSession } from './mock-session.js';
import { resolveTerminalHistoryConfig } from '../../src/config/terminal-history.js';
import type { SessionCreationOptions } from '../../src/web/ports/session-port.js';

/**
 * Creates a mock context that satisfies all port interfaces.
 * Pre-populated with one session for convenience.
 */
export function createMockRouteContext(options?: {
  sessionId?: string;
  agentSkillEnabled?: boolean;
  claudeVoiceEnabled?: boolean;
  workspaceHooksEnabled?: boolean;
}) {
  const sessionId = options?.sessionId ?? 'test-session-1';
  const session = createMockSession(sessionId);
  const sessions = new Map<string, MockSession>();
  sessions.set(sessionId, session);

  // Stateful backing for the global tab order (COD-131) so route tests can
  // assert that setSessionOrder() actually persists what the handler computed.
  let sessionOrder: string[] = [];

  return {
    // -- SessionPort --
    sessions,
    addSession: vi.fn(async (s: MockSession, _options?: SessionCreationOptions) => {
      sessions.set(s.id, s);
      const layout = {
        version: 0,
        groups: [],
        ungrouped: [{ kind: 'session' as const, id: s.id }],
        updatedAt: '1970-01-01T00:00:00.000Z',
      };
      return { layout, placements: [] };
    }),
    tabLayouts: {
      get: vi.fn(),
      put: vi.fn(),
      putLegacyOrder: vi.fn(async (_actor: unknown, order: readonly string[]) => ({
        order: [...order],
        changedOwnerOrders: {},
        globalOrder: [...order],
        globalChanged: false,
      })),
      sessionCreated: vi.fn(),
      webviewCreated: vi.fn(),
      sessionsRemoved: vi.fn(async () => {}),
      webviewDeleted: vi.fn(async () => {}),
      markRestorationComplete: vi.fn(),
      markRestorationFailed: vi.fn(),
      markRestorationSkipped: vi.fn(),
      assertDeletionReady: vi.fn(),
      runSessionDeletion: vi.fn(async (_removed, action) => action()),
      runStaleSessionCleanup: vi.fn(async (_activeIds, action) => action(new Set())),
      reconcileAfterRestoration: vi.fn(async () => {}),
      caseDefaultGroup: vi.fn(async () => ({ groupId: null, groups: [] })),
      setCaseDefaultGroup: vi.fn(async (_owner: string, _caseName: string, groupId: string | null) => ({
        groupId,
        groups: [],
      })),
      forgetCaseDefaultGroup: vi.fn(async () => {}),
    },
    cleanupSession: vi.fn(async () => {}),
    cleanupRecoveryReconnectWrapper: vi.fn(async (id: string) => {
      sessions.delete(id);
    }),
    setupSessionListeners: vi.fn(async () => {}),
    persistSessionState: vi.fn(),
    persistSessionStateNow: vi.fn(),
    reapplyPersistedSessionState: vi.fn(async () => {}),
    discardPartiallyBuiltSession: vi.fn(async (id: string) => {
      sessions.delete(id);
    }),
    getSessionStateWithRespawn: vi.fn((s: MockSession) => ({
      ...s.toState(),
      activityStatus: s.status,
      activityStatusSince: null,
    })),

    // -- AgentActivityPort --
    // COD-350. Defaults mirror a session with no background agents: every hook
    // event is presented to the human, and the projection is the session's
    // `activityProjection` when a test sets one, else its own status (what the
    // real server returns for a session it has no adapter for). Upstream merges
    // have dropped this block before (4a5a9d14); the completeness test guards it.
    agentActivity: {
      attachSession: vi.fn(),
      detachSession: vi.fn(),
      identityChanged: vi.fn(),
      terminalActivity: vi.fn(),
      sessionExited: vi.fn(),
      setTrackingEnabled: vi.fn(),
      allocateEvent: vi.fn((s: MockSession, kind: string, externalSourceSequence?: number) => ({
        sessionId: s.id,
        identityGeneration: 0,
        trackingGeneration: 0,
        sequence: 1,
        kind,
        ...(externalSourceSequence !== undefined ? { externalSourceSequence } : {}),
      })),
      decideEvent: vi.fn(async (_s: MockSession, event: unknown) => ({
        event,
        settleEndedEarly: false,
        presentToHuman: true,
        autonomyBlocked: false,
        quarantined: false,
        ambiguous: false,
        observation: 'none' as const,
        liveEvidence: null,
      })),
      project: vi.fn(
        (s: MockSession & { activityProjection?: { activityStatus: string; activityStatusSince: number | null } }) =>
          s.activityProjection ?? { activityStatus: s.status, activityStatusSince: null }
      ),
    },

    // -- EventPort --
    broadcast: vi.fn(),
    sendPushNotifications: vi.fn(),
    batchTerminalData: vi.fn(),
    broadcastSessionStateDebounced: vi.fn(),
    batchTaskUpdate: vi.fn(),
    getSseClientCount: vi.fn(() => 0),

    // -- RespawnPort --
    respawnControllers: new Map(),
    respawnTimers: new Map(),
    setupRespawnListeners: vi.fn(),
    setupTimedRespawn: vi.fn(),
    restoreRespawnController: vi.fn(),
    saveRespawnConfig: vi.fn(),

    // -- KeepWarmPort --
    keepWarm: { schedule: vi.fn(), rescheduleAll: vi.fn(), remove: vi.fn() },

    // -- ConfigPort --
    store: {
      getConfig: vi.fn(() => ({ ralphEnabled: false, maxConcurrentSessions: 5 })),
      getSessions: vi.fn(() => ({})),
      getSession: vi.fn(),
      setSession: vi.fn(),
      removeSession: vi.fn(),
      demoteOrRemoveSession: vi.fn(() => 'removed' as const),
      getSettings: vi.fn(() => ({})),
      setSettings: vi.fn(),
      getRalphLoopState: vi.fn(() => ({})),
      setRalphLoopState: vi.fn(),
      getTasks: vi.fn(() => ({})),
      save: vi.fn(),
      load: vi.fn(),
      incrementSessionsCreated: vi.fn(),
      setConfig: vi.fn(),
      getSessionOrder: vi.fn(() => sessionOrder),
      setSessionOrder: vi.fn((order: string[]) => {
        sessionOrder = order;
      }),
      getCaseDefaultGroup: vi.fn(),
      setCaseDefaultGroup: vi.fn(),
      renameCaseDefaultGroup: vi.fn(),
      deleteCaseDefaultGroup: vi.fn(),
      getCodexCommandProfiles: vi.fn(() => []),
      setCodexCommandProfiles: vi.fn(),
      getCaseCodexCommandSelection: vi.fn(() => undefined),
      getCaseCodexCommandSelections: vi.fn(() => ({})),
      setCaseCodexCommandSelection: vi.fn(),
      renameCaseCodexCommandSelection: vi.fn(),
      deleteCaseCodexCommandSelection: vi.fn(),
      getAggregateStats: vi.fn(() => ({ totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 })),
      getGlobalStats: vi.fn(() => ({ sessionsCreated: 0 })),
      getDailyStats: vi.fn(() => []),
      cleanupStaleSessions: vi.fn(() => ({ count: 0, cleaned: [] })),
      cleanupSessionsByIds: vi.fn(() => ({ count: 0, cleaned: [] })),
    },
    port: 3000,
    https: false,
    testMode: true,
    serverStartTime: Date.now(),
    getGlobalNiceConfig: vi.fn(async () => undefined),
    getModelConfig: vi.fn(async () => null),
    getClaudeModeConfig: vi.fn(async () => ({})),
    getTerminalHistoryConfig: vi.fn(async () => resolveTerminalHistoryConfig()),
    getTruecolorEnabled: vi.fn(async () => false),
    getCheckpointDefaultEnabled: vi.fn(async () => true),
    // Default OFF mirrors the shipped setting, so existing tests never touch a
    // case's .claude/skills. Overridable per test because the create-time
    // injection call sites are otherwise unreachable from a route test.
    getAgentSkillEnabled: vi.fn(async () => options?.agentSkillEnabled ?? false),
    // Default OFF mirrors the shipped setting: no test opens a voice relay by accident.
    getClaudeVoiceEnabled: vi.fn(async () => options?.claudeVoiceEnabled ?? false),
    // Default ON mirrors the shipped setting, so a route test sees what a user sees.
    // Writes land in the test's temp working dir, never in a real repo.
    getWorkspaceHooksEnabled: vi.fn(async () => options?.workspaceHooksEnabled ?? true),
    getDefaultClaudeMdPath: vi.fn(async () => undefined),
    getLightState: vi.fn(() => ({ sessions: [], status: 'ok' })),
    getLightSessionsState: vi.fn(() => {
      const result: Record<string, unknown>[] = [];
      for (const s of sessions.values()) {
        result.push(s.toState());
      }
      return result;
    }),
    startTranscriptWatcher: vi.fn(),
    stopTranscriptWatcher: vi.fn(),
    getTranscriptPath: vi.fn(() => null),
    getReadMyMindModel: vi.fn(async () => 'claude-opus-4-5-20251101'),

    // -- InfraPort --
    mux: {
      muxSocket: 'codeman',
      createSession: vi.fn(),
      killSession: vi.fn(),
      listSessions: vi.fn(() => []),
      getStats: vi.fn(() => ({})),
      updateSessionName: vi.fn(() => true),
      setHistoryLimit: vi.fn(async () => {}),
      getSession: vi.fn(() => null),
      clearRespawnConfig: vi.fn(),
      updateRespawnConfig: vi.fn(),
      startStatsCollection: vi.fn(),
    },
    runSummaryTrackers: new Map(),
    activePlanOrchestrators: new Map(),
    scheduledRuns: new Map(),
    teamWatcher: { getTeams: vi.fn(() => []), getTeamTasks: vi.fn(() => []), hasActiveTeammates: vi.fn(() => false) },
    tunnelManager: null,
    pushStore: null,
    startScheduledRun: vi.fn(),
    stopScheduledRun: vi.fn(),

    // -- AuthPort --
    authSessions: null,
    qrAuthFailures: null,
    // https already declared above in ConfigPort (shared property)

    // -- OrchestratorPort --
    orchestratorLoop: null,
    initOrchestratorLoop: vi.fn(),

    // Convenience accessors (not part of any port interface)
    _session: session,
    _sessionId: sessionId,
  };
}

export type MockRouteContext = ReturnType<typeof createMockRouteContext>;
