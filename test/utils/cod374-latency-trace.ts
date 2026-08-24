import { performance as nodePerformance } from 'node:perf_hooks';
import type { Page } from 'playwright';

export const BROWSER_LATENCY_STAGES = [
  'browser.keydown',
  'browser.xterm-on-data',
  'browser.logical',
  'browser.durable-queued',
  'browser.ws-input-send',
  'browser.ws-input-send-return',
  'browser.ws-input-send-failure',
  'browser.ws-input-ack',
  'browser.ws-output-receive',
  'browser.output-handler',
  'browser.write-queued',
  'browser.xterm-write',
  'browser.xterm-write-return',
  'browser.xterm-write-callback',
  'browser.xterm-parsed',
  'browser.xterm-visible-after-parse',
  'browser.xterm-render',
  'browser.xterm-visible',
  'browser.paint-proxy',
  'browser.generation-incomplete',
] as const;

export type BrowserLatencyStage = (typeof BROWSER_LATENCY_STAGES)[number];
export const BROWSER_INPUT_STAGES = [
  'browser.keydown',
  'browser.xterm-on-data',
  'browser.logical',
  'browser.durable-queued',
  'browser.ws-input-send',
  'browser.ws-input-send-return',
  'browser.ws-input-ack',
] as const satisfies readonly BrowserLatencyStage[];
export const BROWSER_GLOBAL_OUTPUT_STAGES = [
  'browser.ws-output-receive',
  'browser.output-handler',
  'browser.write-queued',
  'browser.xterm-write',
  'browser.xterm-write-return',
  'browser.xterm-write-callback',
  'browser.xterm-parsed',
] as const satisfies readonly BrowserLatencyStage[];
export const BROWSER_VISIBILITY_STAGES = [
  'browser.xterm-visible-after-parse',
  'browser.xterm-render',
  'browser.xterm-visible',
  'browser.paint-proxy',
] as const satisfies readonly BrowserLatencyStage[];
export type LatencyClock = 'browser' | 'server' | 'harness';

export interface BrowserLatencyEvent {
  stage: BrowserLatencyStage;
  atMs: number;
  clock: 'browser';
  clockId: string;
  trialId: string;
  generation: number;
  inputIndex: number;
  tokenHash: string;
  tokenLength: number;
  clientId?: string;
  seq?: number;
  bytes?: number;
  ordinal?: number;
  writeId?: number;
  pendingCount?: number;
  valueHash?: string;
  selectedForAttribution?: boolean;
  attributedGeneration?: number;
  attributedInputIndex?: number;
  attempt?: number;
  failureHash?: string;
  incompleteReason?: 'coalesced-before-exact-visibility';
  coalescedIndex?: number;
  coalescedCount?: number;
}

export interface PaneProbe {
  startedNs: bigint;
  completedNs: bigint;
  present: boolean;
  durationMs: number;
  error?: string;
}

export interface PaneVisibilityInterval {
  lastAbsentCompletedNs: bigint | null;
  firstPresentStartedNs: bigint;
  firstPresentCompletedNs: bigint;
  widthMs: number;
  probes: PaneProbe[];
}

export interface PaneVisibilityObserverOptions {
  capture: (options: { signal?: AbortSignal; timeoutMs: number }) => Promise<string>;
  isPresent: (text: string) => boolean;
  deadlineMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
  nowNs?: () => bigint;
  wait?: (delayMs: number) => Promise<void>;
}

export interface PaneVisibilityTarget {
  id: string;
  isPresent: (text: string) => boolean;
}

export interface PaneVisibilitiesObserverOptions {
  capture: PaneVisibilityObserverOptions['capture'];
  targets: PaneVisibilityTarget[];
  completionTargetId: string;
  deadlineMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
  nowNs?: () => bigint;
  wait?: (delayMs: number) => Promise<void>;
}

export type PaneVisibilityResult =
  | { id: string; status: 'visible'; interval: PaneVisibilityInterval }
  | { id: string; status: 'incomplete'; error: PaneObservationError };

export class PaneObservationError extends Error {
  readonly probes: PaneProbe[];

  constructor(message: string, probes: PaneProbe[]) {
    super(message);
    this.name = 'PaneObservationError';
    this.probes = probes.map((probe) => ({ ...probe }));
  }
}

export class PaneVisibilitiesObservationError extends Error {
  readonly results: PaneVisibilityResult[];

  constructor(message: string, results: PaneVisibilityResult[]) {
    super(message);
    this.name = 'PaneVisibilitiesObservationError';
    this.results = results;
  }
}

const BROWSER_EVENT_FIELDS = new Set<keyof BrowserLatencyEvent>([
  'stage',
  'atMs',
  'clock',
  'clockId',
  'trialId',
  'generation',
  'inputIndex',
  'tokenHash',
  'tokenLength',
  'clientId',
  'seq',
  'bytes',
  'ordinal',
  'writeId',
  'pendingCount',
  'valueHash',
  'selectedForAttribution',
  'attributedGeneration',
  'attributedInputIndex',
  'attempt',
  'failureHash',
  'incompleteReason',
  'coalescedIndex',
  'coalescedCount',
]);
const HASH = /^[0-9a-f]{16}$/;

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function tracingOverheadGate(
  offP95: number,
  onP95: number
): { passed: boolean; deltaMs: number; deltaPercent: number } {
  if (!finitePositive(offP95) || !finitePositive(onP95))
    throw new Error('Tracing overhead requires finite positive p95');
  const deltaMs = onP95 - offP95;
  const deltaPercent = (deltaMs / offP95) * 100;
  return { passed: deltaMs <= 5 && deltaPercent <= 10, deltaMs, deltaPercent };
}

