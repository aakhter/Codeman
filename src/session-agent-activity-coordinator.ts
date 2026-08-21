import { IDLE_SILENCE_MS } from './session-activity.js';
import { claudeProjectHash } from './claude-project-identity.js';
import type {
  AgentObservation,
  SessionActivityProjection,
  SessionActivityStatus,
  SessionMode,
  SessionStatus,
} from './types/session.js';

export interface CoordinatorSession {
  readonly id: string;
  readonly status: SessionStatus;
  readonly mode: SessionMode;
  readonly workingDir: string;
  readonly claudeSessionId: string | null;
  readonly terminalActivityEpoch: number;
  readonly claudeRuntimeVersion?: string;
  readonly claudeRuntimeCapability?: 'exact_role' | 'none';
  readonly agentObservationSupported?: boolean;
  readonly remote?: unknown;
  setActivityProjection(projection: SessionActivityProjection): void;
}

export function projectAgentActivity(
  status: SessionStatus,
  observation: AgentObservation,
  previous: SessionActivityProjection | undefined,
  now: number
): SessionActivityProjection {
  let activityStatus: SessionActivityStatus = status;
  if (status === 'idle') {
    if (observation === 'live') activityStatus = 'waiting_agents';
    if (observation === 'unknown') activityStatus = 'checking_agents';
  }

  const derived = activityStatus === 'waiting_agents' || activityStatus === 'checking_agents';
  return {
    activityStatus,
    activityStatusSince: derived
      ? previous?.activityStatus === activityStatus
        ? previous.activityStatusSince
        : now
      : null,
  };
}

// Re-exported so the settle contract has one canonical duration.
export const FINAL_AGENT_SETTLE_MS = IDLE_SILENCE_MS;

export interface ObservableSessionProject {
  session: CoordinatorSession;
  workingDir: string;
  projectHash: string;
  claudeSessionId: string;
  claudeRuntimeVersion?: string;
  claudeRuntimeCapability?: 'exact_role' | 'none';
}

export interface AgentEvidence {
  observation: AgentObservation;
  semanticRevision: number;
  processReason?: 'matching_process' | 'no_registered_role_signature' | 'no_matching_process';
  exactWatcherCount?: number;
  currentFrame?: 'working' | 'idle_prompt' | 'other' | 'unavailable';
}

export type InspectionJob = (project: ObservableSessionProject, signal: AbortSignal) => Promise<AgentEvidence>;
export type HookKind = 'raw_idle' | 'stop' | 'idle_prompt' | 'permission' | 'elicitation';

export interface ActivityDecision {
  presentToHuman: boolean;
  autonomyBlocked: boolean;
  quarantined: boolean;
  ambiguous: boolean;
  observation: AgentObservation;
}

interface SessionRecord {
  session: CoordinatorSession;
  identityGeneration: number;
  trackingGeneration: number;
  tracking: boolean;
  observation: AgentObservation;
  projection: SessionActivityProjection;
  semanticRevision: number;
  decisionToken: number;
  eventSequence: number;
  completionWatermark: number;
  inFlight?: { promise: Promise<boolean>; controller: AbortController; token: number };
  retryAttempt: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  settleTimer?: ReturnType<typeof setTimeout>;
  settleGeneration: number;
  immediateRevisionRetry: boolean;
}

export interface CoordinatorOptions {
  inspect?: InspectionJob;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  inspectionDeadlineMs?: number;
  onDerivedIdle?: (session: CoordinatorSession) => void;
  scheduler?: BoundedActivityScheduler;
}

export type ActivityJobClass = 'foreground' | 'background';

interface ScheduledJob<T> {
  key: string;
  kind: ActivityJobClass;
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
}

/** Bounded two-class scheduler with a foreground reserve and starvation bound. */
export class BoundedActivityScheduler {
  private readonly foreground: ScheduledJob<unknown>[] = [];
  private readonly background: ScheduledJob<unknown>[] = [];
  private running = 0;
  private runningBackground = 0;
  private consecutiveForeground = 0;

  constructor(
    private readonly concurrency = 4,
    private readonly backgroundConcurrency = 3,
    private readonly foregroundBurst = 3
  ) {}

