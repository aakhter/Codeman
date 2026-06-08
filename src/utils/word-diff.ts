/**
 * @fileoverview Word/line-level prose diff for document revision review (COD-59).
 *
 * Produces a flat list of {equal|insert|delete} segments whose concatenation
 * reconstructs each side exactly (whitespace preserved). Tuned for prose, not
 * code: it diffs word tokens for normal drafts, degrades to line tokens for
 * larger ones, and to a whole-block replace for very large inputs — keeping the
 * O(n*m) LCS table bounded.
 */

export type DiffOpType = 'equal' | 'insert' | 'delete';
export interface DiffOp {
  type: DiffOpType;
  value: string;
}

/** Word + whitespace tokens, both preserved so the text reconstructs exactly. */
function tokenizeWords(s: string): string[] {
  return s.match(/\s+|\S+/g) ?? [];
}

/** Line tokens including their trailing newline, so the text reconstructs exactly. */
function tokenizeLines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

const MAX_WORD_TOKENS = 3000;
const MAX_LINE_TOKENS = 5000;

/** Coalesce adjacent same-type ops into single runs. */
function mergeOps(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (const op of ops) {
    if (!op.value) continue;
    const last = out[out.length - 1];
    if (last && last.type === op.type) last.value += op.value;
    else out.push({ type: op.type, value: op.value });
  }
  return out;
}

/** Longest-common-subsequence diff over two token arrays. */
function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..], b[j..]. Values <= min(n,m) <= cap < 65536.
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const next = dp[i + 1];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', value: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'delete', value: a[i] });
      i++;
    } else {
      ops.push({ type: 'insert', value: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'delete', value: a[i++] });
  while (j < m) ops.push({ type: 'insert', value: b[j++] });
  return ops;
}

function wholeReplace(before: string, after: string): DiffOp[] {
  const ops: DiffOp[] = [];
  if (before) ops.push({ type: 'delete', value: before });
  if (after) ops.push({ type: 'insert', value: after });
  return ops;
}

/**
 * Diff two prose strings into equal/insert/delete segments. Granularity adapts
 * to input size so the LCS table stays bounded.
 */
export function wordDiff(before: string, after: string): DiffOp[] {
  if (before === after) {
    return before ? [{ type: 'equal', value: before }] : [];
  }

  const aw = tokenizeWords(before);
  const bw = tokenizeWords(after);
  if (aw.length <= MAX_WORD_TOKENS && bw.length <= MAX_WORD_TOKENS) {
    return mergeOps(lcsDiff(aw, bw));
  }

  const al = tokenizeLines(before);
  const bl = tokenizeLines(after);
  if (al.length <= MAX_LINE_TOKENS && bl.length <= MAX_LINE_TOKENS) {
    return mergeOps(lcsDiff(al, bl));
  }

  return mergeOps(wholeReplace(before, after));
}
