import { createHash } from 'node:crypto';
import { lstat, open, opendir, readlink, realpath } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';

export const HOST_SAMPLE_COUNT = 11;
export const HOST_SAMPLE_INTERVAL_MS = 500;
export const HOST_MIN_WINDOW_MS = 5_000;
export const HOST_MIN_IDLE_PERCENT = 80;
export const HOST_MAX_LOAD_PER_CPU = 0.5;
export const BROWSER_TICK_COUNT = 50;
export const BROWSER_TIMER_INTERVAL_MS = 20;
export const BROWSER_MAX_P95_DRIFT_MS = 10;
export const BROWSER_MAX_DRIFT_MS = 25;

const MAX_ALLOWED_ANCESTORS = 32;
const MAX_CONFLICT_RECORDS = 32;
const MAX_PROC_ENTRIES = 4_096;
const MAX_CURRENT_UID_PROCESSES = 512;
const MAX_TOTAL_COMMAND_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTIC_HASHES = 32;
const HASH16 = /^[0-9a-f]{16}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;
const HOST_KEYS = [
  'cpuCount',
  'sampleCount',
  'sampleIntervalMs',
  'startedAtMs',
  'endedAtMs',
  'sampleTimesMs',
  'idlePercent',
  'firstLoad1',
  'finalLoad1',
  'processes',
  'measurementErrorHash',
  'passed',
];
const PROCESS_KEYS = ['classification', 'commandHash', 'startIdentity', 'allowedAncestor'];
const BROWSER_KEYS = [
  'tickCount',
  'timerIntervalMs',
  'driftsMs',
  'p95DriftMs',
  'maxDriftMs',
  'longTaskDurationsMs',
  'pageErrorHashes',
  'consoleErrorHashes',
  'resizeCount',
  'overflowed',
  'measurementErrorHash',
  'passed',
];
const PROCESS_CLASSIFICATIONS = new Set([
  'allowed-ancestor',
  'vitest',
  'playwright-runner',
  'cod-374-runner',
  'disposable-runtime',
  'associated-chromium',
  'ancestor-pid-reused',
  'disappeared',
]);

function invalid(message = 'evidence') {
  throw new Error(`COD-374 quiescence invalid: ${message}`);
}

function hash16(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

class HostNotQuiescentError extends Error {
  constructor(evidence) {
    super('COD-374 host is not quiescent');
    this.name = 'HostNotQuiescentError';
    this.evidence = evidence;
  }
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid(label);
}

function finiteNumber(value, label, { integer = false, minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isInteger(value))
  ) {
    invalid(label);
  }
  return value;
}

function safeHash(value, label, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !HASH16.test(value)) invalid(label);
}

export function parseAggregateCpuStat(value) {
  if (typeof value !== 'string' || value.length > 64 * 1024) invalid('CPU counters');
  const line = value.split(/\r?\n/, 1)[0];
  const fields = line.trim().split(/\s+/);
  if (fields[0] !== 'cpu' || fields.length < 9) invalid('CPU counters');
  const allCounters = fields.slice(1).map((field) => {
    if (!/^[0-9]+$/.test(field)) invalid('CPU counters');
    return BigInt(field);
  });
  const counters = allCounters.slice(0, 8);
  const idle = counters[3] + counters[4];
  const total = counters.reduce((sum, counter) => sum + counter, 0n);
  return { idle, total };
}

export function calculateCpuIdlePercent(first, last) {
  if (
    first === null ||
    last === null ||
    typeof first !== 'object' ||
    typeof last !== 'object' ||
    typeof first.idle !== 'bigint' ||
    typeof first.total !== 'bigint' ||
    typeof last.idle !== 'bigint' ||
    typeof last.total !== 'bigint'
  ) {
    invalid('CPU counters');
  }
  const idleDelta = last.idle - first.idle;
  const totalDelta = last.total - first.total;
  if (idleDelta < 0n || totalDelta <= 0n || idleDelta > totalDelta) invalid('CPU counters');
  return Number((idleDelta * 100_000n) / totalDelta) / 1_000;
}

