/**
 * @fileoverview Tests for the `checkpoint --status` CLI helper (COD-111).
 *
 * The bug: there was no read-only way to query a session's AGENT CHECKPOINT
 * config. The only "probe" was `aicodeman checkpoint`, which QUEUES/fires a real
 * checkpoint (a compact/clear of the live session) — a destructive side effect.
 *
 * The fix adds `aicodeman checkpoint --status`, which GETs `/api/sessions/:id`
 * (already serialized via `toState()` with `checkpointEnabled` / `checkpointMode`
 * / `checkpointModes`) and renders it — no hook POST, so nothing is queued.
 *
 * These tests cover the PURE formatter that turns an (already-unwrapped) session
 * state object into the human-readable status report: enabled state, allowed
 * modes, the mode a bare checkpoint runs, and the default continue prompt —
 * including defensive handling of missing/legacy fields.
 */

import { describe, it, expect } from 'vitest';
import { formatCheckpointStatus } from '../src/cli.js';

describe('formatCheckpointStatus', () => {
  it('reports enabled + both allowed modes', () => {
    const out = formatCheckpointStatus({
      checkpointEnabled: true,
      checkpointMode: 'compact',
      checkpointModes: ['compact', 'clear'],
    });
    expect(out).toMatch(/enabled:\s+yes/);
    expect(out).toMatch(/allowed modes:\s+compact, clear/);
    // A bare `checkpoint` (no -m) runs compact when allowed.
    expect(out).toMatch(/bare checkpoint:\s+compact/);
    expect(out).toMatch(/default continue:\s+continue/);
  });

  it('reports disabled when the toggle is off', () => {
    const out = formatCheckpointStatus({
      checkpointEnabled: false,
      checkpointModes: ['compact', 'clear'],
    });
    expect(out).toMatch(/enabled:\s+no/);
    // Allowed modes are still reported (config persists while disabled).
    expect(out).toMatch(/allowed modes:\s+compact, clear/);
  });

  it('falls back to clear for bare checkpoint when only clear is allowed', () => {
    const out = formatCheckpointStatus({
      checkpointEnabled: true,
      checkpointModes: ['clear'],
    });
    expect(out).toMatch(/allowed modes:\s+clear/);
    expect(out).toMatch(/bare checkpoint:\s+clear/);
  });

  it('runs compact for bare checkpoint when only compact is allowed', () => {
    const out = formatCheckpointStatus({
      checkpointEnabled: true,
      checkpointModes: ['compact'],
    });
    expect(out).toMatch(/bare checkpoint:\s+compact/);
  });

  it('normalizes mode order regardless of input ordering', () => {
    const out = formatCheckpointStatus({
      checkpointEnabled: true,
      checkpointModes: ['clear', 'compact'],
    });
    // Stable display order is always compact, clear.
    expect(out).toMatch(/allowed modes:\s+compact, clear/);
  });

  it('falls back to the legacy checkpointMode when checkpointModes is absent', () => {
    const out = formatCheckpointStatus({
      checkpointEnabled: true,
      checkpointMode: 'clear',
    });
    expect(out).toMatch(/allowed modes:\s+clear/);
    expect(out).toMatch(/bare checkpoint:\s+clear/);
  });

  it('handles a state object with no checkpoint fields defensively', () => {
    const out = formatCheckpointStatus({ id: 'abc', status: 'idle' });
    expect(out).toMatch(/enabled:\s+no/);
    expect(out).toMatch(/allowed modes:\s+none/);
    expect(out).toMatch(/bare checkpoint:\s+n\/a/);
  });

  it('handles null/undefined input without throwing', () => {
    expect(() => formatCheckpointStatus(null)).not.toThrow();
    expect(() => formatCheckpointStatus(undefined)).not.toThrow();
    expect(formatCheckpointStatus(null)).toMatch(/enabled:\s+no/);
  });
});