export async function observePaneVisibility(options: PaneVisibilityObserverOptions): Promise<PaneVisibilityInterval> {
  if (!finitePositive(options.deadlineMs) || !Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs < 0) {
    throw new Error('Pane observer requires a positive deadline and nonnegative poll interval');
  }
  const nowNs = options.nowNs ?? process.hrtime.bigint;
  const wait = options.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const deadlineAt = nodePerformance.now() + options.deadlineMs;
  const probes: PaneProbe[] = [];
  let lastAbsentCompletedNs: bigint | null = null;

  for (;;) {
    if (options.signal?.aborted) throw new PaneObservationError('Pane observer aborted', probes);
    if (nodePerformance.now() > deadlineAt)
      throw new PaneObservationError(`Pane observer deadline exceeded after ${probes.length} probes`, probes);

    const startedNs = nowNs();
    let text = '';
    let error: string | undefined;
    try {
      text = await options.capture({
        signal: options.signal,
        timeoutMs: Math.max(1, Math.floor(deadlineAt - nodePerformance.now())),
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const completedNs = nowNs();
    let present = false;
    if (error === undefined) {
      try {
        present = options.isPresent(text);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }
    const probe: PaneProbe = {
      startedNs,
      completedNs,
      present,
      durationMs: Number(completedNs - startedNs) / 1_000_000,
      ...(error === undefined ? {} : { error }),
    };
    probes.push(probe);

    if (nodePerformance.now() > deadlineAt)
      throw new PaneObservationError(`Pane observer deadline exceeded after ${probes.length} probes`, probes);

    if (present) {
      if (lastAbsentCompletedNs === null) {
        throw new PaneObservationError(
          'Pane observer was not proven pre-armed: first successful probe was already present',
          probes
        );
      }
      const lowerBoundNs = lastAbsentCompletedNs;
      return {
        lastAbsentCompletedNs,
        firstPresentStartedNs: startedNs,
        firstPresentCompletedNs: completedNs,
        widthMs: Number(completedNs - lowerBoundNs) / 1_000_000,
        probes,
      };
    }
    if (error === undefined) lastAbsentCompletedNs = completedNs;
    if (options.signal?.aborted) throw new PaneObservationError('Pane observer aborted', probes);
    await wait(options.pollIntervalMs);
  }
}

export async function observePaneVisibilities(
  options: PaneVisibilitiesObserverOptions
): Promise<PaneVisibilityResult[]> {
  if (!finitePositive(options.deadlineMs) || !Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs < 0) {
    throw new Error('Pane observer requires a positive deadline and nonnegative poll interval');
  }
  if (options.targets.length === 0) throw new Error('Pane observer requires at least one target');
  const ids = options.targets.map((target) => target.id);
  if (ids.some((id) => id.length === 0) || new Set(ids).size !== ids.length) {
    throw new Error('Pane observer target IDs must be nonempty and unique');
  }
  if (!ids.includes(options.completionTargetId)) throw new Error('Pane observer completion target is missing');

  const nowNs = options.nowNs ?? process.hrtime.bigint;
  const wait = options.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const deadlineAt = nodePerformance.now() + options.deadlineMs;
  const states = options.targets.map((target) => ({
    target,
    probes: [] as PaneProbe[],
    lastAbsentCompletedNs: null as bigint | null,
    result: null as PaneVisibilityResult | null,
  }));

  const resultsForStop = (reason: string): PaneVisibilityResult[] =>
    states.map(
      (state) =>
        state.result ?? {
          id: state.target.id,
          status: 'incomplete',
          error: new PaneObservationError(reason, state.probes),
        }
    );
  const throwStopped = (message: string): never => {
    throw new PaneVisibilitiesObservationError(message, resultsForStop(message));
  };

  for (;;) {
    if (options.signal?.aborted) throwStopped('Pane observer aborted');
    if (nodePerformance.now() > deadlineAt) throwStopped('Pane observer deadline exceeded');

    const startedNs = nowNs();
    let text = '';
    let captureError: string | undefined;
    try {
      text = await options.capture({
        signal: options.signal,
        timeoutMs: Math.max(1, Math.floor(deadlineAt - nodePerformance.now())),
      });
    } catch (cause) {
      captureError = cause instanceof Error ? cause.message : String(cause);
    }
    const completedNs = nowNs();
    const durationMs = Number(completedNs - startedNs) / 1_000_000;

    for (const state of states) {
      if (state.result !== null) continue;
      let present = false;
      let error = captureError;
      if (error === undefined) {
        try {
          present = state.target.isPresent(text);
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
      }
      const probe: PaneProbe = {
        startedNs,
        completedNs,
        present,
        durationMs,
        ...(error === undefined ? {} : { error }),
      };
      state.probes.push(probe);
      if (present) {
        if (state.lastAbsentCompletedNs === null) {
          state.result = {
            id: state.target.id,
            status: 'incomplete',
            error: new PaneObservationError(
              'Pane observer was not proven pre-armed: first successful probe was already present',
              state.probes
            ),
          };
          continue;
        }
        state.result = {
          id: state.target.id,
          status: 'visible',
          interval: {
            lastAbsentCompletedNs: state.lastAbsentCompletedNs,
            firstPresentStartedNs: startedNs,
            firstPresentCompletedNs: completedNs,
            widthMs: Number(completedNs - state.lastAbsentCompletedNs) / 1_000_000,
            probes: state.probes.map((entry) => ({ ...entry })),
          },
        };
      } else if (error === undefined) {
        state.lastAbsentCompletedNs = completedNs;
      }
    }

    const completion = states.find((state) => state.target.id === options.completionTargetId)!;
    if (completion.result?.status === 'visible') {
      return resultsForStop('Pane target was not observed before the completion target');
    }
    if (completion.result?.status === 'incomplete') {
      throw new PaneVisibilitiesObservationError(
        completion.result.error.message,
        resultsForStop('Pane observation stopped after completion target pre-arm failure')
      );
    }
    if (nodePerformance.now() > deadlineAt) throwStopped('Pane observer deadline exceeded');
    if (options.signal?.aborted) throwStopped('Pane observer aborted');
    await wait(options.pollIntervalMs);
  }
}

export function requireNoBrowserLongTasks(diagnosticWarnings: string[]): void {
  if (diagnosticWarnings.length === 0) return;
  throw new Error(
    `Accepted typing window contained browser long-task diagnostics: ${JSON.stringify(diagnosticWarnings)}`
  );
}

export function validateBrowserLatencyTrace(events: BrowserLatencyEvent[]): BrowserLatencyEvent[] {
  if (!Array.isArray(events) || events.length === 0) throw new Error('Browser trace is empty');
  const expectedClockId = events[0].clockId;
  const expectedTrialId = events[0].trialId;
  for (const event of events) {
    for (const field of Object.keys(event)) {
      if (!BROWSER_EVENT_FIELDS.has(field)) throw new Error(`Unknown browser trace field: ${field}`);
    }
    if (
      !BROWSER_LATENCY_STAGES.includes(event.stage) ||
      !Number.isFinite(event.atMs) ||
      event.atMs < 0 ||
      event.clock !== 'browser' ||
      typeof event.clockId !== 'string' ||
      event.clockId.length === 0 ||
      typeof event.trialId !== 'string' ||
      event.trialId.length === 0 ||
      !Number.isSafeInteger(event.generation) ||
      event.generation < 0 ||
      !Number.isSafeInteger(event.inputIndex) ||
      event.inputIndex < 0 ||
      !HASH.test(event.tokenHash) ||
      !Number.isSafeInteger(event.tokenLength) ||
      event.tokenLength < 1 ||
      (event.seq !== undefined && (!Number.isSafeInteger(event.seq) || event.seq < 0)) ||
      (event.bytes !== undefined && (!Number.isSafeInteger(event.bytes) || event.bytes < 0)) ||
      (event.ordinal !== undefined && (!Number.isSafeInteger(event.ordinal) || event.ordinal < 0)) ||
      (event.writeId !== undefined && (!Number.isSafeInteger(event.writeId) || event.writeId < 1)) ||
      (event.pendingCount !== undefined && (!Number.isSafeInteger(event.pendingCount) || event.pendingCount < 0)) ||
      (event.valueHash !== undefined && !HASH.test(event.valueHash)) ||
      (event.selectedForAttribution !== undefined && typeof event.selectedForAttribution !== 'boolean') ||
      (event.attributedGeneration !== undefined &&
        (!Number.isSafeInteger(event.attributedGeneration) || event.attributedGeneration < 1)) ||
      (event.attributedInputIndex !== undefined &&
        (!Number.isSafeInteger(event.attributedInputIndex) || event.attributedInputIndex < 0)) ||
      (event.attempt !== undefined && (!Number.isSafeInteger(event.attempt) || event.attempt < 1)) ||
      (event.failureHash !== undefined && !HASH.test(event.failureHash)) ||
      (event.incompleteReason !== undefined && event.incompleteReason !== 'coalesced-before-exact-visibility') ||
      (event.coalescedIndex !== undefined &&
        (!Number.isSafeInteger(event.coalescedIndex) || event.coalescedIndex < 0)) ||
      (event.coalescedCount !== undefined &&
        (!Number.isSafeInteger(event.coalescedCount) || event.coalescedCount < 1)) ||
      (event.coalescedIndex === undefined) !== (event.coalescedCount === undefined) ||
      (event.coalescedIndex !== undefined &&
        event.coalescedCount !== undefined &&
        event.coalescedIndex >= event.coalescedCount) ||
      (event.generation === 0 && !BROWSER_GLOBAL_OUTPUT_STAGES.includes(event.stage as any))
    ) {
      throw new Error(`Invalid browser trace event: ${event.stage}`);
    }
    if (event.clockId !== expectedClockId) throw new Error('Mixed browser clock identity');
    if (event.trialId !== expectedTrialId) throw new Error('Mixed browser trial identity');
  }
  for (let index = 1; index < events.length; index++) {
    if (events[index].atMs < events[index - 1].atMs) {
      throw new Error(`Global browser trace is non-monotonic at ${events[index].stage}`);
    }
  }

  const inputEvents = events.filter((event) => event.generation > 0);
  const generationInputs = new Map<number, number>();
  const inputGenerations = new Map<number, number>();
  const allGroupTokens = new Map<string, string>();
  for (const event of inputEvents) {
    const generationInput = generationInputs.get(event.generation);
    const inputGeneration = inputGenerations.get(event.inputIndex);
    if (
      (generationInput !== undefined && generationInput !== event.inputIndex) ||
      (inputGeneration !== undefined && inputGeneration !== event.generation)
    ) {
      throw new Error('Mixed browser generation input identity');
    }
    generationInputs.set(event.generation, event.inputIndex);
    inputGenerations.set(event.inputIndex, event.generation);
    const groupKey = `${event.generation}:${event.inputIndex}`;
    const tokenIdentity = `${event.tokenHash}:${event.tokenLength}`;
    if (allGroupTokens.has(groupKey) && allGroupTokens.get(groupKey) !== tokenIdentity) {
      throw new Error(`Mixed browser token identity for ${groupKey}`);
    }
    allGroupTokens.set(groupKey, tokenIdentity);
  }

  const keydowns = inputEvents.filter((event) => event.stage === 'browser.keydown');
  for (let index = 1; index < keydowns.length; index++) {
    if (
      keydowns[index].generation <= keydowns[index - 1].generation ||
      keydowns[index].inputIndex <= keydowns[index - 1].inputIndex
    ) {
      throw new Error('Browser generation order violation');
    }
  }

  const selected = inputEvents.filter((event) => event.selectedForAttribution !== false);
  const groupKeys = [...new Set(inputEvents.map((event) => `${event.generation}:${event.inputIndex}`))];
  for (const key of groupKeys) {
    const group = selected.filter((event) => `${event.generation}:${event.inputIndex}` === key);
    if (group.length === 0) throw new Error(`Missing selected input events for ${key}`);
    const tokenHash = group[0].tokenHash;
    const tokenLength = group[0].tokenLength;
    if (group.some((event) => event.tokenHash !== tokenHash || event.tokenLength !== tokenLength)) {
      throw new Error(`Mixed browser token identity for ${key}`);
    }
    const stageIndexes = new Map<BrowserLatencyStage, number>();
    for (const stage of BROWSER_INPUT_STAGES) {
      const matches = group.map((event, index) => ({ event, index })).filter((entry) => entry.event.stage === stage);
      if (matches.length === 0) throw new Error(`Missing browser stage: ${stage} for ${key}`);
      if (matches.length > 1) throw new Error(`Duplicate browser stage: ${stage} for ${key}`);
      stageIndexes.set(stage, matches[0].index);
    }
    for (let index = 1; index < group.length; index++) {
      if (group[index].atMs < group[index - 1].atMs) {
        throw new Error(`Non-monotonic browser time at ${group[index].stage} for ${key}`);
      }
    }
    const orderedEdges: Array<readonly [BrowserLatencyStage, BrowserLatencyStage]> = [
      ['browser.keydown', 'browser.xterm-on-data'],
      ['browser.xterm-on-data', 'browser.logical'],
      ['browser.logical', 'browser.durable-queued'],
      ['browser.durable-queued', 'browser.ws-input-send'],
      ['browser.ws-input-send', 'browser.ws-input-send-return'],
      ['browser.ws-input-send-return', 'browser.ws-input-ack'],
    ];
    for (const [before, after] of orderedEdges) {
      if (stageIndexes.get(before)! >= stageIndexes.get(after)!) {
        throw new Error(`Browser stage order violation: ${before} must precede ${after} for ${key}`);
      }
    }
    const visibility = group.filter((event) => BROWSER_VISIBILITY_STAGES.includes(event.stage as any));
    const incomplete = group.filter((event) => event.stage === 'browser.generation-incomplete');
    if (visibility.length > 0 && incomplete.length > 0) throw new Error(`Mixed completion state for ${key}`);
    if (visibility.length === 0) {
      if (incomplete.length !== 1) throw new Error(`Missing explicit incomplete generation marker for ${key}`);
    } else {
      if (visibility.map((event) => event.stage).join(',') !== BROWSER_VISIBILITY_STAGES.join(',')) {
        throw new Error(`Incomplete visibility stage order for ${key}`);
      }
    }
    const identityEvents = group.filter((event) =>
      [
        'browser.durable-queued',
        'browser.ws-input-send',
        'browser.ws-input-send-return',
        'browser.ws-input-ack',
      ].includes(event.stage)
    );
    const clientIds = new Set(identityEvents.map((event) => event.clientId));
    const sequences = new Set(identityEvents.map((event) => event.seq));
    if (
      identityEvents.length !== 4 ||
      identityEvents.some(
        (event) =>
          typeof event.clientId !== 'string' ||
          event.clientId.length === 0 ||
          !Number.isSafeInteger(event.seq) ||
          event.seq! < 0
      ) ||
      clientIds.size !== 1 ||
      sequences.size !== 1
    ) {
      throw new Error(`Mixed client sequence identity for ${key}`);
    }
    const coalescedEvents = group.filter((event) =>
      [
        'browser.logical',
        'browser.durable-queued',
        'browser.ws-input-send',
        'browser.ws-input-send-return',
        'browser.ws-input-ack',
      ].includes(event.stage)
    );
    const coalescedIdentities = new Set(
      coalescedEvents.map((event) => `${event.coalescedIndex ?? 0}:${event.coalescedCount ?? 1}`)
    );
    if (coalescedEvents.length !== 5 || coalescedIdentities.size !== 1) {
      throw new Error(`Mixed browser coalesced input identity for ${key}`);
    }
  }

  let priorOrdinal = -1;
  for (const event of events.filter((entry) => entry.stage === 'browser.ws-output-receive')) {
    if (event.ordinal === undefined || event.ordinal <= priorOrdinal) throw new Error('Non-monotonic output ordinal');
    priorOrdinal = event.ordinal;
  }
  return events;
}

export interface ClockStamp {
  clock: LatencyClock;
  clockId: string;
  atMs: number;
}

export interface ClockCalibration {
  offsetMs: number;
  uncertaintyMs: number;
}

export function componentLocalDuration(start: ClockStamp, end: ClockStamp): number;
export function componentLocalDuration(
  start: ClockStamp,
  end: ClockStamp,
  calibration: ClockCalibration
): { durationMs: number; uncertaintyMs: number };
export function componentLocalDuration(
  start: ClockStamp,
  end: ClockStamp,
  calibration?: ClockCalibration
): number | { durationMs: number; uncertaintyMs: number } {
  if (![start.atMs, end.atMs].every(Number.isFinite)) throw new Error('Clock timestamps must be finite');
  if (start.clock === end.clock && start.clockId === end.clockId) return end.atMs - start.atMs;
  if (
    !calibration ||
    !Number.isFinite(calibration.offsetMs) ||
    !Number.isFinite(calibration.uncertaintyMs) ||
    calibration.uncertaintyMs < 0
  ) {
    throw new Error('Cross-clock subtraction requires bounded calibration');
  }
  return { durationMs: end.atMs - calibration.offsetMs - start.atMs, uncertaintyMs: calibration.uncertaintyMs };
}

export interface CorrelatedOutputEvent extends BrowserLatencyEvent {
  serverOrdinal: number;
  connectionHash: string;
}

export interface MeasuredInputIdentity {
  clientId: string;
  seq: number;
}

export function correlateBrowserServerTrace(
  browserEvents: BrowserLatencyEvent[],
  serverEvents: Array<Record<string, unknown>>,
  measuredInput: MeasuredInputIdentity
): CorrelatedOutputEvent[] {
  const measuredConnections = new Set(
    serverEvents
      .filter(
        (event) =>
          event.stage === 'server.input.post-ack' &&
          event.clientId === measuredInput.clientId &&
          event.seq === measuredInput.seq &&
          typeof event.connectionHash === 'string'
      )
      .map((event) => event.connectionHash as string)
  );
  if (measuredConnections.size !== 1) throw new Error('Unable to derive one measured input connection');
  const measuredConnectionHash = [...measuredConnections][0];
  const measuredAckOrdinals = serverEvents
    .filter(
      (event) =>
        event.stage === 'server.input.post-ack' &&
        event.clientId === measuredInput.clientId &&
        event.seq === measuredInput.seq &&
        event.connectionHash === measuredConnectionHash &&
        typeof event.ordinal === 'number'
    )
    .map((event) => event.ordinal as number);
  if (measuredAckOrdinals.length !== 1) throw new Error('Unable to derive one measured input ACK boundary');
  const ackOrdinal = measuredAckOrdinals[0];
  const candidates = serverEvents.filter(
    (event) =>
      event.stage === 'server.output.post-send' &&
      event.connectionHash === measuredConnectionHash &&
      typeof event.ordinal === 'number' &&
      event.ordinal > ackOrdinal &&
      typeof event.valueHash === 'string' &&
      typeof event.bytes === 'number' &&
      typeof event.connectionHash === 'string'
  );
  const browserOutput = browserEvents.filter((event) => event.stage === 'browser.ws-output-receive');
  if (browserOutput.length !== candidates.length) {
    throw new Error(`Lossless output mismatch: browser=${browserOutput.length} server=${candidates.length}`);
  }
  return browserOutput.map((event, index) => {
    const match = candidates[index];
    if (match.valueHash !== event.valueHash || match.bytes !== event.bytes) {
      throw new Error(`Lossless output mismatch at browser ordinal ${event.ordinal}`);
    }
    return {
      ...event,
      serverOrdinal: match.ordinal as number,
      connectionHash: match.connectionHash as string,
    };
  });
}

const SERVER_UPSTREAM_OUTPUT_STAGES = [
  'server.output.pty-received',
  'server.output.handler-enter',
  'server.output.terminal-emitted',
] as const;
const SERVER_CONNECTION_CHUNK_STAGES = ['server.output.ws-received', 'server.output.batch-enqueued'] as const;
const SERVER_FLUSH_STAGES = ['server.output.flush-start', 'server.output.pre-send', 'server.output.post-send'] as const;

function validateServerStageGroups(
  events: Array<Record<string, unknown>>,
  stages: readonly string[],
  label: string
): number {
  if (events.length === 0 || events.length % stages.length !== 0) {
    throw new Error(`Incomplete server output ${label} chain`);
  }
  let priorOrdinal = -1;
  for (let offset = 0; offset < events.length; offset += stages.length) {
    const group = events.slice(offset, offset + stages.length);
    if (group.some((event, index) => event.stage !== stages[index])) {
      throw new Error(`Server output ${label} stage order violation`);
    }
    const first = group[0];
    for (const event of group) {
      if (
        event.valueHash !== first.valueHash ||
        event.bytes !== first.bytes ||
        typeof event.ordinal !== 'number' ||
        event.ordinal <= priorOrdinal
      ) {
        throw new Error(`Server output ${label} identity or ordinal order violation`);
      }
      priorOrdinal = event.ordinal;
    }
  }
  return events.length / stages.length;
}

export function validateServerOutputChain(
  serverEvents: Array<Record<string, unknown>>,
  connectionHash: string
): { upstreamChunks: number; connectionChunks: number; flushes: number } {
  if (!HASH.test(connectionHash)) throw new Error('Invalid measured server connection hash');
  const upstream = serverEvents.filter((event) => SERVER_UPSTREAM_OUTPUT_STAGES.includes(event.stage as any));
  const connectionChunks = serverEvents.filter(
    (event) => event.connectionHash === connectionHash && SERVER_CONNECTION_CHUNK_STAGES.includes(event.stage as any)
  );
  const flushes = serverEvents.filter(
    (event) => event.connectionHash === connectionHash && SERVER_FLUSH_STAGES.includes(event.stage as any)
  );
  const upstreamCount = validateServerStageGroups(upstream, SERVER_UPSTREAM_OUTPUT_STAGES, 'upstream');
  const connectionCount = validateServerStageGroups(
    connectionChunks,
    SERVER_CONNECTION_CHUNK_STAGES,
    'connection chunk'
  );
  const flushCount = validateServerStageGroups(flushes, SERVER_FLUSH_STAGES, 'flush');
  if (flushes.some((event) => event.stage === 'server.output.post-send' && event.delivered !== true)) {
    throw new Error('Server output post-send was not delivered');
  }
  const emitted = upstream.filter((event) => event.stage === 'server.output.terminal-emitted');
  const received = connectionChunks.filter((event) => event.stage === 'server.output.ws-received');
  if (
    emitted.length !== received.length ||
    emitted.some(
      (event, index) => event.valueHash !== received[index].valueHash || event.bytes !== received[index].bytes
    )
  ) {
    throw new Error('Server output upstream/connection lossless mismatch');
  }
  return { upstreamChunks: upstreamCount, connectionChunks: connectionCount, flushes: flushCount };
}

export interface PaintSelection {
  generation: number;
  inputIndex: number;
  ordinal: number;
  writeId: number;
  selectionId: number;
}

export function createPaintFence() {
  let nextSelectionId = 1;
  const current = new Map<number, PaintSelection>();
  return {
    select(selection: Omit<PaintSelection, 'selectionId'>): PaintSelection {
      const frozen = Object.freeze({ ...selection, selectionId: nextSelectionId++ });
      current.set(selection.generation, frozen);
      return frozen;
    },
    isCurrent(selection: PaintSelection): boolean {
      return current.get(selection.generation) === selection;
    },
  };
}

export interface XtermWriteContext {
  generation: number;
  inputIndex: number;
  outputOrdinal: number;
}

export interface XtermWriteTraceEvent extends XtermWriteContext {
  phase: 'entry' | 'return' | 'callback' | 'parsed' | 'render';
  writeId: number;
  atMs: number;
}

export function createXtermWriteCorrelator(now: () => number) {
  let nextWriteId = 1;
  const contexts = new Map<number, XtermWriteContext>();
  const pendingParse: number[] = [];
  const events: XtermWriteTraceEvent[] = [];
  let lastParsedWriteId: number | null = null;
  const append = (phase: XtermWriteTraceEvent['phase'], writeId: number, atMs = now()) => {
    const context = contexts.get(writeId);
    if (!context) throw new Error(`Unknown xterm write ${writeId}`);
    events.push(Object.freeze({ phase, writeId, atMs, ...context }));
  };
  return {
    enter(context: XtermWriteContext): number {
      const writeId = nextWriteId++;
      contexts.set(writeId, { ...context });
      pendingParse.push(writeId);
      append('entry', writeId);
      return writeId;
    },
    returned(writeId: number): void {
      append('return', writeId);
    },
    callback(writeId: number): void {
      append('callback', writeId);
    },
    parsed(atMs = now()): void {
      for (const writeId of pendingParse.splice(0)) {
        append('parsed', writeId, atMs);
        lastParsedWriteId = writeId;
      }
    },
    rendered(atMs = now()): void {
      if (lastParsedWriteId !== null) append('render', lastParsedWriteId, atMs);
    },
    snapshot(): XtermWriteTraceEvent[] {
      return events.map((event) => ({ ...event }));
    },
  };
}

export async function runCleanupSteps(steps: Array<readonly [string, () => void | Promise<void>]>): Promise<void> {
  const failures: Error[] = [];
  for (const [label, step] of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map((failure) => failure.message).join('; '));
}

export interface BrowserLatencyTrial {
  trialId: string;
  inputIndex: number;
  tokenHash: string;
  tokenLength: number;
  token: string;
}

export interface BrowserHookInstallOptions {
  failAfter?: string;
}

const BROWSER_LATENCY_INIT_SCRIPT = [
  '(() => {',
  '    const browserWindow = window;',
  '    const globalOutputStages = new Set([',
  "        'browser.ws-output-receive',",
  "        'browser.output-handler',",
  "        'browser.write-queued',",
  "        'browser.xterm-write',",
  "        'browser.xterm-write-return',",
  "        'browser.xterm-write-callback',",
  "        'browser.xterm-parsed',",
  '    ]);',
  '    const visibilityStages = new Set([',
  "        'browser.xterm-visible-after-parse',",
  "        'browser.xterm-render',",
  "        'browser.xterm-visible',",
  "        'browser.paint-proxy',",
  '    ]);',
  '    const state = {',
  '        events: [],',
  '        window: null,',
  '        contexts: [],',
  '        armedContexts: [],',
  '        dispatchContext: null,',
  '        pendingOnDataContexts: [],',
  '        pendingLogicalContexts: [],',
  '        pendingReliableContexts: [],',
  '        reliableContexts: [],',
  '        generation: 0,',
  '        clockId: `page-${crypto.randomUUID()}`,',
  '        originals: {},',
  '        initCleanup: [],',
  '        hookCleanup: [],',
  '        listenerCount: 0,',
  '        wrappersInstalled: false,',
  '        outputOrdinal: 0,',
  '        pendingOutputOrdinal: 0,',
  '        currentOutput: null,',
  '        flushingOutput: null,',
  '        epochOutputs: {},',
  '        inputContextsBySeq: {},',
  '        ackedGenerations: {},',
  '        firstAcked: false,',
  '        sendAttempts: {},',
  '        nextWriteId: 1,',
  '        pendingParse: [],',
  '        lastParsed: null,',
  '        pendingVisibility: {},',
  '        currentSelections: {},',
  '        completedGenerations: {},',
  '        nextSelectionId: 1,',
  '    };',
  '    const contextSnapshot = (context) => (context ? { ...context } : null);',
  '    const windowContext = () => state.window',
  '        ? {',
  '            trialId: state.window.trialId,',
  '            generation: 0,',
  '            inputIndex: 0,',
  '            tokenHash: state.window.tokenHash,',
  '            tokenLength: state.window.tokenLength,',
  '        }',
  '        : null;',
  '    const record = (stage, extra = {}, suppliedContext) => {',
  '        const active = contextSnapshot(suppliedContext ?? (globalOutputStages.has(stage) ? windowContext() : null));',
  '        if (!active ||',
  '            state.events.some((event) => event.stage === stage &&',
  '                event.trialId === active.trialId &&',
  '                event.generation === active.generation &&',
  '                event.inputIndex === active.inputIndex &&',
  '                (extra.attempt === undefined || event.attempt === extra.attempt) &&',
  '                (!globalOutputStages.has(stage) && !visibilityStages.has(stage)',
  '                    ? true',
  '                    : event.ordinal === extra.ordinal && (extra.writeId === undefined || event.writeId === extra.writeId))))',
  '            return null;',
  '        const event = {',
  '            stage,',
  '            atMs: window.performance.now(),',
  "            clock: 'browser',",
  '            clockId: state.clockId,',
  '            trialId: active.trialId,',
  '            generation: active.generation,',
  '            inputIndex: active.inputIndex,',
  '            tokenHash: active.tokenHash,',
  '            tokenLength: active.tokenLength,',
  '            selectedForAttribution: !globalOutputStages.has(stage) && !visibilityStages.has(stage),',
  '            ...extra,',
  '        };',
  '        state.events.push(event);',
  '        return event;',
  '    };',
  '    const exactTokenVisible = (terminal, context) => {',
  '        if (!context?.token)',
  '            return false;',
  "        const marker = context.token[0].replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
  '        const pattern = new RegExp(`^\\\\s*[│┃]\\\\s+(${marker}[A-Za-z0-9]*)\\\\s*(?:[│┃])?\\\\s*$`);',
  '        const matches = [];',
  '        const buffer = terminal.buffer.active;',
  '        for (let row = 0; row < buffer.length; row++) {',
  '            const match = buffer.getLine(row)?.translateToString(true).match(pattern)?.[1];',
  '            if (match)',
  '                matches.push(match);',
  '        }',
  '        return matches.length === 1 && matches[0] === context.token;',
  '    };',
  '    const selectAttribution = (context, ordinal, writeId) => {',
  '        for (const event of state.events) {',
  '            if (event.trialId !== context.trialId)',
  '                continue;',
  '            const globalOutput = globalOutputStages.has(String(event.stage));',
  '            const selectedVisibility = visibilityStages.has(String(event.stage)) &&',
  '                event.selectedForAttribution !== false &&',
  '                event.generation === context.generation &&',
  '                event.inputIndex === context.inputIndex;',
  '            if (!globalOutput && !selectedVisibility)',
  '                continue;',
  "            const writeStage = String(event.stage).startsWith('browser.xterm');",
  '            const exactWrite = selectedVisibility || writeStage;',
  '            if (event.ordinal === ordinal && (!exactWrite || event.writeId === undefined || event.writeId === writeId)) {',
  '                event.selectedForAttribution = true;',
  '                event.attributedGeneration = context.generation;',
  '                event.attributedInputIndex = context.inputIndex;',
  '            }',
  '        }',
  '    };',
  '    state.originals.record = record;',
  '    state.originals.exactTokenVisible = exactTokenVisible;',
  '    state.originals.selectAttribution = selectAttribution;',
  '    browserWindow.__cod374LatencyTrace = state;',
  '    const keydown = () => {',
  '        const context = state.armedContexts.shift() ?? null;',
  '        state.dispatchContext = context;',
  '        if (context)',
  '            state.pendingOnDataContexts.push(context);',
  "        record('browser.keydown', {}, context);",
  '    };',
  "    window.addEventListener('keydown', keydown, true);",
  '    state.originals.keydown = keydown;',
  '    state.listenerCount++;',
  '    state.initCleanup.push(() => {',
  "        window.removeEventListener('keydown', keydown, true);",
  '        state.listenerCount--;',
  '    });',
  '    const OriginalWebSocket = window.WebSocket;',
  '    state.originals.WebSocket = OriginalWebSocket;',
  '    class TracedWebSocket extends OriginalWebSocket {',
  '        constructor(url, protocols) {',
  '            super(url, protocols);',
  '            const receive = (event) => {',
  "                if (typeof event.data !== 'string')",
  '                    return;',
  '                try {',
  '                    const frame = JSON.parse(event.data);',
  "                    if (frame?.t === 'o' && typeof frame.d === 'string' && state.window?.collecting && state.firstAcked) {",
  '                        const ordinal = ++state.outputOrdinal;',
  '                        state.pendingOutputOrdinal = ordinal;',
  "                        const start = '\\x1b[?2026h';",
  "                        const end = '\\x1b[?2026l';",
  '                        const rawValue = frame.d.startsWith(start) && frame.d.endsWith(end) ? frame.d.slice(start.length, -end.length) : frame.d;',
  "                        record('browser.ws-output-receive', {",
  '                            bytes: new TextEncoder().encode(rawValue).byteLength,',
  '                            ordinal,',
  '                            rawValue,',
  '                        });',
  '                    }',
  '                }',
  '                catch {',
  '                    // Product handling remains authoritative for malformed frames.',
  '                }',
  '            };',
  "            this.addEventListener('message', receive);",
  '            state.listenerCount++;',
  '            state.initCleanup.push(() => {',
  "                this.removeEventListener('message', receive);",
  '                state.listenerCount--;',
  '            });',
  '        }',
  '        send(data) {',
  '            let frame = null;',
  "            if (typeof data === 'string') {",
  '                try {',
  '                    frame = JSON.parse(data);',
  '                }',
  '                catch {',
  '                    // Non-JSON frames remain outside the trace.',
  '                }',
  '            }',
  "            if (frame?.t === 'i' &&",
  "                typeof frame.cid === 'string' &&",
  '                Number.isInteger(frame.seq) &&',
  "                typeof frame.d === 'string') {",
  '                const entries = state.inputContextsBySeq[frame.seq] ?? [',
  '                    { context: state.dispatchContext, coalescedIndex: 0, coalescedCount: 1 },',
  '                ];',
  '                const attempts = entries.map((entry) => {',
  '                    const context = contextSnapshot(entry.context);',
  '                    const attemptKey = `${context?.generation ?? 0}:${frame.cid}:${frame.seq}`;',
  '                    const attempt = (state.sendAttempts[attemptKey] ?? 0) + 1;',
  '                    state.sendAttempts[attemptKey] = attempt;',
  '                    const details = {',
  '                        clientId: frame.cid,',
  '                        seq: frame.seq,',
  '                        bytes: new TextEncoder().encode(frame.d).byteLength,',
  '                        attempt,',
  '                        coalescedIndex: entry.coalescedIndex,',
  '                        coalescedCount: entry.coalescedCount,',
  '                        selectedForAttribution: false,',
  '                    };',
  "                    return { context, details, event: record('browser.ws-input-send', details, context) };",
  '                });',
  '                try {',
  '                    const result = super.send(data);',
  '                    for (const attempt of attempts) {',
  '                        if (attempt.event)',
  '                            attempt.event.selectedForAttribution = true;',
  "                        record('browser.ws-input-send-return', { ...attempt.details, selectedForAttribution: true }, attempt.context);",
  '                    }',
  '                    return result;',
  '                }',
  '                catch (error) {',
  '                    for (const attempt of attempts) {',
  "                        record('browser.ws-input-send-failure', { ...attempt.details, failureHash: 'ffffffffffffffff', selectedForAttribution: false }, attempt.context);",
  '                    }',
  '                    throw error;',
  '                }',
  '            }',
  '            return super.send(data);',
  '        }',
  '    }',
  '    window.WebSocket = TracedWebSocket;',
  '    let tracedTerminal;',
  "    Object.defineProperty(window, 'Terminal', {",
  '        configurable: true,',
  '        get: () => tracedTerminal,',
  '        set: (OriginalTerminal) => {',
  '            state.originals.Terminal = OriginalTerminal;',
  '            tracedTerminal = new Proxy(OriginalTerminal, {',
  '                construct(target, argumentsList, newTarget) {',
  '                    const terminal = Reflect.construct(target, argumentsList, newTarget);',
  '                    const disposable = terminal.onData(() => {',
  '                        const context = state.pendingOnDataContexts.shift() ?? state.dispatchContext;',
  '                        if (context)',
  '                            state.pendingLogicalContexts.push(context);',
  "                        record('browser.xterm-on-data', {}, context);",
  '                    });',
  '                    state.initCleanup.push(() => {',
  '                        disposable.dispose();',
  '                        state.listenerCount--;',
  '                    });',
  '                    state.listenerCount++;',
  '                    return terminal;',
  '                },',
  '            });',
  '        },',
  '    });',
  '    state.initCleanup.push(() => {',
  '        window.WebSocket = OriginalWebSocket;',
  '    });',
  '    state.initCleanup.push(() => {',
  '        const originalTerminal = state.originals.Terminal;',
  '        delete browserWindow.Terminal;',
  '        browserWindow.Terminal = originalTerminal;',
  '    });',
  '})();',
].join('\n');

export async function installBrowserLatencyInitScript(page: Page): Promise<void> {
  await page.addInitScript({ content: BROWSER_LATENCY_INIT_SCRIPT });
}
const BROWSER_HOOK_FAILURE_STAGES = new Set([
  '_sendInputAsync',
  '_reliableSend',
  '_drainSession',
  '_onWsInputAck',
  '_onSessionTerminal',
  'batchTerminalWrite',
  'flushPendingWrites',
  'terminal.write',
  'parsed-listener',
  'xterm-listeners',
]);

const BROWSER_LATENCY_HOOK_INSTALL_SCRIPT = [
  '((installOptions) => {',
  '    const browserWindow = window;',
  '    const state = browserWindow.__cod374LatencyTrace;',
  '    const app = browserWindow.app;',
  '    if (!state || !app || state.wrappersInstalled)',
  "        throw new Error('COD-374 init hook is unavailable or duplicated');",
  '    const record = state.originals.record;',
  '    const exactTokenVisible = state.originals.exactTokenVisible;',
  '    const selectAttribution = state.originals.selectAttribution;',
  '    const restorers = [];',
  '    const maybeFail = (name) => {',
  '        if (installOptions.failAfter === name)',
  '            throw new Error(`Injected hook install failure after ${name}`);',
  '    };',
  '    const wrap = (owner, name, observer) => {',
  '        const original = owner[name];',
  '        state.originals[name] = original;',
  '        owner[name] = function (...args) {',
  '            observer(...args);',
  '            return Reflect.apply(original, this, args);',
  '        };',
  '        restorers.push(() => {',
  '            owner[name] = original;',
  '        });',
  '        maybeFail(name);',
  '    };',
  '    const install = () => {',
  "        wrap(app, '_sendInputAsync', (data) => {",
  "            const requestedCount = typeof data === 'string' ? Math.max(1, Array.from(data).length) : 1;",
  '            const contexts = state.pendingLogicalContexts.splice(0, requestedCount);',
  '            if (contexts.length === 0 && state.dispatchContext)',
  '                contexts.push(state.dispatchContext);',
  '            const entries = contexts.map((context, coalescedIndex) => ({',
  '                context,',
  '                coalescedIndex,',
  '                coalescedCount: contexts.length,',
  '            }));',
  '            if (entries.length)',
  '                state.pendingReliableContexts.push(entries);',
  '            for (const entry of entries) {',
  "                record('browser.logical', { coalescedIndex: entry.coalescedIndex, coalescedCount: entry.coalescedCount }, entry.context);",
  '            }',
  '        });',
  "        wrap(app, '_reliableSend', () => {",
  '            state.reliableContexts = state.pendingReliableContexts.shift() ?? [',
  '                { context: state.dispatchContext, coalescedIndex: 0, coalescedCount: 1 },',
  '            ];',
  '        });',
  "        wrap(app, '_drainSession', (sessionId) => {",
  '            const pending = app._pendingDeliveries.get(sessionId);',
  '            const latest = pending?.at(-1);',
  '            if (latest) {',
  '                const entries = state.reliableContexts.map((entry) => ({',
  '                    ...entry,',
  '                    context: { ...entry.context },',
  '                }));',
  '                state.inputContextsBySeq[latest.seq] = entries;',
  '                for (const entry of entries) {',
  "                    record('browser.durable-queued', {",
  '                        clientId: app._clientId,',
  '                        seq: latest.seq,',
  '                        coalescedIndex: entry.coalescedIndex,',
  '                        coalescedCount: entry.coalescedCount,',
  '                    }, entry.context);',
  '                }',
  '            }',
  '        });',
  '        const originalAck = app._onWsInputAck;',
  '        state.originals._onWsInputAck = originalAck;',
  '        app._onWsInputAck = function (seq) {',
  '            const result = Reflect.apply(originalAck, this, [seq]);',
  '            const pendingCount = app._pendingDeliveries.get(app._wsSessionId)?.length ?? 0;',
  '            const entries = state.inputContextsBySeq[seq] ?? [];',
  '            for (const entry of entries) {',
  "                record('browser.ws-input-ack', {",
  '                    clientId: app._clientId,',
  '                    seq,',
  '                    pendingCount,',
  '                    coalescedIndex: entry.coalescedIndex,',
  '                    coalescedCount: entry.coalescedCount,',
  '                }, entry.context);',
  '                state.ackedGenerations[entry.context.generation] = true;',
  '                state.firstAcked = true;',
  '            }',
  '            return result;',
  '        };',
  '        restorers.push(() => {',
  '            app._onWsInputAck = originalAck;',
  '        });',
  "        maybeFail('_onWsInputAck');",
  '        const originalTerminalHandler = app._onSessionTerminal;',
  '        state.originals._onSessionTerminal = originalTerminalHandler;',
  '        app._onSessionTerminal = function (...args) {',
  '            const ordinal = state.pendingOutputOrdinal;',
  '            if (!ordinal)',
  '                return Reflect.apply(originalTerminalHandler, this, args);',
  '            state.pendingOutputOrdinal = 0;',
  '            state.currentOutput = { ordinal };',
  "            record('browser.output-handler', { ordinal });",
  '            try {',
  '                return Reflect.apply(originalTerminalHandler, this, args);',
  '            }',
  '            finally {',
  '                state.currentOutput = null;',
  '            }',
  '        };',
  '        restorers.push(() => {',
  '            app._onSessionTerminal = originalTerminalHandler;',
  '        });',
  "        maybeFail('_onSessionTerminal');",
  '        const originalBatch = app.batchTerminalWrite;',
  '        state.originals.batchTerminalWrite = originalBatch;',
  '        app.batchTerminalWrite = function (...args) {',
  '            const output = state.currentOutput;',
  '            const result = Reflect.apply(originalBatch, this, args);',
  '            if (!output)',
  '                return result;',
  '            const epoch = app._terminalOutputAcceptanceEpoch;',
  '            if (Number.isInteger(epoch))',
  '                state.epochOutputs[epoch] = output;',
  "            record('browser.write-queued', { ordinal: output.ordinal });",
  '            return result;',
  '        };',
  '        restorers.push(() => {',
  '            app.batchTerminalWrite = originalBatch;',
  '        });',
  "        maybeFail('batchTerminalWrite');",
  '        const originalFlush = app.flushPendingWrites;',
  '        state.originals.flushPendingWrites = originalFlush;',
  '        app.flushPendingWrites = function (...args) {',
  '            const epoch = app._pendingWritesMaxAcceptanceEpoch;',
  '            state.flushingOutput = state.epochOutputs[epoch] || null;',
  '            try {',
  '                return Reflect.apply(originalFlush, this, args);',
  '            }',
  '            finally {',
  '                state.flushingOutput = null;',
  '            }',
  '        };',
  '        restorers.push(() => {',
  '            app.flushPendingWrites = originalFlush;',
  '        });',
  "        maybeFail('flushPendingWrites');",
  '        const terminal = app.terminal;',
  '        const originalWrite = terminal.write;',
  '        state.originals.terminalWrite = originalWrite;',
  '        terminal.write = function (data, callback) {',
  "            const bytes = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;",
  '            const output = state.flushingOutput;',
  '            if (!output)',
  '                return Reflect.apply(originalWrite, this, [data, callback]);',
  '            const writeId = state.nextWriteId++;',
  '            const write = { writeId, ordinal: output.ordinal };',
  '            state.pendingParse.push(write);',
  "            record('browser.xterm-write', { bytes, ordinal: write.ordinal, writeId });",
  '            const wrappedCallback = () => {',
  "                record('browser.xterm-write-callback', { bytes, ordinal: write.ordinal, writeId });",
  '                callback?.();',
  '            };',
  '            const result = Reflect.apply(originalWrite, this, [data, wrappedCallback]);',
  "            record('browser.xterm-write-return', { bytes, ordinal: write.ordinal, writeId });",
  '            return result;',
  '        };',
  '        restorers.push(() => {',
  '            terminal.write = originalWrite;',
  '        });',
  "        maybeFail('terminal.write');",
  '        const parsed = terminal.onWriteParsed(() => {',
  '            const parsedWrites = state.pendingParse.splice(0);',
  '            for (const write of parsedWrites) {',
  "                record('browser.xterm-parsed', { ordinal: write.ordinal, writeId: write.writeId });",
  '                for (const context of state.contexts) {',
  '                    if (state.ackedGenerations[context.generation] &&',
  '                        !state.completedGenerations[context.generation] &&',
  '                        exactTokenVisible(terminal, context)) {',
  '                        const selection = {',
  '                            ...write,',
  '                            context: { ...context },',
  '                            selectionId: state.nextSelectionId++,',
  '                        };',
  '                        state.pendingVisibility[context.generation] = selection;',
  "                        record('browser.xterm-visible-after-parse', { ordinal: write.ordinal, writeId: write.writeId, selectedForAttribution: false }, context);",
  '                    }',
  '                }',
  '                state.lastParsed = write;',
  '            }',
  '        });',
  '        restorers.push(() => {',
  '            parsed.dispose();',
  '            state.listenerCount--;',
  '        });',
  '        state.listenerCount++;',
  "        maybeFail('parsed-listener');",
  '        const render = terminal.onRender(() => {',
  '            const write = state.lastParsed;',
  '            if (!write)',
  '                return;',
  '            for (const context of state.contexts) {',
  '                const pending = state.pendingVisibility[context.generation];',
  '                if (!pending ||',
  '                    pending.writeId !== write.writeId ||',
  '                    state.completedGenerations[context.generation] ||',
  '                    !exactTokenVisible(terminal, context))',
  '                    continue;',
  '                for (const event of state.events) {',
  '                    if (event.trialId === context.trialId &&',
  '                        event.generation === context.generation &&',
  "                        ['browser.xterm-visible-after-parse', 'browser.xterm-render', 'browser.xterm-visible'].includes(String(event.stage))) {",
  '                        event.selectedForAttribution = false;',
  '                    }',
  '                }',
  '                const selection = { ...pending, selectionId: state.nextSelectionId++ };',
  '                state.currentSelections[context.generation] = selection;',
  '                const parseVisible = state.events.find((event) => event.trialId === context.trialId &&',
  '                    event.generation === context.generation &&',
  "                    event.stage === 'browser.xterm-visible-after-parse' &&",
  '                    event.ordinal === write.ordinal &&',
  '                    event.writeId === write.writeId);',
  '                if (parseVisible)',
  '                    parseVisible.selectedForAttribution = true;',
  "                record('browser.xterm-render', { ordinal: write.ordinal, writeId: write.writeId, selectedForAttribution: true }, context);",
  "                record('browser.xterm-visible', { ordinal: write.ordinal, writeId: write.writeId, selectedForAttribution: true }, context);",
  '                const captured = { ...selection, context: { ...context } };',
  '                requestAnimationFrame(() => {',
  '                    const current = state.currentSelections[captured.context.generation];',
  '                    if (current?.selectionId !== captured.selectionId ||',
  '                        current?.ordinal !== captured.ordinal ||',
  '                        current?.writeId !== captured.writeId ||',
  '                        !state.window?.collecting ||',
  '                        !exactTokenVisible(terminal, captured.context))',
  '                        return;',
  "                    record('browser.paint-proxy', { ordinal: captured.ordinal, writeId: captured.writeId, selectedForAttribution: true }, captured.context);",
  '                    state.completedGenerations[captured.context.generation] = true;',
  '                    selectAttribution(captured.context, captured.ordinal, captured.writeId);',
  '                });',
  '            }',
  '        });',
  '        restorers.push(() => {',
  '            render.dispose();',
  '            state.listenerCount--;',
  '        });',
  '        state.listenerCount++;',
  "        maybeFail('xterm-listeners');",
  '    };',
  '    try {',
  '        install();',
  '    }',
  '    catch (cause) {',
  '        const rollbackErrors = [];',
  '        for (const restore of restorers.reverse()) {',
  '            try {',
  '                restore();',
  '            }',
  '            catch (error) {',
  '                rollbackErrors.push(error instanceof Error ? error : new Error(String(error)));',
  '            }',
  '        }',
  '        state.hookCleanup = [];',
  '        state.wrappersInstalled = false;',
  '        if (rollbackErrors.length)',
  "            throw new AggregateError([cause, ...rollbackErrors], 'Hook install rollback failed');",
  '        throw cause;',
  '    }',
  '    state.hookCleanup = restorers.reverse();',
  '    state.wrappersInstalled = true;',
  '})',
].join('\n');

export async function installBrowserLatencyHooks(page: Page, options: BrowserHookInstallOptions = {}): Promise<void> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== 'failAfter') ||
    (options.failAfter !== undefined && !BROWSER_HOOK_FAILURE_STAGES.has(options.failAfter))
  ) {
    throw new Error('COD-374 hook failure stage is invalid');
  }
  const installOptions = options.failAfter === undefined ? {} : { failAfter: options.failAfter };
  await page.evaluate(`(${BROWSER_LATENCY_HOOK_INSTALL_SCRIPT})(${JSON.stringify(installOptions)})`);
}
export async function armBrowserLatencyTrial(page: Page, trial: BrowserLatencyTrial): Promise<void> {
  if (
    !trial.trialId ||
    !Number.isSafeInteger(trial.inputIndex) ||
    trial.inputIndex < 0 ||
    !HASH.test(trial.tokenHash) ||
    trial.tokenLength < 1 ||
    trial.token.length !== trial.tokenLength
  ) {
    throw new Error('Invalid browser latency trial');
  }
  await page.evaluate((nextTrial) => {
    const state = (window as any).__cod374LatencyTrace;
    if (!state?.wrappersInstalled) throw new Error('COD-374 browser hooks are not installed');
    if (state.window?.trialId !== nextTrial.trialId) {
      state.window = {
        trialId: nextTrial.trialId,
        tokenHash: nextTrial.tokenHash,
        tokenLength: nextTrial.tokenLength,
        collecting: true,
      };
      state.contexts = [];
      state.armedContexts = [];
      state.dispatchContext = null;
      state.pendingOnDataContexts = [];
      state.pendingLogicalContexts = [];
      state.pendingReliableContexts = [];
      state.reliableContexts = [];
      state.generation = 0;
      state.outputOrdinal = 0;
      state.pendingOutputOrdinal = 0;
      state.inputContextsBySeq = {};
      state.ackedGenerations = {};
      state.firstAcked = false;
      state.sendAttempts = {};
      state.pendingParse = [];
      state.pendingVisibility = {};
      state.currentSelections = {};
      state.completedGenerations = {};
    }
    state.window.tokenHash = nextTrial.tokenHash;
    state.window.tokenLength = nextTrial.tokenLength;
    const context = Object.freeze({ ...nextTrial, generation: ++state.generation });
    state.contexts.push(context);
    state.armedContexts.push(context);
  }, trial);
}

export async function completeBrowserLatencyWindow(page: Page, trialId: string): Promise<void> {
  await page.evaluate((id) => {
    const state = (window as any).__cod374LatencyTrace;
    if (!state?.window?.collecting || state.window.trialId !== id) {
      throw new Error('COD-374 browser latency window is not active');
    }
    const record = state.originals.record as (stage: string, extra?: Record<string, unknown>, context?: any) => void;
    for (const context of state.contexts) {
      if (!state.completedGenerations[context.generation]) {
        for (const event of state.events) {
          if (
            event.trialId === context.trialId &&
            event.generation === context.generation &&
            [
              'browser.xterm-visible-after-parse',
              'browser.xterm-render',
              'browser.xterm-visible',
              'browser.paint-proxy',
            ].includes(String(event.stage))
          ) {
            event.selectedForAttribution = false;
          }
        }
        record(
          'browser.generation-incomplete',
          {
            incompleteReason: 'coalesced-before-exact-visibility',
            selectedForAttribution: true,
          },
          context
        );
      }
    }
    state.window.collecting = false;
  }, trialId);
}

export async function readBrowserLatencyTrace(page: Page, trialId: string): Promise<BrowserLatencyEvent[]> {
  return page.evaluate(async (id) => {
    const state = (window as any).__cod374LatencyTrace;
    const trialEvents = state.events.filter((event: any) => event.trialId === id);
    const safeEvents = [];
    for (const event of trialEvents) {
      const { rawValue, ...safe } = event;
      if (typeof rawValue === 'string') {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawValue));
        safe.valueHash = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('')
          .slice(0, 16);
      }
      safeEvents.push(safe);
    }
    return safeEvents;
  }, trialId);
}

export async function removeBrowserLatencyHooks(
  page: Page | null
): Promise<{ wrappersRestored: boolean; listenersDisposed: boolean }> {
  if (!page || page.isClosed()) return { wrappersRestored: false, listenersDisposed: false };
  return page.evaluate(() => {
    const browserWindow = window as any;
    const state = browserWindow.__cod374LatencyTrace;
    const app = browserWindow.app;
    if (!state) return { wrappersRestored: false, listenersDisposed: false };

    const failures: Error[] = [];
    const steps = [...state.hookCleanup, ...state.initCleanup.reverse()];
    for (const cleanup of steps) {
      try {
        cleanup();
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    state.hookCleanup = [];
    state.initCleanup = [];
    state.wrappersInstalled = false;
    state.window = null;
    state.contexts = [];
    state.armedContexts = [];
    state.dispatchContext = null;
    state.pendingOnDataContexts = [];
    state.pendingLogicalContexts = [];
    state.pendingReliableContexts = [];
    state.reliableContexts = [];
    if (failures.length) throw new AggregateError(failures, 'COD-374 browser cleanup failed');
    return { wrappersRestored: state.wrappersInstalled === false, listenersDisposed: state.listenerCount === 0 };
  });
}