function processIdentityText(processRecord) {
  if (processRecord.cwd === undefined && processRecord.exe === undefined) return processRecord.command;
  return [processRecord.command, processRecord.cwd ?? '', processRecord.exe ?? ''].join('\0');
}

function processObservationHash(processRecord) {
  if (processRecord.cwd === undefined && processRecord.exe === undefined) return hash16(processRecord.command);
  return hash16(processIdentityText(processRecord));
}

function processClassification(processRecord) {
  const normalized = processIdentityText(processRecord).toLowerCase();
  if (/(?:^|[\s/])vitest(?:[\s/.]|$)/.test(normalized)) return 'vitest';
  if (/(?:^|[\s/@])playwright(?:[\s/.]|$)/.test(normalized) && /(?:^|\s)test(?:[\s/]|$)/.test(normalized)) {
    return 'playwright-runner';
  }
  if (/cod-374-(?:runner|summarize|quiescence)(?:\.mjs)?/.test(normalized)) return 'cod-374-runner';
  if (/^(?:\S*\/)?tmux\s+-L\s+cod(?:370|374)-opencode-[0-9]+-[0-9a-z]+(?:\s|$)/.test(processRecord.command)) {
    return 'disposable-runtime';
  }
  if (
    /(?:^|[\s\0])\/tmp\/cod-?(?:370|374)[a-z0-9._/-]*(?:[\s\0]|$)/.test(normalized) ||
    /cod-?(?:370|374)[a-z0-9._-]*(?:runtime|overlay|worktree|socket|tmux|root)/.test(normalized)
  ) {
    return 'disposable-runtime';
  }
  return null;
}

function validRawProcess(processRecord) {
  if (
    processRecord === null ||
    typeof processRecord !== 'object' ||
    !Number.isInteger(processRecord.pid) ||
    processRecord.pid <= 0 ||
    !Number.isInteger(processRecord.ppid) ||
    processRecord.ppid < 0 ||
    !Number.isInteger(processRecord.uid) ||
    processRecord.uid < 0 ||
    typeof processRecord.startIdentity !== 'string' ||
    !DECIMAL.test(processRecord.startIdentity) ||
    typeof processRecord.command !== 'string' ||
    processRecord.command.length === 0 ||
    processRecord.command.length > 32 * 1024
  ) {
    invalid('process inventory');
  }
  for (const field of ['cwd', 'exe']) {
    if (
      processRecord[field] !== undefined &&
      (typeof processRecord[field] !== 'string' ||
        processRecord[field].length === 0 ||
        processRecord[field].length > 4_096)
    ) {
      invalid('process inventory');
    }
  }
  if (processRecord.disappeared !== undefined && processRecord.disappeared !== true) invalid('process inventory');
}