  enqueue<T>(key: string, kind: ActivityJobClass, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: ScheduledJob<T> = { key, kind, run, resolve, reject, signal };
      (kind === 'foreground' ? this.foreground : this.background).push(job as ScheduledJob<unknown>);
      if (signal)
        signal.addEventListener('abort', () => this.cancelQueued(job as ScheduledJob<unknown>), { once: true });
      this.drain();
    });
  }

  cancelKey(key: string): void {
    for (const queue of [this.foreground, this.background]) {
      for (const job of [...queue]) if (job.key === key) this.cancelQueued(job);
    }
  }

  private cancelQueued(job: ScheduledJob<unknown>): void {
    const queue = job.kind === 'foreground' ? this.foreground : this.background;
    const index = queue.indexOf(job);
    if (index < 0) return;
    queue.splice(index, 1);
    job.reject(new DOMException('Inspection aborted', 'AbortError'));
  }

  private drain(): void {
    while (this.running < this.concurrency) {
      const backgroundDue = this.background.length > 0 && this.consecutiveForeground >= this.foregroundBurst;
      let job: ScheduledJob<unknown> | undefined;
      if (backgroundDue && this.runningBackground < this.backgroundConcurrency) {
        job = this.background.shift();
      } else if (this.foreground.length > 0) {
        job = this.foreground.shift();
      } else if (this.runningBackground < this.backgroundConcurrency) {
        job = this.background.shift();
      }
      if (!job) break;
      if (job.signal?.aborted) {
        job.reject(new DOMException('Inspection aborted', 'AbortError'));
        continue;
      }
      this.start(job);
    }
  }

  private start(job: ScheduledJob<unknown>): void {
    this.running += 1;
    if (job.kind === 'background') {
      this.runningBackground += 1;
      this.consecutiveForeground = 0;
    } else {
      this.consecutiveForeground += 1;
    }
    let result: Promise<unknown>;
    try {
      result = job.run();
    } catch (error) {
      job.reject(error);
      this.finish(job);
      return;
    }
    void result.then(job.resolve, job.reject).finally(() => this.finish(job));
  }

  private finish(job: ScheduledJob<unknown>): void {
    this.running -= 1;
    if (job.kind === 'background') this.runningBackground -= 1;
    this.drain();
  }
}

export class SessionAgentActivityCoordinator {
  private readonly records = new Map<string, SessionRecord>();
  private readonly inspect?: InspectionJob;
  private readonly now: () => number;
  private readonly scheduleTimer: typeof setTimeout;
  private readonly cancelTimer: typeof clearTimeout;
  private readonly inspectionDeadlineMs: number;
  private readonly onDerivedIdle?: (session: CoordinatorSession) => void;
  private readonly scheduler: BoundedActivityScheduler;

  constructor(options: CoordinatorOptions = {}) {
    this.inspect = options.inspect;
    this.now = options.now ?? Date.now;
    this.scheduleTimer = options.setTimeout ?? setTimeout;
    this.cancelTimer = options.clearTimeout ?? clearTimeout;
    this.inspectionDeadlineMs = options.inspectionDeadlineMs ?? 5000;
    this.onDerivedIdle = options.onDerivedIdle;
    this.scheduler = options.scheduler ?? new BoundedActivityScheduler();
  }

  attachSession(session: CoordinatorSession): void {
    const prior = this.records.get(session.id);
    if (prior) this.disposeRecord(prior);
    const observation: AgentObservation = this.isObservable(session) ? 'unknown' : 'not_observable';
    const projection = projectAgentActivity(session.status, observation, undefined, this.now());
    const record: SessionRecord = {
      session,
      identityGeneration: (prior?.identityGeneration ?? 0) + 1,
      trackingGeneration: (prior?.trackingGeneration ?? 0) + 1,
      tracking: true,
      observation,
      projection,
      semanticRevision: 0,
      decisionToken: 0,
      eventSequence: 0,
      completionWatermark: 0,
      retryAttempt: 0,
      settleGeneration: 0,
      immediateRevisionRetry: false,
    };
    this.records.set(session.id, record);
    session.setActivityProjection(projection);
    if (this.inspect && observation === 'unknown') this.scheduleReconcile(record, 0);
  }

  detachSession(session: CoordinatorSession): void {
    const record = this.recordFor(session);
    if (!record) return;
    this.disposeRecord(record);
    this.records.delete(session.id);
  }

