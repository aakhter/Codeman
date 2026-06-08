import { describe, it, expect } from 'vitest';
import { wordDiff } from '../src/utils/word-diff.js';

/** Reconstruct the "before" text from a diff (equal + delete segments). */
function reconstructBefore(ops: ReturnType<typeof wordDiff>): string {
  return ops
    .filter((o) => o.type === 'equal' || o.type === 'delete')
    .map((o) => o.value)
    .join('');
}
/** Reconstruct the "after" text from a diff (equal + insert segments). */
function reconstructAfter(ops: ReturnType<typeof wordDiff>): string {
  return ops
    .filter((o) => o.type === 'equal' || o.type === 'insert')
    .map((o) => o.value)
    .join('');
}

describe('wordDiff', () => {
  it('returns a single equal op for identical text', () => {
    const ops = wordDiff('the quick brown fox', 'the quick brown fox');
    expect(ops).toEqual([{ type: 'equal', value: 'the quick brown fox' }]);
  });

  it('detects a replaced word in the middle', () => {
    const ops = wordDiff('the quick brown fox', 'the quick red fox');
    expect(ops.some((o) => o.type === 'delete' && o.value.includes('brown'))).toBe(true);
    expect(ops.some((o) => o.type === 'insert' && o.value.includes('red'))).toBe(true);
    // unchanged words stay equal
    expect(ops.some((o) => o.type === 'equal' && o.value.includes('the quick'))).toBe(true);
  });

  it('reconstructs both sides exactly (whitespace preserved)', () => {
    const before = '# Title\n\nFirst paragraph here.\n';
    const after = '# Title\n\nFirst revised paragraph is here now.\n';
    const ops = wordDiff(before, after);
    expect(reconstructBefore(ops)).toBe(before);
    expect(reconstructAfter(ops)).toBe(after);
  });

  it('is a pure insertion when text is only appended', () => {
    const ops = wordDiff('one two', 'one two three');
    expect(ops.filter((o) => o.type === 'delete')).toHaveLength(0);
    expect(ops.some((o) => o.type === 'insert' && o.value.includes('three'))).toBe(true);
  });

  it('is a pure deletion when text is only removed', () => {
    const ops = wordDiff('one two three', 'one two');
    expect(ops.filter((o) => o.type === 'insert')).toHaveLength(0);
    expect(ops.some((o) => o.type === 'delete' && o.value.includes('three'))).toBe(true);
  });

  it('handles empty before (all insert) and empty after (all delete)', () => {
    expect(wordDiff('', 'hello world')).toEqual([{ type: 'insert', value: 'hello world' }]);
    expect(wordDiff('hello world', '')).toEqual([{ type: 'delete', value: 'hello world' }]);
    expect(wordDiff('', '')).toEqual([]);
  });

  it('merges consecutive same-type ops into runs', () => {
    const ops = wordDiff('a b c', 'a x y z c');
    // no two adjacent ops share a type
    for (let i = 1; i < ops.length; i++) {
      expect(ops[i].type).not.toBe(ops[i - 1].type);
    }
    expect(reconstructBefore(ops)).toBe('a b c');
    expect(reconstructAfter(ops)).toBe('a x y z c');
  });

  it('falls back to a whole-block replace for very large inputs but still reconstructs', () => {
    const before = Array.from({ length: 9000 }, (_, i) => `w${i}`).join(' ');
    const after = before + ' extra';
    const ops = wordDiff(before, after);
    expect(reconstructBefore(ops)).toBe(before);
    expect(reconstructAfter(ops)).toBe(after);
  });
});