export function classifyHostProcesses({ currentPid, ancestorPids, processes }) {
  if (!Number.isInteger(currentPid) || currentPid <= 0 || !Array.isArray(ancestorPids) || !Array.isArray(processes)) {
    invalid('process inventory');
  }
  if (ancestorPids.length === 0 || ancestorPids.length > MAX_ALLOWED_ANCESTORS) invalid('process inventory');
  const allowed = new Map();
  for (const ancestor of ancestorPids) {
    exactKeys(ancestor, ['pid', 'startIdentity'], 'ancestor identity');
    if (
      !Number.isInteger(ancestor.pid) ||
      ancestor.pid <= 0 ||
      typeof ancestor.startIdentity !== 'string' ||
      !DECIMAL.test(ancestor.startIdentity) ||
      allowed.has(ancestor.pid)
    ) {
      invalid('process inventory');
    }
    allowed.set(ancestor.pid, ancestor.startIdentity);
  }
  if (!allowed.has(currentPid)) {
    invalid('process inventory');
  }
  if (processes.length > MAX_CURRENT_UID_PROCESSES) invalid('process inventory work bound');
  for (const processRecord of processes) validRawProcess(processRecord);
  if (
    processes.reduce((total, processRecord) => total + Buffer.byteLength(processIdentityText(processRecord)), 0) >
    MAX_TOTAL_COMMAND_BYTES
  ) {
    invalid('process inventory work bound');
  }

  const classifications = processes.map((processRecord) => {
    if (processRecord.disappeared === true) return 'disappeared';
    if (allowed.get(processRecord.pid) === processRecord.startIdentity) {
      return 'allowed-ancestor';
    }
    if (allowed.has(processRecord.pid)) return 'ancestor-pid-reused';
    return processClassification(processRecord);
  });
  const indexesByPid = new Map();
  for (const [index, processRecord] of processes.entries()) {
    const indexes = indexesByPid.get(processRecord.pid) ?? [];
    indexes.push(index);
    indexesByPid.set(processRecord.pid, indexes);
  }
  for (const [index, processRecord] of processes.entries()) {
    if (
      classifications[index] !== null ||
      !/(?:^|[\s/])(?:google-chrome|chrome|chromium)(?:[\s/-]|$)/i.test(processRecord.command)
    ) {
      continue;
    }
    const seen = new Set([processRecord.pid]);
    let parentPids = [processRecord.ppid];
    while (parentPids.length > 0) {
      const currentParentPids = parentPids.filter((pid) => pid > 0 && !seen.has(pid));
      parentPids = [];
      for (const pid of currentParentPids) seen.add(pid);
      const parentIndexes = currentParentPids.flatMap((pid) => indexesByPid.get(pid) ?? []);
      const parentClassifications = parentIndexes
        .map((candidateIndex) => classifications[candidateIndex])
        .filter(Boolean);
      if (parentClassifications.some((classification) => classification !== 'allowed-ancestor')) {
        classifications[index] = 'associated-chromium';
        break;
      }
      if (parentClassifications.includes('allowed-ancestor')) break;
      parentPids.push(...parentIndexes.map((candidateIndex) => processes[candidateIndex].ppid));
    }
  }

  const retained = processes
    .map((processRecord, index) => ({ processRecord, classification: classifications[index] }))
    .filter(({ classification }) => classification !== null)
    .map(({ processRecord, classification }) => ({
      classification,
      commandHash: processObservationHash(processRecord),
      startIdentity: processRecord.startIdentity,
      allowedAncestor: classification === 'allowed-ancestor',
    }))
    .filter(
      (record, index, records) =>
        records.findIndex(
          (candidate) =>
            candidate.classification === record.classification &&
            candidate.commandHash === record.commandHash &&
            candidate.startIdentity === record.startIdentity &&
            candidate.allowedAncestor === record.allowedAncestor
        ) === index
    );
  const conflictCount = retained.filter((record) => !record.allowedAncestor).length;
  const ancestorCount = retained.length - conflictCount;
  if (conflictCount > MAX_CONFLICT_RECORDS || ancestorCount > MAX_ALLOWED_ANCESTORS) {
    invalid('process inventory cardinality');
  }
  return retained;
}

function validateProcessRecords(processes) {
  if (!Array.isArray(processes) || processes.length > MAX_CONFLICT_RECORDS + MAX_ALLOWED_ANCESTORS) {
    invalid('process inventory');
  }
  for (const processRecord of processes) {
    exactKeys(processRecord, PROCESS_KEYS, 'process record');
    if (!PROCESS_CLASSIFICATIONS.has(processRecord.classification)) invalid('process classification');
    safeHash(processRecord.commandHash, 'process command hash');
    if (typeof processRecord.startIdentity !== 'string' || !DECIMAL.test(processRecord.startIdentity)) {
      invalid('process start identity');
    }
    if (typeof processRecord.allowedAncestor !== 'boolean') invalid('process ancestor flag');
    if ((processRecord.classification === 'allowed-ancestor') !== processRecord.allowedAncestor) {
      invalid('process ancestor classification');
    }
  }
  if (
    processes.filter((record) => record.allowedAncestor).length > MAX_ALLOWED_ANCESTORS ||
    processes.filter((record) => !record.allowedAncestor).length > MAX_CONFLICT_RECORDS
  ) {
    invalid('process inventory cardinality');
  }
}

function mergeClassifiedProcessRecords(...boundaries) {
  const merged = boundaries
    .flat()
    .filter(
      (record, index, records) =>
        records.findIndex(
          (candidate) =>
            candidate.classification === record.classification &&
            candidate.commandHash === record.commandHash &&
            candidate.startIdentity === record.startIdentity &&
            candidate.allowedAncestor === record.allowedAncestor
        ) === index
    );
  validateProcessRecords(merged);
  return merged;
}

