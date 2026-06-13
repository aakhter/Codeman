/**
 * buildHeadroomExports (src/tmux-manager.ts): the extra env-export lines that
 * route a Claude session's traffic through the Headroom proxy. COD-98.
 * Port: N/A (pure function).
 */
import { describe, it, expect } from 'vitest';
import { buildHeadroomExports } from '../src/tmux-manager.js';

describe('buildHeadroomExports', () => {
  it('exports ANTHROPIC_BASE_URL for a Claude session with a URL', () => {
    expect(buildHeadroomExports('claude', 'http://192.168.55.175:8787')).toEqual([
      "export ANTHROPIC_BASE_URL='http://192.168.55.175:8787'",
    ]);
  });

  it('returns nothing when no URL is resolved (fallback to direct API)', () => {
    expect(buildHeadroomExports('claude', undefined)).toEqual([]);
  });

  it('never routes non-claude modes even if a URL is passed', () => {
    expect(buildHeadroomExports('codex', 'http://192.168.55.175:8787')).toEqual([]);
    expect(buildHeadroomExports('shell', 'http://192.168.55.175:8787')).toEqual([]);
  });
});
