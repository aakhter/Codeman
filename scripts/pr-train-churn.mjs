#!/usr/bin/env node
/**
 * pr-train-churn.mjs — recency-weighted upstream churn for COD-27 PR-train prioritization.
 *
 * Ranks repo files by how actively `upstream/master` has changed them, weighting recent
 * commits far more than old ones (exponential time-decay, 14-day half-life). High score =
 * a file upstream is touching NOW = high merge-conflict cost for any downstream PR that sits
 * on it = upstream that PR sooner.
 *
 * Why decay (not flat commits/year): a file hot last year but quiet now over-ranks under a
 * flat count; a file surging this week under-ranks. The 14-day half-life emphasizes the last
 * ~2 weeks while retaining a few months of signal.
 *
 * Usage:
 *   node scripts/pr-train-churn.mjs                 # default: upstream/master, top 25
 *   node scripts/pr-train-churn.mjs --ref REF       # compare against a different ref
 *   node scripts/pr-train-churn.mjs --half 14       # half-life in days (default 14)
 *   node scripts/pr-train-churn.mjs --window 365    # lookback window in days (default 365)
 *   node scripts/pr-train-churn.mjs --top 40        # rows to print
 *   node scripts/pr-train-churn.mjs --paths 'src/*' 'test/*'   # pathspecs (default these two)
 *
 * Read docs/upstream-pr-train-prioritization.md for how to turn this table into priorities.
 */
import { execFileSync } from 'node:child_process';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const REF = arg('ref', 'upstream/master');
const HALF = Number(arg('half', '14')); // days
const WINDOW = Number(arg('window', '365')); // days
const TOP = Number(arg('top', '25'));
const pathsIdx = process.argv.indexOf('--paths');
const PATHS = pathsIdx >= 0 ? process.argv.slice(pathsIdx + 1).filter((a) => !a.startsWith('--')) : ['src/*', 'test/*'];

const now = Date.now() / 1000;
let log;
try {
  log = execFileSync(
    'git',
    ['log', REF, `--since=${WINDOW} days ago`, '--pretty=format:C %ct', '--name-only', '--', ...PATHS],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
} catch (e) {
  console.error(`git log failed (is "${REF}" fetched?): ${e.message}`);
  process.exit(1);
}

const dec = new Map();
const c14 = new Map();
const c90 = new Map();
const c365 = new Map();
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

let ts = null;
for (const line of log.split('\n')) {
  if (line.startsWith('C ')) {
    ts = Number(line.slice(2));
    continue;
  }
  const f = line.trim();
  if (!f || ts == null) continue;
  const ageDays = (now - ts) / 86400;
  dec.set(f, (dec.get(f) || 0) + Math.pow(0.5, ageDays / HALF));
  if (ageDays <= 14) bump(c14, f);
  if (ageDays <= 90) bump(c90, f);
  bump(c365, f);
}

const ranked = [...dec.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP);
console.log(`# Recency-weighted churn — ref=${REF}  half-life=${HALF}d  window=${WINDOW}d`);
console.log(`${'decayed'.padStart(8)} ${'14d'.padStart(4)} ${'90d'.padStart(4)} ${'365d'.padStart(5)}  file`);
for (const [f, score] of ranked) {
  console.log(
    `${score.toFixed(2).padStart(8)} ${String(c14.get(f) || 0).padStart(4)} ${String(c90.get(f) || 0).padStart(4)} ${String(c365.get(f) || 0).padStart(5)}  ${f}`
  );
}
