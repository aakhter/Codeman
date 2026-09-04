/**
 * @fileoverview Tests for StateStore
 *
 * Tests the persistent JSON state storage including
 * debounced saves, state CRUD operations, and Ralph state management.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, unlinkSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Import types before mocking
import type { AppState, SessionState, TaskState, RalphSessionState } from '../src/types.js';

// We need to import without mocking to test the actual implementation
import { StateStore, getStore } from '../src/state-store.js';
import type { SessionRecoveryRecord } from '../src/types/session-recovery.js';

describe('StateStore', () => {
  const testDir = join(tmpdir(), 'codeman-test-' + Date.now());
  const testFilePath = join(testDir, 'state.json');
  const testInnerPath = join(testDir, 'state-inner.json');

  beforeEach(() => {
    // Create test directory
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }

    // Clean up any existing test files
    try {
      if (existsSync(testFilePath)) unlinkSync(testFilePath);
      if (existsSync(testInnerPath)) unlinkSync(testInnerPath);
    } catch (e) {
      // Ignore cleanup errors
    }

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();

    // Clean up test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('should create initial state when no file exists', () => {
      const store = new StateStore(testFilePath);

      const state = store.getState();
      expect(state).toBeDefined();
      expect(state.sessions).toBeDefined();
      expect(state.tasks).toBeDefined();
      expect(state.config).toBeDefined();
    });

    it('should set state file path in config', () => {
      const store = new StateStore(testFilePath);

      expect(store.getConfig().stateFilePath).toBe(testFilePath);
    });
  });

  describe('save and saveNow', () => {
    it('should debounce saves by default', () => {
      const store = new StateStore(testFilePath);

      store.setSession('test-1', createMockSessionState('test-1'));
      store.setSession('test-2', createMockSessionState('test-2'));

      // File should not exist yet (debounced — save is scheduled, not immediate)
      expect(existsSync(testFilePath)).toBe(false);

      // The debounced save uses async I/O (fs/promises writeFile/rename),
      // which can't be fully resolved under fake timers. Verify data is pending
      // by forcing a sync flush, which confirms the debounce delayed the write.
      store.flush();
      expect(existsSync(testFilePath)).toBe(true);
    });

    it('should write immediately with saveNow', () => {
      const store = new StateStore(testFilePath);

      store.setSession('test-1', createMockSessionState('test-1'));
      store.saveNow();

      expect(existsSync(testFilePath)).toBe(true);
    });

    it('should flush pending saves', () => {
      const store = new StateStore(testFilePath);

      store.setSession('test-1', createMockSessionState('test-1'));
      store.flush();

      expect(existsSync(testFilePath)).toBe(true);
    });
  });

  describe('session operations', () => {
    it('should set and get sessions', () => {
      const store = new StateStore(testFilePath);
      const sessionState = createMockSessionState('session-1');

      store.setSession('session-1', sessionState);

      expect(store.getSession('session-1')).toEqual(sessionState);
    });

    it('should return null for non-existent session', () => {
      const store = new StateStore(testFilePath);

      expect(store.getSession('non-existent')).toBeNull();
    });

    it('should remove sessions', () => {
      const store = new StateStore(testFilePath);
      store.setSession('session-1', createMockSessionState('session-1'));

      store.removeSession('session-1');

      expect(store.getSession('session-1')).toBeNull();
    });

    it('should get all sessions', () => {
      const store = new StateStore(testFilePath);
      store.setSession('session-1', createMockSessionState('session-1'));
      store.setSession('session-2', createMockSessionState('session-2'));

      const sessions = store.getSessions();

      expect(Object.keys(sessions)).toHaveLength(2);
      expect(sessions['session-1']).toBeDefined();
      expect(sessions['session-2']).toBeDefined();
    });
  });

  describe('session recovery operations', () => {
    it('clones recovery records at the StateStore boundary', () => {
      const store = new StateStore(testFilePath);
      const record = createMockSessionRecoveryRecord('recovery-1');

      store.setSessionRecoveries([record]);
      record.status = 'recovered';
      const recoveries = store.getSessionRecoveries();
      recoveries[0].status = 'recovered';

      expect(store.getSessionRecoveries()[0].status).toBe('pending');
    });

    it('upserts, removes, and persists recovery records independently of active sessions', () => {
      const store = new StateStore(testFilePath);
      const first = createMockSessionRecoveryRecord('first');
      const updated = { ...first, status: 'resumable' as const, nativeResumeId: 'rollout-1' };

      store.upsertSessionRecovery(first);
      store.upsertSessionRecovery(updated);
      store.upsertSessionRecovery(createMockSessionRecoveryRecord('second'));
      store.removeSessionRecovery('second');
      store.flushAll();

      expect(store.getSession('session-first')).toBeNull();
      expect(store.getSessionRecoveries()).toEqual([updated]);
      expect(JSON.parse(readFileSync(testFilePath, 'utf-8')).sessionRecoveries).toEqual([updated]);
      expect(new StateStore(testFilePath).getSessionRecoveries()).toEqual([updated]);
    });

    it('retains at most 200 terminal records per owner without removing pending records', () => {
      const store = new StateStore(testFilePath);
      const terminal = Array.from({ length: 201 }, (_, index) => ({
        ...createMockSessionRecoveryRecord(`terminal-${index}`),
        status: 'recovered' as const,
        createdAt: index,
      }));

      store.setSessionRecoveries([...terminal, createMockSessionRecoveryRecord('pending')]);

      const recoveries = store.getSessionRecoveries();
      expect(recoveries).toHaveLength(201);
      expect(recoveries.filter((record) => record.status === 'recovered')).toHaveLength(200);
      expect(recoveries.some((record) => record.id === 'terminal-0')).toBe(false);
      expect(recoveries.some((record) => record.id === 'pending')).toBe(true);
    });

    it('sanitizes manual recovery hints supplied through set and upsert before persistence', () => {
      const store = new StateStore(testFilePath);
      const setHint = 'ssh: host=private.example password=set-secret Permission denied';
      const upsertHint = 'ssh: host=private.example password=upsert-secret Connection timed out';

      store.setSessionRecoveries([
        {
          ...createMockSessionRecoveryRecord('set-manual'),
          status: 'manual_required',
          launch: { kind: 'manual_required', hint: setHint },
        },
      ]);
      store.upsertSessionRecovery({
        ...createMockSessionRecoveryRecord('upsert-manual'),
        status: 'manual_required',
        launch: { kind: 'manual_required', hint: upsertHint },
      });
      store.flushAll();

      expect(store.getSessionRecoveries().map((record) => record.launch)).toEqual([
        {
          kind: 'manual_required',
          hint: 'Manual recovery is required. Start a new session from the original working directory.',
        },
        {
          kind: 'manual_required',
          hint: 'Manual recovery is required. Start a new session from the original working directory.',
        },
      ]);
      const serialized = readFileSync(testFilePath, 'utf-8');
      expect(serialized).not.toContain(setHint);
      expect(serialized).not.toContain(upsertHint);
      expect(serialized).not.toContain('set-secret');
      expect(serialized).not.toContain('upsert-secret');
    });
  });

  describe('case default groups', () => {
    it('distinguishes unset defaults from intentional Ungrouped values per owner', () => {
      const store = new StateStore(testFilePath);

      expect(store.getCaseDefaultGroup('alice', 'nzbdav')).toBeUndefined();

      store.setCaseDefaultGroup('alice', 'nzbdav', 'group-nzbdav');
      store.setCaseDefaultGroup('bob', 'nzbdav', null);

      expect(store.getCaseDefaultGroup('alice', 'nzbdav')).toBe('group-nzbdav');
      expect(store.getCaseDefaultGroup('bob', 'nzbdav')).toBeNull();
    });

    it('moves a default when its case is renamed and removes it when the case is deleted', () => {
      const store = new StateStore(testFilePath);
      store.setCaseDefaultGroup('alice', 'nzbdav', 'group-nzbdav');

      store.renameCaseDefaultGroup('alice', 'nzbdav', 'nzbdav-next');

      expect(store.getCaseDefaultGroup('alice', 'nzbdav')).toBeUndefined();
      expect(store.getCaseDefaultGroup('alice', 'nzbdav-next')).toBe('group-nzbdav');

      store.deleteCaseDefaultGroup('alice', 'nzbdav-next');

      expect(store.getCaseDefaultGroup('alice', 'nzbdav-next')).toBeUndefined();
    });

    it('treats prototype-collision owner and case names as ordinary record keys', () => {
      const store = new StateStore(testFilePath);
      store.setCaseDefaultGroup('seed-owner', 'seed-case', 'seed-group');

      expect(store.getCaseDefaultGroup('constructor', 'toString')).toBeUndefined();
      expect(store.getCaseDefaultGroup('seed-owner', 'constructor')).toBeUndefined();

      store.setCaseDefaultGroup('__proto__', 'constructor', 'group-prototype');
      store.setCaseDefaultGroup('constructor', '__proto__', null);

      expect(store.getCaseDefaultGroup('__proto__', 'constructor')).toBe('group-prototype');
      expect(store.getCaseDefaultGroup('constructor', '__proto__')).toBeNull();

      store.renameCaseDefaultGroup('__proto__', 'constructor', '__proto__');

      expect(store.getCaseDefaultGroup('__proto__', 'constructor')).toBeUndefined();
      expect(store.getCaseDefaultGroup('__proto__', '__proto__')).toBe('group-prototype');

      store.deleteCaseDefaultGroup('__proto__', '__proto__');
      store.deleteCaseDefaultGroup('constructor', '__proto__');

      expect(store.getCaseDefaultGroup('__proto__', '__proto__')).toBeUndefined();
      expect(store.getCaseDefaultGroup('constructor', '__proto__')).toBeUndefined();
    });
  });

  describe('Codex command profiles', () => {
    it('isolates profiles by owner and clones profiles at the store boundary', () => {
      const store = new StateStore(testFilePath);
      const aliceProfiles = [{ id: 'personal', name: 'Personal', command: 'exec codx personal' }];

      store.setCodexCommandProfiles('alice', aliceProfiles);
      store.setCodexCommandProfiles('bob', [{ id: 'work', name: 'Work', command: 'exec codx work' }]);
      aliceProfiles[0].name = 'Changed input';

      const aliceRead = store.getCodexCommandProfiles('alice');
      aliceRead[0].name = 'Changed output';

      expect(store.getCodexCommandProfiles('alice')).toEqual([
        { id: 'personal', name: 'Personal', command: 'exec codx personal' },
      ]);
      expect(store.getCodexCommandProfiles('bob')).toEqual([{ id: 'work', name: 'Work', command: 'exec codx work' }]);
      expect(store.getCodexCommandProfiles('constructor')).toEqual([]);
    });

    it('persists profiles across restart and includes them in the serialized state', () => {
      const store = new StateStore(testFilePath);
      const profiles = [{ id: 'personal', name: 'Personal', command: 'exec codx personal' }];

      store.setCodexCommandProfiles('alice', profiles);
      store.flushAll();

      expect(JSON.parse(readFileSync(testFilePath, 'utf-8')).codexCommandProfiles).toEqual({ alice: profiles });
      expect(new StateStore(testFilePath).getCodexCommandProfiles('alice')).toEqual(profiles);
    });
  });

  describe('Local case Codex command selections (COD-392)', () => {
    it('returns empty selections for unknown owners and clones selections at the boundary', () => {
      const store = new StateStore(testFilePath);
      expect(store.getCaseCodexCommandSelections('nobody')).toEqual({});

      store.setCaseCodexCommandSelection('alice', 'case-a', { kind: 'custom', command: 'codex a' });
      const selections = store.getCaseCodexCommandSelections('alice');
      selections['case-a'] = { kind: 'custom', command: 'mutated' } as never;

      expect(store.getCaseCodexCommandSelection('alice', 'case-a')).toEqual({
        kind: 'custom',
        command: 'codex a',
      });
    });

    it('isolates selections by owner, clears on default, and survives restart', () => {
      const store = new StateStore(testFilePath);

      expect(store.getCaseCodexCommandSelection('alice', 'case-a')).toBeUndefined();

      store.setCaseCodexCommandSelection('alice', 'case-a', { kind: 'profile', profileId: 'p1' });
      store.setCaseCodexCommandSelection('bob', 'case-a', {
        kind: 'custom',
        command: 'codex --profile bob',
      });

      expect(store.getCaseCodexCommandSelection('alice', 'case-a')).toEqual({
        kind: 'profile',
        profileId: 'p1',
      });

      store.setCaseCodexCommandSelection('alice', 'case-a', undefined);
      expect(store.getCaseCodexCommandSelection('alice', 'case-a')).toBeUndefined();
      expect(store.getCaseCodexCommandSelection('bob', 'case-a')).toEqual({
        kind: 'custom',
        command: 'codex --profile bob',
      });

      store.setCaseCodexCommandSelection('alice', 'case-b', { kind: 'custom', command: 'codex --yolo' });
      store.flushAll();

      const persisted = JSON.parse(readFileSync(testFilePath, 'utf-8')).caseCodexCommandSelections;
      expect(persisted.alice['case-b']).toEqual({ kind: 'custom', command: 'codex --yolo' });
      expect(new StateStore(testFilePath).getCaseCodexCommandSelection('alice', 'case-b')).toEqual({
        kind: 'custom',
        command: 'codex --yolo',
      });
    });

    it('renames and deletes selections including prototype-collision keys', () => {
      const store = new StateStore(testFilePath);
      store.setCaseCodexCommandSelection('alice', 'old-case', { kind: 'custom', command: 'codex a' });

      store.renameCaseCodexCommandSelection('alice', 'old-case', 'new-case');
      expect(store.getCaseCodexCommandSelection('alice', 'old-case')).toBeUndefined();
      expect(store.getCaseCodexCommandSelection('alice', 'new-case')).toEqual({
        kind: 'custom',
        command: 'codex a',
      });

      store.deleteCaseCodexCommandSelection('alice', 'new-case');
      expect(store.getCaseCodexCommandSelection('alice', 'new-case')).toBeUndefined();

      store.setCaseCodexCommandSelection('__proto__', 'constructor', { kind: 'custom', command: 'codex x' });
      expect(store.getCaseCodexCommandSelection('__proto__', 'constructor')).toEqual({
        kind: 'custom',
        command: 'codex x',
      });
    });
  });

  describe('demoteOrRemoveSession and pinned cleanup (COD-142)', () => {
    it('should preserve a pinned session as a stopped record on kill', () => {
      const store = new StateStore(testFilePath);
      const pinnedAt = Date.now();
      store.setSession('pinned-1', {
        ...createMockSessionState('pinned-1'),
        name: 'My Pinned Session',
        workingDir: '/tmp/pinned',
        pinned: true,
        pinnedAt,
      });

      const result = store.demoteOrRemoveSession('pinned-1');

      expect(result).toBe('preserved');
      const preserved = store.getSession('pinned-1');
      expect(preserved).not.toBeNull();
      expect(preserved?.status).toBe('stopped');
      expect(preserved?.pid).toBeNull();
      expect(preserved?.pinned).toBe(true);
      expect(preserved?.pinnedAt).toBe(pinnedAt);
      expect(preserved?.name).toBe('My Pinned Session');
      expect(preserved?.workingDir).toBe('/tmp/pinned');
    });

    it('should fully remove an unpinned session on kill', () => {
      const store = new StateStore(testFilePath);
      store.setSession('plain-1', createMockSessionState('plain-1'));

      const result = store.demoteOrRemoveSession('plain-1');

      expect(result).toBe('removed');
      expect(store.getSession('plain-1')).toBeNull();
    });

    it('should report absent for an unknown session id', () => {
      const store = new StateStore(testFilePath);

      expect(store.demoteOrRemoveSession('does-not-exist')).toBe('absent');
    });

    it('should keep pinned records during cleanupStaleSessions but reap unpinned ones', () => {
      const store = new StateStore(testFilePath);
      store.setSession('pinned-1', {
        ...createMockSessionState('pinned-1'),
        pinned: true,
        pinnedAt: Date.now(),
      });
      store.setSession('plain-1', createMockSessionState('plain-1'));

      const result = store.cleanupStaleSessions(new Set<string>());

      expect(result.count).toBe(1);
      expect(result.cleaned.map((c) => c.id)).toEqual(['plain-1']);
      expect(result.cleaned.some((c) => c.id === 'pinned-1')).toBe(false);
      expect(store.getSession('pinned-1')).not.toBeNull();
      expect(store.getSession('plain-1')).toBeNull();
    });

    it('cleans only requested unpinned session ids', () => {
      const store = new StateStore(testFilePath);
      store.setSession('requested', createMockSessionState('requested'));
      store.setSession('pinned', { ...createMockSessionState('pinned'), pinned: true, pinnedAt: Date.now() });
      store.setSession('unrequested', createMockSessionState('unrequested'));

      const result = store.cleanupSessionsByIds(new Set(['requested', 'pinned', 'missing']));

      expect(result.cleaned.map((session) => session.id)).toEqual(['requested']);
      expect(store.getSession('requested')).toBeNull();
      expect(store.getSession('pinned')).not.toBeNull();
      expect(store.getSession('unrequested')).not.toBeNull();
    });
  });

  describe('task operations', () => {
    it('should set and get tasks', () => {
      const store = new StateStore(testFilePath);
      const taskState = createMockTaskState('task-1');

      store.setTask('task-1', taskState);

      expect(store.getTask('task-1')).toEqual(taskState);
    });

    it('should return null for non-existent task', () => {
      const store = new StateStore(testFilePath);

      expect(store.getTask('non-existent')).toBeNull();
    });

    it('should remove tasks', () => {
      const store = new StateStore(testFilePath);
      store.setTask('task-1', createMockTaskState('task-1'));

      store.removeTask('task-1');

      expect(store.getTask('task-1')).toBeNull();
    });

    it('should get all tasks', () => {
      const store = new StateStore(testFilePath);
      store.setTask('task-1', createMockTaskState('task-1'));
      store.setTask('task-2', createMockTaskState('task-2'));

      const tasks = store.getTasks();

      expect(Object.keys(tasks)).toHaveLength(2);
    });
  });

  describe('Ralph Loop state', () => {
    it('should get and set Ralph Loop state', () => {
      const store = new StateStore(testFilePath);

      store.setRalphLoopState({ status: 'running', startedAt: 12345 });

      const state = store.getRalphLoopState();
      expect(state.status).toBe('running');
      expect(state.startedAt).toBe(12345);
    });

    it('should merge partial updates', () => {
      const store = new StateStore(testFilePath);

      store.setRalphLoopState({ status: 'running' });
      store.setRalphLoopState({ tasksCompleted: 5 });

      const state = store.getRalphLoopState();
      expect(state.status).toBe('running');
      expect(state.tasksCompleted).toBe(5);
    });
  });

  describe('config operations', () => {
    it('should get and set config', () => {
      const store = new StateStore(testFilePath);

      store.setConfig({ maxConcurrentSessions: 10 });

      expect(store.getConfig().maxConcurrentSessions).toBe(10);
    });

    it('should merge partial updates', () => {
      const store = new StateStore(testFilePath);
      const originalPollInterval = store.getConfig().pollIntervalMs;

      store.setConfig({ maxConcurrentSessions: 10 });

      expect(store.getConfig().maxConcurrentSessions).toBe(10);
      expect(store.getConfig().pollIntervalMs).toBe(originalPollInterval);
    });
  });

  describe('reset', () => {
    it('should reset state to initial values', () => {
      const store = new StateStore(testFilePath);

      store.setSession('session-1', createMockSessionState('session-1'));
      store.setTask('task-1', createMockTaskState('task-1'));

      store.reset();

      expect(store.getSession('session-1')).toBeNull();
      expect(store.getTask('task-1')).toBeNull();
      expect(store.getAllRalphStates().size).toBe(0);
    });

    it('should preserve state file path in config', () => {
      const store = new StateStore(testFilePath);

      store.reset();

      expect(store.getConfig().stateFilePath).toBe(testFilePath);
    });
  });

  describe('ralph state operations', () => {
    it('should get and set ralph state', () => {
      const store = new StateStore(testFilePath);
      const ralphState = createMockRalphState('session-1');

      store.setRalphState('session-1', ralphState);

      expect(store.getRalphState('session-1')).toEqual(ralphState);
    });

    it('should return null for non-existent ralph state', () => {
      const store = new StateStore(testFilePath);

      expect(store.getRalphState('non-existent')).toBeNull();
    });

    it('should update ralph state with partial merge', () => {
      const store = new StateStore(testFilePath);

      store.setRalphState('session-1', createMockRalphState('session-1'));
      const updated = store.updateRalphState('session-1', { totalTodos: 10 });

      expect(updated.totalTodos).toBe(10);
      expect(updated.sessionId).toBe('session-1');
    });

    it('should create initial state on update if none exists', () => {
      const store = new StateStore(testFilePath);

      const state = store.updateRalphState('new-session', { totalTodos: 5 });

      expect(state.sessionId).toBe('new-session');
      expect(state.totalTodos).toBe(5);
    });

    it('should remove ralph state', () => {
      const store = new StateStore(testFilePath);
      store.setRalphState('session-1', createMockRalphState('session-1'));

      store.removeRalphState('session-1');

      expect(store.getRalphState('session-1')).toBeNull();
    });

    it('should get all ralph states', () => {
      const store = new StateStore(testFilePath);
      store.setRalphState('session-1', createMockRalphState('session-1'));
      store.setRalphState('session-2', createMockRalphState('session-2'));

      const allStates = store.getAllRalphStates();

      expect(allStates.size).toBe(2);
      expect(allStates.has('session-1')).toBe(true);
      expect(allStates.has('session-2')).toBe(true);
    });
  });

  describe('flushAll', () => {
    it('should flush both main and ralph state', () => {
      const store = new StateStore(testFilePath);

      store.setSession('session-1', createMockSessionState('session-1'));
      store.setRalphState('session-1', createMockRalphState('session-1'));

      store.flushAll();

      expect(existsSync(testFilePath)).toBe(true);
      expect(existsSync(testInnerPath)).toBe(true);
    });
  });

  describe('persistence', () => {
    it('should persist and restore state across instances', () => {
      // Create and save state
      const store1 = new StateStore(testFilePath);
      store1.setSession('session-1', createMockSessionState('session-1'));
      store1.setTask('task-1', createMockTaskState('task-1'));
      store1.setRalphState('session-1', createMockRalphState('session-1'));
      store1.flushAll();

      // Create new instance and verify state is loaded
      const store2 = new StateStore(testFilePath);

      expect(store2.getSession('session-1')).toBeDefined();
      expect(store2.getTask('task-1')).toBeDefined();
      expect(store2.getRalphState('session-1')).toBeDefined();
    });
  });

  describe('circuit breaker recovery (COD-50)', () => {
    it('recovers via HALF_OPEN trial write after the cooldown', () => {
      // Fake timers are already active (beforeEach). The store loads cleanly
      // while testFilePath does not exist yet.
      const store = new StateStore(testFilePath);

      // Force every write to fail: make the destination a DIRECTORY so the
      // atomic rename(tempPath, testFilePath) fails with EISDIR while the temp
      // write succeeds. Real fs, deterministic — no mocks.
      rmSync(testFilePath, { recursive: true, force: true });
      mkdirSync(testFilePath, { recursive: true });

      // 3 consecutive failed saves trip the breaker open.
      for (let i = 0; i < 3; i++) {
        store.setSession(`s${i}`, createMockSessionState(`s${i}`));
        store.saveNow();
      }

      // Fix the fs so writes *could* succeed, but stay within the cooldown
      // window. A latched breaker (bug) and a cooling-down breaker (fix) both
      // skip here, so the file must NOT be recreated yet.
      rmSync(testFilePath, { recursive: true, force: true });
      store.setSession('within', createMockSessionState('within'));
      store.saveNow();
      expect(existsSync(testFilePath)).toBe(false); // still cooling down -> skipped

      // Advance past the 30s cooldown. The fixed breaker must allow a HALF_OPEN
      // trial write, which now succeeds and recovers persistence. The buggy
      // (permanently latched) breaker never writes again.
      vi.advanceTimersByTime(30_000 + 1);
      store.setSession('after', createMockSessionState('after'));
      store.saveNow();
      expect(existsSync(testFilePath)).toBe(true); // recovered via trial write
    });
  });

  describe('global stats', () => {
    it('should initialize global stats with zero values', () => {
      const store = new StateStore(testFilePath);
      const stats = store.getGlobalStats();

      expect(stats.totalInputTokens).toBe(0);
      expect(stats.totalOutputTokens).toBe(0);
      expect(stats.totalCost).toBe(0);
      expect(stats.totalSessionsCreated).toBe(0);
      expect(stats.firstRecordedAt).toBeDefined();
      expect(stats.lastUpdatedAt).toBeDefined();
    });

    it('should add to global stats', () => {
      const store = new StateStore(testFilePath);

      store.addToGlobalStats(1000, 500, 0.05);

      const stats = store.getGlobalStats();
      expect(stats.totalInputTokens).toBe(1000);
      expect(stats.totalOutputTokens).toBe(500);
      expect(stats.totalCost).toBe(0.05);
    });

    it('should accumulate global stats across multiple calls', () => {
      const store = new StateStore(testFilePath);

      store.addToGlobalStats(1000, 500, 0.05);
      store.addToGlobalStats(2000, 1000, 0.1);

      const stats = store.getGlobalStats();
      expect(stats.totalInputTokens).toBe(3000);
      expect(stats.totalOutputTokens).toBe(1500);
      expect(stats.totalCost).toBeCloseTo(0.15, 10);
    });

    it('should increment sessions created counter', () => {
      const store = new StateStore(testFilePath);

      store.incrementSessionsCreated();
      store.incrementSessionsCreated();
      store.incrementSessionsCreated();

      const stats = store.getGlobalStats();
      expect(stats.totalSessionsCreated).toBe(3);
    });

    it('should compute aggregate stats combining global and active sessions', () => {
      const store = new StateStore(testFilePath);

      // Add global stats (from deleted sessions)
      store.addToGlobalStats(5000, 2500, 0.25);

      // Simulate active sessions
      const activeSessions = {
        'session-1': { inputTokens: 1000, outputTokens: 500, totalCost: 0.05 },
        'session-2': { inputTokens: 2000, outputTokens: 1000, totalCost: 0.1 },
      };

      const aggregate = store.getAggregateStats(activeSessions);

      expect(aggregate.totalInputTokens).toBe(8000); // 5000 + 1000 + 2000
      expect(aggregate.totalOutputTokens).toBe(4000); // 2500 + 500 + 1000
      expect(aggregate.totalCost).toBeCloseTo(0.4, 10); // 0.25 + 0.05 + 0.10
      expect(aggregate.activeSessionsCount).toBe(2);
    });

    it('should persist global stats across instances', () => {
      const store1 = new StateStore(testFilePath);
      store1.addToGlobalStats(10000, 5000, 0.5);
      store1.incrementSessionsCreated();
      store1.flushAll();

      const store2 = new StateStore(testFilePath);
      const stats = store2.getGlobalStats();

      expect(stats.totalInputTokens).toBe(10000);
      expect(stats.totalOutputTokens).toBe(5000);
      expect(stats.totalCost).toBe(0.5);
      expect(stats.totalSessionsCreated).toBe(1);
    });
  });

  describe('assembleStateJson', () => {
    it('should produce output identical to JSON.stringify(state)', () => {
      const store = new StateStore(testFilePath);

      // Add sessions, tasks, config changes
      store.setSession('s1', createMockSessionState('s1'));
      store.setSession('s2', createMockSessionState('s2'));
      store.setTask('t1', createMockTaskState('t1'));
      store.setConfig({ maxConcurrentSessions: 5 });
      store.addToGlobalStats(1000, 500, 0.05);

      // Force a save so assembleStateJson is called
      store.saveNow();

      // Read persisted file and compare with full JSON.stringify
      const persisted = JSON.parse(readFileSync(testFilePath, 'utf-8'));
      const fullStringify = JSON.parse(JSON.stringify(store.getState()));

      expect(persisted).toEqual(fullStringify);
    });

    it('should correctly persist all sessions after partial update', () => {
      const store = new StateStore(testFilePath);

      // Create 10 sessions
      for (let i = 0; i < 10; i++) {
        store.setSession(`s${i}`, createMockSessionState(`s${i}`));
      }
      store.saveNow();

      // Modify only 1 session
      const updated = createMockSessionState('s3');
      updated.status = 'idle';
      updated.pid = 99999;
      store.setSession('s3', updated);
      store.saveNow();

      // Read from disk and verify all 10 sessions are present and correct
      const persisted = JSON.parse(readFileSync(testFilePath, 'utf-8'));
      expect(Object.keys(persisted.sessions)).toHaveLength(10);

      // The updated session should have the new values
      expect(persisted.sessions['s3'].status).toBe('idle');
      expect(persisted.sessions['s3'].pid).toBe(99999);

      // Other sessions should be unchanged
      for (let i = 0; i < 10; i++) {
        if (i === 3) continue;
        expect(persisted.sessions[`s${i}`].id).toBe(`s${i}`);
        expect(persisted.sessions[`s${i}`].status).toBe('running');
      }
    });

    it('should handle session removal and prune cache correctly', () => {
      const store = new StateStore(testFilePath);

      store.setSession('s1', createMockSessionState('s1'));
      store.setSession('s2', createMockSessionState('s2'));
      store.setSession('s3', createMockSessionState('s3'));
      store.saveNow();

      // Remove s2
      store.removeSession('s2');
      store.saveNow();

      const persisted = JSON.parse(readFileSync(testFilePath, 'utf-8'));
      expect(Object.keys(persisted.sessions)).toHaveLength(2);
      expect(persisted.sessions['s1']).toBeDefined();
      expect(persisted.sessions['s2']).toBeUndefined();
      expect(persisted.sessions['s3']).toBeDefined();

      // Verify round-trip: state in memory matches what's on disk
      const fullStringify = JSON.parse(JSON.stringify(store.getState()));
      expect(persisted).toEqual(fullStringify);
    });

    it('should persist the last value after rapid updates to the same session', () => {
      const store = new StateStore(testFilePath);

      // Rapidly update the same session 100 times
      for (let i = 0; i < 100; i++) {
        const session = createMockSessionState('rapid');
        session.pid = i;
        store.setSession('rapid', session);
      }

      // Only one save at the end
      store.saveNow();

      const persisted = JSON.parse(readFileSync(testFilePath, 'utf-8'));
      expect(persisted.sessions['rapid']).toBeDefined();
      expect(persisted.sessions['rapid'].pid).toBe(99); // Last value wins
    });
  });
});

// Helper functions to create mock state objects
function createMockSessionState(id: string): SessionState {
  return {
    id,
    workingDir: '/tmp/test',
    status: 'running',
    pid: 12345,
    createdAt: Date.now(),
    caseName: 'test-case',
    mode: 'claude',
  };
}

function createMockTaskState(id: string): TaskState {
  return {
    id,
    prompt: 'Test prompt',
    workingDir: '/tmp/test',
    priority: 0,
    dependencies: [],
    status: 'pending',
    assignedSessionId: null,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    output: '',
    error: null,
  };
}

function createMockSessionRecoveryRecord(id: string): SessionRecoveryRecord {
  return {
    id,
    sourceSessionId: `session-${id}`,
    owner: 'alice',
    mode: 'codex',
    workingDir: '/tmp/test',
    transport: 'local',
    status: 'pending',
    launch: { kind: 'built-in' },
    createdAt: Date.now(),
  };
}

function createMockRalphState(sessionId: string): RalphSessionState {
  return {
    sessionId,
    enabled: true,
    loopActive: false,
    totalTodos: 0,
    completedTodos: 0,
    completionPhrase: null,
    expectedPhrase: null,
    todoItems: [],
    lastUpdated: Date.now(),
    messageId: null,
  };
}