  cleanup(): void {
    for (const record of this.records.values()) this.disposeRecord(record);
    this.records.clear();
  }

  identityChanged(session: CoordinatorSession): void {
    const record = this.requireRecord(session);
    record.identityGeneration += 1;
    record.decisionToken += 1;
    record.semanticRevision = 0;
    record.eventSequence = 0;
    record.completionWatermark = 0;
    this.abortInspection(record);
    this.setRecordObservation(record, this.isObservable(session) ? 'unknown' : 'not_observable');
    if (this.inspect && record.observation === 'unknown') this.scheduleReconcile(record, 0);
  }

  trackingDisabled(session: CoordinatorSession): void {
    const record = this.requireRecord(session);
    record.tracking = false;
    record.trackingGeneration += 1;
    record.decisionToken += 1;
    this.abortInspection(record);
    this.setRecordObservation(record, 'not_observable');
  }

  trackingEnabled(session: CoordinatorSession): void {
    const record = this.requireRecord(session);
    record.tracking = true;
    record.trackingGeneration += 1;
    record.decisionToken += 1;
    this.setRecordObservation(record, this.isObservable(session) ? 'unknown' : 'not_observable');
    if (this.inspect && record.observation === 'unknown') this.scheduleReconcile(record, 0);
  }

  onAgentRevision(session: CoordinatorSession, semanticRevision: number): boolean {
    const record = this.requireRecord(session);
    if (semanticRevision <= record.semanticRevision) return false;
    record.semanticRevision = semanticRevision;
    record.decisionToken += 1;
    this.abortInspection(record);
    this.setRecordObservation(record, 'unknown');
    record.immediateRevisionRetry = true;
    if (this.inspect) this.scheduleReconcile(record, 0);
    return true;
  }

  setObservation(session: CoordinatorSession, observation: AgentObservation, semanticRevision: number): void {
    const record = this.requireRecord(session);
    record.semanticRevision = Math.max(record.semanticRevision, semanticRevision);
    this.setRecordObservation(record, observation);
  }

  invalidateDecision(session: CoordinatorSession): void {
    const record = this.requireRecord(session);
    record.decisionToken += 1;
    this.abortInspection(record);
  }

  nextRetryDelay(session: CoordinatorSession): number {
    const record = this.requireRecord(session);
    if (record.immediateRevisionRetry) return 0;
    return [250, 1000, 5000, 30_000][Math.min(Math.max(record.retryAttempt - 1, 0), 3)];
  }

  commitEvidence(session: CoordinatorSession, evidence: AgentEvidence): void {
    const record = this.requireRecord(session);
    record.semanticRevision = Math.max(record.semanticRevision, evidence.semanticRevision);
    if (evidence.exactWatcherCount !== undefined) {
      this.onWatcherCount(session, evidence.exactWatcherCount, evidence.semanticRevision);
      if (evidence.exactWatcherCount === 0 && evidence.currentFrame === 'idle_prompt') this.confirmExactZero(session);
      if (evidence.exactWatcherCount > 0 || evidence.observation === 'none') return;
    }
    if (evidence.processReason === 'no_registered_role_signature') {
      if (evidence.observation === 'live') this.setRecordObservation(record, 'live');
      return;
    }
    this.setRecordObservation(record, evidence.observation);
  }

  onWatcherCount(session: CoordinatorSession, count: number, semanticRevision: number): void {
    const record = this.requireRecord(session);
    if (semanticRevision < record.semanticRevision) return;
    if (semanticRevision > record.semanticRevision) {
      record.decisionToken += 1;
      this.abortInspection(record);
    }
    record.semanticRevision = semanticRevision;
    record.settleGeneration += 1;
    if (record.settleTimer) this.cancelTimer(record.settleTimer);
    record.settleTimer = undefined;
    if (count > 0) {
      this.setRecordObservation(record, 'live');
      return;
    }
    const generation = record.settleGeneration;
    record.settleTimer = this.scheduleTimer(() => {
      if (this.recordFor(session) !== record || record.settleGeneration !== generation) return;
      record.settleTimer = undefined;
      this.setRecordObservation(record, 'none');
      this.onDerivedIdle?.(session);
    }, FINAL_AGENT_SETTLE_MS);
  }

