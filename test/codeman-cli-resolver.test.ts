/**
 * @fileoverview Unit tests for the Codeman CLI alias resolver (COD-103).
 *
 * Covers the pure, injectable core (`resolveCodemanCliNameWith`) so the
 * warn-on-PATH-miss logic is testable without depending on the real machine PATH.
 */

import { describe, it, expect } from 'vitest';
import { resolveCodemanCliNameWith } from '../src/utils/codeman-cli-resolver.js';

describe('resolveCodemanCliNameWith', () => {
  it("returns 'aicodeman' when only aicodeman is on PATH", () => {
    const lookup = (bin: string) => bin === 'aicodeman';
    expect(resolveCodemanCliNameWith(lookup)).toBe('aicodeman');
  });

  it("returns 'codeman' when only codeman is on PATH", () => {
    const lookup = (bin: string) => bin === 'codeman';
    expect(resolveCodemanCliNameWith(lookup)).toBe('codeman');
  });

  it("prefers 'aicodeman' when both are on PATH", () => {
    const lookup = () => true;
    expect(resolveCodemanCliNameWith(lookup)).toBe('aicodeman');
  });

  it('returns null when neither is on PATH', () => {
    const lookup = () => false;
    expect(resolveCodemanCliNameWith(lookup)).toBeNull();
  });
});
