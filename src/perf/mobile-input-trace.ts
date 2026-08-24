import { createHash, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const DEFAULT_CAPACITY = 4096;
const MAX_CAPACITY = 20_000;
const MAX_CLIENT_ID_LENGTH = 128;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const HASH = /^[0-9a-f]{16}$/;
const MONOTONIC_NS = /^(?:0|[1-9]\d*)$/;

export type MobileInputTraceStage =
  | 'server.input.received'
  | 'server.input.parsed'
  | 'server.input.deduped'
  | 'server.input.activated'
  | 'server.input.pre-write'
  | 'server.input.post-write'
  | 'server.input.pre-ack'
  | 'server.input.post-ack'
  | 'server.output.pty-received'
  | 'server.output.handler-enter'
  | 'server.output.terminal-emitted'
  | 'server.output.ws-received'
  | 'server.output.batch-enqueued'
  | 'server.output.flush-start'
  | 'server.output.pre-send'
  | 'server.output.post-send';

export interface MobileInputTraceEvent {
  stage: MobileInputTraceStage;
  monoNs: string;
  epochMs?: number;
  sessionHash?: string;
  clientId?: string;
  seq?: number;
  ordinal?: number;
  bytes?: number;
  valueHash?: string;
  applied?: boolean;
  delivered?: boolean;
}

export interface MobileInputTraceSnapshot {
  enabled: boolean;
  overflowed: boolean;
  events: MobileInputTraceEvent[];
}

export interface MobileInputTraceCollector {
  readonly enabled: boolean;
  record(event: MobileInputTraceEvent): boolean;
  snapshot(): MobileInputTraceSnapshot;
  clear(): void;
  isAuthorized(secret: string | undefined): boolean;
}

export interface MobileInputTraceCollectorConfig {
  nodeEnv?: string;
  traceFlag?: string;
  secret?: string;
  capacity?: number;
}

const STAGES: ReadonlySet<string> = new Set<MobileInputTraceStage>([
  'server.input.received',
  'server.input.parsed',
  'server.input.deduped',
  'server.input.activated',
  'server.input.pre-write',
  'server.input.post-write',
  'server.input.pre-ack',
  'server.input.post-ack',
  'server.output.pty-received',
  'server.output.handler-enter',
  'server.output.terminal-emitted',
  'server.output.ws-received',
  'server.output.batch-enqueued',
  'server.output.flush-start',
  'server.output.pre-send',
  'server.output.post-send',
]);

const EVENT_FIELDS: ReadonlySet<string> = new Set<keyof MobileInputTraceEvent>([
  'stage',
  'monoNs',
  'epochMs',
  'sessionHash',
  'clientId',
  'seq',
  'ordinal',
  'bytes',
  'valueHash',
  'applied',
  'delivered',
]);

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateEvent(value: MobileInputTraceEvent): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid trace event');

  for (const field of Object.keys(value)) {
    if (!EVENT_FIELDS.has(field)) throw new Error(`Unknown trace field: ${field}`);
  }

  const valid =
    STAGES.has(value.stage) &&
    typeof value.monoNs === 'string' &&
    MONOTONIC_NS.test(value.monoNs) &&
    (value.epochMs === undefined ||
      (typeof value.epochMs === 'number' && Number.isFinite(value.epochMs) && value.epochMs >= 0)) &&
    (value.sessionHash === undefined || (typeof value.sessionHash === 'string' && HASH.test(value.sessionHash))) &&
    (value.clientId === undefined ||
      (typeof value.clientId === 'string' &&
        value.clientId.length > 0 &&
        value.clientId.length <= MAX_CLIENT_ID_LENGTH &&
        SAFE_ID.test(value.clientId))) &&
    (value.seq === undefined || isNonnegativeInteger(value.seq)) &&
    (value.ordinal === undefined || isNonnegativeInteger(value.ordinal)) &&
    (value.bytes === undefined || isNonnegativeInteger(value.bytes)) &&
    (value.valueHash === undefined || (typeof value.valueHash === 'string' && HASH.test(value.valueHash))) &&
    (value.applied === undefined || typeof value.applied === 'boolean') &&
    (value.delivered === undefined || typeof value.delivered === 'boolean');

  if (!valid) throw new Error('Invalid trace event');
}

export function hashMobileInputTraceValue(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function mobileInputTraceTimestamp(): Pick<MobileInputTraceEvent, 'monoNs' | 'epochMs'> {
  return {
    monoNs: process.hrtime.bigint().toString(),
    epochMs: performance.timeOrigin + performance.now(),
  };
}

export function createMobileInputTraceCollector(config: MobileInputTraceCollectorConfig): MobileInputTraceCollector {
  const capacity = config.capacity ?? DEFAULT_CAPACITY;
  const secret = config.secret ?? '';
  const secretDigest = createHash('sha256').update(secret).digest();
  const enabled =
    config.nodeEnv === 'test' &&
    config.traceFlag === '1' &&
    secret.length > 0 &&
    Number.isSafeInteger(capacity) &&
    capacity >= 1 &&
    capacity <= MAX_CAPACITY;
  const events: MobileInputTraceEvent[] = [];
  let overflowed = false;

  return {
    enabled,
    record(event) {
      if (!enabled) return false;
      validateEvent(event);
      if (overflowed || events.length >= capacity) {
        overflowed = true;
        return false;
      }
      events.push({ ...event });
      return true;
    },
    snapshot() {
      return { enabled, overflowed, events: events.map((event) => ({ ...event })) };
    },
    clear() {
      events.length = 0;
      overflowed = false;
    },
    isAuthorized(candidate) {
      if (!enabled || candidate === undefined) return false;
      const candidateDigest = createHash('sha256').update(candidate).digest();
      return timingSafeEqual(secretDigest, candidateDigest);
    },
  };
}

function parseConfiguredCapacity(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return Number.NaN;
  return Number(value);
}

export const mobileInputTraceCollector = createMobileInputTraceCollector({
  nodeEnv: process.env.NODE_ENV,
  traceFlag: process.env.CODEMAN_TEST_MOBILE_TRACE,
  secret: process.env.CODEMAN_TEST_MOBILE_TRACE_SECRET,
  capacity: parseConfiguredCapacity(process.env.CODEMAN_TEST_MOBILE_TRACE_CAPACITY),
});
