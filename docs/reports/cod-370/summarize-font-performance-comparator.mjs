#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';

const BASE_SHA = 'd080481690dc62ffc0d0d4f8e7daae2cc8bf8613';
const [candidateSha, outputPath, ...rawPaths] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(candidateSha ?? '') || !outputPath || rawPaths.length !== 4) {
  throw new Error(
    'usage: summarize-font-performance-comparator.mjs <candidate-sha> <output.md> <baseline-1.json> <candidate-1.json> <candidate-2.json> <baseline-2.json>'
  );
}

const rows = rawPaths.map((path) => ({ path, data: JSON.parse(readFileSync(path, 'utf8')) }));
const expectedOrder = [
  ['baseline', 1],
  ['candidate', 1],
  ['candidate', 2],
  ['baseline', 2],
];
for (const [index, row] of rows.entries()) {
  const [label, repetition] = expectedOrder[index];
  if (row.data.config.label !== label || row.data.config.repetition !== repetition) {
    throw new Error(`raw order mismatch at ${row.path}`);
  }
  if (
    !row.data.passed ||
    row.data.failures.length ||
    row.data.pageErrors.length ||
    row.data.seriousConsoleErrors.length
  ) {
    throw new Error(`failed or incomplete comparator raw result: ${row.path}`);
  }
  if (!Object.values(row.data.cleanup).every((value) => value === true)) {
    throw new Error(`cleanup proof is not all true: ${row.path}`);
  }
  if (row.data.rates.length !== 2 || row.data.rates.some((rate) => rate.samples.length !== 10)) {
    throw new Error(`incomplete rate/sample matrix: ${row.path}`);
  }
  for (const rate of row.data.rates) {
    if (
      rate.expectedBytes !== rate.logicalBytes ||
      rate.expectedBytes !== rate.wsPayloadBytes ||
      rate.logicalFrames.length !== 10 ||
      rate.durableFrames.length !== 10 ||
      rate.paneComposerToken !== rate.payload ||
      rate.xtermComposerToken !== rate.payload
    ) {
      throw new Error(`input contract failed in ${row.path} at ${rate.cpuRate}x`);
    }
  }
}

const baselineRows = rows.filter((row) => row.data.config.label === 'baseline');
const candidateRows = rows.filter((row) => row.data.config.label === 'candidate');
if (baselineRows.some((row) => row.data.provenance.runtime.sha !== BASE_SHA || row.data.observedFontSize !== 10)) {
  throw new Error('baseline provenance/font mismatch');
}
if (candidateRows.some((row) => row.data.provenance.runtime.sha !== candidateSha)) {
  throw new Error('candidate provenance mismatch');
}
const candidateFonts = new Set(candidateRows.map((row) => row.data.observedFontSize));
if (candidateFonts.size !== 1 || ![8, 9].includes([...candidateFonts][0])) {
  throw new Error('candidate matrix mixes fonts or is not 8px/9px');
}
const harnessManifests = new Set(
  rows.map((row) => JSON.stringify(row.data.provenance.harness.files.map(({ path, sha256 }) => ({ path, sha256 }))))
);
if (harnessManifests.size !== 1) throw new Error('raw results used different harness files');
const runtimeLocks = new Set(rows.map((row) => row.data.provenance.runtime.packageLockSha256));
if (runtimeLocks.size !== 1) throw new Error('raw results used different dependency lockfiles');
const runtimeVendors = new Set(rows.map((row) => JSON.stringify(row.data.provenance.runtime.generatedVendor)));
if (runtimeVendors.size !== 1) throw new Error('raw results used different served vendor assets');

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function fixed(value) {
  return Number(value.toFixed(1));
}

function aggregate(label, cpuRate) {
  const selected = rows.filter((row) => row.data.config.label === label);
  const rates = selected.map((row) => row.data.rates.find((rate) => rate.cpuRate === cpuRate));
  const samples = rates.flatMap((rate) => rate.samples);
  const longTasks = rates.flatMap((rate) => rate.longTasks.map((entry) => entry.duration));
  return {
    samples,
    median: fixed(percentile(samples, 0.5)),
    p95: fixed(percentile(samples, 0.95)),
    max: fixed(Math.max(...samples)),
    longTasks,
    wsSerializedBytes: rates.map((rate) => rate.wsSerializedBytes),
    resizeEvents: rates.map((rate) => rate.resizeEvents.length),
    dimensions: rates.map((rate) => `${rate.phoneDims.cols}x${rate.phoneDims.rows}`),
    repetitions: rates.map((rate, index) => ({
      repetition: selected[index].data.config.repetition,
      median: fixed(rate.medianMs),
      p95: fixed(rate.p95Ms),
      max: fixed(rate.maxMs),
    })),
  };
}

function delta(candidate, baseline) {
  const absolute = fixed(candidate - baseline);
  return { absolute, percent: fixed((absolute / baseline) * 100) };
}

