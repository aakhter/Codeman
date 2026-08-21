/**
 * @fileoverview Tests for the `mux` CLI command's table formatter (COD-70).
 *
 * The `mux` command fetches `/api/mux-sessions` from a running instance and
 * renders the tmux <-> Codeman mapping. `formatMuxTable` is the pure row-mapping
 * / table-rendering helper, unit-tested here. The HTTP transport is not unit
 * tested (mirrors how `attach` leaves its request helper untested).
 */

import { describe, it, expect, vi } from 'vitest';
import { enrichMuxActivityForOutput, formatMuxTable, mergeMuxActivity } from '../src/cli.js';

const sampleRows = [
  {
    sessionId: '03f0aff9-46e6-4193-87ee-ae71951bd436',
    muxName: 'codeman-03f0aff9',
    name: 'lp-faq',
    mode: 'codex',
    attached: false,
    pid: 1184073,
  },
  {
    sessionId: 'a3687f7c-c8e9-4884-b955-f9bb577b780e',
    muxName: 'codeman-a3687f7c',
    name: 'w3-codeman-n: upstream',
    mode: 'claude',
    attached: true,
    pid: 20811,
  },
];

describe('formatMuxTable', () => {
  it('renders the muxName, display name, sessionId, mode, and status for each row', () => {
    const table = formatMuxTable(sampleRows);

    // Display names
    expect(table).toContain('lp-faq');
    expect(table).toContain('w3-codeman-n: upstream');

    // tmux session (muxName) — the whole point of the feature
    expect(table).toContain('codeman-03f0aff9');
    expect(table).toContain('codeman-a3687f7c');

    // sessionId
    expect(table).toContain('03f0aff9-46e6-4193-87ee-ae71951bd436');
    expect(table).toContain('a3687f7c-c8e9-4884-b955-f9bb577b780e');

    // mode
    expect(table).toContain('codex');
    expect(table).toContain('claude');
  });

  it('includes column headers', () => {
    const table = formatMuxTable(sampleRows);
    expect(table).toMatch(/Display name/i);
    expect(table).toMatch(/tmux session/i);
    expect(table).toMatch(/session/i);
    expect(table).toMatch(/mode/i);
    expect(table).toMatch(/status/i);
  });

  it('derives status from the attached flag', () => {
    const table = formatMuxTable(sampleRows);
    expect(table).toContain('attached');
    expect(table).toContain('detached');
  });

  it('renders effective agent activity separately from mux attachment state', () => {
    const table = formatMuxTable([{ ...sampleRows[0], status: 'idle', activityStatus: 'waiting_agents' }]);
    expect(table).toContain('WAITING ON AGENTS');
    expect(table).toContain('detached');
  });

  it('joins canonical activity from the live status payload by exact session id', () => {
    const merged = mergeMuxActivity(sampleRows, {
      sessions: [{ id: sampleRows[0].sessionId, status: 'idle', activityStatus: 'checking_agents' }],
    });
    expect(formatMuxTable(merged)).toContain('CHECKING AGENTS');
  });

  it('falls back to raw mux rows when bounded status enrichment times out', async () => {
    const fetchStatus = vi.fn(async (timeoutMs: number) => {
      expect(timeoutMs).toBe(1500);
      throw new Error('request timed out');
    });
    await expect(enrichMuxActivityForOutput(sampleRows, { fetchStatus })).resolves.toEqual(sampleRows);
    expect(fetchStatus).toHaveBeenCalledOnce();
  });

  it('keeps --json raw and never fetches status enrichment', async () => {
    const fetchStatus = vi.fn();
    const result = await enrichMuxActivityForOutput(sampleRows, { json: true, fetchStatus });
    expect(result).toBe(sampleRows);
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it('falls back to a placeholder display name when name is missing', () => {
    const table = formatMuxTable([
      {
        sessionId: 'fe7637d9-f06f-4b0c-8be0-b91bb92f3655',
        muxName: 'codeman-fe7637d9',
        mode: 'claude',
        attached: false,
        pid: 1,
      },
    ]);
    // Still renders the muxName + sessionId even without a display name
    expect(table).toContain('codeman-fe7637d9');
    expect(table).toContain('fe7637d9-f06f-4b0c-8be0-b91bb92f3655');
  });

  it('handles an empty list with a clear message', () => {
    const table = formatMuxTable([]);
    expect(table).toMatch(/no .*sessions/i);
  });
});
