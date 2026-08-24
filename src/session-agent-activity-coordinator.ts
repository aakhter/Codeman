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
  readonly rawIdleAnchorAt?: number;
  /** Stable underlying Session object when this coordinator receives an adapter. */
  readonly reconstructionOwner?: object;
  readonly claudeRuntimeVersion?: string;
  readonly claudeRuntimeCapability?: 'exact_role' | 'none';
  readonly agentObservationSupported?: boolean;
  readonly remote?: unknown;
  setActivityProjection(projection: SessionActivityProjection, options?: { reconstructEpisode?: boolean }): void;
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
  const previousDerived =
    previous?.activityStatus === 'waiting_agents' || previous?.activityStatus === 'checking_agents';
  return {
    activityStatus,
    activityStatusSince: derived ? (previousDerived ? previous.activityStatusSince : now) : null,
  };
}

export function deriveRestoredAgentEpisodeAnchor(
  rawIdleAnchorAt: number | undefined,
  liveAgentStartedAt: readonly number[]
): number | undefined {
  if (!Number.isFinite(rawIdleAnchorAt)) return undefined;
  const reliableStarts = liveAgentStartedAt.filter((value) => Number.isFinite(value));
  return Math.max(rawIdleAnchorAt!, reliableStarts.length > 0 ? Math.min(...reliableStarts) : 0);
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
  exactWatcherAgentKeys?: readonly string[];
  /** Raw exact watcher keys before this coordinator's completion quarantine is applied. */
  observedWatcherAgentKeys?: readonly string[];
  /** Composite watcher keys backed by an exact agentId process proof. */
  exactProcessAgentKeys?: readonly string[];
  currentFrame?: Readonly<{
    source: 'tmux_visible_frame';
    status: 'positive' | 'negative' | 'unavailable';
    reason: string;
    renderedCount?: number;
  }>;
  /** Reliable recovery-only lower bound for the current derived agent episode. */
  episodeAnchorAt?: number;
}

export type InspectionJob = (project: ObservableSessionProject, signal: AbortSignal) => Promise<AgentEvidence>;
export type HookKind = 'raw_idle' | 'stop' | 'idle_prompt' | 'permission' | 'elicitation';

export interface ActivityDecision {
  event: ActivityEvent;
  settleEndedEarly: boolean;
  presentToHuman: boolean;
  autonomyBlocked: boolean;
  quarantined: boolean;
  ambiguous: boolean;
  observation: AgentObservation;
  liveEvidence: 'exact_process' | 'watcher_or_frame' | null;
  processReason?: AgentEvidence['processReason'];
}

export interface EventReconciliation {
  readonly event: ActivityEvent;
  readonly identityGeneration: number;
  readonly trackingGeneration: number;
  readonly terminalActivityEpoch: number;
  readonly semanticRevision: number;
  readonly decisionToken: number;
  readonly evidence: Readonly<AgentEvidence>;
}

export interface ReconciliationResult {
  readonly event?: ActivityEvent;
  readonly identityGeneration: number;
  readonly trackingGeneration: number;
  readonly terminalActivityEpoch: number;
  readonly semanticRevision: number;
  readonly decisionToken: number;
  readonly evidence: Readonly<AgentEvidence>;
}

export interface ActivityDecisionInput {
  reconciliation?: EventReconciliation;
}

export interface ActivityEvent {
  readonly sessionId: string;
  readonly identityGeneration: number;
  readonly trackingGeneration: number;
  readonly sequence: number;
  readonly kind: HookKind;
  readonly externalSourceSequence?: number;
}

export interface ActivityBookkeepingSnapshot {
  allocatedEvents: number;
  retiredEvents: number;
  reconciliationResults: number;
  eventReconciliations: number;
  activeConsumers: number;
}

const MAX_EVENT_BOOKKEEPING = 128;

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
  lastDecisionSequence: number;
  completionWatermark: number;
  quarantinedAgentKeys: Set<string>;
  allocatedEvents: Map<number, ActivityEvent>;
  retiredEvents: Map<number, ActivityEvent>;
  failedReconciliationEvents: Set<number>;
  activeEventConsumers: Map<number, number>;
  retireWhenInactive: Set<number>;
  eventReconciliations: Map<number, EventReconciliation>;
  reconciliationResults: Set<ReconciliationResult>;
  inFlight?: SharedInspection;
  retryAttempt: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  retryReason?: 'state' | 'evidence';
  settleTimer?: ReturnType<typeof setTimeout>;
  settleGeneration: number;
  immediateRevisionRetry: boolean;
  exactProcessLive: boolean;
  processReason?: AgentEvidence['processReason'];
  startupReconstructionPending: boolean;
}

interface InspectionSnapshot {
  record: SessionRecord;
  session: CoordinatorSession;
  identityGeneration: number;
  trackingGeneration: number;
  terminalActivityEpoch: number;
  semanticRevision: number;
  token: number;
}

