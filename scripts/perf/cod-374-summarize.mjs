#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const BASELINE_PRODUCT = Object.freeze({
  sha: 'd080481690dc62ffc0d0d4f8e7daae2cc8bf8613',
  tree: '1c3e2b5aa2adad328e86d66c08f0b941f1900b1e',
});
export const CANDIDATE_PRODUCT = Object.freeze({
  sha: 'f3851229167a5078a15ae398c006cc2756690296',
  tree: '608989a703ae9fd7ac692c41d0a2e3f733e192c3',
});
export const OVERLAY_FILES = Object.freeze([
  'src/perf/mobile-input-trace.ts',
  'src/session.ts',
  'src/web/routes/perf-trace-routes.ts',
  'src/web/routes/ws-routes.ts',
  'src/web/server.ts',
]);
export const HARNESS_FILES = Object.freeze([
  'scripts/perf/cod-374-summarize.mjs',
  'scripts/perf/cod-374-runner.mjs',
  'scripts/perf/cod-374-playwright-runtime.ts',
  'test/perf-cod-374-report.test.ts',
  'test/perf-cod-374-runner.test.ts',
  'test/utils/cod374-latency-trace.ts',
  'test/mobile/cod374-input-latency.test.ts',
  'test/utils/cod370-opencode-fixture.ts',
  'docs/reports/cod-374/README.md',
]);
export const SERVER_OUTPUT_STAGES = Object.freeze([
  'server.output.pty-received',
  'server.output.handler-enter',
  'server.output.terminal-emitted',
  'server.output.ws-received',
  'server.output.batch-enqueued',
  'server.output.flush-start',
  'server.output.pre-send',
  'server.output.post-send',
]);