function normalizeHostQuiescence(evidence) {
  exactKeys(evidence, HOST_KEYS, 'host evidence');
  finiteNumber(evidence.cpuCount, 'CPU count', { integer: true, minimum: 1, maximum: 4_096 });
  finiteNumber(evidence.sampleCount, 'sample count', { integer: true, maximum: HOST_SAMPLE_COUNT });
  finiteNumber(evidence.sampleIntervalMs, 'sample interval', { integer: true, maximum: 60_000 });
  finiteNumber(evidence.startedAtMs, 'start time');
  finiteNumber(evidence.endedAtMs, 'end time');
  if (!Array.isArray(evidence.sampleTimesMs) || evidence.sampleTimesMs.length !== evidence.sampleCount) {
    invalid('sample timing');
  }
  for (const sampleTime of evidence.sampleTimesMs) finiteNumber(sampleTime, 'sample timing');
  finiteNumber(evidence.idlePercent, 'idle percent', { maximum: 100 });
  finiteNumber(evidence.firstLoad1, 'first load', { maximum: 1_000_000 });
  finiteNumber(evidence.finalLoad1, 'final load', { maximum: 1_000_000 });
  validateProcessRecords(evidence.processes);
  safeHash(evidence.measurementErrorHash, 'measurement error hash', true);
  if (typeof evidence.passed !== 'boolean') invalid('host pass flag');

  if (evidence.measurementErrorHash !== null) {
    return { normalized: { ...evidence, passed: false }, quiescent: false };
  }
  const validTiming =
    evidence.sampleTimesMs.length === HOST_SAMPLE_COUNT &&
    evidence.sampleTimesMs[0] === evidence.startedAtMs &&
    evidence.sampleTimesMs.at(-1) === evidence.endedAtMs &&
    evidence.sampleTimesMs.every(
      (sampleTime, index) => index === 0 || sampleTime - evidence.sampleTimesMs[index - 1] >= HOST_SAMPLE_INTERVAL_MS
    );
  const conflict = evidence.processes.some((record) => !record.allowedAncestor);
  const quiescent =
    evidence.sampleCount === HOST_SAMPLE_COUNT &&
    evidence.sampleIntervalMs === HOST_SAMPLE_INTERVAL_MS &&
    evidence.endedAtMs - evidence.startedAtMs >= HOST_MIN_WINDOW_MS &&
    validTiming &&
    evidence.idlePercent >= HOST_MIN_IDLE_PERCENT &&
    evidence.firstLoad1 <= evidence.cpuCount * HOST_MAX_LOAD_PER_CPU &&
    evidence.finalLoad1 <= evidence.cpuCount * HOST_MAX_LOAD_PER_CPU &&
    !conflict;
  return { normalized: { ...evidence, passed: quiescent }, quiescent };
}

export function validatePersistedHostQuiescence(evidence) {
  const { normalized } = normalizeHostQuiescence(evidence);
  if (evidence.passed !== normalized.passed) invalid('host pass assertion');
  return evidence;
}

export function validateHostQuiescence(evidence) {
  const { normalized, quiescent } = normalizeHostQuiescence(evidence);
  if (normalized.measurementErrorHash !== null) return normalized;
  if (!quiescent) {
    throw new HostNotQuiescentError(normalized);
  }
  return normalized;
}

export function nearestRankPercentile(values, percentile) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    !Number.isInteger(percentile) ||
    percentile < 1 ||
    percentile > 100
  ) {
    invalid('percentile');
  }
  const sorted = values
    .map((value) => finiteNumber(value, 'percentile value', { maximum: 60_000 }))
    .sort((a, b) => a - b);
  return sorted[Math.ceil((percentile / 100) * sorted.length) - 1];
}

function validateHashArray(values, label) {
  if (!Array.isArray(values) || values.length > MAX_DIAGNOSTIC_HASHES) invalid(label);
  for (const value of values) safeHash(value, label);
}