  confirmExactZero(session: CoordinatorSession): void {
    const record = this.requireRecord(session);
    if (!record.settleTimer) return;
    this.cancelTimer(record.settleTimer);
    record.settleTimer = undefined;
    record.settleGeneration += 1;
    this.setRecordObservation(record, 'none');
    this.onDerivedIdle?.(session);
  }

  onTerminalOutput(session: CoordinatorSession): void {
    const record = this.requireRecord(session);
    record.settleGeneration += 1;
    if (record.settleTimer) this.cancelTimer(record.settleTimer);
    record.settleTimer = undefined;
    record.decisionToken += 1;
    this.abortInspection(record);
    this.setRecordObservation(record, 'unknown');
  }

  project(session: CoordinatorSession): SessionActivityProjection {
    const record = this.recordFor(session);
    if (!record) return projectAgentActivity(session.status, 'not_observable', undefined, this.now());
    const ambiguous = this.isAmbiguous(record);
    const observation = ambiguous && record.observation !== 'not_observable' ? 'unknown' : record.observation;
    record.projection = projectAgentActivity(session.status, observation, record.projection, this.now());
    session.setActivityProjection(record.projection);
    return { ...record.projection };
  }

  projectFor(session: CoordinatorSession): ObservableSessionProject | undefined {
    if (!this.isObservable(session)) return undefined;
    return {
      session,
      workingDir: session.workingDir,
      projectHash: claudeProjectHash(session.workingDir),
      claudeSessionId: session.claudeSessionId!,
      claudeRuntimeVersion: session.claudeRuntimeVersion,
      claudeRuntimeCapability: session.claudeRuntimeCapability,
    };
  }

