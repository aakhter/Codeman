import { parentPort } from 'node:worker_threads';

const raw = process.argv[2] ? JSON.parse(process.argv[2]) : {};
const busyIntervalMs = Math.max(1, Math.min(99, Number(raw.busyIntervalMs) || 70));
const idleIntervalMs = Math.max(1, Math.min(99, Number(raw.idleIntervalMs) || 30));
const durationMs = Math.max(1, Math.min(60_000, Number(raw.durationMs) || 60_000));
const deadline = performance.now() + durationMs;
let stopped = false;

function stop() {
  stopped = true;
}

process.once('disconnect', stop);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
parentPort?.once('close', stop);

function cycle() {
  if (stopped || performance.now() >= deadline) {
    process.exit(0);
  }
  const busyUntil = Math.min(deadline, performance.now() + busyIntervalMs);
  let accumulator = 0;
  while (!stopped && performance.now() < busyUntil) {
    accumulator = Math.imul(accumulator + 1, 2_654_435_761) >>> 0;
  }
  if (accumulator === -1) process.stderr.write('unreachable');
  setTimeout(cycle, Math.min(idleIntervalMs, Math.max(0, deadline - performance.now()))).unref();
}

cycle();
