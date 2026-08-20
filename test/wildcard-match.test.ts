/**
 * @fileoverview Unit coverage for the shared wildcard walk (COD-342). Both callers depend on
 * the option defaults, and they want OPPOSITE `?` behaviour, so the defaults are pinned here
 * rather than left to whichever caller is read first.
 */

import { describe, it, expect } from 'vitest';
import { matchWildcard } from '../src/utils/wildcard-match.js';

describe('matchWildcard', () => {
  it('matches anchored, with * spanning any run', () => {
    expect(matchWildcard('a*c', 'abc')).toBe(true);
    expect(matchWildcard('a*c', 'ac')).toBe(true);
    expect(matchWildcard('a*c', 'abcd')).toBe(false);
    expect(matchWildcard('*', '')).toBe(true);
    expect(matchWildcard('', '')).toBe(true);
    expect(matchWildcard('', 'x')).toBe(false);
  });

  it('backtracks correctly across several stars', () => {
    expect(matchWildcard('a*b*c', 'axxbyyc')).toBe(true);
    expect(matchWildcard('a*b*c', 'axxbyy')).toBe(false);
    expect(matchWildcard('*a*a*a', 'banana')).toBe(true);
    expect(matchWildcard('**x', 'x')).toBe(true);
  });

  it('treats ? literally by default', () => {
    // skill-install-reader depends on this: `*` is its only metacharacter.
    expect(matchWildcard('ab?*', 'ab')).toBe(false);
    expect(matchWildcard('ab?*', 'ab?cd')).toBe(true);
    expect(matchWildcard('?x*', '?xy')).toBe(true);
    expect(matchWildcard('?x*', 'ax')).toBe(false);
  });

  it('treats ? as exactly one character under singleCharWildcard', () => {
    // file-query's documented query language.
    expect(matchWildcard('ab?', 'abc', { singleCharWildcard: true })).toBe(true);
    expect(matchWildcard('ab?', 'ab', { singleCharWildcard: true })).toBe(false);
    expect(matchWildcard('?x', 'ax', { singleCharWildcard: true })).toBe(true);
  });

  it('compares case-sensitively — callers own casing', () => {
    expect(matchWildcard('READ*', 'README.md')).toBe(true);
    expect(matchWildcard('read*', 'README.md')).toBe(false);
  });

  it('stays fast on a pathological star-heavy pattern (no regex backtracking)', () => {
    // The RegExp this replaced took 79 SECONDS on this shape.
    const started = Date.now();
    expect(matchWildcard(`${'*'.repeat(40)}x`, 'a'.repeat(255))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