  async reconcile(session: CoordinatorSession, kind: ActivityJobClass = 'foreground'): Promise<boolean> {
    const record = this.requireRecord(session);
    if (!this.inspect || !record.tracking) return false;
    if (record.inFlight) return record.inFlight.promise;
    if (record.retryTimer) {
      this.cancelTimer(record.retryTimer);
      record.retryTimer = undefined;
    }
    const project = this.projectFor(session);
    if (!project) return false;

    const controller = new AbortController();
    const token = ++record.decisionToken;
    const snapshot = {
      record,
      session,
      identityGeneration: record.identityGeneration,
      trackingGeneration: record.trackingGeneration,
      terminalActivityEpoch: session.terminalActivityEpoch,
      semanticRevision: record.semanticRevision,
      token,
    };
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const promise = this.scheduler
      .enqueue(
        session.id,
        kind,
        () => {
          deadline = this.scheduleTimer(() => controller.abort(), this.inspectionDeadlineMs);
          const aborted = new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener(
              'abort',
              () => reject(new DOMException('Inspection deadline exceeded', 'AbortError')),
              { once: true }
            );
          });
          return Promise.race([this.inspect!(project, controller.signal), aborted]);
        },
        controller.signal
      )
      .then((evidence) => {
        if (!this.isLiveSnapshot(snapshot) || controller.signal.aborted) return false;
        if (evidence.semanticRevision !== record.semanticRevision) return false;
        record.retryAttempt = evidence.observation === 'unknown' ? record.retryAttempt + 1 : 0;
        this.commitEvidence(session, evidence);
        if (record.observation === 'unknown' && !record.settleTimer) {
          this.scheduleReconcile(record, this.nextRetryDelay(session));
        }
        return true;
      })
      .catch(() => {
        if (this.isLiveSnapshot(snapshot)) {
          record.retryAttempt += 1;
          this.setRecordObservation(record, 'unknown');
          this.scheduleReconcile(record, this.nextRetryDelay(session));
        }
        return false;
      })
      .finally(() => {
        if (deadline) this.cancelTimer(deadline);
        if (record.inFlight?.token === token) record.inFlight = undefined;
      });
    record.inFlight = { promise, controller, token };
    return promise;
  }

  decisionForRawIdle(session: CoordinatorSession): ActivityDecision {
    return this.decision(session, 'raw_idle', this.requireRecord(session).eventSequence + 1);
  }

  decisionForHook(
    session: CoordinatorSession,
    kind: Exclude<HookKind, 'raw_idle'>,
    sequence: number
  ): ActivityDecision {
    return this.decision(session, kind, sequence);
  }

  completeEvent(session: CoordinatorSession, sequence: number): void {
    const record = this.requireRecord(session);
    record.completionWatermark = Math.max(record.completionWatermark, sequence);
  }

  isAutonomyBlocked(session: CoordinatorSession): boolean {
    const record = this.recordFor(session);
    if (!record || record.observation === 'not_observable') return false;
    return this.isAmbiguous(record) || record.observation !== 'none';
  }

  private decision(session: CoordinatorSession, kind: HookKind, sequence: number): ActivityDecision {
    const record = this.requireRecord(session);
    if ((kind === 'raw_idle' || kind === 'stop') && record.settleTimer) this.confirmExactZero(session);
    const immediate = kind === 'permission' || kind === 'elicitation';
    const quarantined = !immediate && (sequence <= record.completionWatermark || sequence <= record.eventSequence);
    record.eventSequence = Math.max(record.eventSequence, sequence);
    const ambiguous = this.isAmbiguous(record);
    const autonomyBlocked = this.isAutonomyBlocked(session);
    const suppressible = record.observation === 'live';
    return {
      presentToHuman: immediate || (!quarantined && (ambiguous || !suppressible)),
      autonomyBlocked,
      quarantined,
      ambiguous,
      observation: ambiguous ? 'unknown' : record.observation,
    };
  }

  private isObservable(session: CoordinatorSession): boolean {
    return (
      session.mode === 'claude' &&
      !!session.claudeSessionId &&
      !session.remote &&
      session.agentObservationSupported !== false
    );
  }

  private identityKey(session: CoordinatorSession): string | undefined {
    if (!this.isObservable(session)) return undefined;
    return JSON.stringify([claudeProjectHash(session.workingDir), session.claudeSessionId]);
  }

  private isAmbiguous(record: SessionRecord): boolean {
    const key = this.identityKey(record.session);
    if (!key) return false;
    let matches = 0;
    for (const candidate of this.records.values()) {
      if (candidate.tracking && this.identityKey(candidate.session) === key) matches += 1;
    }
    return matches > 1;
  }

  private setRecordObservation(record: SessionRecord, observation: AgentObservation): void {
    record.observation = observation;
    if (observation !== 'unknown' && record.retryTimer) {
      this.cancelTimer(record.retryTimer);
      record.retryTimer = undefined;
    }
    record.projection = projectAgentActivity(record.session.status, observation, record.projection, this.now());
    record.session.setActivityProjection(record.projection);
  }

  private isLiveSnapshot(snapshot: {
    record: SessionRecord;
    session: CoordinatorSession;
    identityGeneration: number;
    trackingGeneration: number;
    terminalActivityEpoch: number;
    semanticRevision: number;
    token: number;
  }): boolean {
    const current = this.records.get(snapshot.session.id);
    return (
      current === snapshot.record &&
      current.session === snapshot.session &&
      current.identityGeneration === snapshot.identityGeneration &&
      current.trackingGeneration === snapshot.trackingGeneration &&
      snapshot.session.terminalActivityEpoch === snapshot.terminalActivityEpoch &&
      current.semanticRevision === snapshot.semanticRevision &&
      current.decisionToken === snapshot.token
    );
  }

  private recordFor(session: CoordinatorSession): SessionRecord | undefined {
    const record = this.records.get(session.id);
    return record?.session === session ? record : undefined;
  }

  private requireRecord(session: CoordinatorSession): SessionRecord {
    const record = this.recordFor(session);
    if (!record) throw new Error(`Session ${session.id} is not attached to the activity coordinator`);
    return record;
  }

  private abortInspection(record: SessionRecord): void {
    record.inFlight?.controller.abort();
    record.inFlight = undefined;
    this.scheduler.cancelKey(record.session.id);
  }

  private scheduleReconcile(record: SessionRecord, delay: number): void {
    if (record.retryTimer) this.cancelTimer(record.retryTimer);
    const session = record.session;
    record.retryTimer = this.scheduleTimer(() => {
      record.retryTimer = undefined;
      if (this.recordFor(session) !== record || record.observation !== 'unknown') return;
      record.immediateRevisionRetry = false;
      void this.reconcile(session, 'background');
    }, delay);
  }

  private disposeRecord(record: SessionRecord): void {
    this.abortInspection(record);
    if (record.retryTimer) this.cancelTimer(record.retryTimer);
    if (record.settleTimer) this.cancelTimer(record.settleTimer);
  }
}