interface SharedInspection {
  controller: AbortController;
  schedulerKey: symbol;
  token: number;
  snapshot: InspectionSnapshot;
  promise: Promise<Readonly<AgentEvidence> | false>;
  consumers: Set<symbol>;
  settled: boolean;
}

export interface CoordinatorOptions {
  inspect?: InspectionJob;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  inspectionDeadlineMs?: number;
  onDerivedIdle?: (session: CoordinatorSession) => void;
  onProjectionChanged?: (
    session: CoordinatorSession,
    previous: SessionActivityProjection,
    current: SessionActivityProjection
  ) => void;
  scheduler?: BoundedActivityScheduler;
}

export type ActivityJobClass = 'foreground' | 'background';

export interface ReconcileConsumerOptions {
  kind?: ActivityJobClass;
  deadlineMs?: number;
}

interface ScheduledJob<T> {
  key: string | symbol;
  kind: ActivityJobClass;
  order: number;
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
  private nextOrder = 0;

  constructor(
    private readonly concurrency = 4,
    private readonly backgroundConcurrency = 3,
    private readonly foregroundBurst = 3
  ) {}

  enqueue<T>(key: string | symbol, kind: ActivityJobClass, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: ScheduledJob<T> = { key, kind, order: this.nextOrder++, run, resolve, reject, signal };
      (kind === 'foreground' ? this.foreground : this.background).push(job as ScheduledJob<unknown>);
      if (signal)
        signal.addEventListener('abort', () => this.cancelQueued(job as ScheduledJob<unknown>), { once: true });
      this.drain();
    });
  }

  cancelKey(key: string | symbol): void {
    for (const queue of [this.foreground, this.background]) {
      for (const job of [...queue]) if (job.key === key) this.cancelQueued(job);
    }
  }

  promoteQueuedToForeground(key: string | symbol): boolean {
    const index = this.background.findIndex((job) => job.key === key);
    if (index < 0) return false;
    const [job] = this.background.splice(index, 1);
    job.kind = 'foreground';
    const insertionIndex = this.foreground.findIndex((queued) => queued.order > job.order);
    if (insertionIndex < 0) this.foreground.push(job);
    else this.foreground.splice(insertionIndex, 0, job);
    this.drain();
    return true;
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
  private readonly restoredReconstructionConsumed = new WeakSet<object>();
  private readonly inspect?: InspectionJob;
  private readonly now: () => number;
  private readonly scheduleTimer: typeof setTimeout;
  private readonly cancelTimer: typeof clearTimeout;
  private readonly inspectionDeadlineMs: number;
  private readonly onDerivedIdle?: (session: CoordinatorSession) => void;
  private readonly onProjectionChanged?: CoordinatorOptions['onProjectionChanged'];
  private readonly scheduler: BoundedActivityScheduler;

  constructor(options: CoordinatorOptions = {}) {
    this.inspect = options.inspect;
    this.now = options.now ?? Date.now;
    this.scheduleTimer = options.setTimeout ?? setTimeout;
    this.cancelTimer = options.clearTimeout ?? clearTimeout;
    this.inspectionDeadlineMs = options.inspectionDeadlineMs ?? 5000;
    this.onDerivedIdle = options.onDerivedIdle;
    this.onProjectionChanged = options.onProjectionChanged;
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
      lastDecisionSequence: 0,
      completionWatermark: 0,
      quarantinedAgentKeys: new Set(),
      allocatedEvents: new Map(),
      retiredEvents: new Map(),
      failedReconciliationEvents: new Set(),
      activeEventConsumers: new Map(),
      retireWhenInactive: new Set(),
      eventReconciliations: new Map(),
      reconciliationResults: new Set(),
      retryAttempt: 0,
      settleGeneration: 0,
      immediateRevisionRetry: false,
      exactProcessLive: false,
      processReason: undefined,
      startupReconstructionPending:
        session.status === 'idle' &&
        session.rawIdleAnchorAt !== undefined &&
        !this.restoredReconstructionConsumed.has(this.reconstructionOwner(session)),
    };
    this.records.set(session.id, record);
    session.setActivityProjection(projection);
    if (this.inspect && observation === 'unknown') this.scheduleReconcile(record, 0);
  }

  detachSession(session: CoordinatorSession): void {
    const record = this.recordFor(session);
    if (!record) return;
    this.consumeStartupReconstruction(record);
    this.disposeRecord(record);
    this.records.delete(session.id);
  }

  cleanup(): void {
    for (const record of this.records.values()) this.disposeRecord(record);
    this.records.clear();
  }

  identityChanged(session: CoordinatorSession): void {
    const record = this.requireRecord(session);
    this.consumeStartupReconstruction(record);
    record.projection = { activityStatus: session.status, activityStatusSince: null };
    record.session.setActivityProjection(record.projection);
    this.invalidateSettle(record);
    record.identityGeneration += 1;
    record.decisionToken += 1;
    record.semanticRevision = 0;
    record.eventSequence = 0;
    record.lastDecisionSequence = 0;
    record.completionWatermark = 0;
    record.quarantinedAgentKeys.clear();
    record.allocatedEvents.clear();
    record.retiredEvents.clear();
    record.failedReconciliationEvents.clear();
    record.activeEventConsumers.clear();
    record.retireWhenInactive.clear();
    record.eventReconciliations.clear();
    record.reconciliationResults.clear();
    this.abortInspection(record);
    this.setRecordObservation(record, this.isObservable(session) ? 'unknown' : 'not_observable');
    if (this.inspect && record.observation === 'unknown') this.scheduleReconcile(record, 0);
  }

  trackingDisabled(session: CoordinatorSession): void {
    const record = this.requireRecord(session);
    this.consumeStartupReconstruction(record);
    this.invalidateSettle(record);
    record.tracking = false;
    record.trackingGeneration += 1;
    record.decisionToken += 1;
    record.allocatedEvents.clear();
    record.retiredEvents.clear();
    record.failedReconciliationEvents.clear();
    record.activeEventConsumers.clear();
    record.retireWhenInactive.clear();
    record.eventReconciliations.clear();
    record.reconciliationResults.clear();
    record.quarantinedAgentKeys.clear();
    this.cancelRetry(record);
    this.abortInspection(record);
    this.setRecordObservation(record, 'not_observable');
  }

  trackingEnabled(session: CoordinatorSession): void {
    const record = this.requireRecord(session);
    record.tracking = true;
    record.trackingGeneration += 1;
    record.decisionToken += 1;
    record.quarantinedAgentKeys.clear();
    this.setRecordObservation(record, this.isObservable(session) ? 'unknown' : 'not_observable');
    if (this.inspect && record.observation === 'unknown') this.scheduleReconcile(record, 0);
  }

  onAgentRevision(session: CoordinatorSession, semanticRevision: number): boolean {
    const record = this.requireRecord(session);
    if (!record.tracking) return false;
    if (semanticRevision <= record.semanticRevision) return false;
    this.invalidateSettle(record);
    record.semanticRevision = semanticRevision;
    record.eventReconciliations.clear();
    record.reconciliationResults.clear();
    record.decisionToken += 1;
    this.abortInspection(record);
    this.setRecordObservation(record, 'unknown');
    record.immediateRevisionRetry = true;
    if (this.inspect) this.scheduleReconcile(record, 0);
    return true;
  }

  setObservation(session: CoordinatorSession, observation: AgentObservation, semanticRevision: number): void {
    const record = this.requireRecord(session);
    if (!record.tracking) return;
    if (!this.acceptSemanticRevision(record, semanticRevision)) return;
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
    if (!record.tracking) return;
    const exactProcessLive = evidence.observation === 'live' && evidence.processReason === 'matching_process';
    const observedWatcherAgentKeys = evidence.observedWatcherAgentKeys ?? evidence.exactWatcherAgentKeys;
    const initiallyEffectiveWatcherAgentKeys = observedWatcherAgentKeys
      ? this.filterWatcherAgentKeys(session, observedWatcherAgentKeys)
      : undefined;
    if (
      !exactProcessLive &&
      observedWatcherAgentKeys &&
      observedWatcherAgentKeys.length > 0 &&
      initiallyEffectiveWatcherAgentKeys?.length === 0
    ) {
      this.onWatcherSnapshot(session, observedWatcherAgentKeys, evidence.semanticRevision, evidence.episodeAnchorAt);
      return;
    }
    if (!this.acceptSemanticRevision(record, evidence.semanticRevision)) return;
    if (exactProcessLive) {
      for (const agentKey of evidence.exactProcessAgentKeys ?? []) record.quarantinedAgentKeys.delete(agentKey);
    }
    const effectiveWatcherAgentKeys = observedWatcherAgentKeys
      ? this.filterWatcherAgentKeys(session, observedWatcherAgentKeys)
      : undefined;
    record.processReason = evidence.processReason;
    if (evidence.exactWatcherCount !== undefined || observedWatcherAgentKeys !== undefined) {
      const effectiveCount = effectiveWatcherAgentKeys?.length ?? evidence.exactWatcherCount ?? 0;
      if (observedWatcherAgentKeys) {
        this.onWatcherSnapshot(session, observedWatcherAgentKeys, evidence.semanticRevision, evidence.episodeAnchorAt);
      } else {
        this.onWatcherCount(session, effectiveCount, evidence.semanticRevision);
      }
      if (effectiveCount > 0) {
        if (exactProcessLive) {
          record.exactProcessLive = true;
          record.processReason = evidence.processReason;
        }
        return;
      }
      if (evidence.observation === 'none') return;
    }
    if (evidence.processReason === 'no_registered_role_signature') {
      if (evidence.observation === 'live') this.setRecordObservation(record, 'live', false, evidence.processReason);
      return;
    }
    this.setRecordObservation(record, evidence.observation, exactProcessLive, evidence.processReason);
  }

  onWatcherCount(session: CoordinatorSession, count: number, semanticRevision: number): void {
    // Compatibility for count-only coordinator callers. Production watcher and
    // inspection paths use onWatcherSnapshot with opaque composite keys.
    this.onWatcherSnapshot(
      session,
      Array.from({ length: Math.max(0, count) }, (_value, index) => `legacy-count:${index}`),
      semanticRevision
    );
  }

  filterWatcherAgentKeys(session: CoordinatorSession, agentKeys: readonly string[]): string[] {
    const record = this.requireRecord(session);
    return [...new Set(agentKeys)].filter((agentKey) => !record.quarantinedAgentKeys.has(agentKey));
  }

  onWatcherSnapshot(
    session: CoordinatorSession,
    agentKeys: readonly string[],
    semanticRevision: number,
    episodeAnchorAt?: number
  ): void {
    const record = this.requireRecord(session);
    if (!record.tracking) return;
    if (semanticRevision < record.semanticRevision) return;
    if (semanticRevision > record.semanticRevision) {
      this.cancelRetry(record);
      record.decisionToken += 1;
      this.abortInspection(record);
    }
    record.semanticRevision = semanticRevision;
    this.invalidateSettle(record);
    if (this.filterWatcherAgentKeys(session, agentKeys).length > 0) {
      this.setRecordObservation(record, 'live', false, undefined, episodeAnchorAt, true);
      return;
    }
    const generation = record.settleGeneration;
    record.settleTimer = this.scheduleTimer(() => {
      if (this.recordFor(session) !== record || record.settleGeneration !== generation) return;
      record.settleTimer = undefined;
      this.consumeStartupReconstruction(record);
      this.setRecordObservation(record, 'none');
    }, FINAL_AGENT_SETTLE_MS);
  }

  private confirmExactZero(session: CoordinatorSession): boolean {
    const record = this.requireRecord(session);
    if (!record.settleTimer) return false;
    this.cancelTimer(record.settleTimer);
    record.settleTimer = undefined;
    record.settleGeneration += 1;
    this.consumeStartupReconstruction(record);
    this.setRecordObservation(record, 'none');
    return true;
  }

  onTerminalOutput(session: CoordinatorSession): void {
    const record = this.requireRecord(session);
    if (!record.tracking) return;
    record.settleGeneration += 1;
    if (record.settleTimer) this.cancelTimer(record.settleTimer);
    record.settleTimer = undefined;
    record.decisionToken += 1;
    record.eventReconciliations.clear();
    record.reconciliationResults.clear();
    this.abortInspection(record);
    if (!this.isObservable(session)) {
      this.setRecordObservation(record, 'not_observable');
      return;
    }
    this.setRecordObservation(record, 'unknown');
    if (this.inspect) this.scheduleReconcile(record, 0);
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

  reconcile(
    session: CoordinatorSession,
    kind: ActivityJobClass = 'foreground',
    deadlineMs: number = this.inspectionDeadlineMs
  ): Promise<ReconciliationResult | false> {
    return this.reconcileConsumer(session, undefined, { kind, deadlineMs });
  }

  reconcileForEvent(
    session: CoordinatorSession,
    event: ActivityEvent,
    options: ReconcileConsumerOptions = {}
  ): Promise<ReconciliationResult | false> {
    this.requireActiveEvent(session, event);
    return this.reconcileConsumer(session, event, options);
  }

  private reconcileConsumer(
    session: CoordinatorSession,
    event: ActivityEvent | undefined,
    options: ReconcileConsumerOptions
  ): Promise<ReconciliationResult | false> {
    const record = this.requireRecord(session);
    if (!this.inspect || !record.tracking) return Promise.resolve(false);
    const deadlineMs = options.deadlineMs ?? this.inspectionDeadlineMs;
    const deadlineAt = this.now() + Math.max(0, deadlineMs);
    if (deadlineAt <= this.now()) return Promise.resolve(false);
    const requestedKind = options.kind ?? 'foreground';
    let shared = record.inFlight;
    if (shared && (shared.controller.signal.aborted || !this.isLiveSnapshot(shared.snapshot))) {
      shared.controller.abort();
      if (record.inFlight === shared) record.inFlight = undefined;
      shared = undefined;
    }
    shared ??= this.startSharedInspection(record, requestedKind);
    if (!shared) return Promise.resolve(false);
    if (requestedKind === 'foreground') this.scheduler.promoteQueuedToForeground(shared.schedulerKey);
    return this.attachInspectionConsumer(record, shared, event, deadlineAt);
  }

  private startSharedInspection(record: SessionRecord, kind: ActivityJobClass): SharedInspection | undefined {
    const session = record.session;
    this.cancelRetry(record);
    const project = this.projectFor(session);
    if (!project) return undefined;

    const controller = new AbortController();
    const token = ++record.decisionToken;
    const snapshot: InspectionSnapshot = {
      record,
      session,
      identityGeneration: record.identityGeneration,
      trackingGeneration: record.trackingGeneration,
      terminalActivityEpoch: session.terminalActivityEpoch,
      semanticRevision: record.semanticRevision,
      token,
    };
    const shared: SharedInspection = {
      controller,
      schedulerKey: Symbol(`inspection:${session.id}:${token}`),
      token,
      snapshot,
      consumers: new Set(),
      settled: false,
      promise: Promise.resolve(false),
    };
    record.inFlight = shared;
    shared.promise = this.scheduler
      .enqueue(
        shared.schedulerKey,
        kind,
        () => {
          const aborted = new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener(
              'abort',
              () => reject(new DOMException('Inspection consumers detached', 'AbortError')),
              { once: true }
            );
          });
          return Promise.race([this.inspect!(project, controller.signal), aborted]);
        },
        controller.signal
      )
      .then((evidence) => {
        if (!this.isLiveSnapshot(snapshot) || controller.signal.aborted) return false as const;
        if (evidence.semanticRevision !== record.semanticRevision) return false as const;
        const authoritativeEvidence = Object.freeze({ ...evidence });
        const uncertain =
          authoritativeEvidence.observation === 'unknown' ||
          authoritativeEvidence.processReason === 'no_registered_role_signature';
        record.retryAttempt = uncertain ? record.retryAttempt + 1 : 0;
        if (!uncertain) this.cancelRetry(record);
        this.commitEvidence(session, authoritativeEvidence);
        if (uncertain && !record.settleTimer) {
          this.scheduleReconcile(record, this.nextRetryDelay(session), 'evidence');
        }
        return authoritativeEvidence;
      })
      .catch(() => {
        if (this.isLiveSnapshot(snapshot)) {
          record.retryAttempt += 1;
          this.setRecordObservation(record, 'unknown');
          this.scheduleReconcile(record, this.nextRetryDelay(session));
        }
        return false as const;
      })
      .finally(() => {
        shared.settled = true;
        if (record.inFlight === shared) record.inFlight = undefined;
      });
    return shared;
  }

  private attachInspectionConsumer(
    record: SessionRecord,
    shared: SharedInspection,
    event: ActivityEvent | undefined,
    deadlineAt: number
  ): Promise<ReconciliationResult | false> {
    const consumer = Symbol('inspection-consumer');
    if (event) {
      record.activeEventConsumers.set(event.sequence, (record.activeEventConsumers.get(event.sequence) ?? 0) + 1);
    }
    shared.consumers.add(consumer);
    return new Promise<ReconciliationResult | false>((resolve) => {
      let finished = false;
      const finish = (result: ReconciliationResult | false): void => {
        if (finished) return;
        finished = true;
        this.cancelTimer(deadline);
        shared.consumers.delete(consumer);
        if (event) {
          const remaining = (record.activeEventConsumers.get(event.sequence) ?? 1) - 1;
          if (remaining > 0) record.activeEventConsumers.set(event.sequence, remaining);
          else record.activeEventConsumers.delete(event.sequence);
          const hasSuccessfulOwnership = this.hasSuccessfulEventOwnership(record, event);
          if (remaining === 0) {
            const retirementRequested = record.retireWhenInactive.has(event.sequence);
            if (retirementRequested || (result === false && !hasSuccessfulOwnership)) {
              if (result === false && !retirementRequested) {
                record.failedReconciliationEvents.add(event.sequence);
              }
              this.retireEvent(record, event);
            }
          }
        }
        if (!shared.settled && shared.consumers.size === 0) shared.controller.abort();
        resolve(result);
      };
      const deadline = this.scheduleTimer(() => finish(false), Math.max(0, deadlineAt - this.now()));
      void shared.promise.then((evidence) => {
        if (this.now() >= deadlineAt) return finish(false);
        if (evidence === false || !this.isLiveSnapshot(shared.snapshot)) return finish(false);
        if (event && !this.isActiveEvent(record, event)) return finish(false);
        const result: ReconciliationResult = {
          event,
          identityGeneration: record.identityGeneration,
          trackingGeneration: record.trackingGeneration,
          terminalActivityEpoch: record.session.terminalActivityEpoch,
          semanticRevision: record.semanticRevision,
          decisionToken: shared.token,
          evidence,
        };
        if (event) record.reconciliationResults.add(result);
        finish(result);
      });
    });
  }

  decisionForRawIdle(session: CoordinatorSession): ActivityDecision {
    return this.decisionForEvent(session, this.allocateEvent(session, 'raw_idle'));
  }

  decisionForHook(
    session: CoordinatorSession,
    kind: Exclude<HookKind, 'raw_idle'>,
    externalSourceSequence?: number
  ): ActivityDecision {
    return this.decisionForEvent(session, this.allocateEvent(session, kind, externalSourceSequence));
  }

  allocateEvent(session: CoordinatorSession, kind: HookKind, externalSourceSequence?: number): ActivityEvent {
    const record = this.requireRecord(session);
    const event: ActivityEvent = {
      sessionId: session.id,
      identityGeneration: record.identityGeneration,
      trackingGeneration: record.trackingGeneration,
      sequence: ++record.eventSequence,
      kind,
      externalSourceSequence,
    };
    record.allocatedEvents.set(event.sequence, event);
    return event;
  }

  abandonEvent(session: CoordinatorSession, event: ActivityEvent): void {
    const record = this.requireEvent(session, event);
    record.failedReconciliationEvents.delete(event.sequence);
    this.retireEvent(record, event);
  }

  /**
   * Fail open for a current human-facing hook after inspection failure while
   * retaining the receipt's ordering and generation barriers.
   */
  decisionForFailedReconciliation(session: CoordinatorSession, event: ActivityEvent): ActivityDecision {
    const record = this.requireEvent(session, event);
    const immediate = event.kind === 'permission' || event.kind === 'elicitation';
    const failedReceipt = record.failedReconciliationEvents.delete(event.sequence);
    const replayed = record.retiredEvents.get(event.sequence) === event && !failedReceipt;
    const quarantined =
      replayed ||
      (!immediate && (event.sequence <= record.completionWatermark || event.sequence <= record.lastDecisionSequence));
    if (!immediate && !replayed) {
      record.lastDecisionSequence = Math.max(record.lastDecisionSequence, event.sequence);
    }
    const observable = record.observation !== 'not_observable';
    const autonomyBlocked = this.isAutonomyBlocked(session);
    const decision: ActivityDecision = {
      event,
      settleEndedEarly: false,
      presentToHuman: !replayed && (immediate || (!quarantined && (event.kind !== 'raw_idle' || !autonomyBlocked))),
      autonomyBlocked,
      quarantined,
      ambiguous: observable,
      observation: observable ? 'unknown' : 'not_observable',
      liveEvidence: null,
      processReason: record.processReason,
    };
    this.retireEvent(record, event);
    return decision;
  }

  completeEvent(session: CoordinatorSession, event: ActivityEvent): void {
    const record = this.requireEvent(session, event);
    record.failedReconciliationEvents.delete(event.sequence);
    if (event.kind !== 'permission' && event.kind !== 'elicitation') {
      record.completionWatermark = Math.max(record.completionWatermark, event.sequence);
    }
    this.retireEvent(record, event);
  }

  isAutonomyBlocked(session: CoordinatorSession): boolean {
    const record = this.recordFor(session);
    if (!record || record.observation === 'not_observable') return false;
    return this.isAmbiguous(record) || record.observation !== 'none';
  }

  reconciliationForEvent(
    session: CoordinatorSession,
    event: ActivityEvent,
    result: ReconciliationResult | false
  ): EventReconciliation {
    const record = this.requireActiveEvent(session, event);
    if (!record.tracking) throw new Error('Agent tracking is disabled for this session');
    if (
      result === false ||
      !record.reconciliationResults.delete(result) ||
      result.event !== event ||
      result.identityGeneration !== record.identityGeneration ||
      result.trackingGeneration !== record.trackingGeneration ||
      result.terminalActivityEpoch !== session.terminalActivityEpoch ||
      result.semanticRevision !== record.semanticRevision ||
      result.decisionToken !== record.decisionToken
    ) {
      throw new Error('Event reconciliation is not current event-bound evidence');
    }
    const reconciliation: EventReconciliation = {
      event,
      identityGeneration: record.identityGeneration,
      trackingGeneration: record.trackingGeneration,
      terminalActivityEpoch: session.terminalActivityEpoch,
      semanticRevision: record.semanticRevision,
      decisionToken: record.decisionToken,
      evidence: result.evidence,
    };
    record.eventReconciliations.set(event.sequence, reconciliation);
    return reconciliation;
  }

  decisionForEvent(
    session: CoordinatorSession,
    event: ActivityEvent,
    input: ActivityDecisionInput = {}
  ): ActivityDecision {
    const record = this.requireEvent(session, event);
    record.failedReconciliationEvents.delete(event.sequence);
    const reconciliation = input.reconciliation;
    const reconciliationIsFresh =
      !!reconciliation &&
      record.eventReconciliations.get(event.sequence) === reconciliation &&
      reconciliation.event === event &&
      reconciliation.identityGeneration === record.identityGeneration &&
      reconciliation.trackingGeneration === record.trackingGeneration &&
      reconciliation.terminalActivityEpoch === session.terminalActivityEpoch &&
      reconciliation.semanticRevision === record.semanticRevision &&
      reconciliation.decisionToken === record.decisionToken;
    if (reconciliation) record.eventReconciliations.delete(event.sequence);
    const capabilityCompleteNegativeStop =
      event.kind === 'stop' && reconciliationIsFresh && reconciliation.evidence.processReason === 'no_matching_process';
    if (capabilityCompleteNegativeStop) {
      record.completionWatermark = Math.max(record.completionWatermark, event.sequence);
      for (const agentKey of reconciliation.evidence.exactWatcherAgentKeys ?? []) {
        record.quarantinedAgentKeys.add(agentKey);
      }
      this.invalidateSettle(record);
      this.setRecordObservation(record, 'none', false, 'no_matching_process');
    }
    const settleEndedEarly =
      (event.kind === 'raw_idle' || event.kind === 'stop' || event.kind === 'idle_prompt') &&
      reconciliationIsFresh &&
      reconciliation.evidence.exactWatcherCount === 0
        ? this.confirmExactZero(session)
        : false;
    const immediate = event.kind === 'permission' || event.kind === 'elicitation';
    const replayed = record.retiredEvents.get(event.sequence) === event;
    const quarantined =
      replayed ||
      (!immediate &&
        !capabilityCompleteNegativeStop &&
        (event.sequence <= record.completionWatermark || event.sequence <= record.lastDecisionSequence));
    if (!immediate && !replayed) {
      record.lastDecisionSequence = Math.max(record.lastDecisionSequence, event.sequence);
    }
    const ambiguous = this.isAmbiguous(record);
    const autonomyBlocked = this.isAutonomyBlocked(session);
    const freshExactProcessLive =
      reconciliationIsFresh &&
      reconciliation.evidence.observation === 'live' &&
      reconciliation.evidence.processReason === 'matching_process';
    const freshExactFrameLive =
      reconciliationIsFresh &&
      reconciliation.evidence.observation === 'live' &&
      (reconciliation.evidence.exactWatcherAgentKeys?.length ?? reconciliation.evidence.exactWatcherCount ?? 0) > 0 &&
      reconciliation.evidence.currentFrame?.source === 'tmux_visible_frame' &&
      reconciliation.evidence.currentFrame.status === 'positive' &&
      reconciliation.evidence.currentFrame.renderedCount ===
        (reconciliation.evidence.exactWatcherAgentKeys?.length ?? reconciliation.evidence.exactWatcherCount);
    const suppressible =
      record.observation === 'live' &&
      (freshExactProcessLive || ((event.kind === 'idle_prompt' || event.kind === 'raw_idle') && freshExactFrameLive));
    const presentToHuman =
      !replayed &&
      (event.kind === 'raw_idle'
        ? !quarantined && !autonomyBlocked
        : immediate || (!quarantined && (ambiguous || !suppressible)));
    const decision: ActivityDecision = {
      event,
      settleEndedEarly,
      presentToHuman,
      autonomyBlocked,
      quarantined,
      ambiguous,
      observation: ambiguous ? 'unknown' : record.observation,
      liveEvidence:
        record.observation !== 'live'
          ? null
          : event.kind === 'stop'
            ? freshExactProcessLive
              ? 'exact_process'
              : 'watcher_or_frame'
            : record.exactProcessLive
              ? 'exact_process'
              : 'watcher_or_frame',
      processReason:
        event.kind === 'stop'
          ? reconciliationIsFresh
            ? reconciliation.evidence.processReason
            : undefined
          : reconciliationIsFresh
            ? reconciliation.evidence.processReason
            : record.processReason,
    };
    this.retireEvent(record, event);
    return decision;
  }

  bookkeepingSnapshot(session: CoordinatorSession): ActivityBookkeepingSnapshot {
    const record = this.requireRecord(session);
    let activeConsumers = 0;
    for (const count of record.activeEventConsumers.values()) activeConsumers += count;
    return {
      allocatedEvents: record.allocatedEvents.size,
      retiredEvents: record.retiredEvents.size,
      reconciliationResults: record.reconciliationResults.size,
      eventReconciliations: record.eventReconciliations.size,
      activeConsumers,
    };
  }

  private requireEvent(session: CoordinatorSession, event: ActivityEvent): SessionRecord {
    const record = this.requireRecord(session);
    if (!this.isKnownEvent(record, event)) {
      throw new Error('Activity event is stale or was not allocated by this coordinator');
    }
    return record;
  }

  private requireActiveEvent(session: CoordinatorSession, event: ActivityEvent): SessionRecord {
    const record = this.requireRecord(session);
    if (!this.isActiveEvent(record, event)) {
      throw new Error('Activity event is stale or was not allocated by this coordinator');
    }
    return record;
  }

  private hasCurrentIdentity(record: SessionRecord, event: ActivityEvent): boolean {
    return (
      event.sessionId === record.session.id &&
      event.identityGeneration === record.identityGeneration &&
      event.trackingGeneration === record.trackingGeneration
    );
  }

  private isActiveEvent(record: SessionRecord, event: ActivityEvent): boolean {
    return this.hasCurrentIdentity(record, event) && record.allocatedEvents.get(event.sequence) === event;
  }

  private isKnownEvent(record: SessionRecord, event: ActivityEvent): boolean {
    return (
      this.hasCurrentIdentity(record, event) &&
      (record.allocatedEvents.get(event.sequence) === event || record.retiredEvents.get(event.sequence) === event)
    );
  }

  private hasSuccessfulEventOwnership(record: SessionRecord, event: ActivityEvent): boolean {
    if (record.eventReconciliations.get(event.sequence)?.event === event) return true;
    for (const result of record.reconciliationResults) {
      if (result.event === event) return true;
    }
    return false;
  }

  private retireEvent(record: SessionRecord, event: ActivityEvent): void {
    if (!this.hasCurrentIdentity(record, event)) return;
    if ((record.activeEventConsumers.get(event.sequence) ?? 0) > 0) {
      record.retireWhenInactive.add(event.sequence);
      return;
    }
    record.retireWhenInactive.delete(event.sequence);
    if (record.allocatedEvents.get(event.sequence) === event) record.allocatedEvents.delete(event.sequence);
    if (record.eventReconciliations.get(event.sequence)?.event === event) {
      record.eventReconciliations.delete(event.sequence);
    }
    for (const result of record.reconciliationResults) {
      if (result.event === event) record.reconciliationResults.delete(result);
    }
    record.retiredEvents.delete(event.sequence);
    record.retiredEvents.set(event.sequence, event);
    while (record.retiredEvents.size > MAX_EVENT_BOOKKEEPING) {
      const oldest = record.retiredEvents.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      record.retiredEvents.delete(oldest);
      record.failedReconciliationEvents.delete(oldest);
    }
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

  private setRecordObservation(
    record: SessionRecord,
    observation: AgentObservation,
    exactProcessLive = false,
    processReason?: AgentEvidence['processReason'],
    episodeAnchorAt?: number,
    watcherSnapshot = false
  ): void {
    const previousProjection = record.projection;
    record.observation = observation;
    record.exactProcessLive = observation === 'live' && exactProcessLive;
    record.processReason = processReason;
    if (observation !== 'unknown' && record.retryReason !== 'evidence') this.cancelRetry(record);
    record.projection = projectAgentActivity(record.session.status, observation, record.projection, this.now());
    const reconstruct =
      record.startupReconstructionPending &&
      watcherSnapshot &&
      observation === 'live' &&
      Number.isFinite(episodeAnchorAt);
    if (reconstruct) {
      record.projection.activityStatusSince = Math.min(this.now(), Math.max(0, episodeAnchorAt!));
    }
    if (observation === 'live' && watcherSnapshot) this.consumeStartupReconstruction(record);
    record.session.setActivityProjection(record.projection, reconstruct ? { reconstructEpisode: true } : undefined);
    if (
      previousProjection.activityStatus !== record.projection.activityStatus ||
      previousProjection.activityStatusSince !== record.projection.activityStatusSince
    ) {
      this.onProjectionChanged?.(record.session, { ...previousProjection }, { ...record.projection });
    }
    const wasDerived =
      previousProjection.activityStatus === 'waiting_agents' || previousProjection.activityStatus === 'checking_agents';
    if (wasDerived && record.projection.activityStatus === 'idle' && record.session.status === 'idle') {
      this.onDerivedIdle?.(record.session);
    }
  }

  private consumeStartupReconstruction(record: SessionRecord): void {
    record.startupReconstructionPending = false;
    this.restoredReconstructionConsumed.add(this.reconstructionOwner(record.session));
  }

  private reconstructionOwner(session: CoordinatorSession): object {
    return session.reconstructionOwner ?? session;
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
    if (record.inFlight) this.scheduler.cancelKey(record.inFlight.schedulerKey);
    record.inFlight = undefined;
  }

  private invalidateSettle(record: SessionRecord): void {
    record.settleGeneration += 1;
    if (record.settleTimer) this.cancelTimer(record.settleTimer);
    record.settleTimer = undefined;
  }

  private acceptSemanticRevision(record: SessionRecord, semanticRevision: number): boolean {
    if (semanticRevision < record.semanticRevision) return false;
    if (semanticRevision === record.semanticRevision) return true;
    this.invalidateSettle(record);
    record.semanticRevision = semanticRevision;
    record.decisionToken += 1;
    record.eventReconciliations.clear();
    record.reconciliationResults.clear();
    this.abortInspection(record);
    this.setRecordObservation(record, 'unknown');
    return true;
  }

  private scheduleReconcile(record: SessionRecord, delay: number, reason: 'state' | 'evidence' = 'state'): void {
    this.cancelRetry(record);
    const session = record.session;
    record.retryReason = reason;
    record.retryTimer = this.scheduleTimer(() => {
      record.retryTimer = undefined;
      record.retryReason = undefined;
      if (this.recordFor(session) !== record || !record.tracking || !this.isObservable(session)) return;
      if (reason === 'state' && record.observation !== 'unknown') return;
      record.immediateRevisionRetry = false;
      void this.reconcile(session, 'background');
    }, delay);
  }

  private cancelRetry(record: SessionRecord): void {
    if (record.retryTimer) this.cancelTimer(record.retryTimer);
    record.retryTimer = undefined;
    record.retryReason = undefined;
  }

  private disposeRecord(record: SessionRecord): void {
    this.abortInspection(record);
    this.cancelRetry(record);
    if (record.settleTimer) this.cancelTimer(record.settleTimer);
  }
}