const RATES = [1, 4];
const SAMPLES_PER_CELL = 10;
const MAX_PROCESS_START_UNCERTAINTY_MS = 1_000;
const WORKLOAD_INPUTS = Object.freeze([
  { generation: 1, inputIndex: 0, tokenHash: '8e35c2cd3bf6641b', tokenLength: 1 },
  { generation: 2, inputIndex: 1, tokenHash: 'fee3b802a9ba4eeb', tokenLength: 2 },
  { generation: 3, inputIndex: 2, tokenHash: '93557903501f1ae7', tokenLength: 3 },
]);
const HASH16 = /^[0-9a-f]{16}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9]\d*)$/;
const REASON = /^[a-z][a-z0-9-]{0,63}$/;
const CLIENT_ID = /^[0-9a-f]{16}$/;
const SAFE_BROWSER_ID = /^[A-Za-z0-9-]{1,64}$/;
const RUNTIME_OBSERVATION_FAILURE = Symbol('cod374-runtime-observation-failure');
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const BROWSER_INPUT_STAGES = [
  'browser.keydown',
  'browser.xterm-on-data',
  'browser.logical',
  'browser.durable-queued',
  'browser.ws-input-send',
  'browser.ws-input-send-return',
  'browser.ws-input-ack',
];
const BROWSER_GLOBAL_OUTPUT_STAGES = [
  'browser.ws-output-receive',
  'browser.output-handler',
  'browser.write-queued',
  'browser.xterm-write',
  'browser.xterm-write-return',
  'browser.xterm-write-callback',
  'browser.xterm-parsed',
];
const BROWSER_VISIBILITY_STAGES = [
  'browser.xterm-visible-after-parse',
  'browser.xterm-render',
  'browser.xterm-visible',
  'browser.paint-proxy',
];
const BROWSER_STAGES = new Set([
  ...BROWSER_INPUT_STAGES,
  ...BROWSER_GLOBAL_OUTPUT_STAGES,
  ...BROWSER_VISIBILITY_STAGES,
  'browser.ws-input-send-failure',
  'browser.generation-incomplete',
]);
const SERVER_STAGES = new Set([
  'server.input.received',
  'server.input.parsed',
  'server.input.deduped',
  'server.input.activated',
  'server.input.pre-write',
  'server.input.post-write',
  'server.input.pre-ack',
  'server.input.post-ack',
  ...SERVER_OUTPUT_STAGES,
]);
const BROWSER_FIELDS = new Set([
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
const SERVER_FIELDS = new Set([
  'stage',
  'monoNs',
  'epochMs',
  'sessionHash',
  'connectionHash',
  'clientId',
  'seq',
  'ordinal',
  'bytes',
  'valueHash',
  'applied',
  'delivered',
]);
const SCHEDULE = [
  ['calibration', 'trace-off', 1],
  ['calibration', 'trace-on', 1],
  ['calibration', 'trace-off', 2],
  ['diagnostic', 'baseline', 1],
  ['diagnostic', 'candidate', 1],
  ['diagnostic', 'candidate', 2],
  ['diagnostic', 'baseline', 2],
];
const VERIFIED_PREFLIGHTS = new WeakMap();
const VERIFIED_RUNTIME_OBSERVATIONS = new WeakMap();

function fail(message) {
  throw new Error(`COD-374 evidence invalid: ${message}`);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, fields, label) {
  if (!object(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(`${label} has an unknown or missing field`);
  }
}

function exactArray(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    fail(`${label} is incomplete or out of order`);
  }
}

function nonnegative(value, label) {
  if (!Number.isFinite(value) || value < 0) fail(`${label} must be finite and nonnegative`);
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} must be a safe integer`);
}

function hash(value, label, expression = HASH16) {
  if (typeof value !== 'string' || !expression.test(value)) fail(`${label} must be a hash`);
}

function stable(value) {
  return JSON.stringify(canonicalize(value));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summaryStatistics(values) {
  if (!Array.isArray(values) || !values.length || values.some((value) => !Number.isFinite(value) || value < 0)) {
    fail('statistics require finite nonnegative samples');
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    median: median(sorted),
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    max: sorted.at(-1),
  };
}

function at(events, stage, field) {
  const matches = events.filter((event) => event.stage === stage);
  if (matches.length !== 1) fail(`${stage} must occur exactly once`);
  return field === 'monoNs' ? Number(BigInt(matches[0][field])) / 1_000_000 : matches[0][field];
}

function consecutive(events, stages, field, prefix) {
  if (field === 'monoNs') {
    const values = stages.map((stage) => {
      const matches = events.filter((event) => event.stage === stage);
      if (matches.length !== 1) fail(`${stage} must occur exactly once`);
      return BigInt(matches[0].monoNs);
    });
    return Object.fromEntries(
      stages
        .slice(1)
        .map((stage, index) => [
          `${prefix}${stages[index]}→${stage}`,
          Number(values[index + 1] - values[index]) / 1_000_000,
        ])
    );
  }
  const values = stages.map((stage) => at(events, stage, field));
  return Object.fromEntries(
    stages.slice(1).map((stage, index) => [`${prefix}${stages[index]}→${stage}`, values[index + 1] - values[index]])
  );
}

function browserWriteSegments(events, prefix) {
  const write = at(events, 'browser.xterm-write', 'atMs');
  const returned = at(events, 'browser.xterm-write-return', 'atMs');
  const callback = at(events, 'browser.xterm-write-callback', 'atMs');
  const parsed = at(events, 'browser.xterm-parsed', 'atMs');
  return {
    [`${prefix}browser.xterm-write→browser.xterm-write-return`]: returned - write,
    [`${prefix}browser.xterm-write→browser.xterm-write-callback`]: callback - write,
    [`${prefix}browser.xterm-write-callback→browser.xterm-parsed`]: parsed - callback,
  };
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function canonicalize(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

function validateBrowserEvent(event, sample, clockId) {
  if (!object(event) || Object.keys(event).some((field) => !BROWSER_FIELDS.has(field)))
    fail('unknown browser event field');
  if (
    !BROWSER_STAGES.has(event.stage) ||
    event.clock !== 'browser' ||
    event.clockId !== clockId ||
    !SAFE_BROWSER_ID.test(event.clockId ?? '') ||
    !SAFE_BROWSER_ID.test(event.trialId ?? '') ||
    !HASH16.test(event.tokenHash ?? '')
  ) {
    fail('browser event identity is invalid');
  }
  nonnegative(event.atMs, 'browser timestamp');
  integer(event.generation, 'browser generation');
  integer(event.inputIndex, 'browser input index');
  integer(event.tokenLength, 'browser token length', 1);
  for (const field of ['seq', 'bytes', 'ordinal', 'pendingCount', 'attributedInputIndex', 'coalescedIndex']) {
    if (event[field] !== undefined) integer(event[field], `browser ${field}`);
  }
  for (const field of ['writeId', 'attributedGeneration', 'attempt', 'coalescedCount']) {
    if (event[field] !== undefined) integer(event[field], `browser ${field}`, 1);
  }
  if (event.clientId !== undefined && !CLIENT_ID.test(event.clientId)) fail('browser client identity is invalid');
  if (event.valueHash !== undefined) hash(event.valueHash, 'browser value');
  if (event.failureHash !== undefined) hash(event.failureHash, 'browser failure');
  for (const field of ['selectedForAttribution']) {
    if (event[field] !== undefined && typeof event[field] !== 'boolean') fail(`browser ${field} is invalid`);
  }
  if (event.incompleteReason !== undefined && event.incompleteReason !== 'coalesced-before-exact-visibility') {
    fail('browser incomplete reason is invalid');
  }
  if ((event.coalescedIndex === undefined) !== (event.coalescedCount === undefined))
    fail('browser coalescing is incomplete');
  if (event.coalescedIndex !== undefined && event.coalescedIndex >= event.coalescedCount)
    fail('browser coalescing is invalid');
  if (event.generation === 0 && !BROWSER_GLOBAL_OUTPUT_STAGES.includes(event.stage))
    fail('invalid global browser output');
  const input = sample.inputs.find(
    (entry) => entry.generation === event.generation && entry.inputIndex === event.inputIndex
  );
  if (event.generation > 0) {
    if (!input || event.tokenHash !== input.tokenHash || event.tokenLength !== input.tokenLength) {
      fail('browser token identity mismatch');
    }
  }
}

function validateBrowserTrace(events, sample, clockId, allowContamination) {
  if (!Array.isArray(events) || !events.length) fail('browser trace is empty');
  events.forEach((event) => validateBrowserEvent(event, sample, clockId));
  for (let index = 1; index < events.length; index++) {
    if (events[index].atMs < events[index - 1].atMs) fail('browser trace is non-monotonic');
  }
  if (!allowContamination && events.some((event) => event.stage === 'browser.ws-input-send-failure'))
    fail('browser input send failure is present');
  const generations = [];
  for (const input of sample.inputs) {
    const selected = events.filter(
      (event) =>
        event.generation === input.generation &&
        event.inputIndex === input.inputIndex &&
        event.selectedForAttribution !== false
    );
    exactArray(
      selected.filter((event) => BROWSER_INPUT_STAGES.includes(event.stage)).map((event) => event.stage),
      BROWSER_INPUT_STAGES,
      'browser input chain'
    );
    const visibility = selected.filter((event) => BROWSER_VISIBILITY_STAGES.includes(event.stage));
    const incomplete = selected.filter((event) => event.stage === 'browser.generation-incomplete');
    if (visibility.length) {
      exactArray(
        visibility.map((event) => event.stage),
        BROWSER_VISIBILITY_STAGES,
        'browser visibility chain'
      );
      if (incomplete.length) fail('browser generation is both visible and incomplete');
      if (new Set(visibility.map((event) => `${event.ordinal}:${event.writeId}`)).size !== 1)
        fail('browser visibility stages do not share one parsed write');
    } else if (incomplete.length !== 1) fail('browser generation lacks visibility or incompleteness evidence');
    const identityEvents = selected.filter((event) =>
      [
        'browser.durable-queued',
        'browser.ws-input-send',
        'browser.ws-input-send-return',
        'browser.ws-input-ack',
      ].includes(event.stage)
    );
    if (
      identityEvents.length !== 4 ||
      identityEvents.some(
        (event) =>
          event.clientId !== input.clientId ||
          event.seq !== input.seq ||
          (event.coalescedIndex ?? 0) !== input.coalescedIndex ||
          (event.coalescedCount ?? 1) !== input.coalescedCount
      )
    )
      fail('browser input client sequence identity mismatch');
    generations.push({ input, selected, visibility, incomplete });
  }
  const global = events.filter((event) => event.generation === 0);
  const received = global.filter((event) => event.stage === 'browser.ws-output-receive');
  if (!received.length) fail('browser output evidence is empty');
  if (
    global.filter((event) => BROWSER_GLOBAL_OUTPUT_STAGES.slice(0, 3).includes(event.stage)).length !==
    received.length * 3
  )
    fail('browser output receive evidence contains an unbound event');
  let previous = -1;
  for (const event of received) {
    if (event.ordinal === undefined || event.ordinal <= previous) fail('browser output ordinal is invalid');
    previous = event.ordinal;
    const trio = global.filter(
      (candidate) =>
        candidate.ordinal === event.ordinal &&
        ['browser.ws-output-receive', 'browser.output-handler', 'browser.write-queued'].includes(candidate.stage)
    );
    exactArray(
      trio.map((candidate) => candidate.stage),
      BROWSER_GLOBAL_OUTPUT_STAGES.slice(0, 3),
      'browser output receive chain'
    );
    if (!HASH16.test(event.valueHash ?? '') || !Number.isSafeInteger(event.bytes))
      fail('browser output handler identity mismatch');
    if (trio.slice(1).some((candidate) => candidate.valueHash !== undefined || candidate.bytes !== undefined))
      fail('browser output handler or queue contains invented payload identity');
  }
  const writes = global.filter((event) => event.stage === 'browser.xterm-write');
  if (
    global.filter((event) => BROWSER_GLOBAL_OUTPUT_STAGES.slice(3).includes(event.stage)).length !==
      writes.length * 4 ||
    new Set(writes.map((event) => event.writeId)).size !== writes.length
  )
    fail('browser xterm evidence contains an unbound write');
  for (const event of writes) {
    const group = global.filter(
      (candidate) =>
        candidate.writeId === event.writeId && BROWSER_GLOBAL_OUTPUT_STAGES.slice(3).includes(candidate.stage)
    );
    const stages = group.map((candidate) => candidate.stage);
    const writeIndex = stages.indexOf('browser.xterm-write');
    const returnIndexes = stages
      .map((stage, index) => (stage === 'browser.xterm-write-return' ? index : -1))
      .filter((index) => index >= 0);
    const callbackIndex = stages.indexOf('browser.xterm-write-callback');
    const parsedIndex = stages.indexOf('browser.xterm-parsed');
    if (
      stages.length !== 4 ||
      writeIndex !== 0 ||
      returnIndexes.length !== 1 ||
      callbackIndex <= writeIndex ||
      parsedIndex <= callbackIndex ||
      !(returnIndexes[0] < callbackIndex || returnIndexes[0] > parsedIndex)
    ) {
      fail('browser xterm write chain is incomplete or out of order');
    }
    if (group.some((candidate) => candidate.ordinal !== event.ordinal)) fail('browser xterm write identity mismatch');
    if (!received.some((candidate) => candidate.ordinal === event.ordinal)) fail('browser write lacks received output');
  }
  if (writes.length !== global.filter((event) => event.stage === 'browser.xterm-parsed').length)
    fail('browser parsed write identity mismatch');
  let priorWriteOrdinal = -1;
  for (const write of writes) {
    if (write.ordinal <= priorWriteOrdinal) fail('browser coalesced writes are not monotonic');
    const queued = received.filter((event) => event.ordinal > priorWriteOrdinal && event.ordinal <= write.ordinal);
    if (!queued.length) fail('browser write does not consume queued output');
    priorWriteOrdinal = write.ordinal;
  }
  if (priorWriteOrdinal !== received.at(-1).ordinal) fail('browser queued output was not parsed');
  for (const generation of generations) {
    for (const event of generation.visibility) {
      if (
        event.attributedGeneration !== generation.input.generation ||
        event.attributedInputIndex !== generation.input.inputIndex ||
        !global.some(
          (candidate) =>
            candidate.stage === 'browser.xterm-parsed' &&
            candidate.ordinal === event.ordinal &&
            candidate.writeId === event.writeId
        )
      )
        fail('browser visibility is not joined to a parsed write');
    }
  }
  return { generations, global, received, writes };
}

function validateServerEvent(event) {
  if (!object(event) || Object.keys(event).some((field) => !SERVER_FIELDS.has(field)))
    fail('unknown server event field');
  if (!SERVER_STAGES.has(event.stage) || typeof event.monoNs !== 'string' || !DECIMAL.test(event.monoNs)) {
    fail('server event is invalid');
  }
  if (event.epochMs !== undefined) nonnegative(event.epochMs, 'server epoch');
  for (const field of ['sessionHash', 'connectionHash', 'valueHash']) {
    if (event[field] !== undefined) hash(event[field], `server ${field}`);
  }
  if (event.clientId !== undefined && !CLIENT_ID.test(event.clientId)) fail('server client identity is invalid');
  for (const field of ['seq', 'ordinal', 'bytes']) {
    if (event[field] !== undefined) integer(event[field], `server ${field}`);
  }
  for (const field of ['applied', 'delivered']) {
    if (event[field] !== undefined && typeof event[field] !== 'boolean') fail(`server ${field} is invalid`);
  }
}

function groups(events, stages, label) {
  if (!events.length || events.length % stages.length) fail(`incomplete server ${label} chain`);
  let previous = -1;
  for (let offset = 0; offset < events.length; offset += stages.length) {
    const group = events.slice(offset, offset + stages.length);
    exactArray(
      group.map((event) => event.stage),
      stages,
      `server ${label} stages`
    );
    const first = group[0];
    if (!HASH16.test(first.valueHash ?? '') || !Number.isSafeInteger(first.bytes) || first.bytes < 0) {
      fail(`server ${label} output identity is required`);
    }
    for (const event of group) {
      if (
        event.valueHash !== first.valueHash ||
        event.bytes !== first.bytes ||
        event.ordinal === undefined ||
        event.ordinal <= previous
      ) {
        fail(`server ${label} identity or ordinal order is invalid`);
      }
      previous = event.ordinal;
    }
  }
  return events.length / stages.length;
}

function groupedSegments(events, stages, prefix) {
  const result = {};
  for (let offset = 0, groupIndex = 0; offset < events.length; offset += stages.length, groupIndex++) {
    const group = events.slice(offset, offset + stages.length);
    for (let index = 1; index < group.length; index++) {
      result[`${prefix}${groupIndex + 1}:${stages[index - 1]}→${stages[index]}`] =
        Number(BigInt(group[index].monoNs) - BigInt(group[index - 1].monoNs)) / 1_000_000;
    }
  }
  return result;
}

function groupedBrowserSegments(events, stages, prefix) {
  const result = {};
  for (let offset = 0, groupIndex = 0; offset < events.length; offset += stages.length, groupIndex++) {
    const group = events.slice(offset, offset + stages.length);
    for (let index = 1; index < group.length; index++) {
      result[`${prefix}${groupIndex + 1}:${stages[index - 1]}→${stages[index]}`] =
        group[index].atMs - group[index - 1].atMs;
    }
  }
  return result;
}

function validateServerTrace(events, sample, firstAcked) {
  if (!Array.isArray(events) || !events.length) fail('trace-on server evidence is empty');
  events.forEach(validateServerEvent);
  for (let index = 1; index < events.length; index++) {
    if (BigInt(events[index].monoNs) < BigInt(events[index - 1].monoNs)) fail('server trace is non-monotonic');
  }
  const inputs = events.filter((event) => event.stage.startsWith('server.input.'));
  const inputStages = [
    'server.input.received',
    'server.input.parsed',
    'server.input.deduped',
    'server.input.activated',
    'server.input.pre-write',
    'server.input.post-write',
    'server.input.pre-ack',
    'server.input.post-ack',
  ];
  const uniqueInputs = [...new Map(sample.inputs.map((input) => [`${input.clientId}:${input.seq}`, input])).values()];
  const inputGroups = uniqueInputs.map((input) => {
    const chain = inputs.filter((event) => event.clientId === input.clientId && event.seq === input.seq);
    exactArray(
      chain.map((event) => event.stage),
      inputStages,
      'server input chain'
    );
    if (chain.some((event) => event.clientId !== input.clientId || event.seq !== input.seq))
      fail('server input client sequence identity mismatch');
    if (chain[2].applied !== true || chain[5].delivered !== true || chain[7].delivered !== undefined)
      fail('server write or ACK correctness failed');
    return chain;
  });
  if (inputGroups.flat().length !== inputs.length) fail('unbound server input event');
  const connectionHash = inputGroups[0].at(-1).connectionHash;
  hash(connectionHash, 'measured connection');
  if (inputGroups.some((group) => group.at(-1).connectionHash !== connectionHash)) fail('mixed measured connections');
  const upstream = events.filter((event) =>
    ['server.output.pty-received', 'server.output.handler-enter', 'server.output.terminal-emitted'].includes(
      event.stage
    )
  );
  const chunks = events.filter(
    (event) =>
      event.connectionHash === connectionHash &&
      ['server.output.ws-received', 'server.output.batch-enqueued'].includes(event.stage)
  );
  const flushes = events.filter(
    (event) =>
      event.connectionHash === connectionHash &&
      ['server.output.flush-start', 'server.output.pre-send', 'server.output.post-send'].includes(event.stage)
  );
  const multiplicity = {
    upstreamChunks: groups(
      upstream,
      ['server.output.pty-received', 'server.output.handler-enter', 'server.output.terminal-emitted'],
      'upstream'
    ),
    connectionChunks: groups(chunks, ['server.output.ws-received', 'server.output.batch-enqueued'], 'connection chunk'),
    flushes: groups(
      flushes,
      ['server.output.flush-start', 'server.output.pre-send', 'server.output.post-send'],
      'flush'
    ),
  };
  const firstAck = inputGroups
    .flatMap((group) => group)
    .find(
      (event) =>
        event.stage === 'server.input.post-ack' &&
        event.clientId === firstAcked.clientId &&
        event.seq === firstAcked.seq
    );
  if (!firstAck || firstAck.ordinal !== firstAcked.serverOrdinal) fail('server first ACK identity mismatch');
  const firstAckOrdinal = firstAck.ordinal;
  const selectedSends = flushes.filter(
    (event) => event.stage === 'server.output.post-send' && event.ordinal > firstAckOrdinal
  );
  for (const send of selectedSends) {
    const groupOffset = flushes.indexOf(send) - 2;
    if (
      groupOffset < 0 ||
      flushes.slice(groupOffset, groupOffset + 3).some((event) => event.ordinal <= firstAckOrdinal)
    ) {
      fail('selected server output crosses the measured post-ACK boundary');
    }
  }
  if (selectedSends.some((event) => event.delivered !== true)) fail('selected server output was not delivered');
  const emitted = upstream.filter((event) => event.stage === 'server.output.terminal-emitted');
  const received = chunks.filter((event) => event.stage === 'server.output.ws-received');
  let emittedIndex = 0;
  for (const event of received) {
    while (
      emittedIndex < emitted.length &&
      (emitted[emittedIndex].valueHash !== event.valueHash || emitted[emittedIndex].bytes !== event.bytes)
    )
      emittedIndex += 1;
    if (emittedIndex === emitted.length) fail('server connection output lacks an upstream chunk');
    emittedIndex += 1;
  }
  return {
    inputs,
    inputGroups,
    connectionHash,
    upstream,
    chunks,
    flushes,
    selectedSends,
    attributedUpstream: upstream.filter((event) => event.ordinal > firstAckOrdinal),
    attributedChunks: chunks.filter((event) => event.ordinal > firstAckOrdinal),
    attributedFlushes: flushes.filter((event) => event.ordinal > firstAckOrdinal),
    multiplicity,
  };
}

function validatePane(pane, input, allowContamination, final) {
  exactKeys(pane, ['inputIndex', 'tokenHash', 'tokenLength', 'status', 'errorHash', 'probes'], 'pane result');
  if (
    pane.inputIndex !== input.inputIndex ||
    pane.tokenHash !== input.tokenHash ||
    pane.tokenLength !== input.tokenLength ||
    !['visible', 'incomplete'].includes(pane.status) ||
    !Array.isArray(pane.probes) ||
    pane.probes.length < 1
  ) {
    fail('pane target identity or status mismatch');
  }
  if (pane.errorHash !== null) hash(pane.errorHash, 'pane result error');
  let absent = false;
  let visible = false;
  for (const probe of pane.probes) {
    exactKeys(probe, ['startedNs', 'completedNs', 'present', 'durationMs', 'errorHash'], 'pane probe');
    if (!DECIMAL.test(probe.startedNs) || !DECIMAL.test(probe.completedNs)) fail('pane nanoseconds are not canonical');
    if (BigInt(probe.completedNs) < BigInt(probe.startedNs)) fail('pane probe is out of order');
    nonnegative(probe.durationMs, 'pane duration');
    if (probe.errorHash !== null) hash(probe.errorHash, 'pane error');
    if (!probe.present && probe.errorHash === null) absent = true;
    if (probe.present && absent && probe.errorHash === null) visible = true;
  }
  if (!allowContamination && pane.probes.some((probe) => probe.errorHash !== null))
    fail('accepted pane probe has errors');
  if (pane.status === 'visible' && (pane.errorHash !== null || pane.probes.at(-1)?.present !== true || !visible))
    fail('pane visibility is not final');
  if (pane.status === 'incomplete' && pane.errorHash === null) fail('incomplete pane lacks bounded error evidence');
  if (final && !allowContamination && pane.status !== 'visible') fail('final pane target is not visible');
}

export function deriveSampleEvidence(sample, traceEnabled, { allowContamination = false } = {}) {
  const browser = validateBrowserTrace(
    sample.evidence.browserEvents,
    sample,
    sample.evidence.browserEvents[0]?.clockId,
    allowContamination
  );
  const firstAcked = sample.evidence.firstAcked;
  exactKeys(firstAcked, ['clientId', 'seq', 'serverOrdinal'], 'first ACK');
  hash(firstAcked.clientId, 'first ACK client');
  integer(firstAcked.seq, 'first ACK sequence');
  if (traceEnabled) integer(firstAcked.serverOrdinal, 'first ACK server ordinal');
  else if (firstAcked.serverOrdinal !== null) fail('trace-off first ACK has a server ordinal');
  const firstBrowserAck = sample.evidence.browserEvents.find((event) => event.stage === 'browser.ws-input-ack');
  if (firstBrowserAck?.clientId !== firstAcked.clientId || firstBrowserAck?.seq !== firstAcked.seq)
    fail('browser first ACK identity mismatch');
  const server = traceEnabled ? validateServerTrace(sample.evidence.serverEvents, sample, firstAcked) : null;
  if (!traceEnabled && sample.evidence.serverEvents.length) fail('trace-off sample contains server collector events');
  const panes = sample.evidence.paneResults;
  if (panes.length !== sample.inputs.length) fail('pane result multiplicity mismatch');
  panes.forEach((pane, index) =>
    validatePane(pane, sample.inputs[index], allowContamination, index === panes.length - 1)
  );
  const keydown = at(browser.generations[0].selected, 'browser.keydown', 'atMs');
  const finalGeneration = browser.generations.at(-1);
  const paint = at(finalGeneration.visibility, 'browser.paint-proxy', 'atMs');
  const window = sample.evidence.longTaskWindow;
  exactKeys(window, ['startedMs', 'endedMs', 'entries'], 'long-task window');
  nonnegative(window.startedMs, 'long-task start');
  nonnegative(window.endedMs, 'long-task end');
  if (window.startedMs > keydown || window.endedMs < paint)
    fail('long-task window does not enclose keydown through paint');
  if (!Array.isArray(window.entries)) fail('long-task entries are invalid');
  for (const entry of window.entries) {
    exactKeys(entry, ['startedMs', 'durationMs'], 'sample long task');
    nonnegative(entry.startedMs, 'sample long-task timestamp');
    nonnegative(entry.durationMs, 'sample long-task duration');
  }
  if (window.entries.length && !allowContamination) fail('accepted sample has browser long tasks');
  if (!Array.isArray(sample.evidence.resizeEvents)) fail('sample resize evidence is invalid');
  for (const entry of sample.evidence.resizeEvents) {
    exactKeys(entry, ['atMs'], 'sample resize');
    nonnegative(entry.atMs, 'sample resize timestamp');
  }
  if (sample.evidence.resizeEvents.length && !allowContamination) fail('accepted sample resized');
  const outputFrames = browser.received.length;
  if (server) {
    const sends = server.selectedSends;
    if (
      sends.length !== outputFrames ||
      sends.some(
        (event, index) =>
          event.valueHash !== browser.received[index].valueHash || event.bytes !== browser.received[index].bytes
      )
    ) {
      fail('browser and server output frames are not losslessly joined');
    }
  }
  const pane = panes.at(-1);
  const probes = pane.probes;
  const absent = [...probes].reverse().find((probe) => !probe.present && probe.errorHash === null);
  const present = probes.find(
    (probe) => probe.present && probe.errorHash === null && BigInt(probe.startedNs) >= BigInt(absent.completedNs)
  );
  const segments = {
    ...Object.assign(
      {},
      ...browser.generations.map((generation, index) =>
        consecutive(generation.selected, BROWSER_INPUT_STAGES, 'atMs', `input${index + 1}:`)
      )
    ),
    ...Object.assign(
      {},
      ...browser.received.map((event, index) =>
        consecutive(
          browser.global.filter(
            (candidate) =>
              candidate.ordinal === event.ordinal && BROWSER_GLOBAL_OUTPUT_STAGES.slice(0, 3).includes(candidate.stage)
          ),
          BROWSER_GLOBAL_OUTPUT_STAGES.slice(0, 3),
          'atMs',
          `browser-output${index + 1}:`
        )
      )
    ),
    ...Object.assign(
      {},
      ...browser.writes.map((event, index) =>
        browserWriteSegments(
          browser.global.filter(
            (candidate) =>
              candidate.writeId === event.writeId && BROWSER_GLOBAL_OUTPUT_STAGES.slice(3).includes(candidate.stage)
          ),
          `browser-write${index + 1}:`
        )
      )
    ),
    ...consecutive(finalGeneration.visibility, BROWSER_VISIBILITY_STAGES, 'atMs', 'final:'),
    ...(server
      ? {
          ...Object.assign(
            {},
            ...server.inputGroups.map((group, index) =>
              consecutive(
                group,
                [
                  'server.input.received',
                  'server.input.parsed',
                  'server.input.deduped',
                  'server.input.activated',
                  'server.input.pre-write',
                  'server.input.post-write',
                  'server.input.pre-ack',
                  'server.input.post-ack',
                ],
                'monoNs',
                `server-input${index + 1}:`
              )
            )
          ),
          ...groupedSegments(
            server.attributedUpstream,
            ['server.output.pty-received', 'server.output.handler-enter', 'server.output.terminal-emitted'],
            'upstream'
          ),
          ...groupedSegments(
            server.attributedChunks,
            ['server.output.ws-received', 'server.output.batch-enqueued'],
            'connection'
          ),
          ...groupedSegments(
            server.attributedFlushes,
            ['server.output.flush-start', 'server.output.pre-send', 'server.output.post-send'],
            'flush'
          ),
        }
      : {}),
  };
  for (const [name, value] of Object.entries(segments)) nonnegative(value, `derived segment ${name}`);
  return {
    totalMs: paint - keydown,
    segments,
    paneInterval: {
      widthMs: absent && present ? Number(BigInt(present.completedNs) - BigInt(absent.completedNs)) / 1_000_000 : null,
      pollCostMs: Math.max(...probes.map((probe) => probe.durationMs)),
    },
    correctness: {
      browserAcks: browser.generations.reduce(
        (count, generation) =>
          count + generation.selected.filter((event) => event.stage === 'browser.ws-input-ack').length,
        0
      ),
      serverApplied:
        server?.inputs.filter((event) => event.stage === 'server.input.deduped' && event.applied).length ?? 0,
      serverWrites:
        server?.inputs.filter((event) => event.stage === 'server.input.post-write' && event.delivered).length ?? 0,
      serverAcks: server?.inputs.filter((event) => event.stage === 'server.input.post-ack').length ?? 0,
      outputFrames,
      paneVisible: sample.evidence.paneResults.filter((entry) => entry.status === 'visible').length,
      xtermVisible: browser.generations.reduce(
        (count, generation) =>
          count + generation.visibility.filter((event) => event.stage === 'browser.xterm-visible').length,
        0
      ),
    },
    serverMultiplicity: server?.multiplicity ?? { upstreamChunks: 0, connectionChunks: 0, flushes: 0 },
    browserEventCount: sample.evidence.browserEvents.length,
    serverEventCount: sample.evidence.serverEvents.length,
    outputOrdinals: browser.received.map((event) => event.ordinal),
    paneProbeCount: panes.reduce((count, entry) => count + entry.probes.length, 0),
    paneErrorCount: panes.reduce(
      (count, entry) => count + entry.probes.filter((probe) => probe.errorHash !== null).length,
      0
    ),
    paneResults: panes.map((entry) => ({
      inputIndex: entry.inputIndex,
      status: entry.status,
      errorHash: entry.errorHash,
      probes: entry.probes.length,
      probeEvidence: entry.probes.map((probe) => ({
        startedNs: probe.startedNs,
        completedNs: probe.completedNs,
        present: probe.present,
        durationMs: probe.durationMs,
        errorHash: probe.errorHash,
      })),
      probeErrors: entry.probes.filter((probe) => probe.errorHash !== null).map((probe) => probe.errorHash),
    })),
    inputs: sample.inputs.map(
      ({ clientId, seq, tokenHash, tokenLength, generation, inputIndex, coalescedIndex, coalescedCount }) => ({
        clientId,
        seq,
        tokenHash,
        tokenLength,
        generation,
        inputIndex,
        coalescedIndex,
        coalescedCount,
      })
    ),
  };
}

function validateProductAndProvenance(row, accepted) {
  const provenance = row.provenance;
  exactKeys(
    provenance,
    ['product', 'harness', 'overlay', 'dependencies', 'runtimeVendorHash', 'host', 'process'],
    'provenance'
  );
  const crashHash = createHash('sha256').update('producer-crash').digest('hex').slice(0, 16);
  const process = provenance.process;
  const producerCrash =
    row.selection.lifecycle === 'partial' &&
    row.selection.failureReasons.length === 1 &&
    row.selection.failureReasons[0].code === 'producer-crash' &&
    row.selection.failureReasons[0].detailHash === crashHash &&
    Array.isArray(row.cells) &&
    row.cells.length === 0 &&
    process?.tmuxSessionHash === null &&
    process?.tempRootHash === null &&
    process?.server === null &&
    process?.browser === null &&
    process?.opencode === null &&
    row.diagnostics?.processReplaced === false &&
    Array.isArray(row.diagnostics?.errorHashes) &&
    row.diagnostics.errorHashes.length === 1 &&
    row.diagnostics.errorHashes[0] === crashHash &&
    Array.isArray(row.diagnostics?.startupStageHashes) &&
    row.diagnostics.startupStageHashes.length === 1 &&
    row.diagnostics.startupStageHashes[0] === crashHash &&
    Object.values(row.cleanup ?? {}).every((value) => value === false);
  const runtimeVendorProofRequired = accepted || (row.selection.lifecycle === 'partial' && !producerCrash);
  if (provenance.runtimeVendorHash === null) {
    if (runtimeVendorProofRequired) fail('runtime-proven attempt lacks runtime vendor proof');
  } else {
    hash(provenance.runtimeVendorHash, 'runtime vendor', SHA64);
  }
  if (producerCrash && provenance.runtimeVendorHash !== null) fail('producer crash cannot claim runtime vendor proof');
  if (row.selection.lifecycle === 'preflight' && provenance.runtimeVendorHash !== null)
    fail('rejected preflight cannot claim runtime vendor proof');
  const product = row.config.label === 'baseline' ? BASELINE_PRODUCT : CANDIDATE_PRODUCT;
  exactKeys(provenance.product, ['sha', 'tree'], 'product provenance');
  if (provenance.product.sha !== product.sha || provenance.product.tree !== product.tree) fail('product is not frozen');
  exactKeys(provenance.harness, ['commit', 'tree', 'dirty', 'files'], 'harness provenance');
  if (
    !SHA40.test(provenance.harness.commit) ||
    !SHA40.test(provenance.harness.tree) ||
    provenance.harness.dirty !== false
  ) {
    fail('harness provenance is invalid');
  }
  exactArray(
    provenance.harness.files.map((entry) => entry.file),
    HARNESS_FILES,
    'harness file manifest'
  );
  for (const entry of provenance.harness.files) {
    exactKeys(entry, ['file', 'blob', 'sha256'], 'harness file');
    hash(entry.blob, 'harness blob', SHA40);
    hash(entry.sha256, 'harness content', SHA64);
  }
  exactKeys(
    provenance.overlay,
    ['semanticSha256', 'patchSha256', 'files', 'manifestSha256', 'servedAssets'],
    'overlay provenance'
  );
  for (const field of ['semanticSha256', 'patchSha256', 'manifestSha256'])
    hash(provenance.overlay[field], field, SHA64);
  exactArray(
    provenance.overlay.files.map((entry) => entry.file),
    OVERLAY_FILES,
    'overlay allowlist'
  );
  for (const entry of provenance.overlay.files) {
    exactKeys(entry, ['file', 'mode', 'sha256'], 'overlay file');
    if (!/^100(?:644|755)$/.test(entry.mode)) fail('overlay file mode is invalid');
    hash(entry.sha256, 'overlay content', SHA64);
  }
  exactArray(
    provenance.overlay.servedAssets.map((entry) => entry.path),
    ['/', '/app.js', '/styles.css'],
    'served asset manifest'
  );
  for (const entry of provenance.overlay.servedAssets) {
    exactKeys(entry, ['path', 'sha256'], 'served asset');
    hash(entry.sha256, 'served asset content', SHA64);
  }
  exactKeys(
    provenance.dependencies,
    [
      'packageLockSha256',
      'vendorManifestSha256',
      'dependencyRootHash',
      'dependencyContentHash',
      'dependencyDevice',
      'dependencyInode',
    ],
    'dependency provenance'
  );
  hash(provenance.dependencies.packageLockSha256, 'lock', SHA64);
  hash(provenance.dependencies.vendorManifestSha256, 'vendor', SHA64);
  hash(provenance.dependencies.dependencyRootHash, 'dependency root', SHA64);
  hash(provenance.dependencies.dependencyContentHash, 'dependency content', SHA64);
  for (const field of ['dependencyDevice', 'dependencyInode']) {
    if (!/^[1-9][0-9]{0,19}$/.test(provenance.dependencies[field])) fail(`${field} is invalid`);
  }
  exactKeys(
    provenance.host,
    ['hostnameHash', 'cpuModelHash', 'cpuCount', 'platform', 'releaseHash', 'nodeVersionHash', 'opencodeVersionHash'],
    'host provenance'
  );
  for (const field of ['hostnameHash', 'cpuModelHash', 'releaseHash', 'nodeVersionHash', 'opencodeVersionHash']) {
    hash(provenance.host[field], `host ${field}`);
  }
  integer(provenance.host.cpuCount, 'CPU count', 1);
  if (provenance.host.platform !== 'linux') fail('host platform enum is invalid');
  exactKeys(
    process,
    ['runId', 'tmuxSessionHash', 'tempRootHash', 'server', 'browser', 'opencode'],
    'process provenance'
  );
  hash(process.runId, 'run');
  if (accepted) {
    hash(process.tempRootHash, 'temporary root');
    hash(process.tmuxSessionHash, 'tmux session');
    for (const name of ['server', 'browser', 'opencode']) {
      exactKeys(process[name], ['pid', 'startedAt', 'startIdentity', 'startUncertaintyMs'], `${name} process`);
      integer(process[name].pid, `${name} PID`, 1);
      if (!DECIMAL.test(process[name].startIdentity)) fail(`${name} process start identity is invalid`);
      if (!ISO_INSTANT.test(process[name].startedAt)) fail(`${name} process start is invalid`);
      nonnegative(process[name].startUncertaintyMs, `${name} process start uncertainty`);
      if (process[name].startUncertaintyMs > MAX_PROCESS_START_UNCERTAINTY_MS)
        fail(`${name} process start uncertainty exceeds 1000ms`);
      const started = Date.parse(process[name].startedAt);
      if (
        started + process[name].startUncertaintyMs < Date.parse(row.timing.startedAt) ||
        started - process[name].startUncertaintyMs > Date.parse(row.timing.endedAt)
      ) {
        fail(`${name} process start is outside repetition`);
      }
    }
  } else {
    if (process.tempRootHash !== null) hash(process.tempRootHash, 'temporary root');
    if (process.tmuxSessionHash !== null) hash(process.tmuxSessionHash, 'tmux session');
    for (const name of ['server', 'browser', 'opencode']) {
      if (process[name] !== null) {
        exactKeys(process[name], ['pid', 'startedAt', 'startIdentity', 'startUncertaintyMs'], `${name} process`);
        integer(process[name].pid, `${name} PID`, 1);
        if (!DECIMAL.test(process[name].startIdentity)) fail(`${name} process start identity is invalid`);
        if (!ISO_INSTANT.test(process[name].startedAt)) fail(`${name} process start is invalid`);
        nonnegative(process[name].startUncertaintyMs, `${name} process start uncertainty`);
        if (process[name].startUncertaintyMs > MAX_PROCESS_START_UNCERTAINTY_MS)
          fail(`${name} process start uncertainty exceeds 1000ms`);
        const started = Date.parse(process[name].startedAt);
        if (
          started + process[name].startUncertaintyMs < Date.parse(row.timing.startedAt) ||
          started - process[name].startUncertaintyMs > Date.parse(row.timing.endedAt)
        )
          fail(`${name} process start is outside repetition`);
      }
    }
  }
}

function validateCommon(row, accepted, completed = accepted) {
  exactKeys(
    row,
    [
      'schemaVersion',
      'phase',
      'experimentId',
      'config',
      'provenance',
      'timing',
      'clock',
      'selection',
      'cells',
      'diagnostics',
      'allocation',
      'cleanup',
    ],
    'attempt'
  );
  if (row.schemaVersion !== 2) fail('unsupported repetition schema');
  hash(row.experimentId, 'experiment');
  if (!['calibration', 'diagnostic'].includes(row.phase)) fail('phase is invalid');
  exactKeys(
    row.config,
    [
      'label',
      'repetition',
      'traceEnabled',
      'rates',
      'samplesPerCell',
      'viewport',
      'fontPx',
      'payloadHash',
      'payloadLength',
    ],
    'configuration'
  );
  const labels = row.phase === 'calibration' ? ['trace-off', 'trace-on'] : ['baseline', 'candidate'];
  if (!labels.includes(row.config.label)) fail('label does not match phase');
  integer(row.config.repetition, 'repetition', 1);
  if (row.config.traceEnabled !== (row.config.label !== 'trace-off')) fail('trace mode does not match label');
  exactArray(row.config.rates, RATES, 'rates');
  if (row.config.samplesPerCell !== SAMPLES_PER_CELL) fail('sample count configuration mismatch');
  exactKeys(row.config.viewport, ['width', 'height'], 'viewport');
  if (row.config.viewport.width !== 390 || row.config.viewport.height !== 844) fail('viewport is not frozen');
  if (row.config.fontPx !== (row.config.label === 'baseline' ? 10 : 9)) fail('font is not frozen');
  hash(row.config.payloadHash, 'payload');
  if (row.config.payloadHash !== WORKLOAD_INPUTS.at(-1).tokenHash || row.config.payloadLength !== 3)
    fail('payload identity is not the frozen q,z,1 workload');
  exactKeys(row.timing, ['startedAt', 'endedAt', 'loadAverageBefore', 'loadAverageAfter'], 'timing');
  const started = Date.parse(row.timing.startedAt);
  const ended = Date.parse(row.timing.endedAt);
  if (
    !ISO_INSTANT.test(row.timing.startedAt) ||
    !ISO_INSTANT.test(row.timing.endedAt) ||
    !Number.isFinite(started) ||
    !Number.isFinite(ended) ||
    ended <= started
  )
    fail('repetition timing is invalid');
  for (const field of ['loadAverageBefore', 'loadAverageAfter']) {
    if (!Array.isArray(row.timing[field]) || row.timing[field].length !== 3) fail('load evidence is invalid');
    row.timing[field].forEach((value) => nonnegative(value, 'load'));
  }
  exactKeys(row.clock, ['mode', 'browserClockId', 'serverClockId', 'harnessClockId'], 'clock evidence');
  if (row.clock.mode !== 'component-local') fail('only component-local clock attribution is supported');
  if (!SAFE_BROWSER_ID.test(row.clock.browserClockId)) fail('browser clock identity is invalid');
  for (const field of ['serverClockId', 'harnessClockId']) hash(row.clock[field], `clock ${field}`);
  exactKeys(row.selection, ['attempt', 'lifecycle', 'accepted', 'failureReasons'], 'selection');
  integer(row.selection.attempt, 'attempt', 1);
  if (
    !['preflight', 'partial', 'completed'].includes(row.selection.lifecycle) ||
    (accepted && row.selection.lifecycle !== 'completed')
  ) {
    fail('selection lifecycle is invalid');
  }
  if (row.selection.accepted !== accepted || !Array.isArray(row.selection.failureReasons)) fail('selection is invalid');
  for (const reason of row.selection.failureReasons) {
    exactKeys(reason, ['code', 'detailHash'], 'failure reason');
    if (!REASON.test(reason.code)) fail('failure reason code is invalid');
    hash(reason.detailHash, 'failure detail');
  }
  if (accepted !== (row.selection.failureReasons.length === 0)) fail('failure reasons do not match outcome');
  validateProductAndProvenance(row, completed);
  exactKeys(
    row.diagnostics,
    [
      'traceOverflowed',
      'observerErrorHashes',
      'pageErrorHashes',
      'consoleErrorHashes',
      'processReplaced',
      'resizeEvents',
      'longTasks',
      'errorHashes',
      'serverStdoutHashes',
      'serverStderrHashes',
      'startupStageHashes',
      'startupNameHashes',
      'startupMessageHashes',
    ],
    'diagnostics'
  );
  for (const field of [
    'observerErrorHashes',
    'pageErrorHashes',
    'consoleErrorHashes',
    'errorHashes',
    'serverStdoutHashes',
    'serverStderrHashes',
    'startupStageHashes',
    'startupNameHashes',
    'startupMessageHashes',
  ]) {
    if (!Array.isArray(row.diagnostics[field])) fail(`${field} is invalid`);
    if (row.diagnostics[field].length > 32) fail(`${field} exceeds bounded diagnostic count`);
    row.diagnostics[field].forEach((entry) => hash(entry, field));
  }
  if (!Array.isArray(row.diagnostics.resizeEvents) || !Array.isArray(row.diagnostics.longTasks))
    fail('diagnostic arrays are invalid');
  for (const entry of row.diagnostics.resizeEvents) {
    exactKeys(entry, ['atMs'], 'resize diagnostic');
    nonnegative(entry.atMs, 'resize timestamp');
  }
  for (const entry of row.diagnostics.longTasks) {
    exactKeys(entry, ['startedMs', 'durationMs'], 'long-task diagnostic');
    nonnegative(entry.startedMs, 'long-task timestamp');
    nonnegative(entry.durationMs, 'long-task duration');
  }
  if (typeof row.diagnostics.traceOverflowed !== 'boolean' || typeof row.diagnostics.processReplaced !== 'boolean') {
    fail('diagnostic flags are invalid');
  }
  exactKeys(
    row.allocation,
    ['browserClosed', 'serverStopped', 'tmuxRemoved', 'tempRootRemoved', 'hooksRestored', 'listenersDisposed'],
    'allocation'
  );
  if (Object.values(row.allocation).some((value) => typeof value !== 'boolean')) fail('allocation schema is invalid');
  exactKeys(
    row.cleanup,
    ['browserClosed', 'serverStopped', 'tmuxRemoved', 'tempRootRemoved', 'hooksRestored', 'listenersDisposed'],
    'cleanup'
  );
  if (Object.values(row.cleanup).some((value) => typeof value !== 'boolean')) fail('cleanup schema is invalid');
  for (const field of Object.keys(row.cleanup)) {
    if (!row.allocation[field] && row.cleanup[field] !== true) fail('not-allocated cleanup must not be a failure');
  }
}

function validateSample(sample, index, traceEnabled, browserClockId, allowContamination = false) {
  exactKeys(sample, ['index', 'inputs', 'evidence'], 'sample');
  if (sample.index !== index) fail('sample index mismatch');
  if (!Array.isArray(sample.inputs) || sample.inputs.length !== WORKLOAD_INPUTS.length)
    fail('rapid q,z,1 input window is incomplete');
  sample.inputs.forEach((input, inputIndex) => {
    exactKeys(
      input,
      ['clientId', 'seq', 'tokenHash', 'tokenLength', 'generation', 'inputIndex', 'coalescedIndex', 'coalescedCount'],
      'input'
    );
    if (!CLIENT_ID.test(input.clientId)) fail('input client identity is invalid');
    integer(input.seq, 'input sequence');
    hash(input.tokenHash, 'input token');
    integer(input.tokenLength, 'input token length', 1);
    integer(input.generation, 'input generation', 1);
    integer(input.coalescedIndex, 'input coalesced index');
    integer(input.coalescedCount, 'input coalesced count', 1);
    if (input.coalescedIndex >= input.coalescedCount) fail('input coalesced identity is invalid');
    const frozen = WORKLOAD_INPUTS[inputIndex];
    if (
      input.inputIndex !== frozen.inputIndex ||
      input.generation !== frozen.generation ||
      input.tokenHash !== frozen.tokenHash ||
      input.tokenLength !== frozen.tokenLength
    )
      fail('input does not match frozen q,z,1 workload');
  });
  if (new Set(sample.inputs.map((input) => input.clientId)).size !== 1) fail('rapid input client identity changed');
  for (let inputIndex = 1; inputIndex < sample.inputs.length; inputIndex++) {
    if (sample.inputs[inputIndex].seq < sample.inputs[inputIndex - 1].seq)
      fail('rapid input sequence is not monotonic');
  }
  exactKeys(
    sample.evidence,
    ['browserEvents', 'serverEvents', 'paneResults', 'longTaskWindow', 'resizeEvents', 'firstAcked'],
    'sample evidence'
  );
  if (!Array.isArray(sample.evidence.paneResults) || sample.evidence.paneResults.length !== sample.inputs.length)
    fail('pane result missing');
  if (sample.evidence.browserEvents[0]?.clockId !== browserClockId) fail('browser clock identity mismatch');
  return deriveSampleEvidence(sample, traceEnabled, { allowContamination });
}

export function validateRepetition(row) {
  validateCommon(row, true);
  validateCompletedCells(row, false);
  if (
    row.diagnostics.traceOverflowed ||
    row.diagnostics.processReplaced ||
    row.diagnostics.observerErrorHashes.length ||
    row.diagnostics.pageErrorHashes.length ||
    row.diagnostics.consoleErrorHashes.length ||
    row.diagnostics.serverStdoutHashes.length ||
    row.diagnostics.serverStderrHashes.length ||
    row.diagnostics.startupStageHashes.length ||
    row.diagnostics.startupNameHashes.length ||
    row.diagnostics.startupMessageHashes.length ||
    row.diagnostics.resizeEvents.length ||
    row.diagnostics.longTasks.length ||
    row.diagnostics.errorHashes.length ||
    Object.values(row.allocation).some((value) => value !== true) ||
    Object.values(row.cleanup).some((value) => value !== true)
  ) {
    fail('accepted attempt is contaminated or cleanup failed');
  }
  return row;
}

function validateCompletedCells(row, allowContamination) {
  exactArray(
    row.cells?.map((cell) => cell.rate),
    RATES,
    'cell matrix'
  );
  for (const cell of row.cells) {
    exactKeys(cell, ['rate', 'realizedCpuThrottle', 'cpuCalibration', 'samples'], 'cell');
    validateCpuCalibration(cell);
    if (!Array.isArray(cell.samples) || cell.samples.length !== SAMPLES_PER_CELL) fail('cell samples are incomplete');
    cell.samples.forEach((sample, index) =>
      validateSample(sample, index, row.config.traceEnabled, row.clock.browserClockId, allowContamination)
    );
  }
}

export function validateAttempt(row) {
  if (row?.selection?.accepted === true) return validateRepetition(row);
  const completed = row?.selection?.lifecycle === 'completed';
  validateCommon(row, false, completed);
  if (completed) validateCompletedCells(row, true);
  else if (row.selection.lifecycle === 'partial') validatePartialCells(row);
  else if (row.cells.length !== 0) fail('rejected preflight must have zero cells');
  return row;
}

function validatePartialCells(row) {
  if (!Array.isArray(row.cells) || row.cells.length > RATES.length) fail('partial cell prefix is invalid');
  row.cells.forEach((cell, cellIndex) => {
    exactKeys(cell, ['rate', 'realizedCpuThrottle', 'cpuCalibration', 'samples'], 'partial cell');
    if (cell.rate !== RATES[cellIndex]) fail('partial cell order or throttle mismatch');
    validateCpuCalibration(cell);
    if (!Array.isArray(cell.samples) || cell.samples.length > SAMPLES_PER_CELL)
      fail('partial sample prefix is invalid');
    cell.samples.forEach((sample, index) =>
      validateSample(sample, index, row.config.traceEnabled, row.clock.browserClockId, true)
    );
    if (cellIndex < row.cells.length - 1 && cell.samples.length !== SAMPLES_PER_CELL)
      fail('partial attempt skipped an unfinished earlier cell');
  });
}

function validateCpuCalibration(cell) {
  if (cell.realizedCpuThrottle !== cell.rate) fail('realized CDP throttle mismatch');
  const calibration = cell.cpuCalibration;
  exactKeys(
    calibration,
    ['baselineSamplesMs', 'throttledSamplesMs', 'baselineMedianMs', 'throttledMedianMs', 'ratio'],
    'CPU calibration'
  );
  for (const name of ['baselineSamplesMs', 'throttledSamplesMs']) {
    if (!Array.isArray(calibration[name]) || calibration[name].length !== 5)
      fail('CPU calibration samples are incomplete');
    calibration[name].forEach((value) => nonnegative(value, 'CPU calibration sample'));
  }
  const baselineMedian = median(calibration.baselineSamplesMs);
  const throttledMedian = median(calibration.throttledSamplesMs);
  const ratio = throttledMedian / baselineMedian;
  if (
    calibration.baselineMedianMs !== baselineMedian ||
    calibration.throttledMedianMs !== throttledMedian ||
    calibration.ratio !== ratio
  )
    fail('CPU calibration summary is not derived');
  const [minimum, maximum] = cell.rate === 1 ? [0.5, 1.5] : [2.5, 5.5];
  if (!Number.isFinite(ratio) || ratio < minimum || ratio > maximum)
    fail('realized CPU throttle calibration is out of bounds');
}

function requireSchedule(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > SCHEDULE.length)
    fail('attempt schedule is empty or too long');
  let stopped = false;
  for (const [index, row] of rows.entries()) {
    validateAttempt(row);
    if (row.selection.attempt !== index + 1) fail('attempt gap or duplicate in global schedule');
    const expected = SCHEDULE[index];
    if (row.phase !== expected[0] || row.config.label !== expected[1] || row.config.repetition !== expected[2]) {
      fail(`attempt ${index + 1} violates global schedule`);
    }
    if (stopped) fail('later attempt exists after rejected experiment stop');
    if (!row.selection.accepted) stopped = true;
    if (index && Date.parse(row.timing.startedAt) < Date.parse(rows[index - 1].timing.endedAt)) {
      fail('attempt schedule is not chronological');
    }
  }
  const accepted = rows.filter((row) => row.selection.accepted);
  const shared = [
    (row) => row.experimentId,
    (row) => row.provenance.harness,
    (row) => row.provenance.overlay.semanticSha256,
    (row) => row.provenance.dependencies,
    (row) => row.provenance.host,
    (row) => ({
      rates: row.config.rates,
      samplesPerCell: row.config.samplesPerCell,
      viewport: row.config.viewport,
      payloadHash: row.config.payloadHash,
      payloadLength: row.config.payloadLength,
    }),
  ];
  for (const select of shared) {
    if (new Set(rows.map((row) => stable(select(row)))).size !== 1) fail('mixed experiment provenance or workload');
  }
  for (const product of ['candidate', 'baseline']) {
    const selected = rows.filter((row) =>
      product === 'baseline' ? row.config.label === 'baseline' : row.config.label !== 'baseline'
    );
    for (const field of ['patchSha256', 'manifestSha256']) {
      if (new Set(selected.map((row) => row.provenance.overlay[field])).size > 1)
        fail(`mixed ${product} overlay ${field}`);
    }
    if (new Set(selected.map((row) => stable(row.provenance.overlay.files))).size > 1)
      fail(`mixed ${product} overlay files`);
  }
  requireFreshAndInputs(accepted);
  return rows;
}

function requireFreshAndInputs(accepted) {
  for (const field of ['runId', 'tmuxSessionHash', 'tempRootHash']) {
    const values = accepted.map((row) => row.provenance.process[field]);
    if (new Set(values).size !== values.length) fail(`fresh process identity reused: ${field}`);
  }
  for (const field of ['browserClockId', 'serverClockId', 'harnessClockId']) {
    if (new Set(accepted.map((row) => row.clock[field])).size !== accepted.length)
      fail(`fresh clock identity reused: ${field}`);
  }
  const processKeys = accepted.flatMap((row) =>
    ['server', 'browser', 'opencode'].map(
      (name) => `${name}:${row.provenance.process[name].pid}:${row.provenance.process[name].startedAt}`
    )
  );
  if (new Set(processKeys).size !== processKeys.length)
    fail('fresh server, browser, or OpenCode process identity reused');
  const inputs = accepted.flatMap((row) =>
    row.cells.flatMap((cell) =>
      cell.samples.flatMap((sample) =>
        sample.inputs.map((input) => `${input.clientId}:${input.seq}:${input.coalescedIndex}`)
      )
    )
  );
  if (new Set(inputs).size !== inputs.length) fail('duplicate global input identity');
}

function durations(rows, label, rate) {
  return rows
    .filter((row) => row.config.label === label)
    .flatMap((row) =>
      row.cells
        .find((cell) => cell.rate === rate)
        .samples.map((sample) => deriveSampleEvidence(sample, row.config.traceEnabled).totalMs)
    );
}

export function validateCalibration(rows) {
  if (!Array.isArray(rows) || rows.length !== 3) fail('calibration requires exact off/on/off attempts');
  requireSchedule(rows);
  if (rows.some((row) => !row.selection.accepted)) fail('calibration contains rejected attempt');
  const rates = RATES.map((rate) => {
    const offP95 = summaryStatistics(durations(rows, 'trace-off', rate)).p95;
    const onP95 = summaryStatistics(durations(rows, 'trace-on', rate)).p95;
    const deltaMs = onP95 - offP95;
    const deltaPercent = (deltaMs / offP95) * 100;
    return { rate, offP95, onP95, deltaMs, deltaPercent, passed: deltaMs <= 5 && deltaPercent <= 10 };
  });
  return {
    rows,
    gate: {
      passed: rates.every((entry) => entry.passed),
      failedRates: rates.filter((entry) => !entry.passed).map((entry) => entry.rate),
      rates,
    },
  };
}

export function validateDiagnosticMatrix(rows) {
  if (!Array.isArray(rows) || rows.length !== 4) fail('diagnostic requires exact ABBA attempts');
  const normalized = rows.map((row, index) => ({ ...row, selection: { ...row.selection, attempt: index + 4 } }));
  // Validate the actual attempt numbers separately; normalization only supplies the calibration prefix expected by schedule.
  if (rows.some((row, index) => row.selection.attempt !== index + 4)) fail('diagnostic attempt gap');
  rows.forEach(validateRepetition);
  exactArray(
    rows.map((row) => `${row.config.label}:${row.config.repetition}`),
    ['baseline:1', 'candidate:1', 'candidate:2', 'baseline:2'],
    'diagnostic ABBA order'
  );
  requireFreshAndInputs(rows);
  const shared = [
    (row) => row.experimentId,
    (row) => row.provenance.harness,
    (row) => row.provenance.overlay.semanticSha256,
    (row) => row.provenance.dependencies,
    (row) => row.provenance.host,
  ];
  for (const select of shared)
    if (new Set(rows.map((row) => stable(select(row)))).size !== 1) fail('mixed diagnostic provenance');
  void normalized;
  return rows;
}

function escapeReport(value) {
  return String(value).replace(/[\\`*_[\]{}()#+.!|<>]/g, '\\$&');
}

function fixed(value) {
  return Number(value.toFixed(3));
}

function attemptAuditLines(attempts) {
  return attempts.map(
    (row) =>
      `- attempt ${row.selection.attempt} ${row.phase}/${row.config.label} ${row.selection.lifecycle}: accepted ${row.selection.accepted}; failures ${row.selection.failureReasons.map((entry) => `${entry.code}:${entry.detailHash}`).join(',') || 'none'}; cells ${row.cells.length}; samples ${row.cells.reduce((count, cell) => count + cell.samples.length, 0)}; runtime vendor ${row.provenance.runtimeVendorHash ?? 'unavailable'}; load ${row.timing.loadAverageBefore.join(',')} to ${row.timing.loadAverageAfter.join(',')}; diagnostics overflow ${row.diagnostics.traceOverflowed}, observer [${row.diagnostics.observerErrorHashes.join(',')}], page [${row.diagnostics.pageErrorHashes.join(',')}], console [${row.diagnostics.consoleErrorHashes.join(',')}], server-stdout [${row.diagnostics.serverStdoutHashes.join(',')}], server-stderr [${row.diagnostics.serverStderrHashes.join(',')}], startup-stage [${row.diagnostics.startupStageHashes.join(',')}], startup-name [${row.diagnostics.startupNameHashes.join(',')}], startup-message [${row.diagnostics.startupMessageHashes.join(',')}], resize [${row.diagnostics.resizeEvents.map((entry) => entry.atMs).join(',')}], long-tasks [${row.diagnostics.longTasks.map((entry) => `${entry.startedMs}/${entry.durationMs}`).join(',')}], errors [${row.diagnostics.errorHashes.join(',')}], process-replaced ${row.diagnostics.processReplaced}; cleanup ${Object.entries(
        row.cleanup
      )
        .map(([key, value]) => `${key}=${row.allocation[key] ? (value ? 'verified' : 'failed') : 'not-allocated'}`)
        .join(',')}.`
  );
}

function sampleEvidenceLines(attempts, allowContamination) {
  const lines = [];
  for (const row of attempts) {
    for (const cell of row.cells) {
      for (const sample of cell.samples) {
        const derived = deriveSampleEvidence(sample, row.config.traceEnabled, { allowContamination });
        const correctness = derived.correctness;
        const pane = sample.evidence.paneResults.at(-1);
        lines.push(
          `- ${row.config.label} repetition ${row.config.repetition}, ${cell.rate}x, sample ${sample.index}, inputs ${derived.inputs.map((input) => `${input.tokenHash}/seq-${input.seq}`).join(',')}: total ${fixed(derived.totalMs)}ms; ${Object.entries(
            derived.segments
          )
            .map(([name, value]) => `${name} ${fixed(value)}ms`)
            .join(
              ', '
            )}; correctness browser ACKs ${correctness.browserAcks}, server applied ${correctness.serverApplied}, server writes ${correctness.serverWrites}, server ACKs ${correctness.serverAcks}, output frames ${correctness.outputFrames}, pane ${correctness.paneVisible}, xterm ${correctness.xtermVisible}; pane ${pane.status}; pane results ${derived.paneResults.map((entry) => `${entry.inputIndex}/${entry.status}/${entry.errorHash ?? 'none'}/${entry.probes}/[${entry.probeErrors.join(',')}]/probes[${entry.probeEvidence.map((probe) => `${probe.startedNs}-${probe.completedNs}/${probe.present}/${probe.durationMs}/${probe.errorHash ?? 'none'}`).join(',')}]`).join(',')}; probes ${derived.paneProbeCount}; errors ${derived.paneErrorCount}; pane interval ${derived.paneInterval.widthMs === null ? 'unavailable' : `${fixed(derived.paneInterval.widthMs)}ms`}, poll cost ${fixed(derived.paneInterval.pollCostMs)}ms; multiplicity upstream ${derived.serverMultiplicity.upstreamChunks}, connection ${derived.serverMultiplicity.connectionChunks}, flushes ${derived.serverMultiplicity.flushes}; browser events ${derived.browserEventCount}; server events ${derived.serverEventCount}; output ordinals ${derived.outputOrdinals.join(',')}; long-task window ${sample.evidence.longTaskWindow.startedMs}-${sample.evidence.longTaskWindow.endedMs}, entries ${sample.evidence.longTaskWindow.entries.map((entry) => `${entry.startedMs}/${entry.durationMs}`).join(',') || 'none'}; component-local only, cross-domain inconclusive.`
        );
      }
    }
  }
  return lines;
}

function retainedCalibrationLines(attempts) {
  return RATES.map((rate) => {
    const values = (label) =>
      attempts
        .filter((row) => row.phase === 'calibration' && row.config.label === label)
        .flatMap((row) => row.cells.filter((cell) => cell.rate === rate))
        .flatMap((cell) =>
          cell.samples.map(
            (sample) => deriveSampleEvidence(sample, label !== 'trace-off', { allowContamination: true }).totalMs
          )
        );
    const off = values('trace-off');
    const on = values('trace-on');
    if (!off.length || !on.length) return `- ${rate}x: off/on p95 unavailable; failed rate.`;
    const offP95 = summaryStatistics(off).p95;
    const onP95 = summaryStatistics(on).p95;
    const deltaMs = onP95 - offP95;
    const deltaPercent = (deltaMs / offP95) * 100;
    const passed = deltaMs <= 5 && deltaPercent <= 10;
    return `- ${rate}x: off p95 ${fixed(offP95)}ms; on p95 ${fixed(onP95)}ms; delta ${fixed(deltaMs)}ms (${fixed(deltaPercent)}%); ${passed ? 'pass' : 'failed rate'}.`;
  });
}

function invalidReport(reason, details, attempts = []) {
  return [
    '# COD-374 Mobile Input Latency Attribution',
    '',
    `Decision: **MEASUREMENT INVALID — ${escapeReport(reason)}**`,
    '',
    details,
    '',
    '## Retained tracing overhead evidence',
    '',
    ...retainedCalibrationLines(attempts),
    '',
    '## Attempt and cleanup evidence',
    '',
    ...attemptAuditLines(attempts),
    '',
    '## Complete retained sample evidence',
    '',
    ...sampleEvidenceLines(attempts, true),
    'Cross-domain attribution is INCONCLUSIVE. Selective retry is forbidden.',
    '',
  ].join('\n');
}

export function buildAttributionReport({ attempts }) {
  requireSchedule(attempts);
  const rejected = attempts.find((row) => !row.selection.accepted);
  if (rejected) {
    const reason = rejected.selection.failureReasons.map((entry) => entry.code).join(', ');
    return invalidReport('REQUIRED ATTEMPT REJECTED', `Failure reasons: ${escapeReport(reason)}.`, attempts);
  }
  if (attempts.length < 3)
    return invalidReport('INCOMPLETE CALIBRATION', 'The experiment stopped before calibration completed.', attempts);
  const calibration = validateCalibration(attempts.slice(0, 3));
  if (!calibration.gate.passed) {
    if (attempts.length > 3) fail('diagnostic attempts exist after failed tracing overhead gate');
    return invalidReport('TRACE OVERHEAD GATE FAILED', 'Diagnostic ABBA was not authorized or run.', attempts);
  }
  if (attempts.length < 7)
    return invalidReport('INCOMPLETE DIAGNOSTIC', 'The diagnostic ABBA matrix did not complete.', attempts);
  const diagnostic = validateDiagnosticMatrix(attempts.slice(3));
  requireSchedule(attempts);
  const lines = [
    '# COD-374 Mobile Input Latency Attribution',
    '',
    'Decision: **INCONCLUSIVE ACROSS CLOCK DOMAINS**',
    '',
    'All durations are component-local. Cross-domain causal attribution is always inconclusive.',
    '',
    '## Tracing overhead calibration',
    '',
    ...calibration.gate.rates.map(
      (entry) =>
        `- ${entry.rate}x: off p95 ${fixed(entry.offP95)}ms; on p95 ${fixed(entry.onP95)}ms; delta ${fixed(entry.deltaMs)}ms (${fixed(entry.deltaPercent)}%); pass.`
    ),
    '',
    '## Browser-local end-to-end summaries',
    '',
    '| Rate | Baseline median / p95 / max | Candidate median / p95 / max |',
    '| ---: | ---: | ---: |',
    ...RATES.map((rate) => {
      const baseline = summaryStatistics(durations(diagnostic, 'baseline', rate));
      const candidate = summaryStatistics(durations(diagnostic, 'candidate', rate));
      return `| ${rate}x | ${fixed(baseline.median)} / ${fixed(baseline.p95)} / ${fixed(baseline.max)}ms | ${fixed(candidate.median)} / ${fixed(candidate.p95)} / ${fixed(candidate.max)}ms |`;
    }),
    '',
    '## Complete per-sample component-local evidence',
    '',
  ];
  lines.push(...sampleEvidenceLines(attempts, false));
  lines.push('', '## Attempt and cleanup evidence', '', ...attemptAuditLines(attempts));
  lines.push('', 'No raw payload, character, pane text, xterm text, response, or filesystem path is retained.', '');
  return lines.join('\n');
}

export function measureRuntimeObservation(row, probes) {
  validateAttempt(row);
  if (row.selection.lifecycle === 'preflight') fail('runtime observation only applies to launched attempts');
  exactKeys(
    probes,
    [
      'readOpenCodeVersion',
      'readViewport',
      'readFontPx',
      'readRealizedCpuThrottle',
      'readCpuCalibration',
      'readServerProcess',
      'readBrowserProcess',
      'readOpenCodeProcess',
    ],
    'runtime probes'
  );
  if (Object.values(probes).some((probe) => typeof probe !== 'function')) fail('runtime probe is not callable');
  const actual = {
    opencodeVersionHash: createHash('sha256').update(String(probes.readOpenCodeVersion())).digest('hex').slice(0, 16),
    viewport: probes.readViewport(),
    fontPx: probes.readFontPx(),
    cells: row.cells.map((cell) => ({
      rate: cell.rate,
      realizedCpuThrottle: probes.readRealizedCpuThrottle(cell.rate),
      cpuCalibration: probes.readCpuCalibration(cell.rate),
    })),
    server: probes.readServerProcess(),
    browser: probes.readBrowserProcess(),
    opencode: probes.readOpenCodeProcess(),
  };
  const proof = Object.freeze({});
  VERIFIED_RUNTIME_OBSERVATIONS.set(proof, { signature: runtimeSignature(row), actual: JSON.parse(stable(actual)) });
  return proof;
}

export function verifyRuntimeObservation(row, proof) {
  validateAttempt(row);
  const measured = VERIFIED_RUNTIME_OBSERVATIONS.get(proof);
  if (!measured || measured.signature !== runtimeSignature(row)) fail('runtime observation proof mismatch');
  const actual = measured.actual;
  const expected = {
    opencodeVersionHash: row.provenance.host.opencodeVersionHash,
    viewport: row.config.viewport,
    fontPx: row.config.fontPx,
    cells: row.cells.map((cell) => ({
      rate: cell.rate,
      realizedCpuThrottle: cell.realizedCpuThrottle,
      cpuCalibration: cell.cpuCalibration,
    })),
    server: row.provenance.process.server,
    browser: row.provenance.process.browser,
    opencode: row.provenance.process.opencode,
  };
  if (stable(actual) !== stable(expected)) fail('runtime observation mismatch');
}

function runtimeProofFailureAttempt(repetition, cause) {
  const row = structuredClone(repetition);
  const detailHash = createHash('sha256').update(String(cause)).digest('hex').slice(0, 16);
  const stageHash = createHash('sha256').update('runtime-proof').digest('hex').slice(0, 16);
  const names = [];
  const messages = [];
  const seen = new Set();
  const visit = (error) => {
    if (!error || typeof error !== 'object' || seen.has(error) || seen.size >= 32) return;
    seen.add(error);
    names.push(
      createHash('sha256')
        .update(String(error.name ?? 'Error'))
        .digest('hex')
        .slice(0, 16)
    );
    messages.push(
      createHash('sha256')
        .update(String(error.message ?? error))
        .digest('hex')
        .slice(0, 16)
    );
    if (error instanceof AggregateError) error.errors.forEach(visit);
    visit(error.cause);
  };
  visit(cause);
  row.selection = {
    attempt: repetition.selection.attempt,
    lifecycle: 'partial',
    accepted: false,
    failureReasons: [...repetition.selection.failureReasons, { code: 'runtime-proof-failed', detailHash }].filter(
      (entry, index, entries) =>
        entries.findIndex((candidate) => canonicalJson(candidate) === canonicalJson(entry)) === index
    ),
  };
  row.diagnostics = structuredClone(repetition.diagnostics);
  row.diagnostics.errorHashes = [...new Set([...row.diagnostics.errorHashes, detailHash])];
  row.diagnostics.startupStageHashes = [...new Set([...row.diagnostics.startupStageHashes, stageHash])];
  row.diagnostics.startupNameHashes = [...new Set([...row.diagnostics.startupNameHashes, ...names])];
  row.diagnostics.startupMessageHashes = [...new Set([...row.diagnostics.startupMessageHashes, ...messages])];
  validateAttempt(row);
  return row;
}

function runtimeSignature(row) {
  return stable({
    preflight: preflightSignature(row),
    timing: row.timing,
    process: row.provenance.process,
    cells: row.cells.map((cell) => ({
      rate: cell.rate,
      realizedCpuThrottle: cell.realizedCpuThrottle,
      cpuCalibration: cell.cpuCalibration,
    })),
  });
}

function preflightSignature(row) {
  return stable({
    experimentId: row.experimentId,
    phase: row.phase,
    config: row.config,
    product: row.provenance.product,
    harness: row.provenance.harness,
    overlay: row.provenance.overlay,
    dependencies: row.provenance.dependencies,
    host: row.provenance.host,
  });
}

export async function verifyExperimentPreflight({
  repetition,
  repositoryRoot = process.cwd(),
  vendorManifestPath,
  gitVerifier = verifyRepositoryProvenance,
}) {
  hash(repetition?.experimentId, 'preflight experiment');
  if (
    !['calibration', 'diagnostic'].includes(repetition?.phase) ||
    !object(repetition?.config) ||
    !object(repetition?.provenance)
  ) {
    fail('preflight plan is invalid');
  }
  await gitVerifier([repetition], { repositoryRoot, vendorManifestPath, validateEvidence: false });
  const proof = Object.freeze({});
  VERIFIED_PREFLIGHTS.set(proof, preflightSignature(repetition));
  return proof;
}

async function defaultGit(args, repositoryRoot, input) {
  if (input !== undefined) {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn('git', args, { cwd: repositoryRoot, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout = [];
      const stderr = [];
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.once('error', rejectPromise);
      child.once('close', (code) => {
        if (code === 0) resolvePromise(Buffer.concat(stdout));
        else rejectPromise(new Error(`git ${args.join(' ')} failed: ${Buffer.concat(stderr).toString('utf8')}`));
      });
      child.stdin.end(input);
    });
  }
  const result = await execFileAsync('git', args, {
    cwd: repositoryRoot,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

export async function verifyRepositoryProvenance(
  rows,
  {
    repositoryRoot = process.cwd(),
    packageLockPath = join(repositoryRoot, 'package-lock.json'),
    vendorManifestPath,
    git = defaultGit,
    read = readFile,
    validateEvidence = true,
  } = {}
) {
  if (validateEvidence) rows.forEach(validateAttempt);
  if (!rows.length) fail('repository verification has no attempts');
  const harness = rows[0].provenance.harness;
  const runGit = (args) => git(args, repositoryRoot);
  const head = (await runGit(['rev-parse', 'HEAD'])).toString('utf8').trim();
  if (head !== harness.commit) fail('executing harness commit mismatch');
  const dirty = (await runGit(['status', '--porcelain=v1', '--untracked-files=all'])).toString('utf8');
  if (dirty.length) fail('executing harness worktree is not clean');
  const harnessTree = (await runGit(['rev-parse', `${harness.commit}^{tree}`])).toString('utf8').trim();
  if (harnessTree !== harness.tree) fail('harness tree mismatch');
  for (const product of [BASELINE_PRODUCT, CANDIDATE_PRODUCT]) {
    const tree = (await runGit(['rev-parse', `${product.sha}^{tree}`])).toString('utf8').trim();
    if (tree !== product.tree) fail('frozen product tree mismatch');
  }
  for (const file of harness.files) {
    const spec = `${harness.commit}:${file.file}`;
    const blob = (await runGit(['rev-parse', spec])).toString('utf8').trim();
    if (blob !== file.blob) fail(`harness blob mismatch: ${file.file}`);
    const contents = await runGit(['show', spec]);
    if (createHash('sha256').update(contents).digest('hex') !== file.sha256)
      fail(`harness content mismatch: ${file.file}`);
  }
  if (!vendorManifestPath) fail('vendor manifest is required');
  if (
    createHash('sha256')
      .update(await read(packageLockPath))
      .digest('hex') !== rows[0].provenance.dependencies.packageLockSha256
  ) {
    fail('dependency lock hash mismatch');
  }
  if (
    createHash('sha256')
      .update(await read(vendorManifestPath))
      .digest('hex') !== rows[0].provenance.dependencies.vendorManifestSha256
  ) {
    fail('vendor manifest hash mismatch');
  }
}

function parseStatusZ(buffer) {
  const fields = buffer.toString('utf8').split('\0').filter(Boolean);
  const files = [];
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index];
    if (entry.length < 4) fail('overlay status record is invalid');
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    files.push(file);
    if (status.includes('R') || status.includes('C')) {
      const destination = fields[++index];
      if (!destination) fail('overlay rename status is incomplete');
      files.push(destination);
    }
  }
  return files.sort();
}

export async function verifyOverlayArtifact(
  artifact,
  {
    repositoryRoot = process.cwd(),
    read = async (file, root) => readFile(root ? join(root, file) : file),
    stat = async (file, root) => lstat(root ? join(root, file) : file),
    git = defaultGit,
    createWorktree,
    cleanupWorktree,
  } = {}
) {
  const frozen =
    artifact?.product?.sha === BASELINE_PRODUCT.sha
      ? BASELINE_PRODUCT
      : artifact?.product?.sha === CANDIDATE_PRODUCT.sha
        ? CANDIDATE_PRODUCT
        : null;
  if (!frozen || artifact.product.tree !== frozen.tree) fail('overlay product is not frozen');
  exactArray(
    artifact.files?.map((entry) => entry.file),
    OVERLAY_FILES,
    'overlay materialization allowlist'
  );
  const patchPath = resolve(artifact.patchPath);
  const patch = await read(patchPath);
  if (createHash('sha256').update(patch).digest('hex') !== artifact.patchSha256) fail('overlay patch hash mismatch');
  let worktree;
  let container;
  let primaryError;
  try {
    if (createWorktree) worktree = await createWorktree();
    else {
      container = await mkdtemp(join(tmpdir(), 'cod374-overlay-'));
      worktree = join(container, 'worktree');
      await git(['worktree', 'add', '--detach', worktree, frozen.sha], repositoryRoot);
    }
    await git(['apply', '--check', '-'], worktree, patch);
    await git(['apply', '-'], worktree, patch);
    const statusBytes = await git(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
      worktree
    );
    if (
      statusBytes
        .toString('utf8')
        .split('\0')
        .some((entry) => entry.startsWith('!! '))
    )
      fail('overlay contains ignored untracked files');
    const changed = parseStatusZ(statusBytes);
    exactArray(changed, [...OVERLAY_FILES].sort(), 'overlay allowlist');
    const files = [];
    for (const expected of artifact.files) {
      const fileInfo = await stat(expected.file, worktree);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink())
        fail(`overlay result is not a regular file: ${expected.file}`);
      const mode = (fileInfo.mode & 0o111) === 0 ? '100644' : '100755';
      if (mode !== expected.mode) fail(`overlay result mode mismatch: ${expected.file}`);
      const contents = await read(expected.file, worktree);
      const sha256 = createHash('sha256').update(contents).digest('hex');
      if (sha256 !== expected.sha256) fail(`overlay result hash mismatch: ${expected.file}`);
      files.push({ file: expected.file, mode, sha256 });
    }
    const manifestSha256 = createHash('sha256')
      .update(files.map((entry) => `${entry.file}\0${entry.mode}\0${entry.sha256}\n`).join(''))
      .digest('hex');
    if (manifestSha256 !== artifact.manifestSha256) fail('overlay manifest hash mismatch');
    return { manifestSha256 };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      if (worktree && cleanupWorktree) await cleanupWorktree(worktree);
      else if (worktree && container) {
        const failures = [];
        await git(['worktree', 'remove', '--force', worktree], repositoryRoot).catch((error) => failures.push(error));
        await rm(container, { recursive: true, force: true }).catch((error) => failures.push(error));
        if (failures.length) throw new AggregateError(failures, 'overlay cleanup failed');
      }
    } catch (cleanupError) {
      if (primaryError)
        throw new AggregateError([primaryError, cleanupError], `overlay cleanup failed: ${cleanupError.message}`);
      throw cleanupError;
    }
  }
}