export function validateBrowserQuiescence(evidence) {
  exactKeys(evidence, BROWSER_KEYS, 'browser evidence');
  finiteNumber(evidence.tickCount, 'browser tick count', { integer: true, maximum: BROWSER_TICK_COUNT });
  finiteNumber(evidence.timerIntervalMs, 'browser timer interval', { integer: true, maximum: 60_000 });
  safeHash(evidence.measurementErrorHash, 'browser measurement error hash', true);
  if (!Array.isArray(evidence.driftsMs)) invalid('browser tick cardinality');
  if (evidence.driftsMs.length !== evidence.tickCount) invalid('browser tick cardinality');
  for (const drift of evidence.driftsMs) finiteNumber(drift, 'browser drift', { maximum: 60_000 });
  finiteNumber(evidence.p95DriftMs, 'browser p95 drift', { maximum: 60_000 });
  finiteNumber(evidence.maxDriftMs, 'browser maximum drift', { maximum: 60_000 });
  if (!Array.isArray(evidence.longTaskDurationsMs) || evidence.longTaskDurationsMs.length > MAX_DIAGNOSTIC_HASHES) {
    invalid('browser long tasks');
  }
  for (const duration of evidence.longTaskDurationsMs) finiteNumber(duration, 'browser long task', { maximum: 60_000 });
  validateHashArray(evidence.pageErrorHashes, 'browser page error hash');
  validateHashArray(evidence.consoleErrorHashes, 'browser console error hash');
  finiteNumber(evidence.resizeCount, 'browser resize count', { integer: true, maximum: 1_000 });
  if (typeof evidence.overflowed !== 'boolean' || typeof evidence.passed !== 'boolean') invalid('browser flags');

  const calculatedP95 = evidence.driftsMs.length === 0 ? 0 : nearestRankPercentile(evidence.driftsMs, 95);
  const calculatedMax = evidence.driftsMs.length === 0 ? 0 : Math.max(...evidence.driftsMs);
  if (evidence.p95DriftMs !== calculatedP95 || evidence.maxDriftMs !== calculatedMax) invalid('browser drift summary');
  if (evidence.measurementErrorHash !== null) {
    if (evidence.passed) invalid('browser pass flag');
    return evidence;
  }
  if (evidence.driftsMs.length !== BROWSER_TICK_COUNT) {
    throw new Error('COD-374 browser is not quiescent: tick cardinality');
  }
  const quiescent =
    evidence.tickCount === BROWSER_TICK_COUNT &&
    evidence.timerIntervalMs === BROWSER_TIMER_INTERVAL_MS &&
    calculatedP95 <= BROWSER_MAX_P95_DRIFT_MS &&
    calculatedMax <= BROWSER_MAX_DRIFT_MS &&
    evidence.longTaskDurationsMs.length === 0 &&
    evidence.pageErrorHashes.length === 0 &&
    evidence.consoleErrorHashes.length === 0 &&
    evidence.resizeCount === 0 &&
    !evidence.overflowed;
  if (evidence.passed !== quiescent) invalid('browser pass assertion');
  if (!quiescent) throw new Error('COD-374 browser is not quiescent');
  return evidence;
}

export async function readBoundedProcFile(path, { maxBytes = 64 * 1024, encoding = null, openFile = open } = {}) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4_096) invalid('bounded proc read');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 || typeof openFile !== 'function') {
    invalid('bounded proc read');
  }
  if (encoding !== null && encoding !== 'utf8') invalid('bounded proc read');
  const handle = await openFile(path, 'r');
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  try {
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, null);
      if (
        result === null ||
        typeof result !== 'object' ||
        !Number.isInteger(result.bytesRead) ||
        result.bytesRead < 0
      ) {
        invalid('bounded proc read');
      }
      if (result.bytesRead === 0) break;
      if (result.bytesRead > buffer.length - offset) invalid('bounded proc read');
      offset += result.bytesRead;
    }
    if (offset > maxBytes) invalid('bounded proc read');
    const bounded = buffer.subarray(0, offset);
    return encoding === 'utf8' ? bounded.toString('utf8') : bounded;
  } finally {
    await handle.close();
  }
}

