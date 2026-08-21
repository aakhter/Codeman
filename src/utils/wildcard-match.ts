/**
 * @fileoverview The project's single wildcard matcher (COD-342). A pure,
 * RegExp-free two-pointer walk shared by the Files panel query
 * (`file-query.ts`, COD-236/COD-340) and the skill catalog's per-segment glob
 * (`skill-install-reader.ts`).
 *
 * ⚠️ Never translate a glob into a RegExp. `*a*a*a…` compiled to
 * `^.*a.*a.*a…$` (or `^[^/]*a[^/]*a…$`) puts ambiguous quantifiers side by
 * side and backtracks catastrophically — measured at **79 seconds** for 12
 * wildcards against a 32-character name, evaluated synchronously per candidate
 * path, which freezes the event loop for the whole server. This walk carries a
 * single backtrack anchor instead, so it is bounded by O(text · pattern) with
 * no exponential path.
 *
 * ⚠️ Two matchers used to exist. They disagreed on `?` and on case, so
 * "just reuse the other one" was not a drop-in either way — hence the explicit
 * options below rather than one implicit house style. Callers own casing: the
 * walk compares characters exactly, so a case-insensitive caller lowercases
 * BOTH operands before calling.
 *
 * No fs / IO — safe to unit-test directly.
 */

export interface WildcardMatchOptions {
  /**
   * Treat `?` as "exactly one character" (the Files panel query language).
   * Default `false`, i.e. `?` is a literal — the skill catalog documents `*`
   * as its only metacharacter, and a stray `?` in a source's TOML glob must
   * not silently change what the pattern selects.
   */
  singleCharWildcard?: boolean;
}

/**
 * Anchored wildcard match. `*` spans any run of characters (including `/` —
 * callers that want per-segment semantics split on `/` and call this per
 * segment, so the operand never contains one).
 */
export function matchWildcard(pattern: string, text: string, options: WildcardMatchOptions = {}): boolean {
  const singleChar = options.singleCharWildcard === true;
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = -1;
  while (t < text.length) {
    const pc = p < pattern.length ? pattern[p] : '';
    if ((singleChar && pc === '?') || (pc !== '' && pc === text[t])) {
      p++;
      t++;
    } else if (pc === '*') {
      // Remember the star; try matching zero characters first, and on a later
      // mismatch re-expand it one character at a time from here.
      starP = p++;
      starT = t;
    } else if (starP !== -1) {
      p = starP + 1;
      t = ++starT;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}