async function fsyncDirectory(path) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function validateExperimentRoot(experimentRoot) {
  const root = resolve(experimentRoot);
  const temporary = await realpath(tmpdir());
  const info = await lstat(root).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (!info || info.isSymbolicLink() || !info.isDirectory())
    fail('experiment root must be an existing regular directory');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) fail('experiment root owner is unsafe');
  if ((info.mode & 0o777) !== 0o700) fail('experiment root mode must be 0700');
  const resolved = await realpath(root);
  if (dirname(resolved) !== temporary || !/^cod374-[A-Za-z0-9-]{1,80}$/.test(resolved.slice(temporary.length + 1)))
    fail('experiment root must be a direct cod374-* child of the system temporary directory');
  return resolved;
}

async function publishExclusive(
  path,
  contents,
  { stagingDirectory = join(dirname(resolve(path)), '.staging'), prefix = 'report', afterLink } = {}
) {
  const target = resolve(path);
  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
  const stagingInfo = await lstat(stagingDirectory);
  if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink() || (stagingInfo.mode & 0o777) !== 0o700)
    fail('publication staging directory is unsafe');
  const temporary = join(stagingDirectory, `.${prefix}-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  let handle;
  let linked = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, target);
    linked = true;
    await fsyncDirectory(dirname(target));
    await afterLink?.();
    await unlink(temporary);
    await fsyncDirectory(stagingDirectory);
  } finally {
    await handle?.close().catch(() => {});
    if (!linked) await unlink(temporary).catch(() => {});
  }
}

async function recoverPublicationStaging(directory, target, prefix) {
  const staging = join(directory, '.staging');
  await mkdir(staging, { recursive: true, mode: 0o700 });
  for (const name of await readdir(staging)) {
    if (!new RegExp(`^\\.${prefix}-\\d+-[0-9a-f]{16}\\.tmp$`).test(name)) fail(`unknown staging artifact: ${name}`);
    const path = join(staging, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink < 1 || info.nlink > 2)
      fail(`unsafe staging artifact: ${name}`);
    if (info.nlink === 2) {
      const targetInfo = await lstat(target).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
      if (!targetInfo || targetInfo.dev !== info.dev || targetInfo.ino !== info.ino)
        fail(`staging hardlink has no owned publication target: ${name}`);
    }
    await unlink(path);
  }
  await fsyncDirectory(staging);
}

async function publishAttemptExclusive(root, name, contents, { afterStaging, afterLink } = {}) {
  await validateExperimentRoot(root);
  const staging = join(root, '.staging');
  const target = join(root, 'attempts', name);
  const temporary = join(staging, `.${name}-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  let handle;
  let linked = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await afterStaging?.();
    await validateExperimentRoot(root);
    await link(temporary, target);
    linked = true;
    await fsyncDirectory(dirname(target));
    await afterLink?.();
    await unlink(temporary);
    await fsyncDirectory(staging);
  } finally {
    await handle?.close().catch(() => {});
    if (!linked) await unlink(temporary).catch(() => {});
  }
}

