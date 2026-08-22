import { performance } from 'node:perf_hooks';

function timeoutFailure(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError';
}

export async function runFixedOfferSchedule({
  offeredCount,
  intervalMs,
  request,
  now = () => performance.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (!Number.isSafeInteger(offeredCount) || offeredCount < 1) throw new Error('offered count must be positive');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('offer interval must be positive');
  const startedAtMs = now();
  const slots = [];
  for (let slot = 0; slot < offeredCount; slot++) {
    const scheduledAtMs = startedAtMs + slot * intervalMs;
    const delayMs = scheduledAtMs - now();
    if (delayMs > 0) await sleep(delayMs);
    const backlogMs = Math.max(0, now() - scheduledAtMs);
    if (backlogMs >= intervalMs) {
      slots.push({ slot, scheduledAtMs, status: 'missed', backlogMs, latencyMs: null });
      continue;
    }
    const dispatchedAtMs = now();
    try {
      const response = await request({ slot, scheduledAtMs, dispatchedAtMs });
      slots.push({
        slot,
        scheduledAtMs,
        dispatchedAtMs,
        status: 'completed',
        backlogMs,
        latencyMs: response.latencyMs,
      });
    } catch (error) {
      slots.push({
        slot,
        scheduledAtMs,
        dispatchedAtMs,
        status: timeoutFailure(error) ? 'timeout' : 'failed',
        backlogMs,
        latencyMs: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const attempted = slots.filter((slot) => slot.status !== 'missed');
  return {
    offeredCount,
    intervalMs,
    attemptedCount: attempted.length,
    completedCount: slots.filter((slot) => slot.status === 'completed').length,
    missedSlots: slots.filter((slot) => slot.status === 'missed').length,
    timedOut: slots.filter((slot) => slot.status === 'timeout').length,
    failed: slots.filter((slot) => slot.status === 'failed').length,
    maxBacklogMs: Math.max(0, ...slots.map((slot) => slot.backlogMs)),
    latenciesMs: slots.map((slot) => slot.latencyMs).filter(Number.isFinite),
    slots,
  };
}

function nearestRank(sorted, percentile) {
  return sorted[Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)];
}

function sampleLatencySummary(schedule) {
  const sorted = [...schedule.latenciesMs].sort((left, right) => left - right);
  if (sorted.length === 0) return { sampleCount: 0, median: null, p95: null };
  const middle = Math.floor(sorted.length / 2);
  return {
    sampleCount: sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: nearestRank(sorted, 95),
  };
}

function summarizeAcross(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return {
    sampleCount: sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: nearestRank(sorted, 95),
  };
}

export function summarizeFixedOfferSchedule(schedules) {
  if (!Array.isArray(schedules) || schedules.length === 0) throw new Error('schedules must not be empty');
  const offeredCounts = new Set(schedules.map((schedule) => schedule.offeredCount));
  if (offeredCounts.size !== 1) throw new Error('fixed-offer schedules must use equivalent offered populations');
  const perSample = schedules.map((schedule, sampleIndex) => ({
    sampleIndex: sampleIndex + 1,
    offeredCount: schedule.offeredCount,
    attemptedCount: schedule.attemptedCount,
    completedCount: schedule.completedCount,
    missedSlots: schedule.missedSlots,
    timedOut: schedule.timedOut,
    failed: schedule.failed,
    maxBacklogMs: schedule.maxBacklogMs,
    latencyMs: sampleLatencySummary(schedule),
  }));
  return {
    samples: schedules.length,
    offeredCountPerSample: schedules[0].offeredCount,
    totalOffered: schedules.reduce((sum, schedule) => sum + schedule.offeredCount, 0),
    totalAttempted: schedules.reduce((sum, schedule) => sum + schedule.attemptedCount, 0),
    totalCompleted: schedules.reduce((sum, schedule) => sum + schedule.completedCount, 0),
    totalMissedSlots: schedules.reduce((sum, schedule) => sum + schedule.missedSlots, 0),
    totalTimedOut: schedules.reduce((sum, schedule) => sum + schedule.timedOut, 0),
    totalFailed: schedules.reduce((sum, schedule) => sum + schedule.failed, 0),
    latencyMedianMsAcrossSamples: summarizeAcross(perSample.map((sample) => sample.latencyMs.median)),
    latencyP95MsAcrossSamples: summarizeAcross(perSample.map((sample) => sample.latencyMs.p95)),
    perSample,
  };
}