function parseProcessStat(value) {
  if (typeof value !== 'string' || value.length > 64 * 1024) invalid('process stat');
  const open = value.indexOf(' (');
  const close = value.lastIndexOf(')');
  if (open < 1 || close <= open || !/^[1-9][0-9]*$/.test(value.slice(0, open))) invalid('process stat');
  const suffix = value
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  if (suffix.length < 20 || !/^[0-9]+$/.test(suffix[1]) || !DECIMAL.test(suffix[19])) invalid('process stat');
  return { pid: Number(value.slice(0, open)), ppid: Number(suffix[1]), startIdentity: suffix[19] };
}

export async function readStableProcessRecord(
  pid,
  uid,
  { readProcFile = readBoundedProcFile, lstatPath = lstat, readLinkPath = readlink, realpathPath = realpath } = {}
) {
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(uid) || uid < 0) invalid('process inventory');
  const base = `/proc/${pid}`;
  const firstMetadata = await lstatPath(base);
  if (firstMetadata.uid !== uid) return null;
  const first = parseProcessStat(await readProcFile(`${base}/stat`, { maxBytes: 4_096, encoding: 'utf8' }));
  const firstCmdline = await readProcFile(`${base}/cmdline`, { maxBytes: 32 * 1024 });
  const readPathSnapshot = async (name) => {
    const path = `${base}/${name}`;
    const metadata = await lstatPath(path);
    const [link, resolved] = await Promise.all([readLinkPath(path), realpathPath(path)]);
    if (
      metadata.uid !== uid ||
      typeof link !== 'string' ||
      link.length === 0 ||
      link.length > 4_096 ||
      typeof resolved !== 'string' ||
      resolved.length === 0 ||
      resolved.length > 4_096
    ) {
      invalid('unstable process identity');
    }
    return { uid: metadata.uid, dev: metadata.dev, ino: metadata.ino, link, resolved };
  };
  const firstPaths = { cwd: await readPathSnapshot('cwd'), exe: await readPathSnapshot('exe') };
  const middle = parseProcessStat(await readProcFile(`${base}/stat`, { maxBytes: 4_096, encoding: 'utf8' }));
  const lastCmdline = await readProcFile(`${base}/cmdline`, { maxBytes: 32 * 1024 });
  const lastPaths = { cwd: await readPathSnapshot('cwd'), exe: await readPathSnapshot('exe') };
  const last = parseProcessStat(await readProcFile(`${base}/stat`, { maxBytes: 4_096, encoding: 'utf8' }));
  const finalMetadata = await lstatPath(base);
  const samePath = (left, right) =>
    left.uid === right.uid &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.link === right.link &&
    left.resolved === right.resolved;
  if (
    !Buffer.isBuffer(firstCmdline) ||
    !Buffer.isBuffer(lastCmdline) ||
    !firstCmdline.equals(lastCmdline) ||
    !samePath(firstPaths.cwd, lastPaths.cwd) ||
    !samePath(firstPaths.exe, lastPaths.exe) ||
    finalMetadata.uid !== uid ||
    finalMetadata.dev !== firstMetadata.dev ||
    finalMetadata.ino !== firstMetadata.ino ||
    first.pid !== pid ||
    middle.pid !== pid ||
    last.pid !== pid ||
    first.ppid !== middle.ppid ||
    first.ppid !== last.ppid ||
    first.startIdentity !== middle.startIdentity ||
    first.startIdentity !== last.startIdentity
  ) {
    invalid('unstable process identity');
  }
  const command = firstCmdline.toString('utf8').replaceAll('\0', ' ').trim();
  if (!command) invalid('process command');
  return {
    pid,
    ppid: first.ppid,
    uid,
    startIdentity: first.startIdentity,
    command,
    cwd: firstPaths.cwd.resolved,
    exe: firstPaths.exe.resolved,
  };
}

