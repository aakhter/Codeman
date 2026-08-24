import { describe, expect, it, vi } from 'vitest';

const timingSafeEqualSpy = vi.hoisted(() => vi.fn());

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    timingSafeEqual(left: Uint8Array, right: Uint8Array) {
      timingSafeEqualSpy(left, right);
      return actual.timingSafeEqual(left, right);
    },
  };
});

import {
  createMobileInputTraceCollector,
  hashMobileInputTraceValue,
  mobileInputTraceTimestamp,
  type MobileInputTraceEvent,
} from '../src/perf/mobile-input-trace.js';

const received = (overrides: Partial<MobileInputTraceEvent> = {}): MobileInputTraceEvent => ({
  stage: 'server.input.received',
  monoNs: '1',
  ...overrides,
});

describe('COD-374 bounded mobile input trace collector', () => {
  it.each([
    { nodeEnv: 'production', traceFlag: '1', secret: 'secret', capacity: 8 },
    { nodeEnv: 'development', traceFlag: '1', secret: 'secret', capacity: 8 },
    { nodeEnv: 'test', traceFlag: undefined, secret: 'secret', capacity: 8 },
    { nodeEnv: 'test', traceFlag: '', secret: 'secret', capacity: 8 },
    { nodeEnv: 'test', traceFlag: 'true', secret: 'secret', capacity: 8 },
    { nodeEnv: 'test', traceFlag: '01', secret: 'secret', capacity: 8 },
    { nodeEnv: 'test', traceFlag: '1', secret: '', capacity: 8 },
    { nodeEnv: 'test', traceFlag: '1', secret: 'secret', capacity: 0 },
    { nodeEnv: 'test', traceFlag: '1', secret: 'secret', capacity: -1 },
    { nodeEnv: 'test', traceFlag: '1', secret: 'secret', capacity: 20_001 },
    { nodeEnv: 'test', traceFlag: '1', secret: 'secret', capacity: 1.5 },
  ])('is disabled for an incomplete or invalid disposable environment: %o', (config) => {
    const trace = createMobileInputTraceCollector(config);

    expect(trace.enabled).toBe(false);
    expect(trace.record(received())).toBe(false);
    expect(trace.snapshot()).toEqual({ enabled: false, overflowed: false, events: [] });
  });

  it('uses the bounded default capacity when no capacity is configured', () => {
    const trace = createMobileInputTraceCollector({ nodeEnv: 'test', traceFlag: '1', secret: 'secret' });

    expect(trace.enabled).toBe(true);
    for (let ordinal = 0; ordinal < 4096; ordinal++) {
      expect(trace.record(received({ ordinal }))).toBe(true);
    }
    expect(trace.record(received({ ordinal: 4096 }))).toBe(false);
    expect(trace.snapshot()).toMatchObject({ enabled: true, overflowed: true });
    expect(trace.snapshot().events).toHaveLength(4096);
  });

  it('fails closed on overflow without replacing earlier events', () => {
    const trace = createMobileInputTraceCollector({ nodeEnv: 'test', traceFlag: '1', secret: 'secret', capacity: 1 });

    expect(trace.record(received({ clientId: 'client-1', seq: 1 }))).toBe(true);
    expect(trace.record({ stage: 'server.input.pre-write', monoNs: '2', clientId: 'client-1', seq: 1 })).toBe(false);
    expect(trace.record(received({ monoNs: '3' }))).toBe(false);
    expect(trace.snapshot()).toEqual({
      enabled: true,
      overflowed: true,
      events: [received({ clientId: 'client-1', seq: 1 })],
    });
  });

  it('accepts every fixed server stage and only the safe scalar schema', () => {
    const stages: MobileInputTraceEvent['stage'][] = [
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
    ];
    const trace = createMobileInputTraceCollector({
      nodeEnv: 'test',
      traceFlag: '1',
      secret: 'secret',
      capacity: stages.length,
    });

    for (const [ordinal, stage] of stages.entries()) {
      expect(
        trace.record({
          stage,
          monoNs: String(ordinal + 1),
          epochMs: 1_700_000_000_000 + ordinal,
          sessionHash: '0123456789abcdef',
          clientId: 'client_1-safe',
          seq: ordinal,
          ordinal,
          bytes: ordinal,
          valueHash: 'fedcba9876543210',
          applied: true,
          delivered: false,
        })
      ).toBe(true);
    }
    expect(trace.snapshot().events.map((event) => event.stage)).toEqual(stages);
  });

  it.each(['raw', 'text', 'data', 'arbitrary'])('rejects unknown field %s before touching trace state', (field) => {
    const trace = createMobileInputTraceCollector({ nodeEnv: 'test', traceFlag: '1', secret: 'secret', capacity: 1 });

    expect(() => trace.record({ ...received(), [field]: 'terminal secret' } as never)).toThrow(/unknown trace field/i);
    expect(trace.snapshot()).toEqual({ enabled: true, overflowed: false, events: [] });
  });

  it.each([
    { ...received(), stage: 'server.input.raw' },
    { ...received(), monoNs: '-1' },
    { ...received(), monoNs: '1.5' },
    { ...received(), epochMs: -1 },
    { ...received(), sessionHash: 'not-a-hash' },
    { ...received(), sessionHash: 1234567890123456 },
    { ...received(), clientId: '' },
    { ...received(), clientId: 'x'.repeat(129) },
    { ...received(), clientId: 'line\nbreak' },
    { ...received(), clientId: 'terminal text' },
    { ...received(), seq: -1 },
    { ...received(), seq: 1.5 },
    { ...received(), ordinal: -1 },
    { ...received(), bytes: -1 },
    { ...received(), bytes: 1.5 },
    { ...received(), valueHash: 'ABCDEF0123456789' },
    { ...received(), valueHash: 1234567890123456 },
    { ...received(), applied: 'yes' },
    { ...received(), delivered: 1 },
  ])('rejects malformed schema values: %o', (event) => {
    const trace = createMobileInputTraceCollector({ nodeEnv: 'test', traceFlag: '1', secret: 'secret', capacity: 1 });

    expect(() => trace.record(event as never)).toThrow(/invalid trace event/i);
    expect(trace.snapshot().events).toHaveLength(0);
  });

  it('hashes values with SHA-256 truncated to 16 lowercase hexadecimal characters', () => {
    expect(hashMobileInputTraceValue('codeman')).toBe('f6297e06a00386fd');
    expect(hashMobileInputTraceValue('codeman')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashMobileInputTraceValue('Codeman')).not.toBe(hashMobileInputTraceValue('codeman'));
  });

  it('creates component-local monotonic and epoch timestamps without logging or file IO', () => {
    const before = Date.now();
    const timestamp = mobileInputTraceTimestamp();
    const after = Date.now();

    expect(timestamp.monoNs).toMatch(/^[1-9]\d*$/);
    expect(timestamp.epochMs).toBeGreaterThanOrEqual(before);
    expect(timestamp.epochMs).toBeLessThan(after + 1);
  });

  it.each([
    { candidate: 'short', authorized: false },
    { candidate: 'a-much-longer-wrong-secret', authorized: false },
    { candidate: 'exact-secrét', authorized: false },
    { candidate: 'exact-secret', authorized: true },
  ])('compares a fixed-length secret digest for candidate $candidate', ({ candidate, authorized }) => {
    const trace = createMobileInputTraceCollector({
      nodeEnv: 'test',
      traceFlag: '1',
      secret: 'exact-secret',
      capacity: 1,
    });
    timingSafeEqualSpy.mockClear();

    expect(trace.isAuthorized(candidate)).toBe(authorized);
    expect(timingSafeEqualSpy).toHaveBeenCalledOnce();
    const [expectedDigest, candidateDigest] = timingSafeEqualSpy.mock.calls[0] as [Uint8Array, Uint8Array];
    expect(expectedDigest.byteLength).toBe(32);
    expect(candidateDigest.byteLength).toBe(32);
  });

  it('returns immutable snapshots and clears events plus overflow state', () => {
    const trace = createMobileInputTraceCollector({ nodeEnv: 'test', traceFlag: '1', secret: 'secret', capacity: 1 });
    trace.record(received({ clientId: 'client-1' }));
    trace.record(received({ monoNs: '2' }));

    const first = trace.snapshot();
    first.events[0].clientId = 'mutated';
    first.events.push(received({ monoNs: '99' }));
    expect(trace.snapshot()).toEqual({
      enabled: true,
      overflowed: true,
      events: [received({ clientId: 'client-1' })],
    });

    trace.clear();
    expect(trace.snapshot()).toEqual({ enabled: true, overflowed: false, events: [] });
    expect(first.overflowed).toBe(true);
  });
});
