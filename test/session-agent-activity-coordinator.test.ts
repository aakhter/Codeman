import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BoundedActivityScheduler,
  SessionAgentActivityCoordinator,
  projectAgentActivity,
  type CoordinatorSession,
} from '../src/session-agent-activity-coordinator.js';
import type { AgentObservation, SessionStatus } from '../src/types/session.js';

function session(status: SessionStatus = 'idle'): CoordinatorSession {
  return {
    id: 'codeman-1',
    status,
    mode: 'claude',
    workingDir: '/work/project',
    claudeSessionId: 'conversation-1',
    terminalActivityEpoch: 0,
    setActivityProjection() {},
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('session agent activity coordinator', () => {
  afterEach(() => vi.useRealTimers());
  describe('1. projection', () => {
    it.each<[AgentObservation, string]>([
      ['none', 'idle'],
      ['live', 'waiting_agents'],
      ['unknown', 'checking_agents'],
      ['not_observable', 'idle'],
    ])('projects idle + %s to %s', (observation, activityStatus) => {
      expect(projectAgentActivity('idle', observation, undefined, 100)).toEqual({
        activityStatus,
        activityStatusSince: activityStatus === 'idle' ? null : 100,
      });
    });

    it.each<SessionStatus>(['busy', 'error', 'stopped', 'parked'])('gives raw %s precedence', (status) => {
      expect(
        projectAgentActivity(status, 'live', { activityStatus: 'waiting_agents', activityStatusSince: 50 }, 100)
      ).toEqual({ activityStatus: status, activityStatusSince: null });
    });

    it('keeps a symmetric episode timestamp stable and resets it when the derived state changes', () => {
      const waiting = projectAgentActivity('idle', 'live', undefined, 100);
      expect(projectAgentActivity('idle', 'live', waiting, 200).activityStatusSince).toBe(100);
      const checking = projectAgentActivity('idle', 'unknown', waiting, 300);
      expect(checking.activityStatusSince).toBe(300);
      expect(projectAgentActivity('idle', 'live', checking, 400).activityStatusSince).toBe(400);
    });
  });

  describe('2. exact identity isolation', () => {
    it('isolates project and conversation and treats duplicates asymmetrically', () => {
      const coordinator = new SessionAgentActivityCoordinator();
      const first = session();
      const otherProject = { ...session(), id: 'other-project', workingDir: '/work/other' };
      const otherConversation = { ...session(), id: 'other-conversation', claudeSessionId: 'conversation-2' };
      coordinator.attachSession(first);
      coordinator.attachSession(otherProject);
      coordinator.attachSession(otherConversation);
      coordinator.setObservation(first, 'live', 1);
      expect(coordinator.project(first).activityStatus).toBe('waiting_agents');
      expect(coordinator.project(otherProject).activityStatus).toBe('checking_agents');
      expect(coordinator.project(otherConversation).activityStatus).toBe('checking_agents');

      const duplicate = { ...session(), id: 'duplicate' };
      coordinator.attachSession(duplicate);
      expect(coordinator.decisionForRawIdle(first)).toMatchObject({
        presentToHuman: true,
        autonomyBlocked: true,
        ambiguous: true,
      });
    });

    it('uses legacy behavior for remote or explicitly unobservable sessions', () => {
      const coordinator = new SessionAgentActivityCoordinator();
      const remote = { ...session(), id: 'remote', remote: { host: 'example' } };
      coordinator.attachSession(remote);
      expect(coordinator.project(remote).activityStatus).toBe('idle');
      expect(coordinator.decisionForRawIdle(remote)).toMatchObject({ presentToHuman: true, autonomyBlocked: false });
    });
  });

  describe('3. synchronous unknown transitions', () => {
    it('marks startup, re-enable, and a new identity unknown before reconciliation', () => {
      const coordinator = new SessionAgentActivityCoordinator();
      const target = session() as CoordinatorSession & { claudeSessionId: string | null };
      coordinator.attachSession(target);
      expect(coordinator.project(target).activityStatus).toBe('checking_agents');
      coordinator.setObservation(target, 'none', 0);
      coordinator.trackingDisabled(target);
      expect(coordinator.project(target).activityStatus).toBe('idle');
      coordinator.trackingEnabled(target);
      expect(coordinator.project(target).activityStatus).toBe('checking_agents');
      target.claudeSessionId = 'conversation-2';
      coordinator.identityChanged(target);
      expect(coordinator.project(target).activityStatus).toBe('checking_agents');
    });
  });

  describe('4. stale async rejection', () => {
    it('rejects every stale decision token component', async () => {
      const pending = deferred<{ observation: AgentObservation; semanticRevision: number }>();
      const coordinator = new SessionAgentActivityCoordinator({ inspect: () => pending.promise });
      const target = session() as CoordinatorSession & { terminalActivityEpoch: number };
      coordinator.attachSession(target);
      const reconciliation = coordinator.reconcile(target);
      target.terminalActivityEpoch += 1;
      pending.resolve({ observation: 'none', semanticRevision: 0 });
      expect(await reconciliation).toBe(false);
      expect(coordinator.project(target).activityStatus).toBe('checking_agents');
    });

    it.each(['session', 'identity', 'tracking', 'revision', 'token'] as const)(
      'rejects a stale %s generation',
      async (kind) => {
        const pending = deferred<{ observation: AgentObservation; semanticRevision: number }>();
        const coordinator = new SessionAgentActivityCoordinator({ inspect: () => pending.promise });
        const target = session() as CoordinatorSession & { claudeSessionId: string | null };
        coordinator.attachSession(target);
        const reconciliation = coordinator.reconcile(target);
        if (kind === 'session') coordinator.attachSession({ ...target });
        if (kind === 'identity') {
          target.claudeSessionId = 'new';
          coordinator.identityChanged(target);
        }
        if (kind === 'tracking') {
          coordinator.trackingDisabled(target);
          coordinator.trackingEnabled(target);
        }
        if (kind === 'revision') coordinator.onAgentRevision(target, 2);
        if (kind === 'token') coordinator.invalidateDecision(target);
        pending.resolve({ observation: 'none', semanticRevision: kind === 'revision' ? 2 : 0 });
        expect(await reconciliation).toBe(false);
      }
    );
  });

  describe('5. event ordering and decisions', () => {
    it('quarantines late ordered idle events while permissions remain immediate', () => {
      const coordinator = new SessionAgentActivityCoordinator();
      const target = session();
      coordinator.attachSession(target);
      coordinator.commitEvidence(target, {
        observation: 'live',
        semanticRevision: 0,
        processReason: 'matching_process',
      });
      const lateIdle = coordinator.allocateEvent(target, 'idle_prompt', 2);
      const stop = coordinator.decisionForHook(target, 'stop', 3);
      expect(stop.presentToHuman).toBe(true);
      coordinator.completeEvent(target, stop.event);
      expect(coordinator.decisionForEvent(target, lateIdle)).toMatchObject({
        quarantined: true,
        presentToHuman: false,
      });
      expect(coordinator.decisionForHook(target, 'permission', 1).presentToHuman).toBe(true);
      expect(coordinator.decisionForHook(target, 'elicitation', 1).presentToHuman).toBe(true);
      expect(coordinator.isAutonomyBlocked(target)).toBe(true);
    });

    it('requires exact positive process provenance to suppress stop', () => {
      const coordinator = new SessionAgentActivityCoordinator();
      const target = session();
      coordinator.attachSession(target);
      coordinator.onWatcherCount(target, 1, 1);
      expect(coordinator.decisionForRawIdle(target).presentToHuman).toBe(false);
      expect(coordinator.decisionForHook(target, 'stop', 1)).toMatchObject({
        presentToHuman: true,
        liveEvidence: 'watcher_or_frame',
      });
      expect(coordinator.decisionForHook(target, 'idle_prompt', 2).presentToHuman).toBe(false);
      expect(coordinator.isAutonomyBlocked(target)).toBe(true);

      coordinator.commitEvidence(target, {
        observation: 'live',
        semanticRevision: 1,
        processReason: 'matching_process',
      });
      expect(coordinator.decisionForHook(target, 'stop', 3)).toMatchObject({
        presentToHuman: true,
        liveEvidence: 'watcher_or_frame',
        processReason: undefined,
      });
    });

    it('uses only fresh event-bound process proof to suppress stop', async () => {
      let evidence = {
        observation: 'unknown' as AgentObservation,
        semanticRevision: 0,
        processReason: 'no_registered_role_signature' as const,
      };
      const coordinator = new SessionAgentActivityCoordinator({ inspect: async () => evidence });
      const target = session();
      coordinator.attachSession(target);
      coordinator.commitEvidence(target, {
        observation: 'live',
        semanticRevision: 0,
        processReason: 'matching_process',
      });

      const unsupportedStop = coordinator.allocateEvent(target, 'stop');
      const unsupportedResult = await coordinator.reconcileForEvent(target, unsupportedStop);
      const unsupportedReconciliation = coordinator.reconciliationForEvent(target, unsupportedStop, unsupportedResult);
      expect(
        coordinator.decisionForEvent(target, unsupportedStop, { reconciliation: unsupportedReconciliation })
      ).toMatchObject({
        presentToHuman: true,
        autonomyBlocked: true,
        observation: 'live',
        liveEvidence: 'watcher_or_frame',
        processReason: 'no_registered_role_signature',
      });

      evidence = {
        observation: 'live',
        semanticRevision: 0,
        processReason: 'matching_process',
      };
      const provenStop = coordinator.allocateEvent(target, 'stop');
      const provenResult = await coordinator.reconcileForEvent(target, provenStop);
      const provenReconciliation = coordinator.reconciliationForEvent(target, provenStop, provenResult);
      expect(coordinator.decisionForEvent(target, provenStop, { reconciliation: provenReconciliation })).toMatchObject({
        presentToHuman: false,
        autonomyBlocked: true,
        observation: 'live',
        liveEvidence: 'exact_process',
        processReason: 'matching_process',
      });
    });

    it('fails open for a current human prompt but fails safe for autonomy under uncertainty', () => {
      const coordinator = new SessionAgentActivityCoordinator();
      const target = session();
      coordinator.attachSession(target);
      expect(coordinator.decisionForRawIdle(target)).toMatchObject({
        presentToHuman: true,
        autonomyBlocked: true,
        observation: 'unknown',
      });
    });

    it('quarantines a duplicate sequence after its first decision', () => {
      const coordinator = new SessionAgentActivityCoordinator();
      const target = session();
      coordinator.attachSession(target);
      coordinator.setObservation(target, 'none', 0);
      const event = coordinator.allocateEvent(target, 'idle_prompt', 1);
      expect(coordinator.decisionForEvent(target, event).quarantined).toBe(false);
      expect(coordinator.decisionForEvent(target, event).quarantined).toBe(true);
    });

    it('allocates one strictly increasing sequence across every event kind', () => {
      const coordinator = new SessionAgentActivityCoordinator();
      const target = session();
      coordinator.attachSession(target);
      const kinds = ['raw_idle', 'stop', 'idle_prompt', 'permission', 'elicitation'] as const;
      const events = kinds.map((kind, index) => coordinator.allocateEvent(target, kind, 100 - index));
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(events.map((event) => event.externalSourceSequence)).toEqual([100, 99, 98, 97, 96]);
    });
  });

  describe('6. bounded inspection', () => {
    it('coalesces one in-flight inspection and rejects an aborted late result', async () => {
      vi.useFakeTimers();
      const pending = deferred<{ observation: AgentObservation; semanticRevision: number }>();
      const inspect = vi.fn((_project, signal: AbortSignal) => {
        expect(signal.aborted).toBe(false);
        return pending.promise;
      });
      const coordinator = new SessionAgentActivityCoordinator({ inspect, inspectionDeadlineMs: 100 });
      const target = session();
      coordinator.attachSession(target);
      const first = coordinator.reconcile(target);
      const second = coordinator.reconcile(target);
      expect(inspect).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(await Promise.all([first, second])).toEqual([false, false]);
      pending.resolve({ observation: 'none', semanticRevision: 0 });
      await Promise.resolve();
      expect(coordinator.project(target).activityStatus).toBe('checking_agents');
    });

    it('counts foreground queue wait against the deadline and removes an expired consumer', async () => {
      vi.useFakeTimers();
      const scheduler = new BoundedActivityScheduler();
      const blockers = Array.from({ length: 4 }, () => deferred<void>());
      const occupying = blockers.map((blocker, index) =>
        scheduler.enqueue(`occupier-${index}`, 'foreground', () => blocker.promise)
      );
      const inspect = vi.fn(async () => ({ observation: 'none' as const, semanticRevision: 0 }));
      const coordinator = new SessionAgentActivityCoordinator({ scheduler, inspect, inspectionDeadlineMs: 100 });
      const target = session();
      coordinator.attachSession(target);
      const result = coordinator.reconcile(target);
      await vi.advanceTimersByTimeAsync(100);
      expect(await result).toBe(false);
      for (const blocker of blockers) blocker.resolve();
      await Promise.all(occupying);
      expect(inspect).not.toHaveBeenCalled();
      expect(coordinator.project(target).activityStatus).toBe('checking_agents');
    });

    it('coalesces concurrent event consumers and binds the shared evidence to each event', async () => {
      const pending = deferred<{ observation: AgentObservation; semanticRevision: number }>();
      const inspect = vi.fn(() => pending.promise);
      const coordinator = new SessionAgentActivityCoordinator({ inspect });
      const target = session();
      coordinator.attachSession(target);
      const stop = coordinator.allocateEvent(target, 'stop');
      const idlePrompt = coordinator.allocateEvent(target, 'idle_prompt');
      const stopResult = coordinator.reconcileForEvent(target, stop);
      const idleResult = coordinator.reconcileForEvent(target, idlePrompt);
      expect(inspect).toHaveBeenCalledTimes(1);
      pending.resolve({ observation: 'none', semanticRevision: 0 });
      const [resolvedStop, resolvedIdle] = await Promise.all([stopResult, idleResult]);
      expect(resolvedStop && resolvedStop.event).toBe(stop);
      expect(resolvedIdle && resolvedIdle.event).toBe(idlePrompt);
      expect(inspect).toHaveBeenCalledTimes(1);
    });

    it('lets a short event consumer time out without poisoning a longer shared consumer', async () => {
      vi.useFakeTimers();
      const pending = deferred<{ observation: AgentObservation; semanticRevision: number }>();
      let signal!: AbortSignal;
      const inspect = vi.fn((_project, currentSignal: AbortSignal) => {
        signal = currentSignal;
        return pending.promise;
      });
      const coordinator = new SessionAgentActivityCoordinator({ inspect, inspectionDeadlineMs: 50 });
      const target = session();
      coordinator.attachSession(target);
      const shortEvent = coordinator.allocateEvent(target, 'stop');
      const longEvent = coordinator.allocateEvent(target, 'idle_prompt');
      const short = coordinator.reconcileForEvent(target, shortEvent, { deadlineMs: 50 });
      const long = coordinator.reconcileForEvent(target, longEvent, { deadlineMs: 150 });
      await vi.advanceTimersByTimeAsync(50);
      expect(await short).toBe(false);
      expect(signal.aborted).toBe(false);
      pending.resolve({ observation: 'none', semanticRevision: 0 });
      const longResult = await long;
      expect(longResult && longResult.event).toBe(longEvent);
      expect(inspect).toHaveBeenCalledTimes(1);
    });

    it('charges a consumer attached to existing work from its own absolute enqueue deadline', async () => {
      vi.useFakeTimers();
      const pending = deferred<{ observation: AgentObservation; semanticRevision: number }>();
      const inspect = vi.fn(() => pending.promise);
      const coordinator = new SessionAgentActivityCoordinator({ inspect, inspectionDeadlineMs: 500 });
      const target = session();
      coordinator.attachSession(target);
      const firstEvent = coordinator.allocateEvent(target, 'stop');
      const first = coordinator.reconcileForEvent(target, firstEvent, { deadlineMs: 200 });
      await vi.advanceTimersByTimeAsync(50);
      const attachedEvent = coordinator.allocateEvent(target, 'idle_prompt');
      const attached = coordinator.reconcileForEvent(target, attachedEvent, { deadlineMs: 40 });
      await vi.advanceTimersByTimeAsync(40);
      expect(await attached).toBe(false);
      expect(inspect).toHaveBeenCalledTimes(1);
      pending.resolve({ observation: 'none', semanticRevision: 0 });
      const firstResult = await first;
      expect(firstResult && firstResult.event).toBe(firstEvent);
      expect(inspect).toHaveBeenCalledTimes(1);
    });

    it('aborts shared evidence when all independently timed consumers detach', async () => {
      vi.useFakeTimers();
      const pending = deferred<{ observation: AgentObservation; semanticRevision: number }>();
      let signal!: AbortSignal;
      const inspect = vi.fn((_project, currentSignal: AbortSignal) => {
        signal = currentSignal;
        return pending.promise;
      });
      const coordinator = new SessionAgentActivityCoordinator({ inspect, inspectionDeadlineMs: 50 });
      const target = session();
      coordinator.attachSession(target);
      const first = coordinator.reconcileForEvent(target, coordinator.allocateEvent(target, 'stop'), {
        deadlineMs: 50,
      });
      const second = coordinator.reconcileForEvent(target, coordinator.allocateEvent(target, 'idle_prompt'), {
        deadlineMs: 80,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(await Promise.all([first, second])).toEqual([false, false]);
      expect(signal.aborted).toBe(true);
      expect(inspect).toHaveBeenCalledTimes(1);
    });
  });

  describe('7. retry policy', () => {
    it('uses 250ms, 1s, 5s, then capped 30s and grants one immediate semantic retry', async () => {
      vi.useFakeTimers();
      let revision = 0;
      const inspect = vi.fn(async () => ({ observation: 'unknown' as const, semanticRevision: revision }));
      const coordinator = new SessionAgentActivityCoordinator({ inspect });
      const target = session();
      coordinator.attachSession(target);
      await coordinator.reconcile(target);
      expect(coordinator.nextRetryDelay(target)).toBe(250);
      await vi.advanceTimersByTimeAsync(249);
      expect(inspect).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(inspect).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(inspect).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(5000);
      expect(inspect).toHaveBeenCalledTimes(4);
      expect(coordinator.nextRetryDelay(target)).toBe(30_000);
      revision = 1;
      expect(coordinator.onAgentRevision(target, 1)).toBe(true);
      expect(coordinator.onAgentRevision(target, 1)).toBe(false);
      expect(coordinator.nextRetryDelay(target)).toBe(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(inspect).toHaveBeenCalledTimes(5);
    });
  });

  describe('8. scheduler fairness', () => {
    it('reserves one slot and starts the oldest background after three foreground starts', async () => {
      const scheduler = new BoundedActivityScheduler(4, 3, 3);
      const gates = Array.from({ length: 10 }, () => deferred<void>());
      const starts: string[] = [];
      const run = (name: string, index: number, kind: 'foreground' | 'background') =>
        scheduler.enqueue(name, kind, async () => {
          starts.push(name);
          await gates[index].promise;
        });

      const running = [
        run('b0', 0, 'background'),
        run('b1', 1, 'background'),
        run('b2', 2, 'background'),
        run('f0', 3, 'foreground'),
        run('f1', 4, 'foreground'),
        run('f2', 5, 'foreground'),
        run('f3', 6, 'foreground'),
        run('b3', 7, 'background'),
        run('f4', 8, 'foreground'),
      ];
      expect(starts).toEqual(['b0', 'b1', 'b2', 'f0']);
      gates[3].resolve();
      await Promise.resolve();
      await Promise.resolve();
      gates[0].resolve();
      await Promise.resolve();
      await Promise.resolve();
      gates[1].resolve();
      await Promise.resolve();
      await Promise.resolve();
      gates[2].resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(starts.slice(4, 8)).toEqual(['f1', 'f2', 'b3', 'f3']);
      for (const gate of gates) gate.resolve();
      await Promise.all(running);
    });
  });

  describe('9. final-agent settle and installed-build evidence', () => {
    it('settles final zero once, while output/new live/stale timers cannot clear a newer wait', async () => {
      vi.useFakeTimers();
      const onDerivedIdle = vi.fn();
      const coordinator = new SessionAgentActivityCoordinator({ onDerivedIdle });
      const target = session();
      coordinator.attachSession(target);
      coordinator.onWatcherCount(target, 1, 1);
      coordinator.onWatcherCount(target, 0, 2);
      await vi.advanceTimersByTimeAsync(1000);
      coordinator.onTerminalOutput(target);
      await vi.advanceTimersByTimeAsync(2000);
      expect(coordinator.project(target).activityStatus).toBe('checking_agents');
      coordinator.onWatcherCount(target, 1, 3);
      coordinator.onWatcherCount(target, 0, 4);
      await vi.advanceTimersByTimeAsync(2500);
      expect(coordinator.project(target).activityStatus).toBe('idle');
      expect(onDerivedIdle).toHaveBeenCalledTimes(1);
    });

    it('does not let a no-signature negative establish none or erase live', () => {
      const coordinator = new SessionAgentActivityCoordinator();
      const target = session();
      coordinator.attachSession(target);
      coordinator.commitEvidence(target, {
        observation: 'none',
        semanticRevision: 0,
        processReason: 'no_registered_role_signature',
      });
      expect(coordinator.project(target).activityStatus).toBe('checking_agents');
      coordinator.setObservation(target, 'live', 1);
      coordinator.commitEvidence(target, {
        observation: 'unknown',
        semanticRevision: 1,
        processReason: 'no_registered_role_signature',
      });
      expect(coordinator.project(target).activityStatus).toBe('waiting_agents');
    });

    it('allows exact zero from the fresh event reconciliation to end grace early', async () => {
      vi.useFakeTimers();
      const onDerivedIdle = vi.fn();
      const coordinator = new SessionAgentActivityCoordinator({
        onDerivedIdle,
        inspect: async () => ({ observation: 'none', semanticRevision: 2, exactWatcherCount: 0 }),
      });
      for (const [index, kind] of (['raw_idle', 'stop', 'idle_prompt'] as const).entries()) {
        const target = { ...session(), id: `target-${index}`, claudeSessionId: `conversation-${index}` };
        coordinator.attachSession(target);
        coordinator.onWatcherCount(target, 1, 1);
        coordinator.onWatcherCount(target, 0, 2);
        const event = coordinator.allocateEvent(target, kind);
        const result = await coordinator.reconcileForEvent(target, event);
        expect(result).not.toBe(false);
        const reconciliation = coordinator.reconciliationForEvent(target, event, result);
        expect(coordinator.decisionForEvent(target, event, { reconciliation }).settleEndedEarly).toBe(true);
        expect(coordinator.project(target).activityStatus).toBe('idle');
      }
      expect(onDerivedIdle).toHaveBeenCalledTimes(3);
    });

    it('emits derived idle once per eligible edge and never while raw status is busy', async () => {
      vi.useFakeTimers();
      const onDerivedIdle = vi.fn();
      const coordinator = new SessionAgentActivityCoordinator({ onDerivedIdle });
      const target = session() as CoordinatorSession & { status: SessionStatus };
      coordinator.attachSession(target);
      coordinator.onWatcherCount(target, 1, 1);
      coordinator.onWatcherCount(target, 0, 2);
      await vi.advanceTimersByTimeAsync(2500);
      expect(onDerivedIdle).toHaveBeenCalledTimes(1);
      coordinator.onWatcherCount(target, 0, 2);
      await vi.advanceTimersByTimeAsync(2500);
      expect(onDerivedIdle).toHaveBeenCalledTimes(1);

      coordinator.onWatcherCount(target, 1, 3);
      target.status = 'busy';
      coordinator.project(target);
      coordinator.onWatcherCount(target, 0, 4);
      await vi.advanceTimersByTimeAsync(2500);
      expect(onDerivedIdle).toHaveBeenCalledTimes(1);
    });

    it('does not end grace from event kind without fresh exact-zero reconciliation', async () => {
      vi.useFakeTimers();
      const onDerivedIdle = vi.fn();
      const coordinator = new SessionAgentActivityCoordinator({ onDerivedIdle });
      const target = session();
      coordinator.attachSession(target);
      coordinator.onWatcherCount(target, 1, 1);
      coordinator.onWatcherCount(target, 0, 2);
      coordinator.decisionForHook(target, 'idle_prompt');
      await vi.advanceTimersByTimeAsync(1000);
      expect(coordinator.project(target).activityStatus).toBe('waiting_agents');
      expect(onDerivedIdle).not.toHaveBeenCalled();
    });

    it('rejects an exact-zero reconciliation after its decision token is invalidated', async () => {
      const coordinator = new SessionAgentActivityCoordinator({
        inspect: async () => ({ observation: 'none', semanticRevision: 2, exactWatcherCount: 0 }),
      });
      const target = session();
      coordinator.attachSession(target);
      coordinator.onWatcherCount(target, 1, 1);
      coordinator.onWatcherCount(target, 0, 2);
      const event = coordinator.allocateEvent(target, 'idle_prompt');
      const result = await coordinator.reconcileForEvent(target, event);
      coordinator.invalidateDecision(target);
      expect(() => coordinator.reconciliationForEvent(target, event, result)).toThrow(/current/);
    });

    it.each(['identity', 'tracking', 'revision', 'evidence_revision'] as const)(
      'invalidates a pending settle on %s generation change',
      async (change) => {
        vi.useFakeTimers();
        const onDerivedIdle = vi.fn();
        const coordinator = new SessionAgentActivityCoordinator({ onDerivedIdle });
        const target = session() as CoordinatorSession & { claudeSessionId: string | null };
        coordinator.attachSession(target);
        coordinator.onWatcherCount(target, 1, 1);
        coordinator.onWatcherCount(target, 0, 2);
        if (change === 'identity') {
          target.claudeSessionId = 'conversation-2';
          coordinator.identityChanged(target);
        }
        if (change === 'tracking') coordinator.trackingDisabled(target);
        if (change === 'revision') coordinator.onAgentRevision(target, 3);
        if (change === 'evidence_revision') {
          coordinator.commitEvidence(target, {
            observation: 'unknown',
            semanticRevision: 3,
            processReason: 'no_registered_role_signature',
          });
        }
        await vi.advanceTimersByTimeAsync(2500);
        expect(onDerivedIdle).not.toHaveBeenCalled();
        expect(coordinator.project(target).activityStatus).toBe(change === 'tracking' ? 'idle' : 'checking_agents');
      }
    );
  });

  describe('10. teardown', () => {
    it('aborts inspection and makes late results and timers no-ops', async () => {
      vi.useFakeTimers();
      let observedSignal: AbortSignal | undefined;
      const pending = deferred<{ observation: AgentObservation; semanticRevision: number }>();
      const coordinator = new SessionAgentActivityCoordinator({
        inspect: (_project, signal) => {
          observedSignal = signal;
          return pending.promise;
        },
      });
      const target = session();
      coordinator.attachSession(target);
      const result = coordinator.reconcile(target);
      coordinator.onWatcherCount(target, 1, 1);
      coordinator.onWatcherCount(target, 0, 2);
      coordinator.detachSession(target);
      expect(observedSignal?.aborted).toBe(true);
      pending.resolve({ observation: 'none', semanticRevision: 2 });
      expect(await result).toBe(false);
      await vi.runAllTimersAsync();
      expect(() => coordinator.project(target)).not.toThrow();
      coordinator.attachSession(target);
      expect(coordinator.decisionForHook(target, 'idle_prompt', 1).quarantined).toBe(false);
    });

    it('cleans up every attached session', () => {
      const coordinator = new SessionAgentActivityCoordinator();
      const first = session();
      const second = { ...session(), id: 'second', claudeSessionId: 'conversation-2' };
      coordinator.attachSession(first);
      coordinator.attachSession(second);
      coordinator.cleanup();
      expect(coordinator.project(first).activityStatus).toBe('idle');
      expect(coordinator.project(second).activityStatus).toBe('idle');
    });

    it('keeps tracking disabled through late evidence, events, output, retry, and async completion', async () => {
      vi.useFakeTimers();
      const pending = deferred<{ observation: AgentObservation; semanticRevision: number }>();
      const inspect = vi.fn(() => pending.promise);
      const coordinator = new SessionAgentActivityCoordinator({ inspect });
      const target = session();
      coordinator.attachSession(target);
      const preDisableEvent = coordinator.allocateEvent(target, 'idle_prompt');
      const stale = coordinator.reconcile(target);
      coordinator.trackingDisabled(target);
      expect(coordinator.onAgentRevision(target, 5)).toBe(false);
      coordinator.onWatcherCount(target, 1, 5);
      coordinator.commitEvidence(target, {
        observation: 'live',
        semanticRevision: 5,
        processReason: 'matching_process',
      });
      coordinator.onTerminalOutput(target);
      pending.resolve({ observation: 'live', semanticRevision: 0 });
      expect(await stale).toBe(false);
      await vi.runAllTimersAsync();
      expect(coordinator.project(target).activityStatus).toBe('idle');
      expect(coordinator.isAutonomyBlocked(target)).toBe(false);
      expect(inspect).toHaveBeenCalledTimes(1);
      coordinator.trackingEnabled(target);
      expect(() => coordinator.decisionForEvent(target, preDisableEvent)).toThrow(/stale/);
      expect(coordinator.project(target).activityStatus).toBe('checking_agents');
    });
  });
});