export async function collectCurrentUidProcesses(
  uid,
  { listProcEntries = listBoundedProcEntries, readProcess = readStableProcessRecord } = {}
) {
  if (!Number.isInteger(uid) || uid < 0 || typeof listProcEntries !== 'function' || typeof readProcess !== 'function') {
    invalid('process inventory');
  }
  const names = await listProcEntries();
  if (!Array.isArray(names) || names.length > MAX_PROC_ENTRIES) invalid('process inventory work bound');
  const pidNames = names.filter((name) => typeof name === 'string' && /^[1-9][0-9]*$/.test(name));
  if (pidNames.length > MAX_PROC_ENTRIES || new Set(pidNames).size !== pidNames.length) {
    invalid('process inventory work bound');
  }
  const processes = [];
  let commandBytes = 0;
  for (const name of pidNames) {
    const pid = Number(name);
    let processRecord;
    try {
      processRecord = await readProcess(pid, uid);
    } catch (error) {
      if (error !== null && typeof error === 'object' && (error.code === 'ENOENT' || error.code === 'ESRCH')) {
        processRecord = {
          pid,
          ppid: 0,
          uid,
          startIdentity: '0',
          command: `disappeared:${pid}`,
          disappeared: true,
        };
      } else {
        throw error;
      }
    }
    if (processRecord === null) continue;
    validRawProcess(processRecord);
    if (processRecord.uid !== uid) invalid('process inventory');
    commandBytes += Buffer.byteLength(processIdentityText(processRecord));
    processes.push(processRecord);
    if (processes.length > MAX_CURRENT_UID_PROCESSES || commandBytes > MAX_TOTAL_COMMAND_BYTES) {
      invalid('process inventory work bound');
    }
  }
  return processes;
}

async function listBoundedProcEntries() {
  const directory = await opendir('/proc');
  const names = [];
  try {
    while (true) {
      const entry = await directory.read();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > MAX_PROC_ENTRIES) invalid('process inventory work bound');
    }
  } finally {
    await directory.close();
  }
  return names;
}

async function realInventory(uid) {
  return collectCurrentUidProcesses(uid);
}

function validateProcIdentity(identity) {
  if (
    identity === null ||
    typeof identity !== 'object' ||
    !Number.isInteger(identity.pid) ||
    identity.pid <= 0 ||
    !Number.isInteger(identity.ppid) ||
    identity.ppid < 0 ||
    typeof identity.startIdentity !== 'string' ||
    !DECIMAL.test(identity.startIdentity)
  ) {
    invalid('process stat');
  }
  return identity;
}

async function readStableAncestorIdentity(pid) {
  const first = validateProcIdentity(
    parseProcessStat(await readBoundedProcFile(`/proc/${pid}/stat`, { maxBytes: 4_096, encoding: 'utf8' }))
  );
  const last = validateProcIdentity(
    parseProcessStat(await readBoundedProcFile(`/proc/${pid}/stat`, { maxBytes: 4_096, encoding: 'utf8' }))
  );
  if (first.pid !== pid || last.pid !== pid || first.ppid !== last.ppid || first.startIdentity !== last.startIdentity) {
    invalid('unstable ancestor identity');
  }
  return first;
}

export async function discoverStableAncestorIdentities(currentPid, { readIdentity = readStableAncestorIdentity } = {}) {
  if (!Number.isInteger(currentPid) || currentPid <= 0 || typeof readIdentity !== 'function') {
    invalid('ancestor chain');
  }
  const result = [];
  const seen = new Set();
  let child = validateProcIdentity(await readIdentity(currentPid));
  while (true) {
    if (seen.has(child.pid) || result.length >= MAX_ALLOWED_ANCESTORS) invalid('ancestor chain');
    seen.add(child.pid);
    result.push({ pid: child.pid, startIdentity: child.startIdentity });
    if (child.ppid === 0) break;
    const parent = validateProcIdentity(await readIdentity(child.ppid));
    const childAgain = validateProcIdentity(await readIdentity(child.pid));
    if (
      parent.pid !== child.ppid ||
      childAgain.pid !== child.pid ||
      childAgain.ppid !== child.ppid ||
      childAgain.startIdentity !== child.startIdentity
    ) {
      invalid('unstable ancestor edge');
    }
    child = parent;
  }
  return result;
}