async function replaceAtomic(path, contents) {
  const target = resolve(path);
  const existing = await lstat(target).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (existing?.isSymbolicLink() || (existing && !existing.isFile()) || (existing && existing.nlink !== 1)) {
    fail('ledger manifest target is special, linked, or a symlink');
  }
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    await fsyncDirectory(dirname(target));
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

function ledgerEntry(row, file, contents) {
  return {
    attempt: row.selection.attempt,
    file,
    sha256: createHash('sha256').update(contents).digest('hex'),
    startedAt: row.timing.startedAt,
    endedAt: row.timing.endedAt,
    accepted: row.selection.accepted,
    failureReasons: row.selection.failureReasons,
  };
}

function manifestFor(rows, entries) {
  return {
    schemaVersion: 1,
    experimentId: rows[0]?.experimentId ?? null,
    attempts: entries,
  };
}

export function validateExperimentLedger(manifest, rows) {
  exactKeys(manifest, ['schemaVersion', 'experimentId', 'attempts'], 'ledger manifest');
  if (manifest.schemaVersion !== 1 || !HASH16.test(manifest.experimentId ?? '') || !Array.isArray(manifest.attempts)) {
    fail('ledger manifest is invalid');
  }
  requireSchedule(rows);
  if (manifest.experimentId !== rows[0].experimentId || manifest.attempts.length !== rows.length) {
    fail('ledger omits or adds attempt evidence');
  }
  for (const [index, row] of rows.entries()) {
    const entry = manifest.attempts[index];
    exactKeys(
      entry,
      ['attempt', 'file', 'sha256', 'startedAt', 'endedAt', 'accepted', 'failureReasons'],
      'ledger entry'
    );
    const expectedFile = `attempt-${String(index + 1).padStart(4, '0')}.json`;
    const expectedSha256 = createHash('sha256').update(canonicalJson(row)).digest('hex');
    if (
      entry.attempt !== index + 1 ||
      entry.file !== expectedFile ||
      entry.sha256 !== expectedSha256 ||
      entry.startedAt !== row.timing.startedAt ||
      entry.endedAt !== row.timing.endedAt ||
      entry.accepted !== row.selection.accepted ||
      stable(entry.failureReasons) !== stable(row.selection.failureReasons)
    ) {
      fail(`ledger mismatch at attempt ${index + 1}`);
    }
  }
  return manifest.attempts;
}

async function scanAttempts(experimentRoot) {
  const attemptsDirectory = join(experimentRoot, 'attempts');
  await mkdir(attemptsDirectory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(attemptsDirectory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory() || directoryInfo.nlink < 1) {
    fail('attempt evidence directory is special or a symlink');
  }
  const names = await readdir(attemptsDirectory);
  const ordered = [...names].sort();
  for (const name of ordered) {
    if (!/^attempt-\d{4}\.json$/.test(name)) fail(`extra or invalid attempt filename: ${name}`);
  }
  const rows = [];
  const entries = [];
  for (const [index, name] of ordered.entries()) {
    const expected = `attempt-${String(index + 1).padStart(4, '0')}.json`;
    if (name !== expected) fail('attempt filename gap');
    const path = join(attemptsDirectory, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) fail('attempt evidence cannot be a symlink');
    if (!info.isFile()) fail('attempt evidence must be a regular file');
    if (info.nlink !== 1) fail('attempt evidence cannot be hardlinked');
    const contents = await readFile(path);
    let row;
    try {
      row = JSON.parse(contents.toString('utf8'));
    } catch {
      fail(`partial attempt evidence: ${name}`);
    }
    validateAttempt(row);
    if (!contents.equals(Buffer.from(canonicalJson(row)))) fail(`attempt evidence is not canonical: ${name}`);
    rows.push(row);
    entries.push(ledgerEntry(row, name, contents));
  }
  if (rows.length) requireSchedule(rows);
  return { rows, entries, attemptsDirectory };
}

async function createExclusiveRecord(path, contents, stagingDirectory, prefix, { afterLink } = {}) {
  const temporary = join(stagingDirectory, `.${prefix}-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  let handle;
  let linked = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, path);
    linked = true;
    await fsyncDirectory(dirname(path));
    await afterLink?.();
    await unlink(temporary);
    await fsyncDirectory(stagingDirectory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (linked) await unlink(path).catch(() => {});
    throw error;
  }
}

async function recoverStaging(root, { preLockOnly = false } = {}) {
  const staging = join(root, '.staging');
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const stagingInfo = await lstat(staging);
  if (stagingInfo.isSymbolicLink() || !stagingInfo.isDirectory() || (stagingInfo.mode & 0o777) !== 0o700)
    fail('experiment staging directory is unsafe');
  const attempts = join(root, 'attempts');
  for (const name of await readdir(staging)) {
    if (!/^\.(?:attempt-\d{4}\.json|lock|reclaim|inflight|finalizing|finalized)-\d+-[0-9a-f]{16}\.tmp$/.test(name))
      fail(`unknown staging artifact: ${name}`);
    if (preLockOnly && !name.startsWith('.lock-') && !name.startsWith('.reclaim-')) continue;
    const path = join(staging, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink < 1 || info.nlink > 2)
      fail(`unsafe staging artifact: ${name}`);
    const ownerPid = Number(name.match(/-(\d+)-[0-9a-f]{16}\.tmp$/)?.[1]);
    if (preLockOnly && Number.isSafeInteger(ownerPid) && ownerPid > 0) {
      let stagedOwner;
      try {
        stagedOwner = JSON.parse(await readFile(path, 'utf8'));
      } catch {
        stagedOwner = null;
      }
      const currentIdentity = await processStartIdentity(ownerPid);
      if (currentIdentity !== null) {
        if (stagedOwner === null) fail('experiment lock publication is active');
        if (stagedOwner?.pid === ownerPid && stagedOwner?.startIdentity === currentIdentity)
          fail('experiment lock publication is active');
      }
    }
    if (info.nlink === 2) {
      const candidates = [
        join(root, '.cod374-experiment.lock'),
        join(root, '.cod374-experiment.reclaim'),
        join(root, 'inflight.json'),
        join(root, 'finalizing.json'),
        join(root, 'finalized.json'),
      ];
      if (name.startsWith('.attempt-'))
        candidates.push(join(attempts, name.slice(1).replace(/-\d+-[0-9a-f]{16}\.tmp$/, '')));
      let matched = false;
      for (const candidate of candidates) {
        const candidateInfo = await lstat(candidate).catch((error) =>
          error.code === 'ENOENT' ? null : Promise.reject(error)
        );
        if (candidateInfo && candidateInfo.dev === info.dev && candidateInfo.ino === info.ino) matched = true;
      }
      if (!matched) fail(`staging hardlink has no owned publication target: ${name}`);
    }
    await unlink(path);
  }
  await fsyncDirectory(staging);
  return staging;
}

async function withExperimentLock(experimentRoot, operation, { afterLockLink, afterReclaimLink } = {}) {
  const root = await validateExperimentRoot(experimentRoot);
  const staging = join(root, '.staging');
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await recoverStaging(root, { preLockOnly: true });
  const lockPath = join(root, '.cod374-experiment.lock');
  const reclaimPath = join(root, '.cod374-experiment.reclaim');
  let lock;
  for (;;) {
    const reclaim = await lstat(reclaimPath).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (reclaim) {
      if (!reclaim.isFile() || reclaim.isSymbolicLink() || reclaim.nlink !== 1)
        fail('experiment reclaim record is unsafe');
      let record;
      try {
        record = JSON.parse(await readFile(reclaimPath, 'utf8'));
      } catch {
        if (Date.now() - reclaim.mtimeMs < 1_000) fail('experiment reclaim record is malformed and active');
      }
      const alive = record && (await processStartIdentity(record.pid)) === record.startIdentity;
      if (alive) fail('experiment lock recovery is already in progress');
      if (!record && Date.now() - reclaim.mtimeMs < 1_000) fail('experiment reclaim owner is unknown');
      await unlink(reclaimPath);
      await fsyncDirectory(root);
      continue;
    }
    try {
      await createExclusiveRecord(
        lockPath,
        canonicalJson({ pid: process.pid, startIdentity: await processStartIdentity(process.pid) }),
        staging,
        'lock',
        { afterLink: afterLockLink }
      );
      lock = await open(lockPath, 'r');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await lstat(lockPath);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('experiment lock is special or linked');
      let owner;
      let ownerContents;
      try {
        ownerContents = await readFile(lockPath, 'utf8');
        owner = JSON.parse(ownerContents);
      } catch {
        if (Date.now() - info.mtimeMs < 1_000) fail('experiment lock is malformed and active');
        owner = { pid: 0, startIdentity: '0' };
        ownerContents = await readFile(lockPath, 'utf8');
      }
      const validOwner =
        object(owner) &&
        Object.keys(owner).sort().join(',') === 'pid,startIdentity' &&
        Number.isSafeInteger(owner.pid) &&
        owner.pid > 0 &&
        typeof owner.startIdentity === 'string' &&
        DECIMAL.test(owner.startIdentity);
      if (!validOwner && Date.now() - info.mtimeMs < 1_000) fail('experiment lock owner is invalid and active');
      const actual = validOwner ? await processStartIdentity(owner.pid) : null;
      if (actual === owner.startIdentity) fail('experiment lock exists; concurrent writer');
      const reclaimRecord = canonicalJson({
        pid: process.pid,
        startIdentity: await processStartIdentity(process.pid),
        lockDev: String(info.dev),
        lockIno: String(info.ino),
        lockSha256: createHash('sha256').update(ownerContents).digest('hex'),
      });
      try {
        await createExclusiveRecord(reclaimPath, reclaimRecord, staging, 'reclaim', { afterLink: afterReclaimLink });
        const currentInfo = await lstat(lockPath);
        const currentContents = await readFile(lockPath, 'utf8');
        if (currentInfo.dev !== info.dev || currentInfo.ino !== info.ino || currentContents !== ownerContents)
          fail('experiment stale-lock identity changed during recovery');
        await unlink(lockPath);
        await unlink(reclaimPath);
        await fsyncDirectory(root);
      } catch (reclaimError) {
        await unlink(reclaimPath).catch(() => {});
        if (reclaimError.code === 'ENOENT') continue;
        if (reclaimError.code === 'EEXIST') fail('concurrent stale-lock recovery');
        throw reclaimError;
      }
    }
  }
  try {
    await validateExperimentRoot(root);
    await recoverStaging(root);
    await recoverInflight(root);
    return await operation(root);
  } finally {
    await lock.close();
    await unlink(lockPath);
    await fsyncDirectory(root);
  }
}

function reservationSignature(row) {
  return createHash('sha256')
    .update(
      canonicalJson({
        experimentId: row.experimentId,
        phase: row.phase,
        selection: { attempt: row.selection.attempt },
        config: row.config,
        provenance: {
          product: row.provenance.product,
          harness: row.provenance.harness,
          overlay: row.provenance.overlay,
          dependencies: row.provenance.dependencies,
          host: row.provenance.host,
        },
      })
    )
    .digest('hex');
}

function producerCrashAttempt(intent, endedAt = new Date().toISOString()) {
  const row = structuredClone(intent);
  row.provenance.runtimeVendorHash = null;
  const startedAt = new Date().toISOString();
  row.timing = {
    startedAt,
    endedAt: Date.parse(endedAt) > Date.parse(startedAt) ? endedAt : new Date(Date.parse(startedAt) + 1).toISOString(),
    loadAverageBefore: [0, 0, 0],
    loadAverageAfter: [0, 0, 0],
  };
  row.selection = {
    attempt: intent.selection.attempt,
    lifecycle: 'partial',
    accepted: false,
    failureReasons: [
      { code: 'producer-crash', detailHash: createHash('sha256').update('producer-crash').digest('hex').slice(0, 16) },
    ],
  };
  row.provenance.process = {
    runId: randomBytes(8).toString('hex'),
    tmuxSessionHash: null,
    tempRootHash: null,
    server: null,
    browser: null,
    opencode: null,
  };
  row.cells = [];
  row.diagnostics = {
    traceOverflowed: false,
    observerErrorHashes: [],
    pageErrorHashes: [],
    consoleErrorHashes: [],
    processReplaced: false,
    resizeEvents: [],
    longTasks: [],
    errorHashes: [createHash('sha256').update('producer-crash').digest('hex').slice(0, 16)],
    serverStdoutHashes: [],
    serverStderrHashes: [],
    startupStageHashes: [createHash('sha256').update('producer-crash').digest('hex').slice(0, 16)],
    startupNameHashes: [],
    startupMessageHashes: [],
  };
  row.cleanup = {
    browserClosed: false,
    serverStopped: false,
    tmuxRemoved: false,
    tempRootRemoved: false,
    hooksRestored: false,
    listenersDisposed: false,
  };
  validateAttempt(row);
  return row;
}

async function recoverInflight(root) {
  const path = join(root, 'inflight.json');
  const info = await lstat(path).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('inflight reservation is unsafe');
  let record;
  try {
    record = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail('inflight reservation is partial');
  }
  exactKeys(record, ['schemaVersion', 'signature', 'crashAttempt'], 'inflight reservation');
  if (record.schemaVersion !== 1 || !SHA64.test(record.signature)) fail('inflight reservation is invalid');
  validateAttempt(record.crashAttempt);
  const current = await scanAttempts(root);
  const published = current.rows[record.crashAttempt.selection.attempt - 1];
  if (published) {
    if (reservationSignature(published) !== record.signature) fail('inflight reservation conflicts with evidence');
    await unlink(path);
    await fsyncDirectory(root);
    return;
  }
  if (current.rows.some((row) => !row.selection.accepted)) fail('inflight reservation follows rejected attempt');
  requireSchedule([...current.rows, record.crashAttempt]);
  const name = `attempt-${String(record.crashAttempt.selection.attempt).padStart(4, '0')}.json`;
  await publishAttemptExclusive(root, name, canonicalJson(record.crashAttempt));
  await unlink(path);
  await fsyncDirectory(root);
}

export async function processStartIdentity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(' ');
    const start = fields[19];
    return DECIMAL.test(start ?? '') ? start : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}

async function reconcileLocked(root) {
  await validateExperimentRoot(root);
  await recoverStaging(root);
  const scanned = await scanAttempts(root);
  const manifest = manifestFor(scanned.rows, scanned.entries);
  if (scanned.rows.length) validateExperimentLedger(manifest, scanned.rows);
  await validateExperimentRoot(root);
  await replaceAtomic(join(root, 'ledger.json'), canonicalJson(manifest));
  return { manifest, rows: scanned.rows };
}

export async function reconcileExperimentLedger(experimentRoot, hooks) {
  return withExperimentLock(experimentRoot, async (root) => (await reconcileLocked(root)).manifest, hooks);
}

async function resolvedPath(path) {
  let cursor = resolve(path);
  const suffix = [];
  for (;;) {
    try {
      return join(await realpath(cursor), ...suffix.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(cursor.slice(parent.length + 1));
      cursor = parent;
    }
  }
}

async function requireExternalRoot(experimentRoot, repositoryRoot) {
  const evidence = await resolvedPath(experimentRoot);
  const repository = await resolvedPath(repositoryRoot);
  const relation = relative(repository, evidence);
  if (relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))) {
    fail('experiment evidence root must use external temporary storage');
  }
}

export async function publishExperimentAttempt({
  experimentRoot,
  repositoryRoot = process.cwd(),
  repetition,
  runtimeObservation,
  preflightProof,
  afterEvidence,
  afterLedger,
  afterStaging,
  afterLink,
}) {
  await requireExternalRoot(experimentRoot, repositoryRoot);
  return withExperimentLock(experimentRoot, async (root) => {
    const current = await reconcileLocked(root);
    return publishAttemptLocked({
      root,
      current,
      repetition,
      runtimeObservation,
      preflightProof,
      afterEvidence,
      afterLedger,
      afterStaging,
      afterLink,
    });
  });
}

export async function runExperimentProducerTransaction({
  experimentRoot,
  repositoryRoot = process.cwd(),
  intent,
  produce,
  afterReservation,
}) {
  if (typeof produce !== 'function') fail('experiment producer callback is required');
  if (!object(intent) || !object(intent.selection)) fail('experiment producer intent is required');
  await requireExternalRoot(experimentRoot, repositoryRoot);
  return withExperimentLock(experimentRoot, async (root) => {
    const current = await reconcileLocked(root);
    if (
      (await lstat(join(root, 'finalizing.json')).catch((error) =>
        error.code === 'ENOENT' ? null : Promise.reject(error)
      )) ||
      (await lstat(join(root, 'finalized.json')).catch((error) =>
        error.code === 'ENOENT' ? null : Promise.reject(error)
      ))
    )
      fail('experiment is finalized and rejects later attempts');
    if (current.rows.some((row) => !row.selection.accepted)) fail('experiment stopped after rejected attempt');
    const crashAttempt = producerCrashAttempt(intent);
    const proposed = [...current.rows, crashAttempt];
    requireSchedule(proposed);
    if (proposed.length > 3 && !validateCalibration(proposed.slice(0, 3)).gate.passed)
      fail('diagnostic cannot run after failed tracing overhead gate');
    const inflightPath = join(root, 'inflight.json');
    const signature = reservationSignature(intent);
    await createExclusiveRecord(
      inflightPath,
      canonicalJson({ schemaVersion: 1, signature, crashAttempt }),
      join(root, '.staging'),
      'inflight'
    );
    await afterReservation?.();
    let bundle;
    try {
      bundle = await produce(Object.freeze({ root, stagingDirectory: join(root, '.staging') }));
      exactKeys(bundle, ['repetition', 'runtimeObservation', 'preflightProof'], 'producer result');
      if (reservationSignature(bundle.repetition) !== signature)
        fail('producer result does not match reserved attempt');
      const manifest = await publishAttemptLocked({ root, current, ...bundle });
      await unlink(inflightPath);
      await fsyncDirectory(root);
      return manifest;
    } catch (error) {
      const name = `attempt-${String(crashAttempt.selection.attempt).padStart(4, '0')}.json`;
      const target = join(root, 'attempts', name);
      const published = await lstat(target).catch((statError) =>
        statError.code === 'ENOENT' ? null : Promise.reject(statError)
      );
      if (!published && bundle && error?.[RUNTIME_OBSERVATION_FAILURE] === true) {
        try {
          VERIFIED_RUNTIME_OBSERVATIONS.delete(bundle.runtimeObservation);
          const repetition = runtimeProofFailureAttempt(bundle.repetition, error.cause ?? error);
          const manifest = await publishAttemptLocked({
            root,
            current,
            repetition,
            runtimeObservation: undefined,
            preflightProof: bundle.preflightProof,
          });
          await unlink(inflightPath);
          await fsyncDirectory(root);
          return manifest;
        } catch {
          // Fall through to the canonical crash attempt if recovery itself cannot be proven safe.
        }
      }
      if (!published) await publishAttemptExclusive(root, name, canonicalJson(crashAttempt));
      await unlink(inflightPath);
      await fsyncDirectory(root);
      await reconcileLocked(root);
      throw error;
    }
  });
}

async function publishAttemptLocked({
  root,
  current,
  repetition,
  runtimeObservation,
  preflightProof,
  afterEvidence,
  afterLedger,
  afterStaging,
  afterLink,
}) {
  if (
    (await lstat(join(root, 'finalizing.json')).catch((error) =>
      error.code === 'ENOENT' ? null : Promise.reject(error)
    )) ||
    (await lstat(join(root, 'finalized.json')).catch((error) =>
      error.code === 'ENOENT' ? null : Promise.reject(error)
    ))
  )
    fail('experiment is finalized and rejects later attempts');
  validateAttempt(repetition);
  if (repetition.selection.lifecycle !== 'preflight') {
    if (!preflightProof || !VERIFIED_PREFLIGHTS.has(preflightProof))
      fail('launched attempt requires clean repository preflight proof');
    if (VERIFIED_PREFLIGHTS.get(preflightProof) !== preflightSignature(repetition))
      fail('preflight proof provenance mismatch');
    if (!runtimeObservation) {
      if (repetition.selection.lifecycle !== 'partial' || repetition.selection.accepted)
        fail('launched attempt requires measured runtime observation proof');
    } else {
      try {
        verifyRuntimeObservation(repetition, runtimeObservation);
      } catch (cause) {
        const error = new Error('COD-374 runtime observation verification failed', { cause });
        error[RUNTIME_OBSERVATION_FAILURE] = true;
        throw error;
      }
      VERIFIED_RUNTIME_OBSERVATIONS.delete(runtimeObservation);
    }
  } else if (runtimeObservation !== undefined) fail('rejected preflight cannot claim complete runtime observation');
  if (preflightProof) VERIFIED_PREFLIGHTS.delete(preflightProof);
  if (current.rows.some((row) => !row.selection.accepted)) fail('experiment stopped after rejected attempt');
  const proposed = [...current.rows, repetition];
  requireSchedule(proposed);
  if (proposed.length > 3 && !validateCalibration(proposed.slice(0, 3)).gate.passed) {
    fail('diagnostic cannot run after failed tracing overhead gate');
  }
  const name = `attempt-${String(repetition.selection.attempt).padStart(4, '0')}.json`;
  await publishAttemptExclusive(root, name, canonicalJson(repetition), { afterStaging, afterLink });
  await afterEvidence?.();
  const manifest = (await reconcileLocked(root)).manifest;
  await afterLedger?.();
  return manifest;
}

export async function publishAttributionReport(outputPath, report, { afterLink } = {}) {
  if (typeof report !== 'string' || !report.length) fail('report is empty');
  const target = resolve(outputPath);
  await recoverPublicationStaging(dirname(target), target, 'report');
  const contents = report.endsWith('\n') ? report : `${report}\n`;
  const existing = await readPublishedRegular(target);
  if (existing !== null) {
    if (existing !== contents) fail('stale report prefix mismatch');
    return;
  }
  await publishExclusive(target, contents, { prefix: 'report', afterLink });
}

export async function summarizeExperiment({
  experimentRoot,
  outputPath,
  outputDirectory,
  repositoryRoot = process.cwd(),
  vendorManifestPath,
  candidateOverlayPath,
  baselineOverlayPath,
  gitVerifier = verifyRepositoryProvenance,
  overlayVerifier = verifyOverlayArtifact,
  afterReportLink,
  afterFinalizingLink,
  afterFinalizedLink,
}) {
  await requireExternalRoot(experimentRoot, repositoryRoot);
  if (!outputDirectory || resolve(outputDirectory) !== dirname(resolve(outputPath)))
    fail('explicit evidence output directory must contain the report');
  const outputRoot = await validateOutputDirectory(outputDirectory, experimentRoot);
  return withExperimentLock(experimentRoot, async (root) => {
    await recoverPublicationStaging(outputRoot, resolve(outputPath), 'report');
    const { manifest, rows } = await reconcileLocked(root);
    validateExperimentLedger(manifest, rows);
    const report = buildAttributionReport({ attempts: rows });
    const rejectedPreflight = rows.some((row) => !row.selection.accepted && row.selection.lifecycle === 'preflight');
    if (!rejectedPreflight) {
      await gitVerifier(rows, { repositoryRoot, vendorManifestPath });
      const candidate = rows.find((row) => row.config.label !== 'baseline');
      if (!candidateOverlayPath) fail('candidate overlay patch path is required');
      await overlayVerifier(
        {
          product: candidate.provenance.product,
          patchPath: resolve(candidateOverlayPath),
          patchSha256: candidate.provenance.overlay.patchSha256,
          files: candidate.provenance.overlay.files,
          manifestSha256: candidate.provenance.overlay.manifestSha256,
        },
        { repositoryRoot }
      );
      const baseline = rows.find((row) => row.selection.accepted && row.config.label === 'baseline');
      if (baseline) {
        if (!baselineOverlayPath) fail('baseline overlay patch path is required');
        await overlayVerifier(
          {
            product: baseline.provenance.product,
            patchPath: resolve(baselineOverlayPath),
            patchSha256: baseline.provenance.overlay.patchSha256,
            files: baseline.provenance.overlay.files,
            manifestSha256: baseline.provenance.overlay.manifestSha256,
          },
          { repositoryRoot }
        );
      }
    }
    const finalReport = report.endsWith('\n') ? report : `${report}\n`;
    const finalization = canonicalJson({
      schemaVersion: 1,
      experimentId: rows[0].experimentId,
      outputRootHash: createHash('sha256').update(outputRoot).digest('hex'),
      reportName: resolve(outputPath).slice(outputRoot.length + 1),
      reportSha256: createHash('sha256').update(finalReport).digest('hex'),
      ledgerSha256: createHash('sha256').update(canonicalJson(manifest)).digest('hex'),
    });
    const finalizingPath = join(root, 'finalizing.json');
    const finalizedPath = join(root, 'finalized.json');
    const existingFinalized = await readPublishedRegular(finalizedPath);
    if (existingFinalized !== null && existingFinalized !== finalization) fail('finalized marker mismatch');
    const existingFinalizing = await readPublishedRegular(finalizingPath);
    if (existingFinalizing !== null && existingFinalizing !== finalization) fail('stale finalization prefix mismatch');
    if (existingFinalizing === null)
      await publishExclusive(finalizingPath, finalization, {
        stagingDirectory: join(root, '.staging'),
        prefix: 'finalizing',
        afterLink: afterFinalizingLink,
      });
    const existingReport = await readPublishedRegular(outputPath);
    if (existingReport !== null && existingReport !== finalReport) fail('stale report prefix mismatch');
    if (existingReport === null)
      await publishAttributionReport(outputPath, finalReport, { afterLink: afterReportLink });
    if (existingFinalized === null)
      await publishExclusive(finalizedPath, finalization, {
        stagingDirectory: join(root, '.staging'),
        prefix: 'finalized',
        afterLink: afterFinalizedLink,
      });
    await unlink(finalizingPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await fsyncDirectory(root);
    return report;
  });
}

async function readPublishedRegular(path) {
  const info = await lstat(path).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (info === null) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('published evidence path is special or linked');
  return readFile(path, 'utf8');
}

async function validateOutputDirectory(outputDirectory, experimentRoot) {
  const output = resolve(outputDirectory);
  const info = await lstat(output);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700)
    fail('evidence output directory is unsafe');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) fail('evidence output owner is unsafe');
  const real = await realpath(output);
  const temporary = await realpath(tmpdir());
  if (dirname(real) !== temporary || !/^cod374-output-[A-Za-z0-9-]{1,80}$/.test(real.slice(temporary.length + 1)))
    fail('evidence output directory must be an explicit cod374-output-* temporary directory');
  if (real === (await realpath(experimentRoot))) fail('evidence output collides with experiment paths');
  return real;
}

function parseCli(argv) {
  if (argv.some((entry) => /[*?\[\]]/.test(entry))) fail('glob input is forbidden');
  if (
    argv.length !== 14 ||
    argv[0] !== '--experiment-root' ||
    argv[2] !== '--output-directory' ||
    argv[4] !== '--output' ||
    argv[6] !== '--vendor-manifest' ||
    argv[8] !== '--candidate-overlay' ||
    argv[10] !== '--baseline-overlay' ||
    argv[12] !== '--repository-root'
  ) {
    fail(
      'usage: cod-374-summarize.mjs --experiment-root ROOT --output-directory DIR --output REPORT --vendor-manifest FILE --candidate-overlay PATCH --baseline-overlay PATCH --repository-root REPO'
    );
  }
  return {
    experimentRoot: argv[1],
    outputDirectory: argv[3],
    outputPath: argv[5],
    vendorManifestPath: argv[7],
    candidateOverlayPath: argv[9],
    baselineOverlayPath: argv[11],
    repositoryRoot: argv[13],
  };
}

async function main() {
  await summarizeExperiment(parseCli(process.argv.slice(2)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