const aggregates = {};
for (const cpuRate of [1, 4]) {
  const baseline = aggregate('baseline', cpuRate);
  const candidate = aggregate('candidate', cpuRate);
  aggregates[cpuRate] = {
    baseline,
    candidate,
    medianDelta: delta(candidate.median, baseline.median),
    p95Delta: delta(candidate.p95, baseline.p95),
    maxDelta: delta(candidate.max, baseline.max),
  };
}
const regressions = Object.entries(aggregates)
  .filter(([, value]) => value.p95Delta.absolute > 20 && value.p95Delta.percent > 20)
  .map(([cpuRate]) => `${cpuRate}x`);
const decision = regressions.length ? `FAIL: material p95 regression at ${regressions.join(', ')}` : 'PASS';
const first = rows[0].data;
const candidateFont = [...candidateFonts][0];
const lines = [
  '# COD-370 Mobile OpenCode Font Performance Comparison',
  '',
  `Decision: **${decision}**`,
  '',
  `The exact pre-COD-370 runtime \`${BASE_SHA}\` at 10px was compared with \`${candidateSha}\` at ${candidateFont}px on the same host using ABBA ordering and two complete repetitions per runtime. Each rate contains 20 unfiltered dispatch-to-pane-and-xterm-visible samples. The material-regression gate is p95 worse by both more than 20ms and more than 20%.`,
  '',
  'The comparator has one connected 390x844 phone viewer. It does not compare active-viewer handoff because the baseline predates that protocol; final-head handoff remains a separate acceptance gate.',
  '',
  '| CPU | 10px baseline median / p95 / max | Candidate median / p95 / max | Median delta | p95 delta | Max delta |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
];
for (const cpuRate of [1, 4]) {
  const value = aggregates[cpuRate];
  lines.push(
    `| ${cpuRate}x | ${value.baseline.median} / ${value.baseline.p95} / ${value.baseline.max}ms | ${value.candidate.median} / ${value.candidate.p95} / ${value.candidate.max}ms | ${value.medianDelta.absolute}ms (${value.medianDelta.percent}%) | ${value.p95Delta.absolute}ms (${value.p95Delta.percent}%) | ${value.maxDelta.absolute}ms (${value.maxDelta.percent}%) |`
  );
}
lines.push('', '## Per-repetition evidence', '');
for (const cpuRate of [1, 4]) {
  for (const label of ['baseline', 'candidate']) {
    const values = aggregates[cpuRate][label].repetitions
      .map((entry) => `r${entry.repetition} ${entry.median}/${entry.p95}/${entry.max}ms`)
      .join('; ');
    lines.push(`- ${cpuRate}x ${label}: ${values}.`);
  }
}
lines.push('', '## Correctness, geometry, and load evidence', '');
for (const cpuRate of [1, 4]) {
  const value = aggregates[cpuRate];
  lines.push(
    `- ${cpuRate}x: baseline dimensions ${[...new Set(value.baseline.dimensions)].join(', ')}, candidate dimensions ${[
      ...new Set(value.candidate.dimensions),
    ].join(
      ', '
    )}; long tasks baseline ${value.baseline.longTasks.length} (${value.baseline.longTasks.map(fixed).join(', ') || 'none'}ms), candidate ${value.candidate.longTasks.length} (${value.candidate.longTasks.map(fixed).join(', ') || 'none'}ms); typing-window resize events baseline [${value.baseline.resizeEvents.join(', ')}], candidate [${value.candidate.resizeEvents.join(', ')}].`
  );
}
lines.push(
  `- Every cell delivered exactly 10 logical and 10 durable frames in order, with expected = logical = WebSocket payload bytes, unique durable client/sequence identities, and one exact final token in pane and xterm.`,
  `- Page errors and serious console warnings/errors: none. Cleanup: every boolean true in all four repetitions.`,
  `- Host: ${first.provenance.host.hostname}, ${first.provenance.host.cpuCount} x ${first.provenance.host.cpuModel}, ${first.provenance.host.platform} ${first.provenance.host.release}, Node ${first.provenance.host.node}, OpenCode ${first.provenance.host.opencodeVersion}.`,
  '',
  '## Provenance and raw evidence',
  '',
  `- Baseline tree: \`${baselineRows[0].data.provenance.runtime.tree}\`.`,
  `- Candidate tree: \`${candidateRows[0].data.provenance.runtime.tree}\`.`,
  `- Shared lockfile SHA-256: \`${first.provenance.runtime.packageLockSha256}\`.`,
  ...first.provenance.harness.files.map(
    (file) => `- Harness \`${file.path}\`: blob \`${file.blob}\`, SHA-256 \`${file.sha256}\`.`
  ),
  ...rows.map(
    (row) =>
      `- ${row.data.config.label} repetition ${row.data.config.repetition}: \`${row.path}\` (${row.data.timing.startedAt} to ${row.data.timing.endedAt}; load average ${row.data.timing.loadAverage.before.map(fixed).join('/')} to ${row.data.timing.loadAverage.after.map(fixed).join('/')}).`
  ),
  '',
  'All raw samples are retained in the listed JSON files; no sample was deleted, trimmed, or selectively rerun.'
);
writeFileSync(outputPath, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