export const realHostAdapters = Object.freeze({
  currentUid: () => {
    if (typeof process.getuid !== 'function') invalid('current UID');
    return process.getuid();
  },
  cpuCount: () => cpus().length,
  monotonicNow: () => Number(process.hrtime.bigint()) / 1_000_000,
  delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  readCpuStat: () => readBoundedProcFile('/proc/stat', { maxBytes: 64 * 1024, encoding: 'utf8' }),
  load1: () => loadavg()[0],
  ancestorPids: discoverStableAncestorIdentities,
  inventory: realInventory,
});

function failedHostEvidence({ cpuCount = 1, startedAtMs = 0, endedAtMs = 0, error }) {
  const safeCpuCount = Number.isInteger(cpuCount) && cpuCount >= 1 && cpuCount <= 4_096 ? cpuCount : 1;
  const safeStartedAtMs =
    Number.isFinite(startedAtMs) && startedAtMs >= 0 && startedAtMs <= Number.MAX_SAFE_INTEGER ? startedAtMs : 0;
  const safeEndedAtMs =
    Number.isFinite(endedAtMs) && endedAtMs >= safeStartedAtMs && endedAtMs <= Number.MAX_SAFE_INTEGER
      ? endedAtMs
      : safeStartedAtMs;
  return {
    cpuCount: safeCpuCount,
    sampleCount: 0,
    sampleIntervalMs: HOST_SAMPLE_INTERVAL_MS,
    startedAtMs: safeStartedAtMs,
    endedAtMs: safeEndedAtMs,
    sampleTimesMs: [],
    idlePercent: 0,
    firstLoad1: 0,
    finalLoad1: 0,
    processes: [],
    measurementErrorHash: hash16(error instanceof Error ? `${error.name}:${error.message}` : String(error)),
    passed: false,
  };
}

export async function measureHostQuiescence({ currentPid = process.pid, adapters = realHostAdapters } = {}) {
  let startedAtMs = 0;
  let cpuCount = 1;
  try {
    startedAtMs = adapters.monotonicNow();
    cpuCount = adapters.cpuCount();
    const uid = adapters.currentUid();
    const ancestorPids = await adapters.ancestorPids(currentPid);
    const firstInventory = await adapters.inventory(uid);
    const firstLoad1 = adapters.load1();
    const samples = [];
    for (let index = 0; index < HOST_SAMPLE_COUNT; index += 1) {
      samples.push({ atMs: adapters.monotonicNow(), cpu: parseAggregateCpuStat(await adapters.readCpuStat()) });
      if (index < HOST_SAMPLE_COUNT - 1) await adapters.delay(HOST_SAMPLE_INTERVAL_MS);
    }
    const finalLoad1 = adapters.load1();
    const finalInventory = await adapters.inventory(uid);
    const processes = mergeClassifiedProcessRecords(
      classifyHostProcesses({ currentPid, ancestorPids, processes: firstInventory }),
      classifyHostProcesses({ currentPid, ancestorPids, processes: finalInventory })
    );
    const idlePercent = calculateCpuIdlePercent(samples[0].cpu, samples.at(-1).cpu);
    const passed =
      idlePercent >= HOST_MIN_IDLE_PERCENT &&
      firstLoad1 <= cpuCount * HOST_MAX_LOAD_PER_CPU &&
      finalLoad1 <= cpuCount * HOST_MAX_LOAD_PER_CPU &&
      processes.every((record) => record.allowedAncestor);
    const evidence = {
      cpuCount,
      sampleCount: samples.length,
      sampleIntervalMs: HOST_SAMPLE_INTERVAL_MS,
      startedAtMs: samples[0].atMs,
      endedAtMs: samples.at(-1).atMs,
      sampleTimesMs: samples.map((sample) => sample.atMs),
      idlePercent,
      firstLoad1,
      finalLoad1,
      processes,
      measurementErrorHash: null,
      passed,
    };
    return validateHostQuiescence(evidence);
  } catch (error) {
    if (error instanceof HostNotQuiescentError) throw error;
    return failedHostEvidence({
      cpuCount,
      startedAtMs,
      endedAtMs: (() => {
        try {
          return adapters.monotonicNow();
        } catch {
          return startedAtMs;
        }
      })(),
      error,
    });
  }
}
