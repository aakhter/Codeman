import { appendFile } from 'node:fs/promises';

import { createProbeInputEvent, formatInputAcknowledgement } from './cod-356-metrics.mjs';

const logPath = process.env.COD356_PROBE_LOG;
if (!logPath) throw new Error('COD356_PROBE_LOG is required');

let sequence = 0;
let writeChain = Promise.resolve();

function record(event) {
  writeChain = writeChain.then(() => appendFile(logPath, `${JSON.stringify(event)}\n`));
}

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write(`COD356_PROBE_READY pid=${process.pid}\r\n› `);
record({ type: 'ready', pid: process.pid, timestampNs: process.hrtime.bigint().toString() });

process.stdin.on('data', (chunk) => {
  const bytes = Buffer.from(chunk);
  const id = ++sequence;
  const timestampNs = process.hrtime.bigint().toString();
  const event = createProbeInputEvent({ id, monotonicNs: timestampNs, epochMs: Date.now(), bytes });
  const { base64 } = event;
  record(event);
  const outputTimestampNs = process.hrtime.bigint().toString();
  record({
    type: 'stdout-frame',
    inputId: id,
    timestampNs: outputTimestampNs,
    timestampEpochMs: Date.now(),
    base64,
  });
  process.stdout.write(`\r\nCOD356_ECHO:${base64}`);
  process.stdout.write(formatInputAcknowledgement({ id, timestampNs, bytes }));
});

async function exit() {
  process.stdin.pause();
  await writeChain.catch(() => undefined);
  process.exit(0);
}

process.once('SIGTERM', exit);
process.once('SIGINT', exit);
process.stdin.once('end', exit);
