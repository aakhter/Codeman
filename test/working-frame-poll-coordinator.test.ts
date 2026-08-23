import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkingFramePollCoordinator } from '../src/working-frame-poll-coordinator.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('WorkingFramePollCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  function coordinator() {
    return new WorkingFramePollCoordinator({
      intervalMs: 2_000,
      maxConcurrency: 2,
      maxBackoffMs: 8_000,
      now: () => Date.now(),
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: (timer) => clearTimeout(timer),
    });
  }

  it('uses one shared scheduler and deterministically staggers registrations across the interval', async () => {
    const poller = coordinator();
    const captureTimes: number[] = [];
    const captures = Array.from({ length: 4 }, () =>
      vi.fn(async () => {
        captureTimes.push(Date.now());
        return null;
      })
    );
    const unregister = captures.map((capture, index) =>
      poller.register({ key: `session-${index}`, capture, onFrame: vi.fn() })
    );

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(captures.every((capture) => capture.mock.calls.length === 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    const callTimes = captures.flatMap((capture) => capture.mock.invocationCallOrder);
    expect(callTimes).toHaveLength(4);
    expect(new Set(captures.map((capture) => capture.mock.calls.length))).toEqual(new Set([1]));
    expect(new Set(captureTimes).size).toBe(4);
    expect(Math.min(...captureTimes)).toBeGreaterThanOrEqual(2_000);
    expect(Math.max(...captureTimes)).toBeLessThan(4_000);
    expect(vi.getTimerCount()).toBe(1);

    unregister.forEach((stop) => stop());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps global captures at two and never overlaps a session with itself', async () => {
    const poller = coordinator();
    const pending = Array.from({ length: 3 }, () => deferred<string | null>());
    let active = 0;
    let maximum = 0;
    const captures = pending.map((item) =>
      vi.fn(() => {
        active += 1;
        maximum = Math.max(maximum, active);
        return item.promise.finally(() => {
          active -= 1;
        });
      })
    );
    const stops = captures.map((capture, index) =>
      poller.register({ key: `same-offset-${index * 2_000}`, capture, onFrame: vi.fn(), initialDelayMs: 0 })
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(active).toBe(2);
    expect(maximum).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(captures[0]).toHaveBeenCalledTimes(1);
    expect(captures[1]).toHaveBeenCalledTimes(1);

    pending[0].resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(active).toBe(2);
    expect(captures[2]).toHaveBeenCalledTimes(1);
    stops.forEach((stop) => stop());
    pending[1].resolve(null);
    pending[2].resolve(null);
  });

  it('makes fair progress for all due registrations before polling a settled key again', async () => {
    const poller = coordinator();
    const order: string[] = [];
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    const stops = ['a', 'b', 'c', 'd'].map((key, index) =>
      poller.register({
        key,
        initialDelayMs: 0,
        capture: vi.fn(() => {
          order.push(key);
          if (index === 0) return first.promise;
          if (index === 1) return second.promise;
          return Promise.resolve(null);
        }),
        onFrame: vi.fn(),
      })
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['a', 'b']);
    first.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    expect(order.slice(0, 4)).toEqual(['a', 'b', 'c', 'd']);
    stops.forEach((stop) => stop());
    second.resolve(null);
  });

  it('backs failures off to a bound and recovers to the normal interval after success', async () => {
    const poller = coordinator();
    const attempts: number[] = [];
    let failures = 3;
    const stop = poller.register({
      key: 'recovering',
      initialDelayMs: 0,
      capture: async () => {
        attempts.push(Date.now());
        if (failures-- > 0) return null;
        return 'frame';
      },
      onFrame: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(20_001);
    expect(attempts.slice(0, 4)).toEqual([0, 4_000, 12_000, 20_000]);
    expect(poller.getStats().captureFailures).toBe(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(attempts[4]).toBe(22_000);
    stop();
  });

  it('queues on-demand captures through the same concurrency cap', async () => {
    const poller = coordinator();
    const pending = Array.from({ length: 3 }, () => deferred<string | null>());
    const captures = pending.map((item) => vi.fn(() => item.promise));
    const stops = captures.map((capture, index) =>
      poller.register({ key: `demand-${index}`, initialDelayMs: 10_000, capture, onFrame: vi.fn() })
    );

    const requested = captures.map((_, index) => poller.captureNow(`demand-${index}`));
    await vi.advanceTimersByTimeAsync(0);
    expect(captures.map((capture) => capture.mock.calls.length)).toEqual([1, 1, 0]);
    expect(poller.getStats().maximumActiveCaptures).toBe(2);
    pending[0].resolve('first');
    await vi.advanceTimersByTimeAsync(0);
    expect(captures[2]).toHaveBeenCalledTimes(1);
    pending[1].resolve('second');
    pending[2].resolve('third');
    await expect(Promise.all(requested)).resolves.toEqual(['first', 'second', 'third']);
    stops.forEach((stop) => stop());
  });

  it('unregister invalidates a late result and capture rejection is contained', async () => {
    const poller = coordinator();
    const late = deferred<string | null>();
    const onFrame = vi.fn();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const stopLate = poller.register({ key: 'late', initialDelayMs: 0, capture: () => late.promise, onFrame });
    const stopReject = poller.register({
      key: 'reject',
      initialDelayMs: 0,
      capture: async () => {
        throw new Error('expected');
      },
      onFrame: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(0);
    stopLate();
    late.resolve('Working');
    await flushPromises();
    expect(onFrame).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
    stopReject();
    process.off('unhandledRejection', unhandled);
  });

  it('does not count a lifecycle-cancelled null completion as a capture failure', async () => {
    const poller = coordinator();
    const pending = deferred<string | null>();
    const stop = poller.register({
      key: 'cancelled',
      initialDelayMs: 0,
      capture: () => pending.promise,
      onFrame: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);

    stop();
    pending.resolve(null);
    await flushPromises();

    expect(poller.getStats().captureFailures).toBe(0);
  });

  it('owns no live timer when it has zero registrations', () => {
    const poller = coordinator();
    expect(vi.getTimerCount()).toBe(0);
    const stop = poller.register({ key: 'one', capture: async () => null, onFrame: vi.fn() });
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
